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
let calls = [], seen = [], gasReply = null, toolPlan = null;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  if (/\/member\/|\/profile\//.test(url)) return J({ displayName: url.includes("U_ben") ? "Ben" : "Amy" });
  if (url.includes("/count")) return J({ count: 3 });
  if (url.startsWith("https://gas.example")) return J(gasReply);
  if (url.includes("anthropic")) { seen.push(body);
    if (toolPlan && !JSON.stringify(body.messages.at(-1)).includes("tool_result")) { const p = toolPlan; toolPlan = null; return J({ content: [{ type: "tool_use", id: "x", name: p.name, input: p.input }], stop_reason: "tool_use", usage: {} }); }
    return J({ content: [{ type: "text", text: "好。" }], stop_reason: "end_turn", usage: {} }); }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0;
const say = async (u, text) => { const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e" + n++, replyToken: "rt", source: { type: "group", groupId: "Cg", userId: u }, message: { type: "text", id: "m" + n, text: "@小幫手 " + text, mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } }] });
  calls = []; seen = []; await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env }); };
const toolResult = () => JSON.stringify(seen.at(-1)?.messages.at(-1).content);
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const URL1 = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";

// 文件
gasReply = { ok: true, result: { name: "會議紀錄", kind: "text", text: "10/24 職權劃分：Ben 負責報價" } };
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_amy", "讀這份 " + URL1);
let gc = calls.find(c => c.url.startsWith("https://gas.example"));
t(gc.body.fn === "readFile" && gc.body.args[1] === true, "non-admin → onlyShared " + JSON.stringify(gc.body.args));
t(/Ben 負責報價/.test(toolResult()), "doc text to Claude");
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_ben", "讀這份");
t(calls.find(c => c.url.startsWith("https://gas.example")).body.args[1] === false, "admin → any file");
// 沒開放
gasReply = { ok: false, error: "NOT_SHARED" };
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_amy", "讀");
t(/知道連結的人都能檢視/.test(toolResult()), "not shared message");
gasReply = { ok: false, error: "unknown function" };
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_amy", "讀");
t(/Apps Script 要更新/.test(toolResult()), "old apps script");
// 試算表（廣告報表）
gasReply = { ok: true, result: { name: "10月報表", kind: "sheets", sheets: [{ name: "工作表1", rows: [["行銷活動名稱", "曝光次數", "連結點擊次數", "花費金額", "購買次數"], ["A", "1,000", "50", "500", "5"], ["B", "2,000", "10", "500", "0"]] }] } };
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_amy", "看報表");
t(/系統用程式算好的數字/.test(toolResult()) && /合計：曝光 3,000/.test(toolResult()), "sheet → ad stats");
// 上傳的 PDF／簡報（轉 PDF）
gasReply = { ok: true, result: { name: "簡報.pdf", kind: "blob", mime: "application/pdf", data: Buffer.from("%PDF-1.4 test").toString("base64") } };
toolPlan = { name: "read_google_file", input: { url: URL1 } }; await say("U_amy", "看簡報");
t(/"type":"document"/.test(toolResult()) && /application\/pdf/.test(toolResult()), "blob → document block");
console.log(`${ok} passed, ${bad} failed`);
