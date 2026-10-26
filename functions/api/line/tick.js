// POST /api/line/tick — Apps Script 每 5 分鐘呼叫一次：送出到期提醒和每日早報。
import { lineClient, textMessage, say } from "../../../lib/line.js";
import { kv, composeBrief, briefSettings, nextDue, ymd, hm, parseLocal } from "../../../lib/assistant.js";

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.GAS_API_KEY || body.key !== env.GAS_API_KEY) return new Response("unauthorized", { status: 401 });
  const db = env.DB, owner = await kv.get(db, "owner");
  if (!owner || !env.LINE_CHANNEL_TOKEN) return Response.json({ ok: true, idle: true });
  const line = lineClient(env.LINE_CHANNEL_TOKEN), origin = new URL(request.url).origin, now = Date.now();
  const sent = { reminders: 0, brief: false };

  const { results } = await db.prepare("SELECT * FROM line_reminders WHERE user_id=? AND status='open' AND due<=? ORDER BY due LIMIT 20").bind(owner, now + 60e3).all();
  for (const r of results) {
    // 先改狀態再送，避免兩次呼叫重疊時重複提醒
    const next = nextDue(r.due, r.repeat);
    const claim = next
      ? await db.prepare("UPDATE line_reminders SET due=? WHERE id=? AND due=? AND status='open'").bind(next, r.id, r.due).run()
      : await db.prepare("UPDATE line_reminders SET status='sent' WHERE id=? AND status='open'").bind(r.id).run();
    if ((claim.meta?.changes ?? 1) === 0) continue;
    const late = now - r.due > 30 * 60e3 ? `（原定 ${hm(r.due)}）` : "";
    await line.push(owner, [textMessage(`⏰ 提醒${late}\n${r.text}` + (next ? `\n\n下次：${ymd(next).slice(5).replace("-", "/")} ${hm(next)}` : ""), [say("我的提醒")])]);
    sent.reminders++;
  }

  const s = await briefSettings(db);
  const today = ymd(now);
  if (s.on && now >= parseLocal(`${today}T${s.time}`) && now < parseLocal(`${today}T${s.time}`) + 3 * 3600e3 && (await kv.get(db, "brief:last")) !== today) {
    await kv.set(db, "brief:last", today);
    await line.push(owner, [textMessage(await composeBrief(env, db, owner, origin), [say("本月支出"), say("待確認的帳"), say("我的提醒")])]);
    sent.brief = true;
  }
  return Response.json({ ok: true, ...sent });
}
