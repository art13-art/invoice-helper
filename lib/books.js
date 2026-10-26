// 廠商群組記帳：把帳寫進該群組綁定的 Google 試算表（透過管理員自己的 Apps Script，GAS_URL + GAS_KEY）。
// 只有管理員能綁定表格；群組裡每個人都能請助理記帳，但一定要按「確認」才寫入。
import { kv, rid, md, ymd } from "./assistant.js";

/* 連線設定：Cloudflare 變數優先，否則用 Apps Script 自行登記在資料庫的（/api/line/gas-register） */
export async function gasConf(env) {
  if (env.GAS_URL && env.GAS_KEY) return { url: env.GAS_URL, key: env.GAS_KEY };
  const c = env.DB ? await kv.json(env.DB, "gas:conf", null) : null;
  return c && c.url && c.key ? c : null;
}
export async function gas(env, fn, ...args) {
  const c = await gasConf(env);
  if (!c) throw new Error("雲端表格連線還沒設定");
  return gasRaw(c, fn, ...args);
}
export async function gasRaw(c, fn, ...args) {
  const r = await fetch(c.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: c.key, fn, args }), redirect: "follow" });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error("雲端表格回應格式不對（" + r.status + "）"); }
  if (!j.ok) throw new Error(j.error === "unauthorized" ? "雲端表格金鑰不符" : (j.error || "雲端表格失敗"));
  return j.result;
}

export async function getBook(db, chatId) {
  const b = await db.prepare("SELECT * FROM line_books WHERE chat_id=?").bind(chatId).first();
  if (b) b.headers = JSON.parse(b.headers || "[]");
  return b;
}
export async function saveBook(db, chatId, info, userId) {
  await db.prepare("INSERT INTO line_books(chat_id,sheet_id,url,name,tab,headers,created_by,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET sheet_id=excluded.sheet_id,url=excluded.url,name=excluded.name,tab=excluded.tab,headers=excluded.headers")
    .bind(chatId, info.id, info.url, info.name, info.tab, JSON.stringify(info.headers || []), userId, Date.now()).run();
}

/* 管理員：第一個在私訊輸入「/我是管理員」的人；之後由管理員新增 */
export async function admins(db) { return await kv.json(db, "admins", []); }
export async function isAdmin(db, userId) { return (await admins(db)).includes(userId); }

/* ---------- 給 Claude 的工具 ---------- */
export const BOOK_TOOLS = [
  { name: "book_info", description: "這個群組綁定的記帳表：欄位名稱和最近幾筆（了解格式用）。記帳前先看。", input_schema: { type: "object", properties: {} } },
  { name: "propose_rows", description: "準備把 1～20 筆帳寫進記帳表。每筆是「欄位名稱: 值」，欄位名稱要完全照 book_info 的表頭。不會立刻寫入，要有人按「確認」。",
    input_schema: { type: "object", properties: { rows: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: { type: ["string", "number"] } } } }, required: ["rows"] } },
  { name: "query_book", description: "查記帳表裡的帳（最新的在前），可依關鍵字、日期區間篩選；要算合計時自己加總。",
    input_schema: { type: "object", properties: { keyword: { type: "string" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string" }, limit: { type: "integer", maximum: 200 } } } },
  { name: "recent_photos", description: "取得這個群組最近傳的照片（單據、發票、出貨單），用來讀內容記帳。", input_schema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 3 } } } },
];

