// /split/form?t=<群組代碼>&id=<帳單> — 拆帳表單：客人（名字、男女、併給誰）→ 小姐坐誰 → 公費誰分 → 即時試算 → 送出結算。
// 送出後伺服器重算一次、存檔，並在群組貼「@All 拆帳完畢」＋請款卡（推播）。
import { kv, isGroup } from "../../lib/assistant.js";
import { loadSplit, finishForm, fmt } from "../../lib/split.js";
import { itemKind, duration } from "../../lib/billstats.js";
import { lineClient } from "../../lib/line.js";
import { isAdmin } from "../../lib/books.js";

/* LINE 內嵌視窗的身分：用 ID token 跟 LINE 確認是誰（頻道 ID＝LIFF ID 前半段） */
async function lineUser(env, idToken, liff) {
  if (!idToken || !liff) return null;
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id_token: idToken, client_id: liff.split("-")[0] }) }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  return j?.sub || null;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function who(request, env) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "";
  const chatId = t.length >= 20 ? await kv.get(env.DB, "splittok:" + t) : null;
  return { chatId, id: u.searchParams.get("id") || "", origin: u.origin };
}

export async function onRequestPost({ request, env, waitUntil }) {
  const { chatId, id, origin } = await who(request, env);
  if (!chatId) return Response.json({ error: "連結不對或已失效" }, { status: 404 });
  let body = {}; try { body = await request.json(); } catch (e) {}
  // 有設定內嵌視窗：只有管理員（Ben）能送出；check＝打開時先問「我能不能送」
  const liff = await kv.get(env.DB, "liff:split");
  if (liff) {
    const uid = await lineUser(env, body.idToken, liff);
    const ok = !!uid && (await isAdmin(env.DB, uid));
    if (body.check) return Response.json({ admin: ok });
    if (!ok) return Response.json({ error: uid ? "只有 Ben 能送出拆帳" : "請從 LINE 裡的按鈕打開表單" }, { status: 403 });
  } else if (body.check) return Response.json({ admin: true });
  const r = await finishForm(env, env.DB, lineClient(env.LINE_CHANNEL_TOKEN || ""), { chatId, id, body, origin, defer: typeof waitUntil === "function" ? p => waitUntil(p) : null });
  return Response.json(r, { status: r.error ? 400 : 200 });
}

