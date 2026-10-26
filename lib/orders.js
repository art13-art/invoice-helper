// 訂單流程：每分鐘看一次來源表（例如客服表），某一列必填欄位都填好、且 1 分鐘內沒再變動，
// 就把它寫進目的表（廠商表）、到廠商群組通知，並在來源表標記「已轉廠商」。
// 填了一部分卻 30 分鐘都沒補齊，會在內部群組提醒一次並在來源表標記缺什麼。
// 流程設定存在 line_kv 的 "flows"（JSON 陣列）：
//   { id, name, src, srcTab?, dst, dstTab?, required:[...], fields?:[...], notify, alert?, label? }
import { kv, md, ymd, hm, claude } from "./assistant.js";
import { gas } from "./books.js";
import { lineClient, textMessage, mentionMessage } from "./line.js";
import { recordPush, recordAI } from "./usage.js";

const STATUS = "小幫手狀態";
const SETTLE_MS = 40e3, ALERT_MS = 30 * 60e3;

export async function runFlows(env, db, now = Date.now()) {
  const flows = await kv.json(db, "flows", []);
  const out = [];
  for (const f of flows) {
    if (f.enabled === false) continue;
    try { out.push({ id: f.id, ...(await runFlow(env, db, f, now)) }); }
    catch (e) { console.log("flow failed", f.id, e.message); out.push({ id: f.id, error: e.message }); }
  }
  if (out.length) await kv.set(db, "flows:last", JSON.stringify({ at: now, out }));
  return out;
}

const val = v => String(v ?? "").trim();
const tpHour = ms => new Date(ms + 8 * 3600e3).getUTCHours();
async function pushTo(line, db, chatId, text, mentionId) {
  try { await line.push(chatId, [mentionId ? mentionMessage("{who} " + text, mentionId) : textMessage(text)]); await recordPush(db, chatId, await line.memberCount(chatId)); return true; }
  catch (e) { console.log("flow push failed", chatId, e.message); return false; }
}
// 電話被試算表當成數字時會掉開頭的 0（0912… → 912…），補回來
const fix = (k, v) => /(電話|手機)/.test(k) && /^\d{8,9}$/.test(v) ? "0" + v : v;

