import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8")); try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('gas:conf',?)").run(JSON.stringify({ url: "https://gas.example/exec", key: "k" }));

let calls = [], openaiMode = "ok", gasMode = "ok", audioBytes = 1000, claudeSeen = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  let body = null;
  if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${v.name} ${v.size}>`]));
  else if (init.body) body = JSON.parse(init.body);
  calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { "content-type": "application/json" } });
  if (url.includes("api-data.line.me")) return new Response(new Uint8Array(audioBytes), { status: 200, headers: { "content-type": "audio/x-m4a" } });
  if (url.includes("/member/") || url.includes("/profile/")) return J({ displayName: "Amy" });
  if (url.includes("api.openai.com")) {
    if (openaiMode === "gone" && body.model === "gpt-4o-transcribe-diarize") return J({ error: { message: "The model `gpt-4o-transcribe-diarize` does not exist" } }, 404);
    if (body.model === "gpt-transcribe") return J({ text: "大家好今天討論交期", usage: { type: "duration", seconds: 120 } });
    return J({ text: "x", segments: [{ speaker: "spk_1", text: "大家好，", start: 0, end: 3 }, { speaker: "spk_1", text: "今天談交期。", start: 3, end: 6 }, { speaker: "spk_2", text: "我週五前交報價。", start: 6, end: 600 }], usage: { type: "duration", seconds: 600 } });
  }
  if (url.startsWith("https://gas.example")) return gasMode === "ok" ? J({ ok: true, result: { url: "https://docs.google.com/document/d/DOC1/edit" } }) : J({ ok: false, error: "unknown function" });
  if (url.includes("api.anthropic.com")) { claudeSeen.push(body);
    const last = body.messages.at(-1), wantRemind = /按了「要，設提醒」/.test(JSON.stringify(body.messages));
    if (wantRemind && !JSON.stringify(last).includes("tool_result")) {
      const d = new Date(Date.now() + 8 * 3600e3 + 2 * 864e5).toISOString().slice(0, 10);
      return J({ content: [{ type: "tool_use", id: "tu1", name: "set_reminder", input: { when: d + "T14:30", text: "CP Cafe 會議", target: "here" } }, { type: "tool_use", id: "tu2", name: "set_reminder", input: { when: d + "T09:00", text: "交排班", target: "here" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } });
    }
    return J({ content: [{ type: "text", text: wantRemind ? "設好了兩個提醒。" : "重點：週五交報價。" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }); }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = []; claudeSeen = [];
  await wh.onRequestPost({ request: new Request("https://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); lastMsgs = r ? r.body.messages : []; return r ? r.body.messages.map(m => m.text || "[" + m.type + "]").join("\n") : null; };
let lastMsgs = [];
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const oa = () => calls.filter(c => c.url.includes("openai"));

// 1. 私訊傳語音 → 轉文字（分辨說話者）→ 存雲端 → 整理
let r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "A1", duration: 600000 } });
t(oa().length === 1 && oa()[0].body.model === "gpt-4o-transcribe-diarize" && oa()[0].body.chunking_strategy === "auto" && oa()[0].body.response_format === "diarized_json", "diarize request " + JSON.stringify(oa()[0]?.body));
const seen = JSON.stringify(claudeSeen[0]?.messages?.at(-1));
t(/說話者 A：大家好，今天談交期。/.test(seen) && /說話者 B：我週五前交報價/.test(seen), "speaker labels merged: " + seen.slice(0, 300));
t(/\[10:00\]|\[00:06\]/.test(seen), "timestamps");
t(r && r.includes("重點：週五交報價") && JSON.stringify(lastMsgs).includes("https://docs.google.com/document/d/DOC1/edit"), "reply has summary + doc link: " + r);
const usage = sq.prepare("SELECT model,usd FROM line_usage WHERE model LIKE 'gpt%'").all();
t(usage.length === 1 && Math.abs(usage[0].usd - 0.06) < 1e-9, "cost recorded 10 min = $0.06: " + JSON.stringify(usage));
t(sq.prepare("SELECT count(*) n FROM line_kv WHERE k LIKE 'tx:%'").get().n === 1, "transcript kept");
const gasCall = calls.find(c => c.url.startsWith("https://gas.example"));
t(gasCall && gasCall.body.fn === "saveTranscript" && /長度：約 10 分鐘/.test(gasCall.body.args[1]), "gas saveTranscript called");

// 2. 群組：語音只記錄、不回、不轉
const G = { type: "group", groupId: "Cg1", userId: "U_amy" };
r = await send({ type: "message", source: G, message: { type: "audio", id: "A2", duration: 125000 } });
t(r === null && oa().length === 0, "group audio silent");
t(sq.prepare("SELECT text FROM line_msgs WHERE media='audio:A2'").get()?.text === "［傳了錄音，約 2 分鐘］", "group audio recorded");
// 群組說「整理剛剛的錄音」→ 轉
r = await send({ type: "message", source: G, message: { type: "text", id: "T1", text: "@小幫手 整理剛剛的錄音", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(oa().length === 1 && JSON.stringify(lastMsgs).includes("DOC1"), "group transcribe on request: " + r);
// 再問一次 → 用存好的，不再花錢
r = await send({ type: "message", source: G, message: { type: "text", id: "T2", text: "@小幫手 再整理一次錄音重點", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(oa().length === 0 && JSON.stringify(lastMsgs).includes("DOC1"), "reuse transcript, no second charge");
// 回覆錄音只 @ 不說話 → 也會整理
sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES('Cg1','U_bob','Bob','［傳了錄音］',?,'audio:A3')").run(Date.now());
r = await send({ type: "message", source: G, message: { type: "text", id: "T3", text: "@小幫手", quotedMessageId: "A3", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
t(oa().length === 1 && /請整理這段錄音/.test(JSON.stringify(claudeSeen[0])), "quote + bare @ transcribes");

// 3. 分辨說話者的模型停用 → 自動改一般轉錄；Apps Script 還沒更新 → 提示
openaiMode = "gone"; gasMode = "old";
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "file", id: "F1", fileName: "會議.m4a" } });
t(oa().length === 2 && oa()[1].body.model === "gpt-transcribe" && !("chunking_strategy" in oa()[1].body), "fallback to gpt-transcribe");
t(r && /Apps Script 要更新/.test(r) && /重點/.test(r), "old GAS message: " + r);
openaiMode = "ok"; gasMode = "ok";

// 4. 太大 / 不支援格式 / 沒金鑰 / 預算用完
audioBytes = 26 * 1024 * 1024;
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "A9" } });
t(/太大/.test(r) && oa().length === 0, "too big: " + r);
audioBytes = 1000;
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "file", id: "F2", fileName: "x.amr" } });
t(/格式/.test(r), "bad format: " + r);
delete env.OPENAI_API_KEY;
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "A10" } });
t(/暫時不能用/.test(r), "no key: " + r);
env.OPENAI_API_KEY = "o";
sq.prepare("INSERT INTO line_usage(ts,month,kind,usd) VALUES(?,?,'ai',200)").run(Date.now(), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7));
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "A11" } });
t(/上限/.test(r) && oa().length === 0, "budget stop: " + r);

// 6. 卡片與按鈕
sq.prepare("DELETE FROM line_usage").run();
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "B1", duration: 60000 } });
const card = lastMsgs.at(-1);
t(card?.type === "flex" && JSON.stringify(card).includes("2. 逐字稿") && JSON.stringify(card).includes("3. 是否需要提醒"), "card attached");
t(JSON.stringify(card).includes("https://docs.google.com/document/d/DOC1/edit") && !r.replace("[flex]", "").includes("DOC1"), "link only in card, not in text");
const yes = card.contents.footer.contents[0].action.data, no = card.contents.footer.contents[1].action.data;
t(/^txr:yes:\w+$/.test(yes) && /^txr:no:\w+$/.test(no), "button data " + yes);
t(/1\. 重點/.test(JSON.stringify(claudeSeen[0])) && /不要寫「2\. 逐字稿」/.test(JSON.stringify(claudeSeen[0])), "summary prompt format");
const pb = data => send({ type: "postback", source: { type: "user", userId: "U_amy" }, postback: { data } });
const openRem = () => sq.prepare("SELECT count(*) n FROM line_reminders WHERE status='open' AND todo_id IS NULL").get().n;
const before = openRem();
r = await pb(yes);
t(/設好了兩個提醒/.test(r) && openRem() === before + 2, "yes → AI sets reminders: " + r);
r = await pb(yes); t(/已經設好了/.test(r) && claudeSeen.length === 0, "yes twice blocked");
r = await pb(no); t(/取消了/.test(r) && /CP Cafe 會議/.test(r) && openRem() === before, "yes → no cancels them: " + r);
r = await pb(no); t(/已經是不設提醒/.test(r), "no twice");
r = await pb(yes); t(/設好了/.test(r) && openRem() === before + 2, "no → yes sets again: " + r);
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "B2", duration: 60000 } });
const no2 = lastMsgs.at(-1).contents.footer.contents[1].action.data, yes2 = lastMsgs.at(-1).contents.footer.contents[0].action.data;
r = await pb(no2); t(r === "好，不設提醒。" && claudeSeen.length === 0, "no → no AI");
r = await pb(yes2); t(/設好了/.test(r), "no first, then yes works: " + r);
gasMode = "old";
r = await send({ type: "message", source: { type: "user", userId: "U_amy" }, message: { type: "audio", id: "B3", duration: 60000 } });
t(/Apps Script 要更新/.test(r) && JSON.stringify(lastMsgs.at(-1)).includes("留在小幫手"), "no-doc card variant");
gasMode = "ok";
// 卡片欄位長度
const labels = JSON.stringify(card).match(/"label":"[^"]*"/g); t(labels.every(l => l.length - 10 <= 20), "labels ≤20");

// 5. 小助理工具 read_transcript
const { runToolForTest } = await import(R + "/lib/assistant.js").then(m => ({ runToolForTest: m.runTool })).catch(() => ({}));
if (runToolForTest) { const x = await runToolForTest({ env, db, chatId: "Cg1", userId: "U_amy" }, "read_transcript", {}); t(x.text && /說話者/.test(x.text), "read_transcript tool"); }
else console.log("(runTool not exported; skipped tool test)");
console.log(`${ok} passed, ${bad} failed`);
