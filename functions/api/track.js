// POST /api/track → 匿名統計（每日彙總，不存 IP、不用 Cookie）
//   瀏覽：{ p: 路徑, r: 從哪個網站來, u: { s: utm_source, c: utm_campaign } | null }
//   轉換事件：{ e: 事件名稱, s: 這次造訪的廣告來源 }
import { tpDay, isBot, visitorHash, cleanPath, refHost } from "../../lib/stats.js";
const tag = v => String(v || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
export async function onRequestPost({ request, env }) {
  const ua = request.headers.get("user-agent") || "";
  if (isBot(ua) || !env.DB) return new Response(null, { status: 204 });
  let b = {}; try { b = JSON.parse(await request.text()); } catch (e) {}
  const db = env.DB, day = tpDay(), host = new URL(request.url).hostname;
  const up = (t, k, v) => db.prepare(`INSERT INTO ${t} (day, ${k}, n) VALUES (?, ?, 1) ON CONFLICT(day, ${k}) DO UPDATE SET n = n + 1`).bind(day, v);

  if (b.e) {
    const ev = tag(b.e);
    if (ev) try {
      await db.prepare("INSERT INTO stat_events (day, ev, src, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, ev, src) DO UPDATE SET n = n + 1")
        .bind(day, ev, tag(b.s) || "direct").run();
    } catch (e) { console.log("track event", e.message); }
    return new Response(null, { status: 204 });
  }

  const path = cleanPath(b.p);
  if (/^\/(admin|api)\b/.test(path)) return new Response(null, { status: 204 });
  const ref = b.r ? refHost(b.r, host) : null;
  const dev = /Mobi|Android|iPhone|iPod/i.test(ua) ? "手機" : /iPad|Tablet/i.test(ua) ? "平板" : "電腦";
  const h = await visitorHash(request, env, day);
  const batch = [up("stat_views", "path", path), up("stat_devs", "dev", dev), db.prepare("INSERT OR IGNORE INTO stat_visitors (day, h) VALUES (?, ?)").bind(day, h)];
  if (ref) batch.push(up("stat_refs", "ref", ref));
  const src = tag(b.u && b.u.s);
  if (src) batch.push(db.prepare("INSERT INTO stat_utm (day, src, camp, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, src, camp) DO UPDATE SET n = n + 1")
    .bind(day, src, String(b.u.c || "").replace(/[<>"']/g, "").slice(0, 60)));
  if (Math.random() < 0.01) batch.push(db.prepare("DELETE FROM stat_visitors WHERE day < ?").bind(tpDay(Date.now() - 90 * 864e5)));
  try { await db.batch(batch); } catch (e) { console.log("track", e.message); }
  return new Response(null, { status: 204 });
}
