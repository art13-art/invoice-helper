// POST /api/line/tick — 定時（約每 1 分鐘）呼叫：送出到期提醒，並清掉過期紀錄。
// 不需要金鑰：重複呼叫也只會送出已到期且尚未送出的提醒（先標記再送，不會重複）。
import { lineClient, mentionMessage, textMessage, say } from "../../../lib/line.js";
import { recordPush, monthlyReport, checkQuota } from "../../../lib/usage.js";
import { gas, gasConf } from "../../../lib/books.js";
import { runFlows } from "../../../lib/orders.js";
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
    const late = now - r.due > 30 * 60e3 ? `（原訂 ${md(ymd(r.due))} ${hm(r.due)}）` : "";
    const who = r.mention_id && isGroup(r.chat_id) ? "{who} " : "";
    const text = `⏰ ${who}${r.text.replace(/^待辦到期：/, "")}${late}` + (next ? `\n（下次 ${md(ymd(next))} ${hm(next)}）` : "");
    try { await line.push(r.chat_id, [mentionMessage(text, r.mention_id)]); sent.reminders++; await recordPush(db, r.chat_id, await line.memberCount(r.chat_id)); }
    catch (e) { sent.failed++; console.log("reminder push failed", r.id, e.message); }
  }

  try { if (await gasConf(env)) { const f = await runFlows(env, db, now); if (f.length) sent.flows = f; } } catch (e) { console.log("flows failed", e.message); }

  try { await checkQuota(env, db, line, now); } catch (e) { console.log("quota failed", e.message); }

  const today = ymd(now);
  try { if (await monthlyReport(env, db, gas)) sent.report = true; } catch (e) { console.log("report failed", e.message); }
  // 保存期限：群組訊息與對話紀錄 30 天、處理過的事件 7 天
  if (tp_hour(now) === 3 && (await kv.get(db, "cleanup:last")) !== today) {
    await kv.set(db, "cleanup:last", today);
    await db.prepare("DELETE FROM line_msgs WHERE ts<?").bind(now - KEEP_DAYS * 864e5).run();
    await db.prepare("DELETE FROM line_history WHERE ts<?").bind(now - KEEP_DAYS * 864e5).run();
    await db.prepare("DELETE FROM line_events WHERE ts<?").bind(now - 7 * 864e5).run();
    await db.prepare("DELETE FROM line_reminders WHERE status!='open' AND created<?").bind(now - 90 * 864e5).run();
    await db.prepare("DELETE FROM line_kv WHERE k LIKE 'ai:%' AND k<?").bind("ai:" + ymd(now - 7 * 864e5)).run();
  }
  return Response.json({ ok: true, ...sent });
}
const tp_hour = ms => new Date(ms + 8 * 3600e3).getUTCHours();
