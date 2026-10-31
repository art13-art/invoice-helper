// AI 與 LINE 用量：每次呼叫 Claude 記下 token 與費用；接近每月預算時通知管理員；每月 1 號產生上個月報表。
import { kv, ymd } from "./assistant.js";
import { lineClient, textMessage } from "./line.js";

// 每百萬 token 的美元價格（Haiku 5.5：單次輸入超過 10 萬 token 時整筆改用較高價格）
const PRICES = {
  "claude-haiku-5-5": [{ upTo: 100000, in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 }, { upTo: Infinity, in: 0.50, out: 2.50, cr: 0.05, cw: 0.625 }],
  "claude-opus-5-5": [{ upTo: Infinity, in: 4.00, out: 20.00, cr: 0.20, cw: 5.00 }],
  "claude-sonnet-5-5": [{ upTo: Infinity, in: 2.00, out: 10.00, cr: 0.10, cw: 2.50 }],
};
export const budgetUSD = env => Number(env.MONTHLY_BUDGET_USD) || 100;
export const rateTWD = env => Number(env.USD_TWD) || 32;
const month = (ms = Date.now()) => ymd(ms).slice(0, 7);

export function cost(model, u = {}) {
  const tiers = PRICES[model] || PRICES["claude-haiku-5-5"];
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const p = tiers.find(t => prompt <= t.upTo);
  const search = (u.server_tool_use?.web_search_requests || 0) * 0.01;   // 網路搜尋每次 US$0.01
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw) / 1e6 + search;
}

export async function recordAI(env, db, { chatId, userId, model, usage }) {
  const usd = cost(model, usage);
  await db.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,user_id,model,input,output,cache_read,cache_write,usd) VALUES(?,?,'ai',?,?,?,?,?,?,?,?)")
    .bind(Date.now(), month(), chatId, userId || null, model, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usd).run();
  return usd;
}
export async function recordPush(db, chatId, recipients) {
  await db.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,recipients,usd) VALUES(?,?,'push',?,?,0)").bind(Date.now(), month(), chatId, recipients || 1).run();
}

export async function monthSpend(db, m = month()) {
  return (await db.prepare("SELECT COALESCE(SUM(usd),0) s FROM line_usage WHERE month=? AND kind='ai'").bind(m).first()).s;
}

export async function notifyAdmins(env, db, text) {
  const admins = await kv.json(db, "admins", []);
  if (!admins.length || !env.LINE_CHANNEL_TOKEN) return 0;
  const line = lineClient(env.LINE_CHANNEL_TOKEN);
  let n = 0;
  for (const a of admins) { try { await line.push(a, [textMessage(text)]); n++; await recordPush(db, a, 1); } catch (e) { console.log("admin push failed", e.message); } }
  return n;
}

/* 本月用到預算 90% 時通知一次 */
export async function checkBudget(env, db) {
  const spent = await monthSpend(db), budget = budgetUSD(env), k = `alert:${month()}`;
  if (spent < budget * 0.9 || (await kv.get(db, k))) return;
  await kv.set(db, k, "1");
  const twd = Math.round(spent * rateTWD(env));
  await notifyAdmins(env, db, `提醒你：這個月 AI 費用已用 US$${spent.toFixed(2)}（約 NT$${twd.toLocaleString("en-US")}），上限 US$${budget}。到上限我會暫停回覆，要繼續用請到 Claude Console 調高。`);
}

/* 拆帳喵開放給所有人：本月 AI 費用到 US$80（MIAO_ALERT_USD）先私訊管理員一次，不用等到 90% */
export async function checkSpendAlert(env, db) {
  const at = Number(env.MIAO_ALERT_USD) || 80, k = `alert80:${month()}`;
  if (!env.MIAO_CHANNEL_TOKEN || (await kv.get(db, k))) return false;
  const spent = await monthSpend(db);
  if (spent < at) return false;
  await kv.set(db, k, "1");
  await notifyAdmins(env, db, `提醒你：這個月 AI 費用已經到 US$${spent.toFixed(2)}（約 NT$${Math.round(spent * rateTWD(env)).toLocaleString("en-US")}），上限 US$${budgetUSD(env)}。拆帳喵開放給大家用，要不要調高上限或限制使用，跟我說。`);
  return true;
}