const money = v => typeof v === "number" ? v.toLocaleString("en-US") : v;
export async function runBookTool(ctx, name, input) {
  const { env, db, chatId, userId, book } = ctx;
  if (!book) return { error: "這個群組還沒綁定記帳表，請管理員 @小助理 說「設定記帳表」" };
  switch (name) {
    case "book_info": {
      const r = await gas(env, "readRows", book.sheet_id, book.tab, { limit: 3 });
      const headers = r.headers.filter(String);
      if (JSON.stringify(headers) !== JSON.stringify(book.headers)) { book.headers = headers; await db.prepare("UPDATE line_books SET headers=? WHERE chat_id=?").bind(JSON.stringify(headers), chatId).run(); }
      return { sheet: book.name, tab: book.tab, headers, recent: r.rows, today: ymd(),
        auto_filled: "記錄人、原始訊息、記錄時間這類欄位系統會自動填，不用寫" };
    }
    case "propose_rows": {
      const allowed = new Set(book.headers);
      const rows = (input.rows || []).slice(0, 20).map(r => Object.fromEntries(Object.entries(r || {}).filter(([k, v]) => k && v !== "" && v != null).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 300) : v])));
      if (!rows.length || rows.every(r => !Object.keys(r).length)) return { error: "沒有內容" };
      const unknown = [...new Set(rows.flatMap(r => Object.keys(r)).filter(k => !allowed.has(k)))];
      const summary = rows.map((r, i) => (rows.length > 1 ? `${i + 1}. ` : "・") + Object.entries(r).map(([k, v]) => `${k}：${money(v)}`).join("｜")).join("\n");
      const id = rid(10);
      await db.prepare("UPDATE line_pending SET status='expired' WHERE chat_id=? AND user_id=? AND status='open'").bind(chatId, userId).run();
      await db.prepare("INSERT INTO line_pending(id,chat_id,user_id,kind,payload,summary,created,status) VALUES(?,?,?,?,?,?,?,'open')")
        .bind(id, chatId, userId, "rows", JSON.stringify({ rows, raw: ctx.rawText || "" }), summary, Date.now()).run();
      ctx.pending = { id, summary, label: rows.length > 1 ? `✓ 確認記 ${rows.length} 筆` : "✓ 確認記帳" };
      return { status: "已列出，等使用者按確認", summary, columns_not_in_sheet: unknown.length ? unknown : undefined };
    }
    case "query_book": return await gas(env, "readRows", book.sheet_id, book.tab, input);
    case "recent_photos": {
      const n = Math.min(Math.max(Number(input.count) || 1, 1), 3);
      const { results } = await db.prepare("SELECT media,name,ts FROM line_msgs WHERE chat_id=? AND media IS NOT NULL AND ts>? ORDER BY (user_id=?) DESC, id DESC LIMIT ?").bind(chatId, Date.now() - 864e5, userId, n).all();
      if (!results.length) return { error: "最近 24 小時沒有照片，請先傳單據照片再叫我" };
      const blocks = [];
      for (const p of results) {
        try { const img = await ctx.line.image(p.media); blocks.push({ type: "text", text: `${p.name} 傳的照片（${md(ymd(p.ts))}）：` }, { type: "image", source: { type: "base64", media_type: img.type, data: img.data } }); }
        catch (e) { blocks.push({ type: "text", text: `${p.name} 的照片已經讀不到（LINE 只保留一段時間）` }); }
      }
      return { __blocks: blocks };
    }
  }
  return { error: "沒有這個工具" };
}

/* 按下確認／取消 */
export async function settlePending(env, db, chatId, userId, id, accept, whoName) {
  const p = await db.prepare("SELECT * FROM line_pending WHERE id=? AND chat_id=?").bind(id, chatId).first();
  if (!p) return "找不到這筆。";
  if (p.status !== "open") return p.status === "done" ? "這筆已經寫入過了。" : p.status === "cancelled" ? "這筆已經取消了。" : "這筆已經過期，請重新叫我記一次。";
  if (p.user_id !== userId && !(await isAdmin(db, userId))) return "只有提出記帳的人或管理員可以確認這筆。";
  if (Date.now() - p.created > 864e5) { await db.prepare("UPDATE line_pending SET status='expired' WHERE id=?").bind(id).run(); return "這筆超過一天沒確認，已過期，請重新叫我記一次。"; }
  const lock = await db.prepare("UPDATE line_pending SET status=? WHERE id=? AND status='open'").bind(accept ? "running" : "cancelled", id).run();
  if ((lock.meta?.changes ?? 1) === 0) return "這筆正在處理中。";
  if (!accept) return "好，已取消，沒有寫入表格。";
  const book = await getBook(db, chatId);
  if (!book) { await db.prepare("UPDATE line_pending SET status='error' WHERE id=?").bind(id).run(); return "這個群組已經沒有綁定記帳表。"; }
  try {
    const { rows, raw } = JSON.parse(p.payload);
    const proposer = (await db.prepare("SELECT name FROM line_members WHERE chat_id=? AND user_id=?").bind(chatId, p.user_id).first())?.name || whoName;
    const r = await gas(env, "appendRows", book.sheet_id, book.tab, rows, { who: proposer + (p.user_id !== userId ? `（${whoName} 確認）` : ""), raw });
    await db.prepare("UPDATE line_pending SET status='done' WHERE id=?").bind(id).run();
    return `✓ 已寫入「${book.name}」${r.added} 筆（第 ${r.firstRow} 列${r.added > 1 ? "起" : ""}）。`;
  } catch (e) {
    await db.prepare("UPDATE line_pending SET status='error' WHERE id=?").bind(id).run();
    return "沒有寫入成功：" + e.message + "\n請打開表格確認是否已經有這筆，再決定要不要重記，避免重複。";
  }
}
