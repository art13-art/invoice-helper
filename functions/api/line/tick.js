// POST /api/line/tick — 定時（約每 1 分鐘）呼叫：送出到期提醒，並清掉過期紀錄。
// 不需要金鑰：重複呼叫也只會送出已到期且尚未送出的提醒（先標記再送，不會重複）。
import { lineClient, mentionMessage, textMessage, say, doneCard } from "../../../lib/line.js";
import { recordPush, monthlyReport, checkQuota } from "../../../lib/usage.js";
import { gas, gasConf } from "../../../lib/books.js";
import { runFlows } from "../../../lib/orders.js";
import { buildDigests } from "../../../lib/digest.js";
import { cleanupTranscripts } from "../../../lib/audio.js";
import { kv, nextDue, ymd, hm, md, parseLocal, isGroup, KEEP_DAYS } from "../../../lib/assistant.js";

export async function onRequestPost({ request, env }) {
  if (env.TICK_KEY) { let b = {}; try { b = await request.json(); } catch (e) {} if (b.key !== env.TICK_KEY) return new Response("unauthorized", { status: 401 }); }
  if (!env.LINE_CHANNEL_TOKEN) return Response.json({ ok: true, idle: true });
  const db = env.DB, now = Date.now();
  const last = Number(await kv.get(db, "tick:last")) || 0;
  if (now - last < 40e3) return Response.json({ ok: true, throttled: true });
  await kv.set(db, "tick:last", now);
  const line = lineClient(env.LINE_CHANNEL_TOKEN), origin = new URL(request.url).origin;
  const sent = { reminders: 0, failed: 0 };

  const { results } = await db.prepare("SELECT * FROM line_reminders WHERE status='open' AND due<=? ORDER BY due LIMIT 50").bind(now + 30e3).all();
  for (const r of results) {
    const next = nextDue(r.due, r.repeat);
    const claim = next
      ? await db.prepare("UPDATE line_reminders SET due=? WHERE id=? AND due=? AND status='open'").bind(next, r.id, r.due).run()
      : await db.prepare("UPDATE line_reminders SET status='sent' WHERE id=? AND status='open'").bind(r.id).run();
    if ((claim.meta?.changes ?? 1) === 0) continue;
    // 待辦的到期／逾期提醒：已經完成就不發；到期那次發完，隔天早上 9 點還沒完成再提醒一次
    let card = null;
    if (r.todo_id) {
      const t = await db.prepare("SELECT status,task,due FROM line_todos WHERE id=?").bind(r.todo_id).first();
      if (!t || t.status !== "open") continue;
      card = doneCard(r.todo_id, t.task);   // 同一次推播多一張卡，不多算則數
      // 到期或逾期提醒發完：隔天早上 9:00 再追一次，一直到有人按「已完成」（前一天的預告不算）
      if (!r.text.startsWith("明天到期：")) {
        const d = new Date(Math.max(r.due, now) + 8 * 3600e3 + 864e5), next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 0);   // 隔天台北 09:00
        await db.prepare("INSERT OR IGNORE INTO line_reminders(id,chat_id,due,text,repeat,mention_id,mention_name,todo_id,created,created_by,status) VALUES(?,?,?,?,'none',?,?,?,?,?,'open')")
          .bind(r.todo_id + "o" + crypto.randomUUID().slice(0, 6), r.chat_id, next, "逾期還沒完成：" + t.task, r.mention_id, r.mention_name, r.todo_id, now, r.created_by).run().catch(() => null);
      }
      if (r.text.startsWith("逾期還沒完成：") && t.due) r.text = r.text.replace("逾期還沒完成：", `逾期 ${Math.max(1, Math.round((now - t.due) / 864e5))} 天還沒完成：`);
    }
    const late = now - r.due > 30 * 60e3 ? `（原訂 ${md(ymd(r.due))} ${hm(r.due)}）` : "";
    // 群組裡的提醒一律 @人：指定的人／全體（all）；沒指定就 @設提醒的人
    let tag = isGroup(r.chat_id) ? (r.mention_id || r.created_by || null) : null;
    // 發送前確認被 @ 的人還在群組（查詢免費）：指定的人都不在了就不發；部分不在就只 @ 還在的
    if (tag && tag !== "all") {
      const still = [];
      for (const u of String(tag).split(",").filter(Boolean)) if ((await line.isMember(r.chat_id, u).catch(() => null)) !== false) still.push(u);
      if (!still.length && r.mention_id) { console.log("reminder skipped: mentioned people left", r.id); continue; }
      tag = still.join(",") || null;
    }
    const who = tag ? "{who} " : "";
    const text = r.kind === "msg" || r.kind === "chase" ? `${who}${r.text}` : `⏰ ${who}${r.text.replace(/^待辦到期：/, "")}${late}` + (next ? `\n（下次 ${md(ymd(next))} ${hm(next)}）` : "");
    try { await line.push(r.chat_id, card ? [mentionMessage(text, tag), card] : [mentionMessage(text, tag)]); sent.reminders++; await recordPush(db, r.chat_id, await line.memberCount(r.chat_id)); }
    catch (e) {
      // @ 或卡片被 LINE 拒收（例如被 @ 的人已經退群）：改成純文字再送一次，提醒不能丟
      // 被拒收：先拿掉卡片、保留 @ 再送；還不行才用純文字（把名字寫出來）
      console.log("reminder push failed, retry", r.id, e.message);
      const plain = text.replace("{who} ", r.mention_id === "all" ? "@All " : r.mention_name ? "@" + String(r.mention_name).split("、").join(" @") + " " : "");
      const tries = [...(card ? [[mentionMessage(text, tag)]] : []), [textMessage(plain)]];
      let okSent = false;
      for (const m of tries) { try { await line.push(r.chat_id, m); okSent = true; break; } catch (e2) { console.log("retry failed", r.id, e2.message); } }
      if (okSent) { sent.reminders++; await recordPush(db, r.chat_id, await line.memberCount(r.chat_id)); } else sent.failed++;
    }
  }

  try { if (await gasConf(env)) { const f = await runFlows(env, db, now); if (f.length) sent.flows = f; } } catch (e) { console.log("flows failed", e.message); }

  try { await checkQuota(env, db, line, now); } catch (e) { console.log("quota failed", e.message); }

  // 補做以前沒存成的每日摘要（10/28 前 Haiku 的回答被思考用光、摘要都是空的）：每次補 2 天，補到 29 天前
  const bf = Number(await kv.get(db, "digest:backfill") ?? 1);
  if (bf <= 29) {
    await kv.set(db, "digest:backfill", bf + 2);
    for (const k of [bf, bf + 1]) if (k <= 29) await buildDigests(env, db, now - (k - 1) * 864e5).catch(e => console.log("digest backfill", e.message));
  }

  const today = ymd(now);
  try { if (await monthlyReport(env, db, gas)) sent.report = true; } catch (e) { console.log("report failed", e.message); }
  // 保存期限：群組訊息與對話紀錄 30 天、處理過的事件 7 天
  if (tp_hour(now) === 3 && (await kv.get(db, "cleanup:last")) !== today) {
    await kv.set(db, "cleanup:last", today);
    try { await buildDigests(env, db, now); } catch (e) { console.log("digests failed", e.message); }
    await db.prepare("DELETE FROM line_digests WHERE day<?").bind(ymd(now - 365 * 864e5)).run();
    await db.prepare("DELETE FROM line_msgs WHERE ts<?").bind(now - KEEP_DAYS * 864e5).run();
    await db.prepare("DELETE FROM line_history WHERE ts<?").bind(now - KEEP_DAYS * 864e5).run();
    await db.prepare("DELETE FROM line_events WHERE ts<?").bind(now - 7 * 864e5).run();
    await db.prepare("DELETE FROM line_reminders WHERE status!='open' AND created<?").bind(now - 90 * 864e5).run();
    await db.prepare("DELETE FROM line_kv WHERE k LIKE 'ai:%' AND k<?").bind("ai:" + ymd(now - 7 * 864e5)).run();
    await cleanupTranscripts(db, now).catch(e => console.log("tx cleanup", e.message));
  }
  return Response.json({ ok: true, ...sent });
}
const tp_hour = ms => new Date(ms + 8 * 3600e3).getUTCHours();
