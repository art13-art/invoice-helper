// GET /split?t=<群組代碼>[&id=<帳單>] — 拆帳紀錄網頁（只有拿到群組連結的人打得開）
import { kv } from "../../lib/assistant.js";
import { compute, fmt } from "../../lib/split.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tw = ms => { const t = new Date(ms + 8 * 3600e3); return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "", id = u.searchParams.get("id");
  const db = env.DB;
  const chatId = t.length >= 20 ? await kv.get(db, "splittok:" + t) : null;
  if (!chatId) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const group = (await kv.get(db, "name:" + chatId)) || "群組";
  if (id) {
    const r = await db.prepare("SELECT * FROM line_splits WHERE id=? AND chat_id=?").bind(id, chatId).first();
    if (!r) return page("找不到", `<div class="empty">找不到這張帳單。</div>`, 404);
    return page(`${r.status === "done" ? "請款單" : "拆帳中"}｜${group}`, detail(r, t));
  }
  const { results } = await db.prepare("SELECT id,status,data,result,created,done_at FROM line_splits WHERE chat_id=? AND status!='cancelled' ORDER BY created DESC LIMIT 200").bind(chatId).all();
  const sum = results.filter(r => r.status === "done").reduce((a, r) => a + (JSON.parse(r.result || "{}").total || 0), 0);
  const list = results.map(r => {
    const d = JSON.parse(r.data || "{}"), res = r.result ? JSON.parse(r.result) : null;
    return `<a class="bill" href="?t=${esc(t)}&id=${esc(r.id)}">
      <div class="bill-top"><div><div class="store">${esc(d.store || "帳單")}</div><div class="meta">${esc(d.date || tw(r.created))}${d.bill_no ? "｜" + esc(d.bill_no) : ""}</div></div>
      <div class="amt">$${fmt(res ? res.total : d.cash)}</div></div>
      ${res ? `<div class="chips">${res.payers.map(p => `<span class="chip">${esc(p.name)} <b>$${fmt(p.total)}</b></span>`).join("")}</div>` : `<div class="chips"><span class="chip pending">拆帳中</span></div>`}
    </a>`;
  }).join("");
  return page(`拆帳紀錄｜${group}`, `
    <header class="hero"><div class="kicker">拆帳紀錄</div><h1>${esc(group)}</h1>
      <div class="stats"><div><span>${results.filter(r => r.status === "done").length}</span>張帳單</div><div><span>$${fmt(sum)}</span>累計</div></div></header>
    <main>${list || `<div class="empty">還沒有拆過帳。</div>`}</main>`);
}

