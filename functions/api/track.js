// POST /api/track { p: 路徑, r: 從哪個網站來 } → 記一次瀏覽（每日彙總，不存 IP、不用 Cookie）。
import { tpDay, isBot, visitorHash, cleanPath, refHost } from "../../lib/stats.js";
export async function onRequestPost({ request, env }) {
  const ua = request.headers.get("user-agent") || "";
  if (isBot(ua) || !env.DB) return new Response(null, { status: 204 });
  let b = {}; try { b = JSON.parse(await request.text()); } catch (e) {}
  const path = cleanPath(b.p);
  if (/^\/(admin|api)\b/.test(path)) return new Response(null, { status: 204 });
  const db = env.DB, day = tpDay(), host = new URL(request.url).hostname;
  const ref = b.r ? refHost(b.r, host) : null;
  const dev = /Mobi|Android|iPhone|iPod/i.test(ua) ? "手機" : /iPad|Tablet/i.test(ua) ? "平板" : "電腦";
  const h = await visitorHash(request, env, day);
  const up = (t, k, v) => db.prepare(`INSERT INTO ${t} (day, ${k}, n) VALUES (?, ?, 1) ON CONFLICT(day, ${k}) DO UPDATE SET n = n + 1`).bind(day, v);
  const batch = [up("stat_views", "path", path), up("stat_devs", "dev", dev), db.prepare("INSERT OR IGNORE INTO stat_visitors (day, h) VALUES (?, ?)").bind(day, h)];
  if (ref) batch.push(up("stat_refs", "ref", ref));
  if (Math.random() < 0.01) batch.push(db.prepare("DELETE FROM stat_visitors WHERE day < ?").bind(tpDay(Date.now() - 90 * 864e5)));
  try { await db.batch(batch); } catch (e) { console.log("track", e.message); }
  return new Response(null, { status: 204 });
}
