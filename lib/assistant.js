// 個人 LINE 助理：Claude 負責理解與回答，工具負責查帳、記帳（需確認）、提醒、報稅期限、統編查詢。
// 帳本讀寫透過使用者自己的 Apps Script API（GAS_API_URL + GAS_API_KEY），與記帳 APP 走同一套程式。

export const ENTITIES = ["個人", "都是藝術", "玖陸好運", "福田森林"];
const PAYMENTS = ["現金", "銀行轉帳", "信用卡", "行動支付", "電子支付", "其他"];
const ROLE_NAMES = { company: "公司・行號", person: "上班族・接案", landlord: "房東・屋主", car: "有車" };
const HOUR = 3600e3, DAY = 24 * HOUR;

/* ---------- 台北時間 ---------- */
export const tp = (ms = Date.now()) => new Date(ms + 8 * HOUR);              // 用 getUTC* 讀台北時間
export const ymd = (ms = Date.now()) => tp(ms).toISOString().slice(0, 10);
export const hm = ms => tp(ms).toISOString().slice(11, 16);
const WEEK = "日一二三四五六";
export const md = s => { const [, m, d] = s.split("-").map(Number); return `${m}/${d}`; };
export const mdw = ms => { const t = tp(ms); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEK[t.getUTCDay()]}）`; };
/* "2026-10-27T14:00"（台北）→ epoch ms */
export function parseLocal(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 9), +(m[5] || 0)) - 8 * HOUR;
}
export const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/* ---------- 資料表 ---------- */
export const kv = {
  get: async (db, k) => (await db.prepare("SELECT v FROM line_kv WHERE k=?").bind(k).first())?.v ?? null,
  set: (db, k, v) => db.prepare("INSERT INTO line_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(),
};

/* ---------- Apps Script 帳本 API ---------- */
export async function gas(env, fn, ...args) {
  if (!env.GAS_API_URL || !env.GAS_API_KEY) throw new Error("帳本 API 尚未設定");
  const r = await fetch(env.GAS_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env.GAS_API_KEY, fn, args }), redirect: "follow" });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error("帳本 API 回應格式不對（" + r.status + "）"); }
  if (!j.ok) throw new Error(j.error === "unauthorized" ? "帳本 API 金鑰不符" : (j.error || "帳本 API 失敗"));
  return j.result;
}

/* ---------- 報稅期限 ---------- */
async function deadlines(env, origin, days = 30, roles = ["company", "person"]) {
  const res = await env.ASSETS.fetch(new URL("/assets/deadlines.json", origin));
  const data = await res.json();
  const today = ymd(), until = ymd(Date.now() + days * DAY);
  return data.items.filter(it => it.due >= today && it.due <= until && it.roles.some(r => roles.includes(r)))
    .map(it => ({ due: it.due, title: it.title, start: it.start, note: it.desc, link: it.link ? origin + it.link : null, who: it.roles.map(r => ROLE_NAMES[r]).join("、") }));
}

/* ---------- 工具定義 ---------- */
const entryProps = {
  entity: { type: "string", enum: ENTITIES, description: "記帳主體" },
  flow: { type: "string", enum: ["支出", "收入"] },
  amount: { type: "number", description: "金額（新台幣，正數）" },
  text: { type: "string", description: "交易內容，簡短，例如「午餐」「客戶課程收入」" },
  category: { type: "string", description: "類別；請用 list_categories 裡有的名稱，不確定就省略讓帳本自動判斷" },
  payment: { type: "string", enum: PAYMENTS, description: "支付或收款方式，不知道就省略" },
  account: { type: "string", description: "銀行或卡片名稱，例如「玉山卡」，不知道就省略" },
  notes: { type: "string", description: "備註，選填" },
  date: { type: "string", description: "交易日期 YYYY-MM-DD；今天就省略" },
};
export const TOOLS = [
  { name: "propose_entries", description: "準備新增 1～10 筆帳。不會立刻寫入，會請使用者按「確認」後才記帳。主體或收支不明時先問使用者，不要猜。",
    input_schema: { type: "object", properties: { entries: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: entryProps, required: ["entity", "flow", "amount", "text"] } } }, required: ["entries"] } },
  { name: "propose_void", description: "準備作廢一筆帳（例如重複記帳）。需要先用 find_entries 找到記帳 ID。使用者按確認後才作廢，原始資料會保留，可在記帳 APP 恢復。",
    input_schema: { type: "object", properties: { entry_id: { type: "string" }, description: { type: "string", description: "給使用者看的這筆帳摘要" } }, required: ["entry_id", "description"] } },
  { name: "find_entries", description: "查帳：依主體、日期區間、關鍵字、收支、類別找帳目，最新的在前。",
    input_schema: { type: "object", properties: { entity: { type: "string", enum: ENTITIES }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" },
      keyword: { type: "string" }, flow: { type: "string", enum: ["支出", "收入"] }, category: { type: "string" }, status: { type: "string", enum: ["待確認", "已確認"] }, limit: { type: "integer", maximum: 50 } } } },
  { name: "month_summary", description: "某個月份的收支合計與主要支出類別（可指定主體）。",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" }, entity: { type: "string", enum: ENTITIES } }, required: ["month"] } },
  { name: "list_categories", description: "列出帳本目前可用的類別。", input_schema: { type: "object", properties: {} } },
  { name: "list_subscriptions", description: "列出每月訂閱／固定扣款設定。", input_schema: { type: "object", properties: { entity: { type: "string", enum: ENTITIES } } } },
  { name: "tax_deadlines", description: "台灣報稅與繳費期限（營業稅、扣繳、勞健保、綜所稅、房屋稅、牌照稅等）。",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "未來幾天內，預設 30", maximum: 400 },
      roles: { type: "array", items: { type: "string", enum: Object.keys(ROLE_NAMES) }, description: "company=公司行號 person=上班族接案 landlord=房東 car=有車；預設 company,person" } } } },
  { name: "company_lookup", description: "查台灣公司或行號登記資料（經濟部商工登記）。給統一編號或公司名稱關鍵字。",
    input_schema: { type: "object", properties: { ubn: { type: "string", description: "8 碼統一編號" }, keyword: { type: "string" } } } },
  { name: "set_reminder", description: "設定提醒，時間到了用 LINE 通知使用者。",
    input_schema: { type: "object", properties: { when: { type: "string", description: "台北時間 YYYY-MM-DDTHH:mm" }, text: { type: "string", description: "提醒內容" },
      repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"], description: "重複，預設 none" } }, required: ["when", "text"] } },
  { name: "list_reminders", description: "列出還沒到的提醒。", input_schema: { type: "object", properties: {} } },
  { name: "cancel_reminder", description: "取消一個提醒（用 list_reminders 的 id）。", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "daily_brief_settings", description: "設定每日早報：開關、時間、要看的報稅身分。",
    input_schema: { type: "object", properties: { on: { type: "boolean" }, time: { type: "string", description: "HH:mm，台北時間" },
      roles: { type: "array", items: { type: "string", enum: Object.keys(ROLE_NAMES) } } } } },
];

function systemPrompt(origin) {
  const now = Date.now();
  return `你是使用者在 LINE 上的私人助理，幫忙記帳、查帳、提醒和回答問題，特別熟悉台灣的稅務、勞健保與公司行政。
