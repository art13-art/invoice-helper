// 每日重點摘要：每天凌晨把前一天每個群組的對話濃縮成幾行，保存一年，讓小幫手記得 30 天以前的事。
import { claude, ymd, hm } from "./assistant.js";
import { recordAI } from "./usage.js";

export async function buildDigests(env, db, now = Date.now()) {
  if (!env.ANTHROPIC_API_KEY) return 0;
  const day = ymd(now - 864e5);
  const start = Date.parse(day + "T00:00:00+08:00"), end = start + 864e5;
  const { results: chats } = await db.prepare("SELECT chat_id, COUNT(*) n FROM line_msgs WHERE ts>=? AND ts<? AND chat_id LIKE 'C%' GROUP BY chat_id HAVING n>=3").bind(start, end).all();
  let made = 0;
  for (const c of chats) {
    if (await db.prepare("SELECT 1 FROM line_digests WHERE chat_id=? AND day=?").bind(c.chat_id, day).first()) continue;
    const { results } = await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>=? AND ts<? ORDER BY id LIMIT 800").bind(c.chat_id, start, end).all();
    const transcript = results.map(r => `[${hm(r.ts)}] ${r.name || "成員"}：${r.text}`).join("\n").slice(-40000);
    const model = env.BG_MODEL || "claude-haiku-5-5";
    try {
      const res = await claude(env, { model, max_tokens: 600,
        system: "把這個 LINE 工作群組一天的對話整理成重點，之後要拿來查「當時說了什麼」。用繁體中文、條列（・開頭），每點一行，最多 12 點。保留：決定的事、交辦（誰／什麼／期限）、數字（金額、數量、日期）、客戶或廠商名稱、問題和結論。閒聊、打招呼、貼圖略過。整天都是閒聊就只回「（閒聊）」。",
        messages: [{ role: "user", content: `${day} 的對話：\n${transcript}` }] });
      if (res.usage) await recordAI(env, db, { chatId: c.chat_id, model, usage: res.usage }).catch(() => {});
      const text = (res.content || []).map(b => b.text || "").join("").trim().slice(0, 3000);
      if (text) { await db.prepare("INSERT OR IGNORE INTO line_digests(chat_id,day,text,created) VALUES(?,?,?,?)").bind(c.chat_id, day, text, now).run(); made++; }
    } catch (e) { console.log("digest failed", c.chat_id, e.message); }
  }
  return made;
}
