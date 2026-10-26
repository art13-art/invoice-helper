// POST /api/line/gas-register — 管理員自己的 Apps Script 執行 register() 時，把網頁應用程式網址與金鑰登記進來。
// 只接受第一次登記（之後要換，需先在資料庫刪除 gas:conf）；登記前會回呼確認對方真的持有金鑰。
import { kv } from "../../../lib/assistant.js";
import { gasRaw } from "../../../lib/books.js";

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (env.GAS_URL && env.GAS_KEY) return Response.json({ ok: false, error: "already configured by env" }, { status: 409 });
  if (await kv.get(db, "gas:conf")) return Response.json({ ok: false, error: "already registered" }, { status: 409 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const url = String(b.url || ""), key = String(b.key || "");
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/.test(url) || !/^[0-9a-f]{40,}$/.test(key))
    return Response.json({ ok: false, error: "bad url or key" }, { status: 400 });
  try {
    const p = await gasRaw({ url, key }, "ping");
    if (!p || p.pong !== true) throw new Error("no pong");
  } catch (e) { return Response.json({ ok: false, error: "verify failed: " + e.message }, { status: 400 }); }
  await kv.set(db, "gas:conf", JSON.stringify({ url, key, at: Date.now() }));
  return Response.json({ ok: true });
}
