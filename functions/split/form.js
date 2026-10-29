// /split/form?t=<群組代碼>&id=<帳單> — 拆帳表單：客人（名字、男女、併給誰）→ 小姐坐誰 → 公費誰分 → 即時試算 → 送出結算。
// 送出後伺服器重算一次、存檔，並在群組貼「@All 拆帳完畢」＋請款卡（推播）。
import { kv } from "../../lib/assistant.js";
import { loadSplit, finishForm, fmt } from "../../lib/split.js";
import { lineClient } from "../../lib/line.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function who(request, env) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "";
  const chatId = t.length >= 20 ? await kv.get(env.DB, "splittok:" + t) : null;
  return { chatId, id: u.searchParams.get("id") || "", origin: u.origin };
}

export async function onRequestPost({ request, env }) {
  const { chatId, id, origin } = await who(request, env);
  if (!chatId) return Response.json({ error: "連結不對或已失效" }, { status: 404 });
  let body = {}; try { body = await request.json(); } catch (e) {}
  const r = await finishForm(env, env.DB, lineClient(env.LINE_CHANNEL_TOKEN || ""), { chatId, id, body, origin });
  return Response.json(r, { status: r.error ? 400 : 200 });
}

export async function onRequestGet({ request, env }) {
  const { chatId, id } = await who(request, env);
  const r = chatId ? await loadSplit(env.DB, id) : null;
  if (!r || r.chat_id !== chatId) return html("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  if (r.status === "cancelled") return html("拆帳", `<div class="empty">這張已經取消了。</div>`);
  const d = r.d;
  // 預填：已經結算過的照原樣；否則依帳單人數（「5+0」＝男 5、女 0）開好列
  let guests;
  if (d.guests?.length) guests = d.guests.map(g => ({ k: g.id, name: g.name, sex: g.sex || "男", to: d.merge?.[g.id] || "" }));
  else {
    const m = String(d.guests_note || "").match(/(\d+)\s*\+\s*(\d+)/), one = String(d.guests_note || "").match(/(\d+)/);
    const hasAi = Number.isFinite(d.men) && d.men + (d.women || 0) > 0;
    const men = Math.min(hasAi ? d.men : m ? +m[1] : one ? +one[1] : 3, 12), women = Math.min(hasAi ? d.women || 0 : m ? +m[2] : 0, 12 - men);
    guests = [...Array(men).fill("男"), ...Array(women).fill("女")].map((sex, i) => ({ k: "g" + i, name: "", sex, to: "" }));
    if (!guests.length) guests = [{ k: "g0", name: "", sex: "男", to: "" }];
  }
  const state = {
    id: r.id, done: r.status === "done", cash: d.cash,
    guests, next: guests.length,
    hostess: d.hostess.map(h => ({ id: h.id, name: h.name, amount: h.amount, mark: h.mark || "", lines: h.lines.map(l => [l.type, l.time, l.units ? l.units + " 節" : ""].filter(Boolean).join(" ")), g: h.guest || "" })),
    shared: d.shared.map(s => ({ id: s.id, name: s.name, amount: s.amount, qty: s.qty, price: s.price, who: s.who || null })),
    free: d.free || [],
    members: (await env.DB.prepare("SELECT name FROM line_members WHERE chat_id=? AND name IS NOT NULL AND optout=0 ORDER BY updated DESC LIMIT 30").bind(chatId).all()).results.map(x => x.name).filter(n => n && n !== "成員"),
  };
  return html("拆帳", `
  <header class="hero"><div class="kicker">拆帳${r.status === "done" ? "｜已結算，可修改後重送" : ""}</div><h1>${esc(d.store || "帳單")}</h1>
    <div class="meta">${esc([d.date, d.bill_no ? "單號 " + d.bill_no : "", d.guests_note ? "帳單人數 " + d.guests_note : ""].filter(Boolean).join("｜"))}</div>
    <div class="total"><span>現金總額</span><b>$${fmt(d.cash)}</b></div>
    ${d.warn ? `<div class="warn">⚠ ${esc(d.warn)}</div>` : ""}</header>
  <main id="app">
    <section><div class="step"><span>1</span>客人</div><p class="hint">名字、男女；要跟別人一起請款的，在「併給」選付錢的人。</p>
      <div id="guests"></div><button class="add" id="add" type="button">＋ 加一位</button>
      <div class="chips mem" id="members"></div></section>
    <section><div class="step"><span>2</span>小姐坐誰</div><p class="hint">每位小姐點她坐的客人。</p><div id="hostess"></div></section>
    <section><div class="step"><span>3</span>公費誰分</div><p class="hint">預設全部平分；沒份的人點掉。</p><div id="shared"></div>
      ${state.free.length ? `<div class="free">招待：${state.free.map(esc).join("、")}</div>` : ""}</section>
    <section><div class="step"><span>4</span>試算</div><div class="card" id="preview"></div></section>
  </main>
  <footer class="bar" id="bar"><div class="sum" id="sum"></div><button id="send" type="button">送出結算</button></footer>
  <div class="done" id="done" hidden></div>
<script>
const S = ${JSON.stringify(state).replace(/</g, "\\u003c")};
const KEY = "split-form-" + S.id;
try { const sv = JSON.parse(localStorage.getItem(KEY) || "null"); if (sv && sv.guests && !S.done) Object.assign(S, { guests: sv.guests, next: sv.next, hostess: S.hostess.map(h => ({ ...h, g: sv.h?.[h.id] ?? h.g })), shared: S.shared.map(s => ({ ...s, who: sv.s && s.id in sv.s ? sv.s[s.id] : s.who })) }); } catch (e) {}
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const named = () => S.guests.filter(g => g.name.trim());
function persist() { try { localStorage.setItem(KEY, JSON.stringify({ guests: S.guests, next: S.next, h: Object.fromEntries(S.hostess.map(h => [h.id, h.g])), s: Object.fromEntries(S.shared.map(s => [s.id, s.who])) })); } catch (e) {} }

function renderGuests() {
  $("#guests").innerHTML = S.guests.map((g, i) => \`
    <div class="row"><div class="num">\${i + 1}</div><div class="fields">
      <input class="name" data-k="\${g.k}" placeholder="名字" value="\${esc(g.name)}" maxlength="20" autocomplete="off">
      <div class="line2"><div class="seg">\${["男", "女"].map(x => \`<button type="button" data-sex="\${x}" data-k="\${g.k}" class="\${g.sex === x ? "on" : ""}">\${x}</button>\`).join("")}</div>
        <label class="to">併給<select data-k="\${g.k}"></select></label></div></div>
      <button type="button" class="del" data-del="\${g.k}" aria-label="刪除">×</button></div>\`).join("");
  derived();
}
// 打字時不重畫輸入框（中文輸入法選字中重畫會打斷），只更新其他區塊
function derived() {
  const ns = named();
  document.querySelectorAll("select[data-k]").forEach(sel => { const g = S.guests.find(x => x.k === sel.dataset.k); sel.innerHTML = '<option value="">不合併</option>' + ns.filter(x => x.k !== g.k).map(x => \`<option value="\${x.k}" \${g.to === x.k ? "selected" : ""}>\${esc(x.name)}</option>\`).join(""); });
  $("#members").innerHTML = S.members.length ? '<div class="memlabel">群組成員，點一下帶入：</div>' + S.members.map(n => \`<button type="button" class="chip \${ns.some(g => g.name.trim() === n) ? "used" : ""}" data-m="\${esc(n)}">\${esc(n)}</button>\`).join("") : "";
  const pick = (sel, on) => ns.length ? ns.map(g => \`<button type="button" class="pill \${on(g) ? "on" : ""}" \${sel}="\${g.k}">\${esc(g.name)}</button>\`).join("") : '<span class="muted">先在上面填客人名字</span>';
  $("#hostess").innerHTML = S.hostess.map(h => \`
    <div class="item \${h.g && ns.some(g => g.k === h.g) ? "" : "todo"}"><div class="ihead"><div><b>\${esc(h.name)}</b>\${h.mark ? \`<small class="mark">標記 \${esc(h.mark)}</small>\` : ""}<div class="sub">\${h.lines.map(esc).join("｜")}</div></div><div class="amt">\${fmt(h.amount)}</div></div>
      <div class="pills" data-h="\${h.id}">\${pick("data-hg", g => h.g === g.k)}</div></div>\`).join("");
  $("#shared").innerHTML = S.shared.map(s => { const all = !s.who; return \`
    <div class="item"><div class="ihead"><div><b>\${esc(s.name)}</b>\${s.qty > 1 ? \`<small>\${s.qty} × \${fmt(s.price)}</small>\` : ""}<div class="sub">\${all ? "全部平分" : (s.who.filter(k => ns.some(g => g.k === k)).length + " 人分")}</div></div><div class="amt">\${fmt(s.amount)}</div></div>
      <div class="pills" data-s="\${s.id}">\${pick("data-sg", g => all || s.who.includes(g.k))}\${!all ? '<button type="button" class="reset" data-all="' + s.id + '">全部平分</button>' : ""}</div></div>\`; }).join("");
  preview();
  persist();
}
function calc() {
  const ns = named(), ids = ns.map(g => g.k), raw = Object.fromEntries(ids.map(k => [k, { h: 0, s: 0 }]));
  for (const h of S.hostess) if (raw[h.g]) raw[h.g].h += h.amount;
  for (const s of S.shared) { const w = (s.who || ids).filter(k => raw[k]); for (const k of w) raw[k].s += s.amount / w.length; }
  const exact = ids.map(k => raw[k].h + raw[k].s), target = Math.round(exact.reduce((a, b) => a + b, 0)), fl = exact.map(Math.floor);
  let left = target - fl.reduce((a, b) => a + b, 0);
  exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  const people = ns.map((g, i) => ({ k: g.k, name: g.name.trim(), total: fl[i], h: raw[g.k].h, s: Math.round(raw[g.k].s) }));
  const final = k => { let cur = k, n = 0; while (n++ < 12) { const g = S.guests.find(x => x.k === cur); if (!g || !g.to || !ids.includes(g.to) || g.to === k) break; cur = g.to; } return cur; };
  const payers = [];
  for (const p of people) { const to = final(p.k); let pay = payers.find(x => x.k === to); if (!pay) { pay = { k: to, name: people.find(x => x.k === to).name, total: 0, inc: [] }; payers.push(pay); } pay.total += p.total; if (to !== p.k) pay.inc.push(p); }
  return { target, people, payers };
}
function preview() {
  const r = calc(), ns = named(), un = S.hostess.filter(h => !ns.some(g => g.k === h.g)).length;
  $("#preview").innerHTML = r.payers.length ? r.payers.map(p => { const me = r.people.find(x => x.k === p.k); return \`
    <div class="payer"><div class="ptop"><b>\${esc(p.name)}</b><span>$\${fmt(p.total)}</span></div><div class="sub">小姐 \${fmt(me.h)}｜公費 \${fmt(me.s)}</div>
    \${p.inc.map(x => \`<div class="inc">＋ 含 \${esc(x.name)} $\${fmt(x.total)}</div>\`).join("")}</div>\`; }).join("") : '<div class="muted">填好客人就會出現試算</div>';
  const dups = ns.map(g => g.name.trim()).filter((n, i, a) => a.indexOf(n) !== i);
  const msg = !ns.length ? "先填客人" : dups.length ? "名字重複：" + dups[0] : un ? \`還有 \${un} 位小姐沒選客人\` : \`合計 $\${fmt(r.target)}\` + (r.target !== S.cash ? \`（帳單 $\${fmt(S.cash)}）\` : " ✓");
  $("#sum").textContent = msg; $("#sum").className = "sum" + (!ns.length || dups.length || un ? " bad" : "");
  $("#send").disabled = !ns.length || !!dups.length || !!un;
}
document.addEventListener("input", e => { if (e.target.classList.contains("name")) { S.guests.find(g => g.k === e.target.dataset.k).name = e.target.value; derived(); } });
document.addEventListener("change", e => { if (e.target.tagName === "SELECT") { S.guests.find(g => g.k === e.target.dataset.k).to = e.target.value; derived(); } });
document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.sex) { S.guests.find(g => g.k === b.dataset.k).sex = b.dataset.sex; renderGuests(); }
  else if (b.dataset.del) { const k = b.dataset.del; S.guests = S.guests.filter(g => g.k !== k); S.guests.forEach(g => { if (g.to === k) g.to = ""; }); S.hostess.forEach(h => { if (h.g === k) h.g = ""; }); S.shared.forEach(s => { if (s.who) { s.who = s.who.filter(x => x !== k); if (!s.who.length) s.who = null; } }); if (!S.guests.length) S.guests.push({ k: "g" + S.next++, name: "", sex: "男", to: "" }); renderGuests(); }
  else if (b.dataset.m) { const g = S.guests.find(g => !g.name.trim()); if (g) g.name = b.dataset.m; else if (S.guests.length < 12) S.guests.push({ k: "g" + S.next++, name: b.dataset.m, sex: "男", to: "" }); renderGuests(); }
  else if (b.id === "add") { if (S.guests.length < 12) { S.guests.push({ k: "g" + S.next++, name: "", sex: "男", to: "" }); renderGuests(); document.querySelector(\`.name[data-k="g\${S.next - 1}"]\`).focus(); } }
  else if (b.dataset.hg) { const h = S.hostess.find(x => x.id === b.closest(".pills").dataset.h); h.g = b.dataset.hg; derived(); }
  else if (b.dataset.sg) { const s = S.shared.find(x => x.id === b.closest(".pills").dataset.s), all = named().map(g => g.k), cur = s.who || all, k = b.dataset.sg; let nx = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k]; if (!nx.length) { toast("至少要有一個人分"); return; } s.who = all.every(x => nx.includes(x)) ? null : nx; derived(); }
  else if (b.dataset.all) { S.shared.find(x => x.id === b.dataset.all).who = null; derived(); }
  else if (b.id === "send") send();
});
async function send() {
  const ns = named(), name = k => (S.guests.find(g => g.k === k) || {}).name?.trim() || "";
  if (S.done && !confirm("這張已經結算過，要用新的內容更正嗎？群組會再貼一次請款單。")) return;
  $("#send").disabled = true; $("#send").textContent = "結算中…";
  const body = { guests: ns.map(g => ({ name: g.name.trim(), sex: g.sex, to: name(g.to) })), hostess: Object.fromEntries(S.hostess.map(h => [h.id, name(h.g)])), shared: Object.fromEntries(S.shared.filter(s => s.who).map(s => [s.id, s.who.map(name).filter(Boolean)])) };
  try {
    const r = await fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "送出失敗");
    try { localStorage.removeItem(KEY); } catch (e) {}
    $("#app").hidden = true; $("#bar").hidden = true;
    $("#done").innerHTML = \`<div class="ok">✓</div><h2>\${j.fix ? "已更正" : "結算完成"}</h2><p>\${j.posted ? "請款單已經貼到群組。" : "請款單沒貼成功，回群組 @小幫手 說「拆帳紀錄」可以看結果。"}</p>
      <div class="card list">\${j.payers.map(p => \`<div class="payer"><div class="ptop"><b>\${esc(p.name)}</b><span>$\${fmt(p.total)}</span></div>\${p.includes.map(x => \`<div class="inc">＋ 含 \${esc(x.name)} $\${fmt(x.total)}</div>\`).join("")}</div>\`).join("")}</div>
      <p class="small">合計 $\${fmt(j.total)}</p>\`;
    $("#done").hidden = false; window.scrollTo(0, 0);
  } catch (e) { toast(e.message); $("#send").disabled = false; $("#send").textContent = "送出結算"; }
}
function toast(t) { let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); } el.textContent = t; el.className = "show"; setTimeout(() => el.className = "", 2600); }
renderGuests();
</script>`);
}

function html(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{--brand:#12524F;--soft:#EEF2F1;--ink:#1F2937;--sub:#6B7280;--line:#E5E7EB;--bg:#F6F8F7;--card:#FFFFFF;--accent:#F28C28;--warn:#B45309}
@media (prefers-color-scheme:dark){:root{--soft:#1E2B2A;--ink:#E8EEED;--sub:#9AA8A6;--line:#2A3735;--bg:#0F1716;--card:#16201F}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:100px}
button{font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.hero{background:var(--brand);color:#fff;padding:22px 18px 24px;border-radius:0 0 22px 22px}.hero h1{margin:2px 0 4px;font-size:23px}
.kicker{font-size:12px;color:#CFE3E1;letter-spacing:1px}.meta{font-size:13px;color:#CFE3E1}.warn{margin-top:10px;font-size:12.5px;background:rgba(255,255,255,.12);border-radius:10px;padding:8px 10px}
.total{display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.18)}.total span{color:#CFE3E1;font-size:13px}.total b{font-size:26px;font-variant-numeric:tabular-nums}
main{max-width:560px;margin:0 auto;padding:4px 16px 20px}section{margin-top:22px}
.step{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px}.step span{width:24px;height:24px;border-radius:12px;background:var(--brand);color:#fff;font-size:13px;display:inline-flex;align-items:center;justify-content:center}
.hint{font-size:13px;color:var(--sub);margin:4px 2px 10px}.muted{font-size:13px;color:var(--sub)}
.row,.item,.card{background:var(--card);border-radius:16px;padding:12px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.row{display:flex;gap:10px;align-items:flex-start}
.num{width:26px;height:26px;border-radius:13px;background:var(--soft);color:var(--brand);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;margin-top:7px;flex:none}
.fields{flex:1;min-width:0}.name{width:100%;font:inherit;font-size:17px;padding:8px 10px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);outline:none}.name:focus{border-color:var(--brand)}
.line2{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.seg{display:flex;background:var(--soft);border-radius:10px;padding:3px}.seg button{border:0;background:none;font-size:14px;padding:5px 16px;border-radius:8px;color:var(--sub)}.seg button.on{background:var(--brand);color:#fff;font-weight:600}
.to{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--sub)}.to select{font:inherit;font-size:14px;padding:5px 8px;border-radius:9px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);max-width:150px}
.del{border:0;background:none;color:var(--sub);font-size:22px;line-height:1;padding:6px 4px;margin-top:3px}
.add{width:100%;border:1.5px dashed var(--line);background:none;border-radius:14px;padding:11px;color:var(--brand);font-weight:600}
.mem{margin-top:10px}.memlabel{width:100%;font-size:12px;color:var(--sub)}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{border:0;background:var(--card);border-radius:999px;padding:6px 13px;font-size:14px;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06)}.chip.used{opacity:.4}
.item.todo{box-shadow:0 0 0 1.5px var(--accent)}
.ihead{display:flex;justify-content:space-between;gap:10px}.ihead b{font-size:16px}.ihead small{font-size:12px;color:var(--sub);margin-left:6px}.mark{background:var(--soft);border-radius:6px;padding:1px 6px}
.sub{font-size:12px;color:var(--sub)}.amt{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.pill{border:1.5px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:6px 14px;font-size:14.5px}
.pill.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
.reset{border:0;background:none;color:var(--brand);font-size:13px;padding:6px 4px;text-decoration:underline}
.free{font-size:12.5px;color:var(--sub);padding:2px 4px}
.payer{padding:10px 2px;border-bottom:1px solid var(--line)}.payer:last-child{border:0}.ptop{display:flex;justify-content:space-between;align-items:baseline}.ptop b{font-size:16px}
.ptop span{font-weight:800;font-size:19px;color:var(--brand);font-variant-numeric:tabular-nums}.inc{font-size:13px;color:var(--accent)}
@media (prefers-color-scheme:dark){.ptop span{color:#6FC2B9}}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px}
.sum{flex:1;font-size:14px;color:var(--brand);font-weight:600}.sum.bad{color:var(--warn);font-weight:500}
#send{border:0;background:var(--brand);color:#fff;font-weight:700;padding:12px 24px;border-radius:12px}#send:disabled{opacity:.45}
.done{text-align:center;padding:48px 20px;max-width:520px;margin:0 auto}.ok{width:64px;height:64px;border-radius:32px;background:var(--brand);color:#fff;font-size:34px;line-height:64px;margin:0 auto 14px}
.done h2{font-size:21px;margin:0 0 6px}.done p{color:var(--sub);margin:6px 0}.done .list{text-align:left;margin-top:18px}.small{font-size:13px}
#toast{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);background:#1F2937;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}#toast.show{opacity:1}
.empty{text-align:center;color:var(--sub);padding:80px 0}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
