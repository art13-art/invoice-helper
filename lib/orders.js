// 訂單流程：每分鐘看一次來源表（例如客服表），某一列必填欄位都填好、且 1 分鐘內沒再變動，
// 就把它寫進目的表（廠商表）、到廠商群組通知，並在來源表標記「已轉廠商」。
// 填了一部分卻 30 分鐘都沒補齊，會在內部群組提醒一次並在來源表標記缺什麼。
// 流程設定存在 line_kv 的 "flows"（JSON 陣列）：
//   { id, name, src, srcTab?, dst, dstTab?, required:[...], fields?:[...], notify, alert?, label? }
import { kv, md, ymd, hm } from "./assistant.js";
import { gas } from "./books.js";
import { lineClient, textMessage } from "./line.js";
import { recordPush } from "./usage.js";

const STATUS = "小幫手狀態";
const SETTLE_MS = 60e3, ALERT_MS = 30 * 60e3;

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
// 電話被試算表當成數字時會掉開頭的 0（0912… → 912…），補回來
const fix = (k, v) => /(電話|手機)/.test(k) && /^\d{8,9}$/.test(v) ? "0" + v : v;

async function runFlow(env, db, f, now) {
  const r = await gas(env, "readRows", f.src, f.srcTab || "", { limit: 200 });
  const fields = f.fields || f.required;
  const rows = (r.rows || []).filter(x => !val(x[STATUS]).startsWith("已轉")).sort((a, b) => a._row - b._row);
  const line = lineClient(env.LINE_CHANNEL_TOKEN);
  const res = { sent: 0, alerted: 0 };
  for (const row of rows) {
    const missing = f.required.filter(k => !val(row[k]));
    if (missing.length === f.required.length) continue;          // 空白列
    const hash = JSON.stringify(fields.map(k => val(row[k])));
    let st = await db.prepare("SELECT * FROM line_flow_rows WHERE flow=? AND row=?").bind(f.id, row._row).first();
    if (st && st.status === "done" && st.hash === hash) continue;
    if (!st || st.hash !== hash) {
      if (st && st.status === "sending") continue;                // 正在送，別打斷
      await db.prepare("INSERT INTO line_flow_rows(flow,row,hash,first_seen,status,ts) VALUES(?,?,?,?,'seen',?) ON CONFLICT(flow,row) DO UPDATE SET hash=excluded.hash,first_seen=excluded.first_seen,status='seen',ts=excluded.ts")
        .bind(f.id, row._row, hash, now, now).run();
      continue;
    }
    const age = now - st.first_seen;
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
        try { await line.push(f.notify, [textMessage(text)]); await recordPush(db, f.notify, await line.memberCount(f.notify)); }
        catch (e) { console.log("flow notify failed", e.message); }
        await gas(env, "setCell", f.src, f.srcTab || "", row._row, STATUS, `已轉廠商 ${md(ymd(now))} ${hm(now)}`).catch(e => console.log("mark failed", e.message));
        await db.prepare("UPDATE line_flow_rows SET status='done',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
        res.sent++;
      } catch (e) {
        await db.prepare("UPDATE line_flow_rows SET status='seen',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
        throw e;
      }
    } else if (age >= ALERT_MS && st.status === "seen" && f.alert) {
      await db.prepare("UPDATE line_flow_rows SET status='alerted',ts=? WHERE flow=? AND row=?").bind(now, f.id, row._row).run();
      const who = val(row[f.required[0]]) || `第 ${row._row} 列`;
      try { await line.push(f.alert, [textMessage(`${f.label || "表單"}第 ${row._row} 列（${who}）還缺${missing.join("、")}，補齊後我再送廠商。`)]); await recordPush(db, f.alert, await line.memberCount(f.alert)); }
      catch (e) { console.log("flow alert failed", e.message); }
      await gas(env, "setCell", f.src, f.srcTab || "", row._row, STATUS, "缺" + missing.join("、")).catch(() => {});
      res.alerted++;
    }
  }
  return res;
}
