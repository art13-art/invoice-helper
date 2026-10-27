// 群組裡有人沒 @小幫手 但說了自己要做的事（「我明天交報價」「週五前我寄給客戶」）：
// 先用規則篩（不花錢），像的才問 Haiku 確認，確定是承諾就私訊那個人「要加成待辦嗎？」（按鈕）。
// 私訊不到（沒加好友）就在群組裡用回覆權杖問（免費）。同一個人同一個群組 2 小時最多問一次。
import { claude, kv, rid, ymd, hm, mdw, parseLocal, scheduleTodo, isGroup } from "./assistant.js";
import { recordAI, recordPush } from "./usage.js";
import { commitCard, mentionMessage } from "./line.js";

const ME = /我|我們|我這邊|本人|小弟|小妹/;
const WHEN = /今天|今晚|明天|明早|後天|下週|下周|下禮拜|這週|這周|週[一二三四五六日末]|周[一二三四五六日末]|禮拜[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*(點|:\d\d)|晚點|待會|等等|等一下|稍後|月底|月初|中午|下午|晚上|之前|以前|前給|前交/;
const DO = /交|給|寄|傳|回覆|回你|回他|回客戶|處理|做好|做完|弄好|完成|整理|準備|確認|提供|上傳|發|送|改好|補|報價|聯絡|打給|約|排|跟進/;
const NOT = /[?？]$|嗎[?？]?$|誰|請.{0,6}(幫|你|妳|您)|^(你|妳|您)|可以.{0,4}嗎|要不要|能不能|是不是|如果|要是|的話/;

/* 只看規則：像不像「我（們）＋時間＋要做的事」 */
export function looksLikeCommit(text) {
  const t = String(text || "").trim();
  if (t.length < 4 || t.length > 120 || /^https?:/.test(t)) return false;
  return ME.test(t) && WHEN.test(t) && DO.test(t) && !NOT.test(t);
}

/* 規則像的才問 Haiku（約 US$0.001／次）：回 { task, due } 或 null */
async function classify(env, db, { chatId, userId, name, text }) {
  const now = Date.now();
  const res = await claude(env, { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 200,
    system: `判斷 LINE 工作群組裡這句話是不是說話者本人承諾「自己」要在某個時間前完成一件具體的工作（交東西、寄、回覆、處理…）。
現在是台北時間 ${ymd(now)} ${hm(now)}。
只回 JSON，不要其他字：
是承諾：{"commit":true,"task":"短短一句待辦（動詞開頭，例如「交報價單給王總」）","due":"YYYY-MM-DDTHH:mm"}
不是：{"commit":false}
規則：問句、要求別人做、已經做完、閒聊、玩笑、假設語氣、沒有具體的事 → false。只說日期沒說幾點，due 用那天 18:00；「今天」沒說幾點用今天 18:00（已經過了就 23:00）；「晚點」「等等」用 3 小時後。`,
    messages: [{ role: "user", content: `${name}：${text}` }] });
  if (res.usage) await recordAI(env, db, { chatId, userId, model: env.BG_MODEL || "claude-haiku-5-5", usage: res.usage }).catch(() => {});
  const raw = (res.content || []).map(b => b.text || "").join("");
  let j; try { j = JSON.parse((raw.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (e) { return null; }
  if (!j.commit || !j.task) return null;
  const due = parseLocal(j.due);
  return { task: String(j.task).slice(0, 100), due: Number.isFinite(due) && due > now - 3600e3 ? due : null };
}

/* webhook 每則沒叫小幫手的群組文字訊息都會進來；replyToken 留給「私訊不到」時在群組問 */
export async function watchCommit(env, db, line, { chatId, userId, name, text, replyToken, chatName }) {
  if (!isGroup(chatId) || !userId || !env.ANTHROPIC_API_KEY || env.COMMIT_WATCH === "off") return null;
  if (!looksLikeCommit(text)) return null;
  // 廠商群組（自動訂單流程通知的群組）不問，廠商的回覆另外有流程在判斷
  if ((await kv.json(db, "flows", [])).some(f => f.notify === chatId)) return null;
  const k = `cm:last:${chatId}:${userId}`;
  if (Number(await kv.get(db, k)) > Date.now() - 2 * 3600e3) return null;
  const c = await classify(env, db, { chatId, userId, name, text }).catch(e => { console.log("commit classify", e.message); return null; });
  if (!c) return null;
  // 已經有很像的待辦就不問
  const { results } = await db.prepare("SELECT task FROM line_todos WHERE chat_id=? AND status='open' AND (assignee_id=? OR assignee_id IS NULL)").bind(chatId, userId).all();
  const key = c.task.replace(/[給交寄傳回覆完成做好處理]/g, "").slice(0, 4);
  if (key.length >= 2 && results.some(r => r.task.includes(key))) return null;
  await kv.set(db, k, String(Date.now()));
  const id = rid(8);
  await db.prepare("INSERT INTO line_pending(id,chat_id,user_id,kind,payload,summary,created,status) VALUES(?,?,?,'commit',?,?,?,'open')")
    .bind(id, chatId, userId, JSON.stringify({ task: c.task, due: c.due, name }), c.task, Date.now()).run();
  const card = commitCard(id, { task: c.task, due: c.due ? `${mdw(c.due)} ${hm(c.due)}` : null, where: chatName, quote: text });
  try { await line.push(userId, [card]); await recordPush(db, userId, 1); return { id, how: "dm" }; }
  catch (e) {
    // 沒加好友、或封鎖了：在群組裡回覆那句話（免費），只 @ 他本人
    console.log("commit dm failed", e.message);
    if (!replyToken) return { id, how: "none" };
    await line.reply(replyToken, [mentionMessage("{who} 這件要幫你記成待辦嗎？", userId), card]).catch(e2 => console.log("commit reply failed", e2.message));
    return { id, how: "group" };
  }
}

/* 按了「加入待辦／不用」：只有本人能按 */
export async function settleCommit(db, { id, userId, yes }) {
  const p = await db.prepare("SELECT * FROM line_pending WHERE id=? AND kind='commit'").bind(id).first();
  if (!p) return "找不到這筆，可能已經過期了。";
  if (p.user_id !== userId) return "這是要問本人的，請他自己按。";
  if (p.status !== "open") return p.status === "done" ? "已經加過了。" : "好，這件不記。";
  const lock = await db.prepare("UPDATE line_pending SET status=? WHERE id=? AND status='open'").bind(yes ? "done" : "cancelled", id).run();
  if ((lock.meta?.changes ?? 1) === 0) return "這筆正在處理中。";
  if (!yes) return "好，不記。";
  const pl = JSON.parse(p.payload || "{}"), tid = rid(4), now = Date.now();
  await db.prepare("INSERT INTO line_todos(id,chat_id,task,assignee_id,assignee_name,due,status,created,created_by) VALUES(?,?,?,?,?,?,'open',?,?)")
    .bind(tid, p.chat_id, pl.task, userId, pl.name || null, pl.due || null, now, userId).run();
  await scheduleTodo(db, { todoId: tid, chatId: p.chat_id, task: pl.task, due: pl.due, aid: userId, aname: pl.name, by: userId });
  const gname = (await kv.get(db, "name:" + p.chat_id)) || "群組";
  return `✓ 已加到「${gname}」的待辦：${pl.task}${pl.due ? `\n期限 ${mdw(pl.due)} ${hm(pl.due)}，前一天 16:00 和到期時會在群組提醒你。` : ""}`;
}