async function runFlow(env, db, f, now) {
  const r = await gas(env, "readRows", f.src, f.srcTab || "", { limit: 200 });
  const fields = f.fields || f.required;
  const rows = (r.rows || []).sort((a, b) => a._row - b._row);
  const line = lineClient(env.LINE_CHANNEL_TOKEN);
  const res = { sent: 0, alerted: 0 };
  for (const row of rows) {
    const missing = f.required.filter(k => !val(row[k]));
    if (missing.length === f.required.length) continue;          // 空白列
    const hash = JSON.stringify(fields.map(k => val(row[k])));
    let st = await db.prepare("SELECT * FROM line_flow_rows WHERE flow=? AND row=?").bind(f.id, row._row).first();
    if (st && st.status === "done" && st.hash === hash) continue;
    if (!st || st.hash !== hash) {
      if (st && (st.status === "sending" || st.status === "updating")) continue;   // 正在送，別打斷
      // 已送過的訂單之後被修改 → 等穩定後送「更新」
      const next = st && (st.status === "done" || st.status === "upd") ? "upd" : "seen";
      if (next === "upd" && missing.length) continue;               // 已送過的訂單被清掉部分欄位：不理
      await db.prepare("INSERT INTO line_flow_rows(flow,row,hash,first_seen,status,ts) VALUES(?,?,?,?,?,?) ON CONFLICT(flow,row) DO UPDATE SET hash=excluded.hash,first_seen=excluded.first_seen,status=excluded.status,ts=excluded.ts")
        .bind(f.id, row._row, hash, now, next, now).run();
      continue;
    }
    const age = now - st.first_seen;
    if (st.status === "upd") {
      if (age < SETTLE_MS || missing.length) continue;
      const claim = await db.prepare("UPDATE line_flow_rows SET status='updating',ts=? WHERE flow=? AND row=? AND status='upd' AND hash=?").bind(now, f.id, row._row, hash).run();
      if ((claim.meta?.changes ?? 1) === 0) continue;
      const rec = {}; fields.forEach(k => { rec[k] = fix(k, val(row[k])); });
      try {
        if (st.dst_row) for (const k of fields) await gas(env, "setCell", f.dst, f.dstTab || "", st.dst_row, k, /^0\d+$/.test(rec[k]) ? "'" + rec[k] : rec[k]);
        const text = `訂單資料更新\n` + fields.map(k => `${k}：${rec[k]}`).join("\n") + (st.dst_row ? `\n已更新表單第 ${st.dst_row} 列` : "");
        await pushTo(line, db, f.notify, text, f.boss?.id);
        await db.prepare("UPDATE line_flow_rows SET status='done',ts=?,sent_at=?,acked=0,nudged=0 WHERE flow=? AND row=?").bind(now, now, f.id, row._row).run();
        res.updated = (res.updated || 0) + 1;
      } catch (e) {
        await db.prepare("UPDATE line_flow_rows SET status='upd',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
        throw e;
      }
      continue;
    }
    if (!missing.length) {
      if (age < SETTLE_MS) continue;
      // 先佔住這一列，避免同時兩個 tick 重複送
      const claim = await db.prepare("UPDATE line_flow_rows SET status='sending',ts=? WHERE flow=? AND row=? AND status IN ('seen','alerted') AND hash=?").bind(now, f.id, row._row, hash).run();
      if ((claim.meta?.changes ?? 1) === 0) continue;
      try {
        const rec = {}, put = {};
        fields.forEach(k => { rec[k] = fix(k, val(row[k])); put[k] = /^0\d+$/.test(rec[k]) ? "'" + rec[k] : rec[k]; });
        const w = await gas(env, "appendRows", f.dst, f.dstTab || "", [put], { who: "小幫手", raw: `${f.label || "來源表"}第 ${row._row} 列` });
        const text = `${f.title || "新訂單"}\n` + fields.map(k => `${k}：${rec[k]}`).join("\n") + (w && w.firstRow ? `\n已填進表單第 ${w.firstRow} 列` : "");
        await pushTo(line, db, f.notify, text, f.boss?.id);
        await db.prepare("UPDATE line_flow_rows SET status='done',dst_row=?,ts=?,sent_at=?,acked=0,nudged=0 WHERE flow=? AND row=?").bind(w && w.firstRow || null, now, now, f.id, row._row).run();
        if (f.mark !== false) await gas(env, "setCell", f.src, f.srcTab || "", row._row, STATUS, `已轉廠商 ${md(ymd(now))} ${hm(now)}`).catch(e => console.log("mark failed", e.message));
        res.sent++;
      } catch (e) {
        await db.prepare("UPDATE line_flow_rows SET status='seen',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
        throw e;
      }
    } else if (age >= (Number(f.alertMin) > 0 ? f.alertMin * 60e3 : ALERT_MS) && st.status === "seen" && f.alert) {
      await db.prepare("UPDATE line_flow_rows SET status='alerted',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
      const who = val(row[f.required[0]]) || `第 ${row._row} 列`;
      await pushTo(line, db, f.alert, `${f.label || "表單"}第 ${row._row} 列（${who}）還缺${missing.join("、")}，補齊後我再送廠商。`);
      if (f.mark !== false) await gas(env, "setCell", f.src, f.srcTab || "", row._row, STATUS, "缺" + missing.join("、")).catch(() => {});
      res.alerted++;
    }
  }
  // 廠商超過時間沒回覆 → 白天提醒廠商一次，並告訴客服群
  const ackMs = (Number(f.ackHours) > 0 ? f.ackHours : 2) * 3600e3, h = tpHour(now);
  if (h >= 8 && h < 22) {
    const { results: late } = await db.prepare("SELECT * FROM line_flow_rows WHERE flow=? AND status='done' AND acked=0 AND nudged=0 AND sent_at IS NOT NULL AND sent_at<=? AND sent_at>?").bind(f.id, now - ackMs, now - 3 * 864e5).all();
    for (const r of late) {
      const claim = await db.prepare("UPDATE line_flow_rows SET nudged=1 WHERE flow=? AND row=? AND nudged=0").bind(f.id, r.row).run();
      if ((claim.meta?.changes ?? 1) === 0) continue;
      const nm = orderName(f, r);
      await pushTo(line, db, f.notify, `${nm}的單還沒看到回覆，麻煩確認一下。`, f.boss?.id);
      if (f.alert) await pushTo(line, db, f.alert, `廠商 ${Math.round(ackMs / 3600e3)} 小時還沒回覆${nm}的單，我已經再提醒一次。`);
      res.nudged = (res.nudged || 0) + 1;
    }
  }
  return res;
}

function orderName(f, r) {
  let v = []; try { v = JSON.parse(r.hash); } catch (e) {}
  const fields = f.fields || f.required;
  return v[fields.indexOf(f.required[0])] || `第 ${r.row} 列`;
}

/* 廠商群組裡有人說話：有待確認的訂單時，判斷是不是在回覆訂單（收到、出貨、缺貨、改期…） */
export async function vendorReply(env, db, line, chatId, userId, name, text) {
  if (!text || !env.ANTHROPIC_API_KEY) return null;
  const flows = (await kv.json(db, "flows", [])).filter(f => f.enabled !== false && f.notify === chatId);
  const out = [];
  for (const f of flows) {
    if (f.boss?.id && f.boss.id !== userId) continue;              // 有指定老闆就只看老闆的話
    const { results: pend } = await db.prepare("SELECT * FROM line_flow_rows WHERE flow=? AND status='done' AND acked=0 AND sent_at>? ORDER BY row").bind(f.id, Date.now() - 3 * 864e5).all();
    if (!pend.length) continue;
    const fields = f.fields || f.required;
    const list = pend.map(r => { let v = []; try { v = JSON.parse(r.hash); } catch (e) {} return `第${r.row}列：` + fields.map((k, i) => `${k} ${v[i] || ""}`).join("、") + `（${hm(r.sent_at)} 送出）`; }).join("\n");
    const model = env.BG_MODEL || "claude-haiku-5-5";
    const res = await claude(env, { model, max_tokens: 300,
      system: `你在幫忙追蹤訂單。下面是已經通知廠商、但廠商還沒回覆的訂單。判斷廠商在群組裡說的這句話，是不是在回應這些訂單。只輸出 JSON，不要其他文字：{"ack":[列號...],"note":"..."}
- ack：廠商有回應到的訂單列號（收到、好、OK、會處理、已出貨、明天寄、沒貨、要延後、地址有問題都算有回應）。只說「收到」「好」這類沒指明哪一筆的，算全部待確認訂單。
- note：廠商提到需要客服知道或處理的事（缺貨、延後、改價、資料有問題、問問題），寫成一句給客服看的話，要說是哪位客人的單；單純收到、會處理就留空字串。
- 跟訂單無關的閒聊：ack 空陣列、note 空字串。`,
      messages: [{ role: "user", content: `待確認訂單：\n${list}\n\n廠商「${name}」說：${text.slice(0, 500)}` }] });
    if (res.usage) await recordAI(env, db, { chatId, userId, model, usage: res.usage }).catch(() => {});
    let j = {}; try { j = JSON.parse((res.content || []).map(b => b.text || "").join("").replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { continue; }
    const rows = (Array.isArray(j.ack) ? j.ack : []).map(Number).filter(n => pend.some(r => r.row === n));
    for (const n of rows) await db.prepare("UPDATE line_flow_rows SET acked=1 WHERE flow=? AND row=?").bind(f.id, n).run();
    const note = String(j.note || "").trim();
    if (note && f.alert) await pushTo(line, db, f.alert, `廠商回覆：${note}`);
    out.push({ flow: f.id, acked: rows, note });
  }
  return out;
}