export async function onRequestGet({ request, env }) {
  // 從 liff.line.me 打開時，第一次會帶 liff.state（原本的 ?t=…&id=…），轉回正常網址
  const st = new URL(request.url).searchParams.get("liff.state");
  if (st && !new URL(request.url).searchParams.get("t")) { const u = new URL(request.url); return Response.redirect(u.origin + u.pathname + (st.startsWith("?") ? st : st.replace(/^[^?]*/, "")), 302); }
  const { chatId, id } = await who(request, env);
  const r = chatId ? await loadSplit(env.DB, id) : null;
  if (!r || r.chat_id !== chatId) return html("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  if (r.status === "cancelled") return html("拆帳", `<div class="empty">這張已經取消了。</div>`);
  const d = r.d;
  // 預填：已經結算過的照原樣；否則依帳單人數（「5+0」＝男 5、女 0）開好列
  let guests;
  if (d.guests?.length) guests = d.guests.map(g => ({ k: g.id, name: g.name, sex: g.sex || "男", to: d.merge?.[g.id] || "", late: g.late || 0 }));
  else {
    const m = String(d.guests_note || "").match(/(\d+)\s*\+\s*(\d+)/), one = String(d.guests_note || "").match(/(\d+)/);
    const hasAi = Number.isFinite(d.men) && d.men + (d.women || 0) > 0;
    const men = Math.min(hasAi ? d.men : m ? +m[1] : one ? +one[1] : 3, 12), women = Math.min(hasAi ? d.women || 0 : m ? +m[2] : 0, 12 - men);
    guests = [...Array(men).fill("男"), ...Array(women).fill("女")].map((sex, i) => ({ k: "g" + i, name: "", sex, to: "" }));
    if (!guests.length) guests = [{ k: "g0", name: "", sex: "男", to: "" }];
  }
  const mins = duration(d), sitMax = Math.max(0, ...d.hostess.flatMap(h => h.lines.filter(l => !/出場|外全|框/.test(l.type || "")).map(l => l.units || 0)));
  const state = {
    night: d.night || (mins ? Math.round(mins / 10) : sitMax) || 0,
    liff: (await kv.get(env.DB, "liff:split")) || "",
    id: r.id, done: r.status === "done", cash: d.cash, back: isGroup(chatId) ? "https://line.me/R/nv/chat" : "https://line.me/R/oaMessage/" + encodeURIComponent(d.bot === "miao" ? env.MIAO_OA_ID || "@366dzslm" : env.LINE_OA_ID || "@249owrao"),
    bot: d.bot === "miao" ? "拆帳喵" : "小幫手", payee: d.payee || "",
    guests, next: guests.length,
    hostess: d.hostess.map(h => ({ id: h.id, name: h.name, amount: h.amount, mark: h.mark || "", lines: h.lines.map(l => [l.type, l.time, l.units ? l.units + " 節" : ""].filter(Boolean).join(" ")), units: h.lines.reduce((a, l) => a + (l.units || 0), 0), g: h.guest || "",
      mode: h.split && h.split.length > 1 ? "seg" : "pick", w: h.split && h.split.length === 1 ? h.split[0].who : h.guest ? [h.guest] : [], segs: h.split && h.split.length > 1 ? h.split.map(sg => ({ u: sg.u, w: sg.who })) : [] })),
    shared: d.shared.map(s => ({ id: s.id, name: s.name, amount: s.amount, qty: s.qty, price: s.price, who: s.who || null, bt: !!s.byTime, whole: ["room", "table", "manager", "tip"].includes(itemKind(s)) })),
    free: d.free || [],
    members: (await env.DB.prepare("SELECT name FROM line_members WHERE chat_id=? AND name IS NOT NULL AND optout=0 ORDER BY updated DESC LIMIT 30").bind(chatId).all()).results.map(x => x.name).filter(n => n && n !== "成員"),
  };
  return html("拆帳", `
  <header class="hero"><div class="kicker">${d.bot === "miao" ? "拆帳喵" : "拆帳"}${r.status === "done" ? "｜已結算，可修改後重送" : ""}</div><h1>${esc(d.store || "帳單")}</h1>
    <div class="meta">${esc([d.date, d.bill_no ? "單號 " + d.bill_no : "", d.guests_note ? "帳單人數 " + d.guests_note : ""].filter(Boolean).join("｜"))}</div>
    <div class="total"><span>現金總額</span><b>$${fmt(d.cash)}</b></div>
    ${d.warn ? `<div class="warn">⚠ ${esc(d.warn)}</div>` : ""}</header>
  <main id="app">
    <section><div class="step"><span>1</span>客人</div><p class="hint">名字、男女；要跟別人一起請款的，在「併給」選付錢的人。晚到或早走的人，填他沒在場的節數。</p>
      <div id="guests"></div><div class="night" id="night"></div><button class="add" id="add" type="button">＋ 加一位</button>
      <div class="chips mem" id="members"></div></section>
    <section><div class="step"><span>2</span>小姐坐誰</div><p class="hint">點要付這位小姐的人；點好幾位就平分，或按「全部平分」。</p><div id="hostess"></div></section>
    <section><div class="step"><span>3</span>公費誰分</div><p class="hint">預設全部平分；只有部分人付的，直接點要付的人。</p><div id="shared"></div>
      ${state.free.length ? `<div class="free">招待：${state.free.map(esc).join("、")}</div>` : ""}</section>
    <section><div class="step"><span>4</span>試算</div><div class="card" id="preview"></div>
      <div class="payee"><label for="payee">買單人<small>選填</small></label><input id="payee" maxlength="20" placeholder="誰先付的？請款單會寫「轉給 他」" autocomplete="off"><div class="chips" id="payeechips"></div></div></section>
  </main>
  <footer class="bar" id="bar"><div class="sum" id="sum"></div><button id="send" type="button">送出結算</button></footer>
  <div class="done" id="done" hidden></div>
<script>
const S = ${JSON.stringify(state).replace(/</g, "\\u003c")};
let TOKEN = "";
async function liffInit() {
  if (!S.liff || !window.liff) return;
  try {
    await liff.init({ liffId: S.liff });
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    TOKEN = liff.getIDToken() || "";
    const r = await fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check: true, idToken: TOKEN }) });
    const j = await r.json().catch(() => ({}));
    if (!j.admin) { $("#send").disabled = true; $("#send").textContent = "只有 Ben 能送出"; $("#bar").classList.add("ro"); }
  } catch (e) { console.log("liff", e); }
}
const backToChat = () => { try { if (window.liff && liff.isInClient && liff.isInClient()) { liff.closeWindow(); return true; } } catch (e) {} return false; };
const KEY = "split-form-" + S.id;
try { const sv = JSON.parse(localStorage.getItem(KEY) || "null"); if (sv && sv.guests && !S.done) Object.assign(S, { guests: sv.guests, next: sv.next, hostess: S.hostess.map(h => ({ ...h, ...(sv.h?.[h.id] && typeof sv.h[h.id] === "object" && Array.isArray(sv.h[h.id].w) ? { mode: sv.h[h.id].mode === "seg" ? "seg" : "pick", w: sv.h[h.id].mode === "one" ? (sv.h[h.id].g ? [sv.h[h.id].g] : []) : sv.h[h.id].w, segs: sv.h[h.id].segs || [] } : {}) })), shared: S.shared.map(s => ({ ...s, who: sv.s && s.id in sv.s ? sv.s[s.id] : s.who, bt: sv.bt && s.id in sv.bt ? !!sv.bt[s.id] : s.bt })), night: sv.night || S.night }); } catch (e) {}
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const named = () => S.guests.filter(g => g.name.trim());
const anyLate = () => named().some(g => +g.late > 0);
const here = k => Math.max((+S.night || 0) - (+(S.guests.find(g => g.k === k) || {}).late || 0), 0);
// 小姐分給誰：one＝一位、even＝多人平分、seg＝分段（每段節數＋誰），回傳 [{u, w}]
const hsegs = h => { const ok = k => named().some(g => g.k === k); return h.mode === "seg" ? h.segs.map(sg => ({ u: +sg.u || 0, w: sg.w.filter(ok) })) : [{ u: 1, w: h.w.filter(ok) }]; };
const hDone = h => { const sg = hsegs(h); return sg.length && sg.every(x => x.w.length && x.u > 0); };
function persist() { try { localStorage.setItem(KEY, JSON.stringify({ guests: S.guests, next: S.next, h: Object.fromEntries(S.hostess.map(h => [h.id, { g: h.g, mode: h.mode, w: h.w, segs: h.segs }])), s: Object.fromEntries(S.shared.map(s => [s.id, s.who])), bt: Object.fromEntries(S.shared.map(s => [s.id, s.bt])), night: S.night })); } catch (e) {} }

function renderGuests() {
  $("#guests").innerHTML = S.guests.map((g, i) => \`
    <div class="row"><div class="num">\${i + 1}</div><div class="fields">
      <input class="name" data-k="\${g.k}" placeholder="名字" value="\${esc(g.name)}" maxlength="20" autocomplete="off">
      <div class="line2"><div class="seg">\${["男", "女"].map(x => \`<button type="button" data-sex="\${x}" data-k="\${g.k}" class="\${g.sex === x ? "on" : ""}">\${x}</button>\`).join("")}</div>
        <label class="to">併給<select data-k="\${g.k}"></select></label>
        <label class="late">晚到／早走<input type="number" inputmode="numeric" min="0" data-late="\${g.k}" value="\${g.late || ""}" placeholder="0">節</label></div></div>
      <button type="button" class="del" data-del="\${g.k}" aria-label="刪除">×</button></div>\`).join("");
  derived();
}
// 打字時不重畫輸入框（中文輸入法選字中重畫會打斷），只更新其他區塊
function derived() {
  const ns = named();
  document.querySelectorAll("select[data-k]").forEach(sel => { const g = S.guests.find(x => x.k === sel.dataset.k); sel.innerHTML = '<option value="">不合併</option>' + ns.filter(x => x.k !== g.k).map(x => \`<option value="\${x.k}" \${g.to === x.k ? "selected" : ""}>\${esc(x.name)}</option>\`).join(""); });
  $("#members").innerHTML = S.members.length ? '<div class="memlabel">群組成員，點一下帶入：</div>' + S.members.map(n => \`<button type="button" class="chip \${ns.some(g => g.name.trim() === n) ? "used" : ""}" data-m="\${esc(n)}">\${esc(n)}</button>\`).join("") : "";
  const pick = (sel, on) => ns.length ? ns.map(g => \`<button type="button" class="pill \${on(g) ? "on" : ""}" \${sel}="\${g.k}">\${esc(g.name)}</button>\`).join("") : '<span class="muted">先在上面填客人名字</span>';
  $("#hostess").innerHTML = S.hostess.map(h => {
    const tog = (sel, list) => pick(sel, g => list.includes(g.k));
    const body = h.mode === "seg" ? h.segs.map((sg, i) => \`<div class="segrow"><label class="u"><input type="number" inputmode="numeric" min="1" data-hu="\${h.id}" data-i="\${i}" value="\${sg.u || ""}" placeholder="節">節</label><div class="pills" data-h="\${h.id}" data-i="\${i}">\${tog("data-hs", sg.w)}</div>\${h.segs.length > 1 ? \`<button type="button" class="del sm" data-hdel="\${h.id}" data-i="\${i}" aria-label="刪除這段">×</button>\` : ""}</div>\`).join("") + \`<div class="segfoot">\${h.units ? \`帳單 \${h.units} 節，已填 \${h.segs.reduce((a, x) => a + (+x.u || 0), 0)} 節\` : ""}<span><button type="button" class="reset" data-hadd="\${h.id}">＋ 加一段</button><button type="button" class="reset" data-hm="pick" data-h="\${h.id}">取消分段</button></span></div>\`
      : \`<div class="pills" data-h="\${h.id}">\${tog("data-he", h.w)}<button type="button" class="pill all \${ns.length && ns.every(g => h.w.includes(g.k)) ? "on" : ""}" data-hall="\${h.id}">全部平分</button></div><div class="segfoot"><span>\${h.w.length > 1 ? h.w.length + " 人平分" : ""}</span><button type="button" class="reset" data-hm="seg" data-h="\${h.id}">依節數分段</button></div>\`;
    return \`<div class="item \${hDone(h) ? "" : "todo"}"><div class="ihead"><div><b>\${esc(h.name)}</b>\${h.mark ? \`<small class="mark">標記 \${esc(h.mark)}</small>\` : ""}<div class="sub">\${h.lines.map(esc).join("｜")}</div></div><div class="amt">\${fmt(h.amount)}</div></div>
      \${body}</div>\`; }).join("");
  $("#shared").innerHTML = S.shared.map(s => { const all = !s.who; return \`
    <div class="item"><div class="ihead"><div><b>\${esc(s.name)}</b>\${s.qty > 1 ? \`<small>\${s.qty} × \${fmt(s.price)}</small>\` : ""}<div class="sub">\${all ? "全部平分" : (s.who.filter(k => ns.some(g => g.k === k)).length + " 人付")}</div></div><div class="amt">\${fmt(s.amount)}</div></div>
      <div class="pills" data-s="\${s.id}">\${pick("data-sg", g => !all && s.who.includes(g.k))}<button type="button" class="pill all \${all ? "on" : ""}" data-all="\${s.id}">全部平分</button></div>
      \${anyLate() ? \`<div class="segfoot"><span>\${s.bt ? "照在場時間分" : "平分"}</span><button type="button" class="reset" data-bt="\${s.id}">\${s.bt ? "改成平分" : "照在場時間分"}</button></div>\` : ""}</div>\`; }).join("");
  $("#night").innerHTML = anyLate() ? \`<label>整晚共<input type="number" inputmode="numeric" min="1" id="nightu" value="\${S.night || ""}">節</label><span class="sub">包廂、桌面、經理檯、小費預設照在場時間分</span>\` : "";
  $("#payeechips").innerHTML = ns.map(g => \`<button type="button" class="chip \${$("#payee").value.trim() === g.name.trim() ? "on" : ""}" data-payee="\${esc(g.name.trim())}">\${esc(g.name.trim())}</button>\`).join("");
  preview();
  persist();
}
function calc() {
  const ns = named(), ids = ns.map(g => g.k), raw = Object.fromEntries(ids.map(k => [k, { h: 0, s: 0 }]));
  for (const h of S.hostess) { const sg = hsegs(h).filter(x => x.u > 0 && x.w.length), U = sg.reduce((a, x) => a + x.u, 0); for (const x of sg) for (const k of x.w) if (raw[k]) raw[k].h += h.amount * x.u / U / x.w.length; }
  for (const s of S.shared) { const w = (s.who || ids).filter(k => raw[k]), timed = s.bt && +S.night > 0 && w.some(k => here(k) < +S.night), W = timed ? w.reduce((a, k) => a + here(k), 0) : 0; for (const k of w) raw[k].s += timed ? (W ? s.amount * here(k) / W : 0) : s.amount / w.length; }
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
  const r = calc(), ns = named(), un = S.hostess.filter(h => !hDone(h)).length;
  $("#preview").innerHTML = r.payers.length ? r.payers.map(p => { const me = r.people.find(x => x.k === p.k); return \`
    <div class="payer"><div class="ptop"><b>\${esc(p.name)}</b><span>$\${fmt(p.total)}</span></div>\${p.inc.length ? \`<div class="inc me">\${esc(me.name)}（本人） $\${fmt(me.total)}</div>\` : ""}<div class="sub">小姐 \${fmt(me.h)}｜公費 \${fmt(me.total - Math.round(me.h))}</div>
    \${p.inc.map(x => \`<div class="inc">＋ 含 \${esc(x.name)} $\${fmt(x.total)}</div>\`).join("")}</div>\`; }).join("") : '<div class="muted">填好客人就會出現試算</div>';
  const dups = ns.map(g => g.name.trim()).filter((n, i, a) => a.indexOf(n) !== i);
  const lateBad = anyLate() && (!(+S.night > 0) || ns.some(g => +g.late >= +S.night));
  const msg = !ns.length ? "先填客人" : dups.length ? "名字重複：" + dups[0] : lateBad ? "晚到／早走的節數要小於整晚節數" : un ? \`還有 \${un} 位小姐沒選客人\` : \`合計 $\${fmt(r.target)}\` + (r.target !== S.cash ? \`（帳單 $\${fmt(S.cash)}）\` : " ✓");
  $("#sum").textContent = msg; $("#sum").className = "sum" + (!ns.length || dups.length || un || lateBad ? " bad" : "");
  $("#send").disabled = !ns.length || !!dups.length || !!un || lateBad;
}
document.addEventListener("input", e => {
  if (e.target.dataset.late) { const g = S.guests.find(x => x.k === e.target.dataset.late), was = anyLate(); g.late = Math.max(0, +e.target.value || 0);
    if (!was && anyLate() && !S.btSet) { S.shared.forEach(s => { if (s.whole) s.bt = true; }); S.btSet = true; }
    derived(); return; }
  if (e.target.id === "payee") { document.querySelectorAll("[data-payee]").forEach(b => b.classList.toggle("on", b.dataset.payee === e.target.value.trim())); return; }
  if (e.target.id === "nightu") { S.night = Math.max(0, +e.target.value || 0); preview(); persist(); return; }
  if (e.target.dataset.hu) { const h = S.hostess.find(x => x.id === e.target.dataset.hu); h.segs[+e.target.dataset.i].u = +e.target.value || 0; preview(); persist(); const f = e.target.closest(".item").querySelector(".segfoot"); if (f && h.units) f.firstChild.textContent = \`帳單 \${h.units} 節，已填 \${h.segs.reduce((a, x) => a + (+x.u || 0), 0)} 節\`; e.target.closest(".item").classList.toggle("todo", !hDone(h)); return; } if (e.target.classList.contains("name")) { S.guests.find(g => g.k === e.target.dataset.k).name = e.target.value; derived(); } });
document.addEventListener("change", e => { if (e.target.tagName === "SELECT") { S.guests.find(g => g.k === e.target.dataset.k).to = e.target.value; derived(); } });
document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.sex) { S.guests.find(g => g.k === b.dataset.k).sex = b.dataset.sex; renderGuests(); }
  else if (b.dataset.del) { const k = b.dataset.del; S.guests = S.guests.filter(g => g.k !== k); S.guests.forEach(g => { if (g.to === k) g.to = ""; }); S.hostess.forEach(h => { if (h.g === k) h.g = ""; h.w = h.w.filter(x => x !== k); h.segs.forEach(sg => sg.w = sg.w.filter(x => x !== k)); }); S.shared.forEach(s => { if (s.who) { s.who = s.who.filter(x => x !== k); if (!s.who.length) s.who = null; } }); if (!S.guests.length) S.guests.push({ k: "g" + S.next++, name: "", sex: "男", to: "" }); renderGuests(); }
  else if (b.dataset.m) { const g = S.guests.find(g => !g.name.trim()); if (g) g.name = b.dataset.m; else if (S.guests.length < 12) S.guests.push({ k: "g" + S.next++, name: b.dataset.m, sex: "男", to: "" }); renderGuests(); }
  else if (b.id === "add") { if (S.guests.length < 12) { S.guests.push({ k: "g" + S.next++, name: "", sex: "男", to: "" }); renderGuests(); document.querySelector(\`.name[data-k="g\${S.next - 1}"]\`).focus(); } }
  else if (b.dataset.hm) { const h = S.hostess.find(x => x.id === b.dataset.h), m = b.dataset.hm; if (m === h.mode) return;
    const cur = hsegs(h).flatMap(x => x.w).filter((k, i, a) => a.indexOf(k) === i);
    if (m === "pick") h.w = cur; else h.segs = [{ u: h.units || 0, w: cur }];
    h.mode = m; derived(); }
  else if (b.dataset.he) { const h = S.hostess.find(x => x.id === b.closest(".pills").dataset.h), k = b.dataset.he; h.w = h.w.includes(k) ? h.w.filter(x => x !== k) : [...h.w, k]; derived(); }
  else if (b.dataset.hall) { const h = S.hostess.find(x => x.id === b.dataset.hall), all = named().map(g => g.k); h.w = all.every(k => h.w.includes(k)) ? [] : all; derived(); }
  else if (b.dataset.hs) { const p = b.closest(".pills"), h = S.hostess.find(x => x.id === p.dataset.h), sg = h.segs[+p.dataset.i], k = b.dataset.hs; sg.w = sg.w.includes(k) ? sg.w.filter(x => x !== k) : [...sg.w, k]; derived(); }
  else if (b.dataset.hadd) { const h = S.hostess.find(x => x.id === b.dataset.hadd), used = h.segs.reduce((a, x) => a + (+x.u || 0), 0); h.segs.push({ u: h.units > used ? h.units - used : 0, w: [] }); derived(); }
  else if (b.dataset.hdel) { const h = S.hostess.find(x => x.id === b.dataset.hdel); h.segs.splice(+b.dataset.i, 1); derived(); }

  else if (b.dataset.sg) { const s = S.shared.find(x => x.id === b.closest(".pills").dataset.s), all = named().map(g => g.k), k = b.dataset.sg; const cur = s.who || []; const nx = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k]; s.who = !nx.length || all.every(x => nx.includes(x)) ? null : nx; derived(); }
  else if (b.dataset.bt) { const s = S.shared.find(x => x.id === b.dataset.bt); s.bt = !s.bt; derived(); }
  else if (b.dataset.all) { S.shared.find(x => x.id === b.dataset.all).who = null; derived(); }
  else if (b.dataset.payee !== undefined) { const v = b.dataset.payee; $("#payee").value = $("#payee").value.trim() === v ? "" : v; derived(); }
  else if (b.id === "send") send();
});
async function send() {
  const ns = named(), name = k => (S.guests.find(g => g.k === k) || {}).name?.trim() || "";
  if (S.done && !confirm("這張已經結算過，要用新的內容更正嗎？群組會再貼一次請款單。")) return;
  $("#send").disabled = true; $("#send").textContent = "結算中…";
  const body = { idToken: TOKEN, payee: ($("#payee").value || "").trim(), guests: ns.map(g => ({ name: g.name.trim(), sex: g.sex, to: name(g.to), late: +g.late || 0 })), night: +S.night || 0, byTime: Object.fromEntries(S.shared.filter(s => s.bt && anyLate()).map(s => [s.id, true])), hostess: Object.fromEntries(S.hostess.map(h => [h.id, h.mode === "pick" ? (h.w.length === 1 ? name(h.w[0]) : { even: h.w.map(name).filter(Boolean) }) : { segs: h.segs.map(sg => ({ u: +sg.u || 0, who: sg.w.map(name).filter(Boolean) })) }])), shared: Object.fromEntries(S.shared.filter(s => s.who).map(s => [s.id, s.who.map(name).filter(Boolean)])) };
  try {
    const r = await fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "送出失敗");
    try { localStorage.removeItem(KEY); } catch (e) {}
    // 送出成功：直接回 LINE 對話，請款卡會貼在聊天室
    $("#app").hidden = true; $("#bar").hidden = true;
    $("#done").innerHTML = \`<div class="ok">✓</div><h2>\${j.fix ? "已更正" : "已送出"}</h2><p>回到聊天室，按「<b>貼出請款單</b>」或說「請款單」就會貼出。</p><p class="small">10 分鐘內沒人按，\${S.bot}會自動貼。</p>\`;
    $("#done").hidden = false; window.scrollTo(0, 0);
    if (!backToChat()) { try { window.close(); } catch (e) {} }
  } catch (e) { toast(e.message); $("#send").disabled = false; $("#send").textContent = "送出結算"; }
}
function toast(t) { let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); } el.textContent = t; el.className = "show"; setTimeout(() => el.className = "", 2600); }
$("#payee").value = S.payee || "";
renderGuests();
liffInit();
</script>`);
}

function html(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="robots" content="noindex"><script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script><title>${esc(title)}</title><style>
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
.inc.me{color:var(--ink);font-weight:600}.late{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--sub)}.late input,.night input{width:52px;padding:5px 6px;border:1px solid var(--line);border-radius:8px;font-size:15px;background:var(--card);color:var(--ink);margin:0 4px}
.night{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 0;font-size:14px}.night:empty{display:none}.pill.all{border-style:dashed}.pill.all.on{border-style:solid}.segrow{display:flex;align-items:flex-start;gap:8px;margin:8px 0;padding-top:8px;border-top:1px dashed var(--line)}.segrow .u{display:flex;align-items:center;gap:4px;font-size:14px;color:var(--sub);flex:none}.segrow .u input{width:56px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--card);color:var(--ink)}.segrow .pills{flex:1;margin:0}.del.sm{width:28px;height:28px;font-size:16px}.segfoot{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--sub);margin-top:4px}
.done h2{font-size:21px;margin:0 0 6px}.done .back{display:inline-block;margin-top:14px;padding:12px 28px;border-radius:24px;background:var(--brand);color:#fff;text-decoration:none;font-weight:700}.done p{color:var(--sub);margin:6px 0}.done .list{text-align:left;margin-top:18px}.small{font-size:13px}
#toast{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);background:#1F2937;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}#toast.show{opacity:1}
.empty{text-align:center;color:var(--sub);padding:80px 0}
.payee{margin-top:12px;background:var(--card);border-radius:16px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.payee label{display:flex;align-items:center;gap:6px;font-weight:700;font-size:15px;margin-bottom:8px}.payee small{font-weight:500;font-size:11px;color:var(--sub);background:var(--soft);border-radius:6px;padding:1px 6px}
.payee input{width:100%;font:inherit;font-size:16px;padding:8px 10px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);outline:none}.payee input:focus{border-color:var(--brand)}.payee .chips{margin-top:8px}.payee .chip{border:1.5px solid var(--line);box-shadow:none}.chip.on{background:var(--brand);border-color:var(--brand);color:#fff}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
