// /bo?k=<後台代碼> — 內部後台：所有群組的帳單存檔（一張單一筆）、各店行情、誰的單、CSV 匯出。
// 代碼由 Ben 在私訊說「後台」或「新增後台 名字」取得（kv botok:<代碼>）；用真實姓名，只給內部人員。
import { kv } from "../../lib/assistant.js";
import { fmt, compute } from "../../lib/split.js";
import { facts, dedupe, byStore, durText, sampleCard } from "../../lib/billstats.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tw = ms => { const t = new Date(ms + 8 * 3600e3); return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };
const ym = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 7);
const n = v => (v || v === 0 ? fmt(v) : "–");

export async function staff(db, k) {
  if (!k || k.length < 20) return null;
  try { return JSON.parse((await kv.get(db, "botok:" + k)) || "null"); } catch (e) { return null; }
}
async function load(db) {
  const { results } = await db.prepare("SELECT id,chat_id,status,created,data,result FROM line_splits WHERE status!='cancelled' ORDER BY created DESC LIMIT 3000").all();
  const names = Object.fromEntries((await db.prepare("SELECT k,v FROM line_kv WHERE k LIKE 'name:%'").all()).results.map(r => [r.k.slice(5), r.v]));
  return { rows: results, list: dedupe(results), names };
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), k = u.searchParams.get("k") || "", db = env.DB;
  const who = await staff(db, k);
  if (!who) return page("後台", `<div class="empty">連結不對或已停用。</div>`, 404);
  const v = u.searchParams.get("v") || "list", id = u.searchParams.get("id");
  const { rows, list, names } = await load(db);
  const K = esc(k), nav = `<nav>${[["list", "帳單"], ["stores", "各店行情"], ["owners", "誰的單"]].map(([x, t]) => `<a href="?k=${K}&v=${x}" class="${v === x && !id ? "on" : ""}">${t}</a>`).join("")}<a href="?k=${K}&v=csv">匯出 CSV</a></nav>`;
  const head = (title, sub) => `<header class="hero"><div class="kicker">後台｜${esc(who.name || "內部")}</div><h1>${esc(title)}</h1>${sub || ""}</header>${nav}`;

  if (v === "csv") {
    const cols = ["date", "store", "bill_no", "owner", "pax", "men", "women", "cash", "card", "cardPct", "perPerson", "minutes", "hostessCount", "units", "unitPrice", "outUnits", "outAmount", "room", "table", "tip", "manager", "head", "drink", "food", "ride", "other", "group", "status", "id"];
    const csv = [cols.join(","), ...list.map(f => cols.map(c => { const x = c === "group" ? names[f.chat_id] || "" : f[c]; return /[",\n]/.test(String(x ?? "")) ? `"${String(x).replace(/"/g, '""')}"` : x ?? ""; }).join(","))].join("\n");
    return new Response("﻿" + csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="bills-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
  }

  if (id) {
    const r = rows.find(x => x.id === id);
    if (!r) return page("找不到", head("找不到這張帳單"), 404);
    const d = JSON.parse(r.data || "{}"), res = r.result ? JSON.parse(r.result) : (d.guests?.length ? compute(d) : null), f = facts(r);
    const same = rows.filter(x => x.id !== r.id && facts(x).bill_no && facts(x).bill_no === f.bill_no && facts(x).store === f.store);
    const nm = gid => esc((d.guests || []).find(g => g.id === gid)?.name || "未指定");
    const card = sampleCard(r), sample = [];
    JSON.stringify(card.contents, (key, val) => { if (key === "text") sample.push(val); return val; });
    const facts1 = [["店", f.rawStore || f.store], ["日期", f.date || tw(r.created)], ["單號", f.bill_no], ["人數", f.pax ? `${f.pax}（${f.men} 男 ${f.women} 女）` : "–"], ["時長", durText(f.minutes) || "–"],
      ["現金", "$" + n(f.cash)], ["刷卡", f.card ? `$${n(f.card)}（+${f.cardPct}%）` : "–"], ["每人", "$" + n(f.perPerson)], ["小姐", `${f.hostessCount} 位｜${f.units} 節｜每節約 ${n(f.unitPrice)}`],
      ["出場", f.outUnits ? `${f.outUnits} 節｜$${n(f.outAmount)}` : "–"], ["包廂／桌面／小費／經理檯", [f.room, f.table, f.tip, f.manager].map(n).join("／")], ["酒水", "$" + n(f.drink)], ["群組", names[r.chat_id] || r.chat_id]];
    return page(`${f.store} ${f.date}`, head(`${f.rawStore || f.store}　${f.date || tw(r.created)}`, `<div class="meta light">單號 ${esc(f.bill_no || "–")}</div><div class="total"><span>現金</span><b>$${n(f.cash)}</b></div>`) + `<main>
      <h2>誰的單</h2><form method="post" class="card own"><input type="hidden" name="id" value="${esc(r.id)}"><input name="owner" value="${esc(f.owner)}" placeholder="例如：香閣" maxlength="20"><button>儲存</button></form>
      <h2>欄位</h2><section class="card"><table>${facts1.map(([a, b]) => `<tr><td class="k">${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</table></section>
      ${res ? `<h2>請款（真名）</h2><section class="card"><table>${res.payers.map(p => `<tr><td><b>${esc(p.name)}</b>${p.includes.map(x => `<div class="sub">＋ 含 ${esc(x.name)} $${n(x.total)}</div>`).join("")}</td><td class="num">$${n(p.total)}</td></tr>`).join("")}</table></section>` : ""}
      <h2>小姐</h2><section class="card"><table>${(d.hostess || []).map(h => `<tr><td>${esc(h.name)}<div class="sub">${h.lines.map(l => esc([l.type, l.time, l.units ? l.units + " 節" : ""].filter(Boolean).join(" "))).join("<br>")}</div></td><td>${h.split ? h.split.map(sg => (h.split.length > 1 ? sg.u + " 節：" : "") + sg.who.map(nm).join("、")).join("<br>") : nm(h.guest)}</td><td class="num">${n(h.amount)}</td></tr>`).join("")}</table></section>
      <h2>公費</h2><section class="card"><table>${(d.shared || []).map(s => `<tr><td>${esc(s.name)}${s.qty > 1 ? `<span class="sub"> ${s.qty}×${n(s.price)}</span>` : ""}</td><td>${s.who ? s.who.map(nm).join("、") : "全部平分"}</td><td class="num">${n(s.amount)}</td></tr>`).join("")}</table></section>
      <h2>消費範例卡（客人看到的樣子，假名）</h2><section class="card sample">${sample.map(esc).join("<br>")}</section>
      <h2>帳單照片</h2><section class="photos">${[0, 1, 2, 3].map(i => `<a href="/bo/img?k=${K}&id=${esc(r.id)}&n=${i}" target="_blank"><img loading="lazy" src="/bo/img?k=${K}&id=${esc(r.id)}&n=${i}" alt="帳單照片" onerror="this.parentNode.remove()"></a>`).join("")}</section>
      ${same.length ? `<h2>同一張單的其他紀錄</h2><section class="card">${same.map(x => `<a class="row" href="?k=${K}&id=${esc(x.id)}">${esc(names[x.chat_id] || x.chat_id)}｜${esc(x.status === "done" ? "已結算" : "拆帳中")}｜${tw(x.created)}</a>`).join("")}</section>` : ""}
    </main>`);
  }

  if (v === "stores") {
    const st = byStore(list);
    return page("各店行情", head("各店行情", `<div class="meta light">${list.length} 張帳單｜每節、包廂、桌面都是中位數；少於 5 張的店僅供參考</div>`) + `<main><section class="card wide"><table>
      <thead><tr><th>店</th><th class="num">張數</th><th class="num">平均現金</th><th class="num">每人</th><th class="num">每節</th><th class="num">包廂</th><th class="num">桌面</th><th class="num">刷卡+%</th><th class="num">時長</th><th>最近</th></tr></thead>
      <tbody>${st.map(s => `<tr><td><a href="?k=${K}&v=list&q=${encodeURIComponent(s.store)}">${esc(s.store)}</a>${s.n < 5 ? `<span class="tag">樣本少</span>` : ""}</td><td class="num">${s.n}</td><td class="num">${n(s.cash)}</td><td class="num">${n(s.perPerson)}</td><td class="num">${n(s.unitPrice)}</td><td class="num">${n(s.room)}</td><td class="num">${n(s.table)}</td><td class="num">${s.cardPct || "–"}</td><td class="num">${s.minutes ? Math.round(s.minutes / 6) / 10 + "h" : "–"}</td><td>${esc(s.last)}</td></tr>`).join("")}</tbody></table></section></main>`);
  }

  if (v === "owners") {
    const m = new Map();
    for (const f of list) { const o = f.owner || "（未標）"; if (!m.has(o)) m.set(o, []); m.get(o).push(f); }
    const os = [...m.entries()].map(([o, fs]) => ({ o, n: fs.length, cash: fs.reduce((a, f) => a + f.cash, 0), stores: [...new Set(fs.map(f => f.store))].join("、"), last: fs[0] })).sort((a, b) => (a.o === "（未標）") - (b.o === "（未標）") || b.cash - a.cash);
    return page("誰的單", head("誰的單", `<div class="meta light">在群組回覆帳單說「這是 XX 的單」，或在帳單頁填寫</div>`) + `<main><section class="card wide"><table>
      <thead><tr><th>誰的單</th><th class="num">張數</th><th class="num">合計現金</th><th>店</th><th>最近一張</th></tr></thead>
      <tbody>${os.map(x => `<tr><td><a href="?k=${K}&v=list&q=${encodeURIComponent(x.o === "（未標）" ? "" : x.o)}">${esc(x.o)}</a></td><td class="num">${x.n}</td><td class="num">${n(x.cash)}</td><td>${esc(x.stores)}</td><td><a href="?k=${K}&id=${esc(x.last.id)}">${esc(x.last.store)} ${esc(x.last.date)}</a></td></tr>`).join("")}</tbody></table></section></main>`);
  }

  // 帳單列表：搜尋店名、誰的單、單號、客人名字；月份篩選
  const q = (u.searchParams.get("q") || "").trim(), mon = u.searchParams.get("m") || "";
  const hay = f => { const r = rows.find(x => x.id === f.id); return [f.store, f.rawStore, f.owner, f.bill_no, names[f.chat_id], r?.data].join(" ").toUpperCase(); };
  const shown = list.filter(f => (!q || hay(f).includes(q.toUpperCase())) && (!mon || ym(f.created) === mon));
  const months = [...new Set(list.map(f => ym(f.created)))];
  const total = shown.reduce((a, f) => a + f.cash, 0);
  return page("帳單存檔", head("帳單存檔", `<div class="stats"><div><span>${shown.length}</span>張</div><div><span>${new Set(shown.map(f => f.store)).size}</span>家店</div><div><span>$${n(total)}</span>合計</div></div>`) + `<main>
    <form class="filter"><input type="hidden" name="k" value="${K}"><input name="q" value="${esc(q)}" placeholder="店名、誰的單、單號、客人"><select name="m"><option value="">全部月份</option>${months.map(x => `<option ${x === mon ? "selected" : ""}>${x}</option>`).join("")}</select><button>搜尋</button></form>
    ${shown.map(f => `<a class="bill" href="?k=${K}&id=${esc(f.id)}"><div class="bt"><div><div class="store">${esc(f.rawStore || f.store)}${f.owner ? `<span class="owner">${esc(f.owner)}的單</span>` : ""}</div>
      <div class="meta">${esc(f.date || tw(f.created))}｜${esc(f.bill_no || "無單號")}｜${f.pax || "?"} 人${f.perPerson ? `｜每人 ${n(f.perPerson)}` : ""}｜${esc(names[f.chat_id] || "")}${f.copies > 1 ? `｜${f.copies} 筆紀錄` : ""}${f.status !== "done" ? "｜拆帳中" : ""}</div></div>
      <div class="amt">$${n(f.cash)}</div></div></a>`).join("") || `<div class="empty">沒有符合的帳單。</div>`}</main>`);
}

/* 在帳單頁填「誰的單」：同一張單（店＋單號）的每一筆紀錄都一起改 */
export async function onRequestPost({ request, env }) {
  const u = new URL(request.url), k = u.searchParams.get("k") || "", db = env.DB;
  const who = await staff(db, k);
  if (!who) return new Response("forbidden", { status: 403 });
  const fd = await request.formData(), id = String(fd.get("id") || ""), owner = String(fd.get("owner") || "").trim().slice(0, 20);
  const r = await db.prepare("SELECT * FROM line_splits WHERE id=?").bind(id).first();
  if (r) await setOwner(db, r, owner, who.name);
  return Response.redirect(`${u.origin}/bo?k=${encodeURIComponent(k)}&id=${encodeURIComponent(id)}`, 303);
}
export async function setOwner(db, r, owner, by) {
  const f = facts(r);
  const { results } = f.bill_no ? await db.prepare("SELECT id,data FROM line_splits WHERE REPLACE(bill_no,' ','')=?").bind(f.bill_no.replace(/\s/g, "")).all() : { results: [r] };
  let n = 0;
  for (const x of results) {
    if (facts(x).store !== f.store) continue;
    const d = JSON.parse(x.data || "{}");
    d.owner = owner || undefined; d.ownerNote = owner ? `${by || ""} 標記` : undefined;
    await db.prepare("UPDATE line_splits SET data=? WHERE id=?").bind(JSON.stringify(d), x.id).run(); n++;
  }
  return n;
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}｜後台</title><style>
:root{--brand:#12524F;--soft:#EEF2F1;--ink:#1F2937;--sub:#6B7280;--line:#E5E7EB;--bg:#F6F8F7;--card:#FFFFFF;--accent:#F28C28}
@media (prefers-color-scheme:dark){:root{--soft:#1E2B2A;--ink:#E8EEED;--sub:#9AA8A6;--line:#2A3735;--bg:#0F1716;--card:#16201F}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
a{color:inherit}.hero{background:var(--brand);color:#fff;padding:20px 18px 22px}.hero h1{margin:2px 0 4px;font-size:22px}.kicker{font-size:12px;color:#CFE3E1}
.meta{font-size:12.5px;color:var(--sub)}.meta.light{color:#CFE3E1}.total{display:flex;justify-content:space-between;align-items:flex-end;margin-top:12px}.total span{color:#CFE3E1;font-size:13px}.total b{font-size:26px}
.stats{display:flex;gap:22px;margin-top:12px;font-size:12px;color:#CFE3E1}.stats span{display:block;font-size:20px;font-weight:700;color:#fff}
nav{display:flex;gap:4px;overflow-x:auto;background:var(--card);border-bottom:1px solid var(--line);padding:0 12px;position:sticky;top:0}nav a{padding:12px 12px;text-decoration:none;font-size:14px;color:var(--sub);white-space:nowrap;border-bottom:2px solid transparent}nav a.on{color:var(--brand);border-color:var(--brand);font-weight:600}
main{max-width:960px;margin:0 auto;padding:6px 16px 40px}h2{font-size:13px;color:var(--sub);font-weight:600;margin:22px 4px 8px}
.card{background:var(--card);border-radius:14px;padding:6px 16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.card.wide{overflow-x:auto;margin-top:14px}
.bill{display:block;background:var(--card);border-radius:14px;padding:14px 16px;margin-top:10px;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bt{display:flex;justify-content:space-between;gap:12px}.store{font-weight:700;font-size:16px}.amt{font-weight:700;font-size:18px;color:var(--brand);white-space:nowrap}
.owner{display:inline-block;margin-left:8px;font-size:12px;font-weight:600;background:#FFF4E8;color:#B45309;border-radius:999px;padding:1px 8px}
.tag{display:inline-block;margin-left:6px;font-size:11px;color:var(--sub);background:var(--soft);border-radius:999px;padding:0 6px}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:12px;color:var(--sub);font-weight:500;text-align:left;padding:10px 8px 6px 0;white-space:nowrap}
td{padding:9px 8px 9px 0;border-top:1px solid var(--line);vertical-align:top}td.k{color:var(--sub);width:34%}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.sub{font-size:12px;color:var(--sub)}.sample{font-size:13px;line-height:1.7;padding:12px 16px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.photos img{width:100%;border-radius:10px}
.filter{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.filter input,.own input{flex:1;min-width:160px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px;background:var(--card);color:var(--ink)}
.filter select{padding:9px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
button{background:var(--brand);color:#fff;border:0;border-radius:10px;padding:9px 16px;font-size:14px;font-weight:600}
.own{display:flex;gap:8px;padding:12px 16px}.row{display:block;padding:10px 0;border-top:1px solid var(--line);text-decoration:none;font-size:14px}.row:first-child{border:0}
.empty{text-align:center;color:var(--sub);padding:60px 0}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
