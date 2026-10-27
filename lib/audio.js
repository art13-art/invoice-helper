// 錄音轉文字：LINE 的語音訊息或錄音檔 → OpenAI 轉成逐字稿（分辨說話者）→ 存一份到雲端硬碟（Google 文件）＋留 30 天讓小助理之後查。
// 金鑰：Cloudflare Pages 的 OPENAI_API_KEY。費用算進每月預算（line_usage kind='ai'）。
import { kv, rid, ymd, hm, mdw, KEEP_DAYS } from "./assistant.js";
import { monthSpend, budgetUSD } from "./usage.js";
import { gas } from "./books.js";

export const AUDIO_EXT = /\.(m4a|mp3|mp4|wav|webm|mpeg|mpga|aac|ogg|oga|opus|amr|3gp|caf|flac)$/i;
const OK_EXT = /\.(m4a|mp3|mp4|wav|webm|mpeg|mpga)$/i;            // OpenAI 收得了的格式
export const MAX_AUDIO = 25 * 1024 * 1024;                          // OpenAI 單檔上限
const TX_PREFIX = "tx:";

// 每分鐘美元（2026/10 官方價）；分辨說話者的模型 OpenAI 預計 2027/2/26 停用，停用後自動改用一般轉錄
const MODELS = {
  "gpt-4o-transcribe-diarize": { perMin: 0.006, format: "diarized_json", speakers: true },
  "gpt-transcribe": { perMin: 0.0045, format: "json", speakers: false },
};

export const isAudioName = name => AUDIO_EXT.test(name || "");
const adminErr = msg => Object.assign(new Error(msg), { admin: true });   // 要管理員處理的錯誤
const extFor = type => /mpeg|mp3/.test(type) ? "mp3" : /wav/.test(type) ? "wav" : /webm/.test(type) ? "webm" : /mp4|m4a|aac/.test(type) ? "m4a" : "m4a";

/* 送 OpenAI 轉文字。回傳 { text, seconds, model, speakers } */
export async function transcribe(env, bytes, type, name, opts = {}) {
  if (!env.OPENAI_API_KEY) throw adminErr("錄音轉文字還沒設定好：Cloudflare 缺 OPENAI_API_KEY。");
  if (bytes.length > MAX_AUDIO) throw new Error("錄音檔太大（超過 25MB，大約一小時）。請分成兩段再傳，或用較低音質錄。");
  let fname = name && AUDIO_EXT.test(name) ? name : "錄音." + extFor(type || "");
  if (!OK_EXT.test(fname)) throw new Error("這個錄音格式我轉不了，請轉成 m4a、mp3 或 wav 再傳。");
  const first = env.TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize";
  const order = [first, ...Object.keys(MODELS).filter(m => m !== first)];
  let lastErr;
  for (const model of order) {
    const spec = MODELS[model] || MODELS["gpt-transcribe"];
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: type || "audio/mp4" }), fname);
    form.append("model", model);
    form.append("response_format", spec.format);
    if (spec.speakers) form.append("chunking_strategy", "auto");
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 280e3);
    let r, j;
    try {
      r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: "Bearer " + env.OPENAI_API_KEY }, body: form, signal: ctl.signal });
      j = await r.json().catch(() => ({}));
    } catch (e) { throw new Error(e.name === "AbortError" ? "錄音太長，轉文字超過時間了。請分段再傳。" : "轉文字服務連不上，等一下再試。"); }
    finally { clearTimeout(timer); }
    if (r.ok) return format(j, model, spec, opts.durationMs);
    const msg = j.error?.message || "";
    console.log("transcribe failed", model, r.status, msg);
    lastErr = r.status === 401 ? adminErr("OpenAI 金鑰不對（401），錄音轉文字不能用。") : r.status === 429 ? adminErr("OpenAI 額度用完或太忙（429），請看一下帳戶餘額。") : new Error("轉文字失敗（" + r.status + "），等一下再試。");
    // 模型停用或不認得：換下一個；其他錯誤直接回報
    if (!(r.status === 404 || (r.status === 400 && /model|deprecat|does not exist|not found|response_format|chunking/i.test(msg)))) throw lastErr;
  }
  throw lastErr;
}