現在是台北時間 ${ymd(now)}（星期${WEEK[tp(now).getUTCDay()]}）${hm(now)}。
使用者的記帳主體：${ENTITIES.join("、")}（「個人」是自己，其他是公司或工作室）。

做事原則：
- 需要資料時用工具查，不要憑空編造金額或帳目。
- 新增或作廢帳目只能用 propose_ 工具，系統會讓使用者按「確認」；在使用者確認前不要說「已記帳」，要說「請按確認」。
- 主體、收支或金額不明確時，先簡短問一句再記。日期說「昨天」「上週五」要換算成實際日期。
- 傳來照片時，如果是發票或收據，讀出店家、日期、金額、品項，用 propose_entries 準備記帳；看不清楚就請使用者補充。
- 提醒時間沒講幾點時，預設早上 9 點並告訴使用者。
- 回答稅務、勞健保、法規問題要依台灣現行規定，提醒「試算僅供參考，以主管機關核定為準」；適合的話附上本站工具連結：
  綜所稅 ${origin}/income-tax/ 、勞健保 ${origin}/labor-health/ 、房東報稅 ${origin}/landlord-tax/ 、營業稅 ${origin}/vat/ 、報稅行事曆 ${origin}/tax-calendar/ 、統編查詢 ${origin}/company-lookup/ 。
- 不確定的事要說不確定，不要硬答。

回覆格式（LINE 不支援 Markdown）：
- 用繁體中文、口語、簡短；手機一眼看得完為主，通常 2～8 行。
- 不要用 #、**、表格、程式碼區塊。條列用「・」，金額加千分位，例如 12,800 元。`;
}

