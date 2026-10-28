// /split/form?t=<群組代碼>&id=<帳單> — 填寫拆帳名單（名字、男女、併給誰）。
// 送出只存成草稿；Ben 回 LINE 按「名單填好了」才套用。
import { kv } from "../../lib/assistant.js";
import { loadSplit, saveDraft, fmt } from "../../lib/split.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function who(request, env) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "";
  const chatId = t.length >= 20 ? await kv.get(env.DB, "splittok:" + t) : null;
  return { chatId, id: u.searchParams.get("id") || "" };
}

export async function onRequestPost({ request, env }) {
  const { chatId, id } = await who(request, env);
  if (!chatId) return Response.json({ error: "連結不對或已失效" }, { status: 404 });
  let body = {}; try { body = await request.json(); } catch (e) {}
  const r = await saveDraft(env.DB, id, chatId, body);
  return Response.json(r, { status: r.error ? 400 : 200 });
}

export async function onRequestGet({ request, env }) {
  const { chatId, id } = await who(request, env);
  const r = chatId ? await loadSplit(env.DB, id) : null;
  if (!r || r.chat_id !== chatId) return html("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const d = r.d;
  if (!["ask", "pick"].includes(r.status)) return html("名單", `<div class="empty">${r.status === "done" ? "這張已經拆完了。" : "這張已經取消了。"}</div>`);
  // 預填：草稿 → 已套用的名單 → 帳單人數（「5+0」＝男 5、女 0）
  let rows = [];
  const src = d.draft?.guests?.length ? d.draft : d.guests?.length ? { guests: d.guests, merge: d.merge || {} } : null;
  if (src) rows = src.guests.map(g => ({ name: g.name, sex: g.sex, to: src.merge[g.id] ? (src.guests.find(x => x.id === src.merge[g.id]) || {}).name || "" : "" }));
  else {
    const m = String(d.guests_note || "").match(/(\d+)\s*\+\s*(\d+)/), one = String(d.guests_note || "").match(/(\d+)/);
    const men = m ? +m[1] : one ? +one[1] : 3, women = m ? +m[2] : 0;
    rows = [...Array(Math.min(men, 12)).fill(0).map(() => ({ name: "", sex: "男", to: "" })), ...Array(Math.min(women, 12)).fill(0).map(() => ({ name: "", sex: "女", to: "" }))].slice(0, 12);
    if (!rows.length) rows = [{ name: "", sex: "男", to: "" }];
  }
  const { results } = await env.DB.prepare("SELECT DISTINCT name FROM line_members WHERE chat_id=? AND name IS NOT NULL AND optout=0 ORDER BY updated DESC LIMIT 30").bind(chatId).all();
  const members = results.map(x => x.name).filter(n => n && n !== "成員");
  const state = { rows, members };
  return html("填寫名單", `
  <header class="hero"><div class="kicker">拆帳｜填寫名單</div><h1>${esc(d.store || "帳單")}</h1>
    <div class="meta">${esc([d.date, d.bill_no ? "單號 " + d.bill_no : "", d.guests_note ? "帳單人數 " + d.guests_note : ""].filter(Boolean).join("｜"))}</div>
    <div class="total"><span>現金總額</span><b>$${fmt(d.cash)}</b></div></header>
  <main id="app">
    <p class="hint">填每位客人的名字和男女。要跟別人一起請款的，在「併給」選付錢的人。</p>
    <div id="rows"></div>
    <button class="add" id="add" type="button">＋ 加一位</button>
    ${members.length ? `<h2>群組成員（點一下帶入空白的那列）</h2><div class="chips" id="chips"></div>` : ""}
  </main>
  <footer class="bar"><div class="count" id="count"></div><button id="send" type="button">送出名單</button></footer>
  <div class="done" id="done" hidden><div class="ok">✓</div><h2>名單存好了</h2><p>回到 LINE，按卡片上的「名單填好了」。</p><p class="small">要改的話，重新整理這頁改完再送出一次。</p></div>
<script>
const S = ${JSON.stringify(state).replace(/</g, "\\u003c")};
const $ = s => document.querySelector(s);
function render() {
  const names = S.rows.map(r => r.name.trim()).filter(Boolean);
  $("#rows").innerHTML = S.rows.map((r, i) => \`
    <div class="row">
      <div class="num">\${i + 1}</div>
      <div class="fields">
        <input class="name" data-i="\${i}" placeholder="名字" value="\${esc(r.name)}" maxlength="20" autocomplete="off">
        <div class="line2">
          <div class="seg" role="group">\${["男", "女"].map(x => \`<button type="button" data-sex="\${x}" data-i="\${i}" class="\${r.sex === x ? "on" : ""}">\${x}</button>\`).join("")}</div>
          <label class="to">併給<select data-i="\${i}"><option value="">不合併</option>\${names.filter(n => n !== r.name.trim()).map(n => \`<option \${r.to === n ? "selected" : ""}>\${esc(n)}</option>\`).join("")}</select></label>
        </div>
      </div>
      <button type="button" class="del" data-del="\${i}" aria-label="刪除">×</button>
    </div>\`).join("");
  if ($("#chips")) $("#chips").innerHTML = S.members.map(n => \`<button type="button" class="chip \${names.includes(n) ? "used" : ""}" data-m="\${esc(n)}">\${esc(n)}</button>\`).join("");
  const n = names.length, m = S.rows.filter(r => r.name.trim() && r.sex === "男").length;
  $("#count").textContent = \`\${n} 人（男 \${m}、女 \${S.rows.filter(r => r.name.trim() && r.sex === "女").length}）\`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// 打字時不重畫輸入框（中文輸入法選字中重畫會打斷），只更新「併給」選單、成員和人數
function derived() {
  const names = S.rows.map(r => r.name.trim()).filter(Boolean);
  document.querySelectorAll("select[data-i]").forEach(sel => { const r = S.rows[+sel.dataset.i]; sel.innerHTML = '<option value="">不合併</option>' + names.filter(n => n !== r.name.trim()).map(n => \`<option \${r.to === n ? "selected" : ""}>\${esc(n)}</option>\`).join(""); });
  if ($("#chips")) document.querySelectorAll("#chips .chip").forEach(c => c.classList.toggle("used", names.includes(c.dataset.m)));
  $("#count").textContent = \`\${names.length} 人（男 \${S.rows.filter(r => r.name.trim() && r.sex === "男").length}、女 \${S.rows.filter(r => r.name.trim() && r.sex === "女").length}）\`;
}
document.addEventListener("input", e => { if (e.target.classList.contains("name")) { const i = +e.target.dataset.i, old = S.rows[i].name.trim(); S.rows[i].name = e.target.value; if (old) S.rows.forEach(r => { if (r.to === old) r.to = e.target.value.trim(); }); derived(); } });
document.addEventListener("change", e => { if (e.target.tagName === "SELECT") { S.rows[+e.target.dataset.i].to = e.target.value; } });
document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.sex) { S.rows[+b.dataset.i].sex = b.dataset.sex; render(); }
  else if (b.dataset.del != null) { const gone = S.rows[+b.dataset.del].name; S.rows.splice(+b.dataset.del, 1); S.rows.forEach(r => { if (r.to === gone) r.to = ""; }); if (!S.rows.length) S.rows.push({ name: "", sex: "男", to: "" }); render(); }
  else if (b.dataset.m) { const r = S.rows.find(r => !r.name.trim()); if (r) r.name = b.dataset.m; else if (S.rows.length < 12) S.rows.push({ name: b.dataset.m, sex: "男", to: "" }); render(); }
  else if (b.id === "add") { if (S.rows.length < 12) { S.rows.push({ name: "", sex: "男", to: "" }); render(); document.querySelector(\`.name[data-i="\${S.rows.length - 1}"]\`).focus(); } }
  else if (b.id === "send") send();
});
async function send() {
  const guests = S.rows.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), sex: r.sex, to: r.to }));
  if (!guests.length) { alertBox("至少要填一個名字"); return; }
  const dup = guests.map(g => g.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) { alertBox("名字重複了：" + dup); return; }
  $("#send").disabled = true; $("#send").textContent = "送出中…";
  try {
    const r = await fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guests }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "送出失敗");
    $("#app").hidden = true; document.querySelector(".bar").hidden = true; $("#done").hidden = false; window.scrollTo(0, 0);
  } catch (e) { alertBox(e.message); $("#send").disabled = false; $("#send").textContent = "送出名單"; }
}
function alertBox(t) { let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); } el.textContent = t; el.className = "show"; setTimeout(() => el.className = "", 2400); }
render();
</script>`);
}

function html(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{--brand:#12524F;--soft:#EEF2F1;--ink:#1F2937;--sub:#6B7280;--line:#E5E7EB;--bg:#F6F8F7;--card:#FFFFFF;--accent:#F28C28}
@media (prefers-color-scheme:dark){:root{--soft:#1E2B2A;--ink:#E8EEED;--sub:#9AA8A6;--line:#2A3735;--bg:#0F1716;--card:#16201F}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:96px}
.hero{background:var(--brand);color:#fff;padding:22px 18px 24px;border-radius:0 0 22px 22px}.hero h1{margin:2px 0 4px;font-size:23px}
.kicker{font-size:12px;color:#CFE3E1;letter-spacing:1px}.meta{font-size:13px;color:#CFE3E1}
.total{display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.18)}.total span{color:#CFE3E1;font-size:13px}.total b{font-size:26px;font-variant-numeric:tabular-nums}
main{max-width:560px;margin:0 auto;padding:4px 16px 20px}.hint{font-size:13.5px;color:var(--sub);margin:16px 4px 12px}
h2{font-size:13px;color:var(--sub);font-weight:600;margin:22px 4px 10px}
.row{display:flex;gap:10px;align-items:flex-start;background:var(--card);border-radius:16px;padding:12px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.num{width:26px;height:26px;border-radius:13px;background:var(--soft);color:var(--brand);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;margin-top:7px;flex:none}
.fields{flex:1;min-width:0}.name{width:100%;font:inherit;font-size:17px;padding:8px 10px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);outline:none}
.name:focus{border-color:var(--brand)}.line2{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.seg{display:flex;background:var(--soft);border-radius:10px;padding:3px}.seg button{border:0;background:none;font:inherit;font-size:14px;padding:5px 16px;border-radius:8px;color:var(--sub)}
.seg button.on{background:var(--brand);color:#fff;font-weight:600}
.to{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--sub)}.to select{font:inherit;font-size:14px;padding:5px 8px;border-radius:9px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);max-width:150px}
.del{border:0;background:none;color:var(--sub);font-size:22px;line-height:1;padding:6px 4px;margin-top:3px}
.add{width:100%;border:1.5px dashed var(--line);background:none;border-radius:14px;padding:12px;font:inherit;color:var(--brand);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{border:0;background:var(--card);border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06)}.chip.used{opacity:.4}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px}
.count{flex:1;font-size:14px;color:var(--sub)}#send{border:0;background:var(--brand);color:#fff;font:inherit;font-weight:700;padding:12px 26px;border-radius:12px}#send:disabled{opacity:.6}
.done{text-align:center;padding:60px 24px}.ok{width:64px;height:64px;border-radius:32px;background:var(--brand);color:#fff;font-size:34px;line-height:64px;margin:0 auto 16px}.done h2{font-size:20px;color:var(--ink);margin:0 0 8px}.done p{color:var(--sub);margin:6px 0}.small{font-size:13px}
#toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#1F2937;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}#toast.show{opacity:1}
.empty{text-align:center;color:var(--sub);padding:80px 0}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