function detail(r, t) {
  const d = JSON.parse(r.data || "{}"), res = r.result ? JSON.parse(r.result) : (d.guests?.length ? compute(d) : null);
  const nm = id => esc((d.guests || []).find(g => g.id === id)?.name || "未指定");
  const payers = res ? res.payers.map(p => {
    const person = res.people.find(x => x.id === p.id);
    return `<div class="payer"><div class="payer-top"><div class="pname">${esc(p.name)}</div><div class="pamt">$${fmt(p.total)}</div></div>
      <div class="psub">小姐 ${fmt(person.hostess)}｜公費 ${fmt(person.shared)}</div>
      ${p.includes.map(x => `<div class="inc">＋ 含 ${esc(x.name)} $${fmt(x.total)}</div>`).join("")}</div>`;
  }).join("") : "";
  const people = res ? res.people.map(p => `<details><summary><span>${esc(p.name)}${p.sex ? `<em>${esc(p.sex)}</em>` : ""}</span><b>$${fmt(p.total)}</b></summary>
      <ul>${p.items.map(i => `<li><span>${esc(i.name)}</span><span>${fmt(i.amount)}</span></li>`).join("")}</ul></details>`).join("") : "";
  const hostess = (d.hostess || []).map(h => `<tr><td>${esc(h.name)}${h.mark ? `<small>${esc(h.mark)}</small>` : ""}<div class="lines">${h.lines.map(l => esc([l.type, l.time, l.units ? l.units + " 節" : ""].filter(Boolean).join(" "))).join("<br>")}</div></td><td>${h.split ? h.split.map(sg => (h.split.length > 1 ? sg.u + " 節：" : "") + sg.who.map(nm).join("、")).join("<br>") : nm(h.guest)}</td><td class="num">${fmt(h.amount)}</td></tr>`).join("");
  const shared = (d.shared || []).map(s => `<tr><td>${esc(s.name)}${s.qty > 1 ? `<small>${s.qty} × ${fmt(s.price)}</small>` : ""}</td><td>${s.who ? s.who.map(nm).join("、") : "全部平分"}</td><td class="num">${fmt(s.amount)}</td></tr>`).join("");
  const photos = [0, 1, 2, 3].map(n => `<a href="/split/img?t=${esc(t)}&id=${esc(r.id)}&n=${n}" target="_blank" class="ph" data-n="${n}"><img loading="lazy" src="/split/img?t=${esc(t)}&id=${esc(r.id)}&n=${n}" alt="帳單照片" onerror="this.parentNode.remove()"></a>`).join("");
  return `
    <header class="hero"><a class="back" href="?t=${esc(t)}">‹ 所有帳單</a>
      <div class="kicker">${r.status === "done" ? "請款單" : "拆帳中"}</div><h1>${esc(d.store || "帳單")}</h1>
      <div class="meta light">${esc(d.date || tw(r.created))}${d.bill_no ? "｜單號 " + esc(d.bill_no) : ""}</div>
      <div class="total"><span>現金總額</span><b>$${fmt(d.cash)}</b></div>${d.card ? `<div class="meta light">刷卡價格 $${fmt(d.card)}</div>` : ""}${d.payee ? `<div class="payto">請轉給 <b>${esc(d.payee)}</b></div>` : ""}</header>
    <main>
      ${payers ? `<h2>請款</h2><section class="card">${payers}</section>` : ""}
      ${people ? `<h2>每個人的明細</h2><section class="card people">${people}</section>` : ""}
      <h2>小姐代支</h2><section class="card"><table><thead><tr><th>小姐</th><th>客人</th><th class="num">金額</th></tr></thead><tbody>${hostess}</tbody></table></section>
      <h2>公費</h2><section class="card"><table><thead><tr><th>項目</th><th>分攤</th><th class="num">金額</th></tr></thead><tbody>${shared}</tbody></table>
        ${(d.free || []).length ? `<div class="free">招待：${(d.free || []).map(esc).join("、")}</div>` : ""}</section>
      <h2>帳單照片</h2><section class="photos">${photos}</section>
    </main>`;
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{--brand:#12524F;--soft:#EEF2F1;--ink:#1F2937;--sub:#6B7280;--line:#E5E7EB;--bg:#F6F8F7;--card:#FFFFFF;--accent:#F28C28}
@media (prefers-color-scheme:dark){:root{--soft:#1E2B2A;--ink:#E8EEED;--sub:#9AA8A6;--line:#2A3735;--bg:#0F1716;--card:#16201F}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;-webkit-font-smoothing:antialiased}
.hero{background:var(--brand);color:#fff;padding:22px 18px 26px;border-radius:0 0 22px 22px}
.hero h1{margin:2px 0 4px;font-size:24px;letter-spacing:.5px}.payto{margin-top:10px;display:inline-block;background:rgba(242,140,40,.18);color:#FFD9B0;border-radius:999px;padding:5px 12px;font-size:13.5px}.payto b{color:#fff}.kicker{font-size:12px;color:#CFE3E1;letter-spacing:1px}
.back{color:#CFE3E1;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:10px}
.meta{font-size:13px;color:var(--sub)}.meta.light{color:#CFE3E1}
.total{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.18)}
.total span{color:#CFE3E1;font-size:13px}.total b{font-size:30px;font-variant-numeric:tabular-nums}
.stats{display:flex;gap:22px;margin-top:14px;font-size:12px;color:#CFE3E1}.stats span{display:block;font-size:22px;font-weight:700;color:#fff}
main{max-width:640px;margin:0 auto;padding:6px 16px 40px}h2{font-size:13px;color:var(--sub);font-weight:600;margin:22px 4px 8px;letter-spacing:1px}
.card{background:var(--card);border-radius:16px;padding:6px 16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bill{display:block;background:var(--card);border-radius:16px;padding:16px;margin-top:12px;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bill-top{display:flex;justify-content:space-between;gap:12px}.store{font-weight:700;font-size:16px}.amt{font-weight:700;font-size:18px;color:var(--brand);font-variant-numeric:tabular-nums}
@media (prefers-color-scheme:dark){.amt,.pamt{color:#6FC2B9!important}}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{background:var(--soft);border-radius:999px;padding:3px 10px;font-size:12.5px;color:var(--sub)}.chip b{color:var(--ink);font-weight:600}
.chip.pending{background:#FFF4E8;color:#B45309}
.payer{padding:14px 0;border-bottom:1px solid var(--line)}.payer:last-child{border:0}
.payer-top{display:flex;justify-content:space-between;align-items:baseline}.pname{font-weight:700;font-size:17px}.pamt{font-weight:800;font-size:21px;color:var(--brand);font-variant-numeric:tabular-nums}
.psub{font-size:12px;color:var(--sub)}.inc{font-size:13px;color:var(--accent);margin-top:2px}
details{border-bottom:1px solid var(--line)}details:last-child{border:0}summary{display:flex;justify-content:space-between;padding:13px 0;cursor:pointer;list-style:none;font-weight:600}
summary::-webkit-details-marker{display:none}summary em{font-style:normal;font-size:12px;color:var(--sub);margin-left:6px;font-weight:400}
details ul{list-style:none;margin:0 0 12px;padding:0}details li{display:flex;justify-content:space-between;font-size:13.5px;color:var(--sub);padding:3px 0;gap:10px}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:12px;color:var(--sub);font-weight:500;text-align:left;padding:10px 0 6px}
td{padding:10px 8px 10px 0;border-top:1px solid var(--line);vertical-align:top}.num{text-align:right;padding-right:0;font-variant-numeric:tabular-nums;white-space:nowrap}
td small{display:inline-block;margin-left:6px;font-size:11px;color:var(--sub)}.lines{font-size:11.5px;color:var(--sub);margin-top:2px}
.free{font-size:12.5px;color:var(--sub);padding:10px 0;border-top:1px solid var(--line)}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ph img{width:100%;border-radius:12px;display:block;background:var(--soft)}
.empty{text-align:center;color:var(--sub);padding:60px 0}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