/* ---------- 工具執行 ---------- */
export async function runTool(ctx, name, input) {
  const { env, db, userId, origin } = ctx;
  switch (name) {
    case "propose_entries": {
      const entries = (input.entries || []).slice(0, 10).map(e => ({ ...e, amount: Math.round(Number(e.amount) * 100) / 100 }));
      for (const e of entries) {
        if (!ENTITIES.includes(e.entity)) return { error: "主體不在清單內：" + e.entity };
        if (!["支出", "收入"].includes(e.flow)) return { error: "收支只能是支出或收入" };
        if (!(e.amount > 0)) return { error: "金額要大於 0" };
        if (e.payment && !PAYMENTS.includes(e.payment)) delete e.payment;
        if (e.date && (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.date === ymd())) delete e.date;
        if (e.date && e.date > ymd()) return { error: "日期不能是未來：" + e.date };
      }
      const summary = entries.map(e => `・${e.date ? md(e.date) + " " : ""}${e.entity}｜${e.flow} ${e.amount.toLocaleString("en-US")} 元｜${e.text}${e.category ? "｜" + e.category : ""}${e.payment ? "｜" + e.payment : ""}${e.account ? " " + e.account : ""}`).join("\n");
      const id = rid();
      await db.prepare("UPDATE line_pending SET status='expired' WHERE user_id=? AND status='open'").bind(userId).run();
      await db.prepare("INSERT INTO line_pending(id,user_id,kind,payload,summary,created,status) VALUES(?,?,?,?,?,?,'open')")
        .bind(id, userId, "entries", JSON.stringify(entries), summary, Date.now()).run();
      ctx.pending = { id, label: entries.length > 1 ? `✓ 確認記 ${entries.length} 筆` : "✓ 確認記帳" };
      return { status: "等待使用者按確認", summary };
    }
    case "propose_void": {
      const id = rid();
      await db.prepare("UPDATE line_pending SET status='expired' WHERE user_id=? AND status='open'").bind(userId).run();
      await db.prepare("INSERT INTO line_pending(id,user_id,kind,payload,summary,created,status) VALUES(?,?,?,?,?,?,'open')")
        .bind(id, userId, "void", JSON.stringify({ id: input.entry_id }), "・作廢：" + input.description, Date.now()).run();
      ctx.pending = { id, label: "✓ 確認作廢" };
      return { status: "等待使用者按確認" };
    }
    case "find_entries": return await gas(env, "findEntries", input);
    case "month_summary": return await gas(env, "monthSummary", input);
    case "list_categories": return await gas(env, "categories");
    case "list_subscriptions": return await gas(env, "subscriptions", input.entity || null);
    case "tax_deadlines": return await deadlines(env, origin, Math.min(Number(input.days) || 30, 400), input.roles?.length ? input.roles : ["company", "person"]);
    case "company_lookup": {
      const q = input.ubn ? "ubn=" + encodeURIComponent(String(input.ubn).replace(/\D/g, "")) : "q=" + encodeURIComponent(input.keyword || "");
      const r = await fetch(`${origin}/api/company?${q}`);
      return await r.json();
    }
    case "set_reminder": {
      const due = parseLocal(input.when);
      if (!isFinite(due)) return { error: "時間格式要是 YYYY-MM-DDTHH:mm" };
      if (due < Date.now() - 60e3) return { error: "這個時間已經過了" };
      const repeat = ["daily", "weekdays", "weekly", "monthly"].includes(input.repeat) ? input.repeat : "none";
      const id = rid().slice(0, 6);
      await db.prepare("INSERT INTO line_reminders(id,user_id,due,text,repeat,created,status) VALUES(?,?,?,?,?,?,'open')")
        .bind(id, userId, due, String(input.text).slice(0, 300), repeat, Date.now()).run();
      return { ok: true, id, when: `${mdw(due)} ${hm(due)}`, repeat };
    }
    case "list_reminders": {
      const { results } = await db.prepare("SELECT id,due,text,repeat FROM line_reminders WHERE user_id=? AND status='open' ORDER BY due LIMIT 30").bind(userId).all();
      return results.map(r => ({ id: r.id, when: `${mdw(r.due)} ${hm(r.due)}`, text: r.text, repeat: r.repeat }));
    }
    case "cancel_reminder": {
      const r = await db.prepare("UPDATE line_reminders SET status='cancelled' WHERE id=? AND user_id=? AND status='open'").bind(input.id, userId).run();
      return { ok: (r.meta?.changes ?? 1) > 0 };
    }
    case "daily_brief_settings": {
      if (typeof input.on === "boolean") await kv.set(db, "brief:on", input.on ? "1" : "0");
      if (/^\d{2}:\d{2}$/.test(input.time || "")) await kv.set(db, "brief:time", input.time);
      if (input.roles?.length) await kv.set(db, "brief:roles", input.roles.filter(r => ROLE_NAMES[r]).join(","));
      return await briefSettings(db);
    }
  }
  return { error: "沒有這個工具" };
}