/* LINE 主動訊息額度用到 80% 時通知一次（每小時檢查） */
export async function checkQuota(env, db, line, now = Date.now()) {
  const hk = "quota:checked", hour = Math.floor(now / 3600e3);
  if (Number(await kv.get(db, hk)) === hour) return null;
  await kv.set(db, hk, String(hour));
  const q = await line.quota();
  if (!q.limit || q.used == null) return q;
  const k = `quota:alert:${month(now)}`;
  if (q.used >= q.limit * 0.8 && !(await kv.get(db, k))) {
    await kv.set(db, k, "1");
    await notifyAdmins(env, db, `提醒你：LINE 主動訊息這個月已用 ${q.used}／${q.limit} 則。用完後提醒和訂單通知會發不出去（@小幫手 的回覆不受影響）。要繼續用可以到 LINE 官方帳號後台升級方案。`);
  }
  return q;
}

/* 上個月的報表 */
export async function buildReport(env, db, m) {
  const ai = await db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(input+cache_read+cache_write),0) tin, COALESCE(SUM(output),0) tout, COALESCE(SUM(usd),0) usd FROM line_usage WHERE month=? AND kind='ai'").bind(m).first();
  const push = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(recipients),0) r FROM line_usage WHERE month=? AND kind='push'").bind(m).first();
  const { results: byChat } = await db.prepare("SELECT chat_id, COUNT(*) calls, SUM(usd) usd FROM line_usage WHERE month=? AND kind='ai' GROUP BY chat_id ORDER BY usd DESC LIMIT 10").bind(m).all();
  const names = {};
  for (const c of byChat) names[c.chat_id] = (await kv.get(db, "name:" + c.chat_id)) || (c.chat_id.startsWith("U") ? "私訊" : "群組");
  const rate = rateTWD(env);
  return {
    month: m, calls: ai.calls, inputTokens: ai.tin, outputTokens: ai.tout, usd: Math.round(ai.usd * 100) / 100, twd: Math.round(ai.usd * rate),
    budget: budgetUSD(env), pushes: push.n, pushRecipients: push.r, rate,
    byChat: byChat.map(c => ({ name: names[c.chat_id], calls: c.calls, usd: Math.round(c.usd * 1000) / 1000 })),
  };
}
export function reportText(r) {
  const [y, mm] = r.month.split("-");
  return `${y} 年 ${Number(mm)} 月開銷報表
・AI 費用：US$${r.usd.toFixed(2)}（約 NT$${r.twd.toLocaleString("en-US")}，預算 US$${r.budget}）
・AI 回覆次數：${r.calls.toLocaleString("en-US")} 次
・使用量：輸入 ${(r.inputTokens / 1e6).toFixed(2)} 百萬、輸出 ${(r.outputTokens / 1e6).toFixed(2)} 百萬 token
・LINE 主動訊息：${r.pushes} 則（約計 ${r.pushRecipients} 則額度，免費方案每月 200 則）` +
    (r.byChat.length ? "\n\n用量最多的聊天室：\n" + r.byChat.slice(0, 5).map(c => `・${c.name}：${c.calls} 次，US$${c.usd.toFixed(2)}`).join("\n") : "") +
    `\n\n（匯率以 1 美元＝${r.rate} 元估算；實際金額以 Claude Console 帳單為準）`;
}

/* 每月 1 號早上 9 點後：上個月報表 → 存起來、傳給管理員、寫進雲端試算表（有設定時） */
export async function monthlyReport(env, db, gasCall) {
  const now = Date.now(), t = new Date(now + 8 * 3600e3);
  if (t.getUTCDate() !== 1 || t.getUTCHours() < 9) return null;
  const prev = month(now - 2 * 864e5);
  if (await db.prepare("SELECT 1 FROM line_reports WHERE month=?").bind(prev).first()) return null;
  const r = await buildReport(env, db, prev);
  await db.prepare("INSERT OR IGNORE INTO line_reports(month,data,created) VALUES(?,?,?)").bind(prev, JSON.stringify(r), now).run();
  let sheet = "";
  if (gasCall) {
    try { const s = await gasCall(env, "appendReport", r); sheet = "\n\n報表也記到雲端試算表：" + s.url; } catch (e) { console.log("report sheet failed", e.message); }
  }
  await notifyAdmins(env, db, reportText(r) + sheet);
  return r;
}
