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
let calls = [], seen = [], videoBytes = 2000, previewOk = true;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); let body = null;
  if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${v.name} ${v.type}>`])); else if (init.body) body = JSON.parse(init.body);
  calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  if (url.endsWith("/content/preview")) return previewOk ? new Response(new Uint8Array([255, 216, 255, 1]), { headers: { "content-type": "image/jpeg" } }) : J({}, 404);
  if (url.includes("api-data.line.me")) return new Response(new Uint8Array(videoBytes), { headers: { "content-type": "video/mp4" } });
  if (/\/member\/|\/profile\//.test(url)) return J({ displayName: "Amy" });
  if (url.includes("/count")) return J({ count: 3 });
  if (url.includes("api.openai.com")) return J({ segments: [{ speaker: "a", text: "限時三天，全館八折！", start: 0, end: 15 }], usage: { seconds: 15 } });
  if (url.includes("api.anthropic.com")) { seen.push(body); return J({ content: [{ type: "text", text: "這支影片在宣傳全館八折。" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }); }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = []; seen = [];
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); return r ? r.body.messages.map(m => m.text).join("\n") : null; };
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const oa = () => calls.filter(c => c.url.includes("openai"));
// 私訊傳影片
let r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "video", id: "V1", duration: 15000 } });
const last = seen[0]?.messages.at(-1).content || [];
t(last.some(b => b.type === "image") && last.some(b => b.type === "text" && /說話者 A：限時三天，全館八折！/.test(b.text)), "cover + transcript to Claude");
t(/開頭三秒/.test(JSON.stringify(last)), "video ask");
t(oa()[0]?.body.file.includes("影片.mp4") && oa()[0].body.file.includes("video/mp4"), "mp4 sent " + JSON.stringify(oa()[0]?.body));
t(/八折/.test(r), "reply");
t(sq.prepare("SELECT count(*) n FROM line_usage WHERE model LIKE 'gpt%'").get().n === 1, "cost recorded");
// 群組：只記錄；回覆影片 @ → 處理
const G = { type: "group", groupId: "Cg", userId: "U_amy" };
r = await send({ type: "message", source: G, message: { type: "video", id: "V2", duration: 30000 } });
t(r === null && oa().length === 0 && sq.prepare("SELECT text FROM line_msgs WHERE media='video:V2'").get()?.text === "［傳了影片，約 1 分鐘］", "group video logged only");
r = await send({ type: "message", source: G, message: { type: "text", id: "T", text: "@小幫手", quotedMessageId: "V2", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(oa().length === 1 && /開頭三秒/.test(JSON.stringify(seen[0])), "quote + @ handles video");
r = await send({ type: "message", source: G, message: { type: "text", id: "T2", text: "@小幫手 看一下剛剛的影片開頭", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(oa().length === 1 && seen[0].messages.at(-1).content.some(b => b.type === "image"), "phrase finds latest video");
// 太大：只看封面
videoBytes = 26 * 1024 * 1024;
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "video", id: "V3" } });
t(/超過 25MB/.test(JSON.stringify(seen[0])) && seen[0].messages.at(-1).content.some(b => b.type === "image") && oa().length === 0, "too big → cover only");
console.log(`${ok} passed, ${bad} failed`);