export async function briefSettings(db) {
  return { on: (await kv.get(db, "brief:on")) !== "0", time: (await kv.get(db, "brief:time")) || "08:00",
    roles: ((await kv.get(db, "brief:roles")) || "company,person").split(",") };
}

/* ---------- Claude 對話 ---------- */
async function claude(env, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("Claude " + r.status + " " + (j.error?.message || "")); e.status = r.status; throw e; }
  return j;
}

/* userContent: Claude content blocks for this turn. Returns { text, pending }. */
export async function chat(ctx, userContent, logText) {
  const { env, db, userId, origin } = ctx;
  const since = Date.now() - 2 * DAY;
  const { results } = await db.prepare("SELECT role,text FROM line_history WHERE user_id=? AND ts>? ORDER BY id DESC LIMIT 16").bind(userId, since).all();
  const messages = [];
  for (const h of results.reverse()) {
    const role = h.role === "user" ? "user" : "assistant";
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += "\n" + h.text;
    else messages.push({ role, content: h.text });
  }
  if (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length && messages[messages.length - 1].role === "user") messages.push({ role: "assistant", content: "（好的）" });
  messages.push({ role: "user", content: userContent });

  const tools = TOOLS.map((t, i) => i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t);
  const system = [{ type: "text", text: systemPrompt(origin), cache_control: { type: "ephemeral" } }];
  const model = env.CLAUDE_MODEL || "claude-haiku-5-5";
  let text = "";
  for (let round = 0; round < 6; round++) {
    const res = await claude(env, { model, max_tokens: 1200, system, tools, messages });
    const blocks = res.content || [];
    text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (res.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: blocks });
    const results = [];
    for (const b of blocks.filter(b => b.type === "tool_use")) {
      let out;
      try { out = await runTool(ctx, b.name, b.input || {}); } catch (e) { out = { error: e.message }; }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: "user", content: results });
  }
  text = cleanText(text) || (ctx.pending ? "請確認下面的內容：" : "我沒有聽懂，可以換個說法嗎？");
  if (ctx.pending) {
    const p = await db.prepare("SELECT summary FROM line_pending WHERE id=?").bind(ctx.pending.id).first();
    if (p && !text.includes(p.summary.split("\n")[0].slice(0, 12))) text += "\n\n" + p.summary;
  }
  await db.prepare("INSERT INTO line_history(user_id,role,text,ts) VALUES(?,?,?,?)").bind(userId, "user", logText.slice(0, 2000), Date.now()).run();
  await db.prepare("INSERT INTO line_history(user_id,role,text,ts) VALUES(?,?,?,?)").bind(userId, "assistant", text.slice(0, 2000), Date.now()).run();
  await db.prepare("DELETE FROM line_history WHERE user_id=? AND id NOT IN (SELECT id FROM line_history WHERE user_id=? ORDER BY id DESC LIMIT 40)").bind(userId, userId).run();
  return { text, pending: ctx.pending || null };
}

