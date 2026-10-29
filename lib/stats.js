// 網站流量與意見回饋的共用小工具（不用 Cookie、不存 IP）。
import { sha256 } from "./auth.js";
export const tpDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse|facebookexternalhit|embedly|whatsapp|telegram/i;
export const isBot = ua => !ua || BOT.test(ua);
/* 當天的訪客代號：IP＋瀏覽器＋日期＋鹽的雜湊，隔天就對不起來，無法追蹤個人 */
export async function visitorHash(request, env, day) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  return (await sha256(`${env.TRACK_SALT || "taxtools"}|${day}|${ip}|${ua}`)).slice(0, 20);
}
export function cleanPath(p) {
  p = String(p || "/").split(/[?#]/)[0].slice(0, 120);
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/index\.html$/, "").replace(/\/{2,}/g, "/");
}
export function refHost(ref, ownHost) {
  try {
    const h = new URL(ref).hostname.replace(/^www\.|^m\.|^l\.|^lm\./, "");
    if (!h || h === ownHost.replace(/^www\./, "") || h.endsWith("pages.dev")) return null;
    if (/(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(h)) return "chatgpt";
    if (/(^|\.)perplexity\.ai$/.test(h)) return "perplexity";
    if (/(^|\.)gemini\.google\.com$/.test(h)) return "gemini";
    if (/(^|\.)claude\.ai$/.test(h)) return "claude";
    if (/(^|\.)copilot\.microsoft\.com$/.test(h)) return "copilot";
    if (/(^|\.)google\./.test(h)) return "google";
    if (/(^|\.)bing\.com$/.test(h)) return "bing";
    if (/(^|\.)yahoo\./.test(h)) return "yahoo";
    if (/(^|\.)facebook\.com$|fb\.com$/.test(h)) return "facebook";
    if (/(^|\.)line\.me$|line\.naver/.test(h)) return "line";
    if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
    if (/(^|\.)threads\.(net|com)$/.test(h)) return "threads";
    if (/(^|\.)ptt\.cc$/.test(h)) return "ptt";
    if (/(^|\.)dcard\.tw$/.test(h)) return "dcard";
    return h.slice(0, 60);
  } catch (e) { return null; }
}
