import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('admins',?)").run(JSON.stringify(["U_ben"]));
sq.prepare("INSERT INTO line_kv VALUES('gas:conf',?)").run(JSON.stringify({ url: "https://gas.example/exec", key: "k" }));
let calls = [], claudeSeen = [], gasFns = { saveDoc: true, createLog: true }, toolPlan = null;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  if (/\/member\/|\/profile\//.test(url)) return J({ displayName: url.includes("U_ben") ? "Ben" : "Amy" });
  if (url.includes("/count")) return J({ count: 3 });
  if (url.startsWith("https://gas.example")) {
    if (gasFns[body.fn] === false) return J({ ok: false, error: "unknown function" });
    if (body.fn === "createLog" || body.fn === "createBook") return J({ ok: true, result: { id: "S", url: "https://sheet", name: body.fn === "createLog" ? "紀錄表｜廣告" : "廠商帳｜廣告", tab: "紀錄", headers: body.args[1] || ["日期", "品項"] } });
    return J({ ok: true, result: { url: "https://docs.google.com/document/d/" + body.fn } });
  }
  if (url.includes("api.anthropic.com")) {
    claudeSeen.push(body);
    if (toolPlan && !JSON.stringify(body.messages.at(-1)).includes("tool_result")) { const p = toolPlan; toolPlan = null; return J({ content: [{ type: "tool_use", id: "x", name: p.name, input: p.input }], stop_reason: "tool_use", usage: {} }); }
    const txt = JSON.stringify(body.messages.at(-1)).includes("document/d/") ? "報告做好了：\nhttps://docs.google.com/document/d/saveDoc/edit\n\n重點：A 品牌預算最高。" : "好。";
    return J({ content: [{ type: "text", text: txt }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0, lastMsgs = [];
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = []; claudeSeen = [];
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); lastMsgs = r ? r.body.messages : []; return lastMsgs.map(m => m.text || "").join("\n"); };
const say = (u, text, at = true) => send({ type: "message", source: { type: "group", groupId: "Cad", userId: u }, message: { type: "text", id: "m" + n, text: (at ? "@小幫手 " : "") + text, ...(at ? { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } : {}) } });
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const tool = (b, name) => b.tools.find(x => x.name === name);

// 一般問題：精簡、搜 3 次、讀網址 3 次
await say("U_amy", "這個標題好嗎");
let b = claudeSeen[0];
t(b.max_tokens === 6000 && tool(b, "web_search").max_uses === 8 && tool(b, "web_fetch")?.type === "web_fetch_20250910" && b.model === "claude-sonnet-5-5", "normal " + JSON.stringify([b.max_tokens, tool(b, "web_search")?.max_uses, b.model]));
t(!b.system[0].text.includes("這次對方要詳細的內容"), "no deep text");
t(b.system[0].text.includes("site:transparency.meta.com") && b.system[0].text.includes("系統用程式算好的數字"), "policy + stats rules");
t(b.tools.some(x => x.name === "save_report"), "save_report tool offered");
// 背景對話提到「詳細分析」不算
await say("U_tom", "我覺得要詳細分析一下競品", false);
await say("U_amy", "好喔");
b = claudeSeen[0]; t(!b.system[0].text.includes("這次對方要詳細的內容") && b.max_tokens === 6000, "background doesn't trigger deep");
// 詳細分析：放寬長度、搜 8 次，但不換 Opus
await say("U_amy", "幫我詳細分析這三家競品的廣告策略");
b = claudeSeen[0];
t(b.max_tokens === 8000 && tool(b, "web_search").max_uses === 8 && tool(b, "web_fetch").max_uses === 5 && b.model === "claude-sonnet-5-5", "deep " + JSON.stringify([b.max_tokens, tool(b, "web_search").max_uses, b.model]));
t(b.system[0].text.includes("這次對方要詳細的內容"), "deep text");
// 仔細想 → Opus（群組也可以）
await say("U_amy", "這個預算分配你仔細想一下");
t(claudeSeen[0].model === "claude-opus-5-5", "opus in group");
// 查競品 → 搜 8 次但不放寬長度
await say("U_amy", "查一下競品最近在打什麼");
b = claudeSeen[0]; t(tool(b, "web_search").max_uses === 8 && b.system[0].text.includes("問題本身需要詳細調查或分析"), "semantic depth rule present");
// save_report → saveDoc；Apps Script 舊版 → 退回 saveTranscript
toolPlan = { name: "save_report", input: { title: "競品分析", content: "# 競品\n- A\n| 品牌 | 預算 |\n|---|---|\n| A | 10 |" } };
await say("U_amy", "做成報告");
let g = calls.filter(c => c.url.startsWith("https://gas.example")).map(c => c.body.fn);
t(g.includes("saveDoc") && /document\/d\/saveDoc/.test(JSON.stringify(claudeSeen.at(-1))), "saveDoc used " + g);
t(calls.find(c => c.body?.fn === "saveDoc").body.args[2] === "報告", "into 報告 folder");
{ const txt = lastMsgs.map(m => m.text || "").join("\n"), cardDoc = lastMsgs.find(m => m.type === "flex");
  t(!/https:/.test(txt) && /報告做好了\n\n重點：A 品牌預算最高/.test(txt), "url stripped from text: " + JSON.stringify(txt));
  t(cardDoc && JSON.stringify(cardDoc).includes("開啟文件") && JSON.stringify(cardDoc).includes("document/d/saveDoc"), "doc card");
  t(!(lastMsgs[0].quickReply?.items || []).some(i => i.action.text === "/詳細分析"), "no 詳細分析 chip after report");
  t(calls.find(c => c.body?.fn === "saveDoc").body.args[1] === "# 競品\n- A\n| 品牌 | 預算 |\n|---|---|\n| A | 10 |", "content cleaned"); }
gasFns.saveDoc = false; toolPlan = { name: "save_report", input: { title: "x", content: "y" } };
await say("U_amy", "做成報告");
g = calls.filter(c => c.url.startsWith("https://gas.example")).map(c => c.body.fn);
t(g.join() === "saveDoc,saveTranscript", "fallback " + g);
// 紀錄表
await say("U_ben", "設定紀錄表");
let r = lastMsgs.map(m => m.text).join("");
t(/已建立紀錄表/.test(r) && calls.some(c => c.body?.fn === "createLog" && c.body.args[1].includes("假設／內容")), "createLog " + r.slice(0, 60));
t(sq.prepare("SELECT v FROM line_kv WHERE k='booktype:Cad'").get()?.v === "log", "booktype log");
await say("U_amy", "記一筆測試結果");
t(claudeSeen[0].system[0].text.includes("這個群組綁定了紀錄表") && !claudeSeen[0].system[0].text.includes("有人請你記帳時"), "log wording in prompt");
sq.prepare("DELETE FROM line_books").run(); gasFns.createLog = false;
await say("U_ben", "設定紀錄表");
r = lastMsgs.map(m => m.text).join("");
t(/Apps Script 還沒更新/.test(r) && calls.some(c => c.body?.fn === "createBook"), "createLog fallback");
await say("U_amy", "再一題");
const hist = JSON.stringify(claudeSeen[0].messages.slice(0, -1));
t(/［\d{1,2}\/\d{1,2} \d{2}:\d{2}］Amy：/.test(hist), "history user lines carry their time " + hist.slice(0, 120));
t(claudeSeen[0].system[0].text.includes("不要拿現在的時間去比") && claudeSeen[0].system[0].text.includes("不要主動翻舊對話"), "scope + time rules");
console.log(`${ok} passed, ${bad} failed`);