/* LINE 不顯示 Markdown：拿掉常見符號 */
export function cleanText(t) {
  return String(t || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "・")
    .replace(/`{1,3}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- 按下確認 ---------- */
export async function confirmPending(ctx, id, accept) {
  const { env, db, userId } = ctx;
  const p = await db.prepare("SELECT * FROM line_pending WHERE id=? AND user_id=?").bind(id, userId).first();
  if (!p) return "找不到這個動作。";
  if (p.status !== "open") return p.status === "done" ? "這筆已經處理過了。" : p.status === "cancelled" ? "這筆已經取消了。" : "這個確認已經過期，請重新跟我說一次。";
  if (Date.now() - p.created > DAY) { await db.prepare("UPDATE line_pending SET status='expired' WHERE id=?").bind(id).run(); return "這個確認已經超過一天，請重新跟我說一次。"; }
  // 先標記，避免重複按造成重複記帳
  const lock = await db.prepare("UPDATE line_pending SET status=? WHERE id=? AND status='open'").bind(accept ? "running" : "cancelled", id).run();
  if ((lock.meta?.changes ?? 1) === 0) return "這筆已經在處理了。";
  if (!accept) return "好，已取消，沒有寫入帳本。";
  let msg;
  try {
    if (p.kind === "entries") {
      const lines = [];
      for (const e of JSON.parse(p.payload)) {
        const r = await gas(env, "addEntry", e);
        if (!r || !r.ok) { lines.push(`✕ ${e.text} ${e.amount.toLocaleString("en-US")} 元：${r?.message || "失敗"}`); continue; }
        lines.push(`✓ ${r.entity}｜${r.flow} ${Number(r.amount).toLocaleString("en-US")} 元｜${r.category}${r.date ? "｜" + md(r.date) : ""}` + (r.status === "待確認" ? `\n　⚠ ${r.confirmReason}（可在記帳 APP 補上）` : ""));
      }
      msg = "已記帳：\n" + lines.join("\n");
    } else if (p.kind === "void") {
      const r = await gas(env, "voidEntry", JSON.parse(p.payload).id);
      msg = r?.ok ? "✓ 已作廢。原始資料有保留，需要時可在記帳 APP 恢復。" : "作廢沒有完成：" + (r?.message || "請到記帳 APP 檢查");
    }
    await db.prepare("UPDATE line_pending SET status='done' WHERE id=?").bind(id).run();
  } catch (e) {
    await db.prepare("UPDATE line_pending SET status='error' WHERE id=?").bind(id).run();
    msg = "沒有完成：" + e.message + "\n請到記帳 APP 確認這筆是否已寫入，再決定要不要重試，避免重複記帳。";
  }
  await db.prepare("INSERT INTO line_history(user_id,role,text,ts) VALUES(?,?,?,?)").bind(userId, "assistant", msg, Date.now()).run();
  return msg;
}

/* ---------- 每日早報（不用 AI，固定格式） ---------- */
export async function composeBrief(env, db, userId, origin) {
  const s = await briefSettings(db);
  const now = Date.now();
  const parts = [`早安！${mdw(now)}今日重點`];
  try {
    const ds = await deadlines(env, origin, 7, s.roles);
    parts.push("📅 報稅期限（7 天內）\n" + (ds.length ? ds.slice(0, 6).map(d => `・${md(d.due)} ${d.title}`).join("\n") : "・沒有"));
  } catch (e) { parts.push("📅 報稅期限：讀取失敗"); }
  try {
    const c = await gas(env, "pendingCounts");
    const list = Object.entries(c || {}).filter(([, n]) => n > 0);
    parts.push("📝 待確認的帳：" + (list.length ? list.map(([k, n]) => `${k} ${n} 筆`).join("、") : "沒有，很棒"));
  } catch (e) { parts.push("📝 待確認的帳：帳本暫時讀不到"); }
  try {
    const subs = await gas(env, "upcomingSubscriptions", 3);
    if (subs?.length) parts.push("💳 近 3 天訂閱扣款\n" + subs.map(x => `・${md(x.date)} ${x.name} ${Number(x.amount).toLocaleString("en-US")} 元（${x.entity}）`).join("\n"));
  } catch (e) { /* 沒有訂閱資料就略過 */ }
  const end = parseLocal(ymd(now) + "T23:59");
  const { results } = await db.prepare("SELECT due,text FROM line_reminders WHERE user_id=? AND status='open' AND due<=? ORDER BY due").bind(userId, end).all();
  if (results.length) parts.push("⏰ 今天的提醒\n" + results.map(r => `・${hm(r.due)} ${r.text}`).join("\n"));
  parts.push("有事直接跟我說就好。");
  return parts.join("\n\n");
}

/* 下一次重複提醒的時間 */
export function nextDue(due, repeat) {
  const t = tp(due);
  if (repeat === "daily") return due + DAY;
  if (repeat === "weekly") return due + 7 * DAY;
  if (repeat === "weekdays") { let n = due + DAY; while ([0, 6].includes(tp(n).getUTCDay())) n += DAY; return n; }
  if (repeat === "monthly") {
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d, last), t.getUTCHours(), t.getUTCMinutes()) - 8 * HOUR;
  }
  return null;
}

export const HELP = `我是你的記帳小助理，直接用說的就可以：
・記帳：「午餐 180 玉山卡」「昨天幫玖陸好運買碳粉 2,350」
・拍發票或收據照片給我，我幫你整理成帳
・查帳：「這個月個人花多少」「上週的待確認」
・提醒：「明天下午 3 點提醒我回電給王會計」「每月 5 號提醒我繳房租」
・稅務問題：「月薪 4 萬勞健保自付多少」「11 月有什麼要報的」
・查公司：「查統編 22099131」

記帳和作廢都會先給你看，按「確認」才寫入。
每天早上 8 點會傳今日重點，可以說「早報改 7 點半」或「關掉早報」。`;