function format(j, model, spec, durationMs) {
  const segs = Array.isArray(j.segments) ? j.segments : [];
  const end = segs.reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  const seconds = Number(j.usage?.seconds) || Number(j.duration) || end || (durationMs ? durationMs / 1000 : 0);
  if (!spec.speakers || !segs.some(s => s.speaker != null)) return { text: String(j.text || "").trim(), seconds, model, speakers: false };
  // 說話者標籤依出現順序改成 A、B、C…；同一人連續說的話併成一段
  const label = {}, lines = [];
  for (const s of segs) {
    const t = String(s.text || "").trim(); if (!t) continue;
    const k = s.speaker == null ? "?" : String(s.speaker);
    if (!(k in label)) label[k] = k === "?" ? "（不確定）" : "說話者 " + String.fromCharCode(65 + Object.values(label).filter(v => v !== "（不確定）").length);
    const last = lines[lines.length - 1];
    if (last && last.who === label[k]) last.text += t;
    else lines.push({ who: label[k], at: Number(s.start) || 0, text: t });
  }
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return { text: lines.map(l => `[${mmss(l.at)}] ${l.who}：${l.text}`).join("\n"), seconds, model, speakers: true };
}

/* 這個月預算用完就不轉（OpenAI 費用也算在每月預算裡） */
export async function budgetLeft(env, db) { return (await monthSpend(db)) < budgetUSD(env); }

export async function recordTranscribe(db, { chatId, userId, model, seconds }) {
  const usd = (Math.max(seconds, 1) / 60) * (MODELS[model]?.perMin ?? 0.006);
  await db.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,user_id,model,usd) VALUES(?,?,'ai',?,?,?,?)")
    .bind(Date.now(), ymd().slice(0, 7), chatId, userId || null, model, usd).run();
  return usd;
}

/* 存逐字稿：雲端硬碟一份 Google 文件（Apps Script saveTranscript），小助理這邊留 30 天 */
export async function saveTranscript(env, db, { chatId, chatName, userId, userName, t, src }) {
  const now = Date.now(), id = rid(6);
  const title = `會議逐字稿 ${ymd(now)} ${hm(now).replace(":", "")}${chatName ? "｜" + chatName : ""}`;
  const head = [`時間：${mdw(now)} ${hm(now)}`, `來源：${chatName || "私訊"}（${userName || "某位成員"} 傳的錄音）`, `長度：約 ${Math.max(1, Math.round(t.seconds / 60))} 分鐘`,
    t.speakers ? "說話者 A、B…是系統自動分辨的不同人，不是真名；可能有誤。" : "（這份沒有分辨說話者）", ""].join("\n");
  let doc = null, docErr = null;
  try { doc = await gas(env, "saveTranscript", title, head + "\n" + t.text); }
  catch (e) { docErr = /unknown function/.test(e.message) ? "雲端備份還沒設好（Apps Script 要更新）" : "雲端備份沒存成功：" + e.message; console.log("saveTranscript", e.message); }
  const rec = { id, src: src || null, ts: now, chat: chatId, by: userName || null, user: userId || null, minutes: Math.round(t.seconds / 6) / 10, speakers: t.speakers, url: doc?.url || null, title, text: t.text.slice(0, 200000) };
  await kv.set(db, `${TX_PREFIX}${ymd(now)}:${chatId}:${id}`, JSON.stringify(rec));
  return { ...rec, docErr };
}

/* 給小助理工具用：這個聊天室最近的逐字稿（可用關鍵字找） */
export async function findTranscripts(db, chatId, keyword) {
  const { results } = await db.prepare("SELECT v FROM line_kv WHERE k LIKE ? ORDER BY k DESC LIMIT 20").bind(`${TX_PREFIX}%:${chatId}:%`).all();
  let list = results.map(r => { try { return JSON.parse(r.v); } catch (e) { return null; } }).filter(Boolean);
  if (keyword) list = list.filter(x => (x.text + x.title).toLowerCase().includes(String(keyword).toLowerCase()));
  return list;
}

export async function cleanupTranscripts(db, now = Date.now()) {
  await db.prepare("DELETE FROM line_kv WHERE k LIKE 'tx:%' AND k<?").bind(TX_PREFIX + ymd(now - KEEP_DAYS * 864e5)).run();
}
