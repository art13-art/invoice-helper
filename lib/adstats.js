// 廣告報表（Meta／Google Ads 等匯出的 Excel、CSV）：先用程式把數字算好，再交給 AI 解讀，避免 AI 心算出錯或表格太長被截斷。
// 認得的欄位：名稱、曝光、觸及、點擊、花費、轉換（成果／購買）、轉換價值（營收）。中英文欄名都可以。

const COLS = [
  ["name", /^(行銷活動|廣告活動|廣告組合|廣告群組|廣告)(名稱)?$|campaign( name)?|ad set( name)?|ad group( name)?|^ad( name)?$|名稱/i],
  ["ctr", /點擊率|ctr/i],
  ["impr", /曝光|impressions?|^impr/i],
  ["reach", /觸及|reach/i],
  ["clicks", /點擊|clicks?/i],
  ["spend", /花費|支出|amount spent|^spend|^cost$|^費用|已花費/i],
  ["rev", /轉換(價)?值|購買.*值|conv(ersion)?s?\.? value|purchase.*value|revenue|營收|銷售額/i],
  ["conv", /^(轉換|購買|成果|結果)(次數|數)?$|^results?$|^conversions?$|^purchases?$|^購買次數$|^轉換次數$/i],
];
const SKIP = /每次|每千|per |率|rate|頻率|frequency|roas|cpm|cpc|cpa|排名|ranking|預算|budget|開始|結束|日期|date|狀態|status|id$/i;

const num = v => { const s = String(v ?? "").replace(/[,\s$NT＄元%]/g, ""); if (!/^-?\d+(\.\d+)?$/.test(s)) return null; return Number(s); };
const fmt = (v, d = 0) => v == null || !isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => v == null || !isFinite(v) ? "—" : (v * 100).toFixed(2) + "%";

/* 找表頭：前 10 列裡，認得最多指標欄位的那一列 */
function mapHeader(rows) {
  let best = null;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const map = {};
    rows[i].forEach((h, j) => {
      const s = String(h || "").trim(); if (!s) return;
      for (const [k, re] of COLS) {
        if (map[k] != null) continue;
        if (k !== "name" && k !== "ctr" && SKIP.test(s)) continue;
        if (re.test(s)) { map[k] = j; break; }
      }
    });
    const score = ["impr", "clicks", "spend", "conv", "rev"].filter(k => map[k] != null).length;
    if (score >= 2 && (!best || score > best.score)) best = { i, map, score };
  }
  return best;
}

/* rows：二維陣列（第一個工作表或 CSV）。認不出是廣告報表就回傳 null */
export function adSummary(rows, label = "") {
  const h = mapHeader(rows);
  if (!h) return null;
  const m = h.map, get = (r, k) => m[k] == null ? null : num(r[m[k]]);
  const items = [];
  for (const r of rows.slice(h.i + 1)) {
    const name = m.name != null ? String(r[m.name] || "").trim() : "";
    if (/^(總計|合計|total|grand total|小計)/i.test(name) || /^(總計|合計|total)/i.test(String(r[0] || ""))) continue;
    const it = { name: name || `第 ${items.length + 1} 列`, impr: get(r, "impr"), clicks: get(r, "clicks"), spend: get(r, "spend"), conv: get(r, "conv"), rev: get(r, "rev") };
    if (["impr", "clicks", "spend", "conv", "rev"].every(k => it[k] == null)) continue;
    items.push(it);
  }
  if (!items.length) return null;
  const sum = k => items.some(x => x[k] != null) ? items.reduce((s, x) => s + (x[k] || 0), 0) : null;
  const T = { impr: sum("impr"), clicks: sum("clicks"), spend: sum("spend"), conv: sum("conv"), rev: sum("rev") };
  const derive = x => ({ ...x, ctr: x.impr ? x.clicks / x.impr : null, cpc: x.clicks ? x.spend / x.clicks : null, cpm: x.impr ? x.spend / x.impr * 1000 : null,
    cpa: x.conv ? x.spend / x.conv : null, roas: x.spend ? x.rev / x.spend : null, cvr: x.clicks ? x.conv / x.clicks : null });
  const t = derive(T), all = items.map(derive);
  const line = x => [x.impr != null && `曝光 ${fmt(x.impr)}`, x.clicks != null && `點擊 ${fmt(x.clicks)}`, x.ctr != null && `CTR ${pct(x.ctr)}`, x.spend != null && `花費 ${fmt(x.spend)}`,
    x.cpc != null && `CPC ${fmt(x.cpc, 2)}`, x.cpm != null && `CPM ${fmt(x.cpm, 1)}`, x.conv != null && `轉換 ${fmt(x.conv)}`, x.cpa != null && `CPA ${fmt(x.cpa, 1)}`,
    x.cvr != null && `CVR ${pct(x.cvr)}`, x.rev != null && `營收 ${fmt(x.rev)}`, x.roas != null && x.rev != null && `ROAS ${fmt(x.roas, 2)}`].filter(Boolean).join("｜");
  // 排名：有營收看 ROAS，有轉換看 CPA，否則看 CTR；花費太少（不到平均 20%）的不排，免得樣本太小
  const avgSpend = T.spend ? T.spend / items.length : 0;
  const pool = all.filter(x => !avgSpend || (x.spend || 0) >= avgSpend * 0.2);
  const by = T.rev ? ["roas", -1, "ROAS"] : T.conv ? ["cpa", 1, "CPA"] : T.clicks ? ["ctr", -1, "CTR"] : null;
  let rank = "";
  const s = by ? pool.filter(x => x[by[0]] != null && isFinite(x[by[0]])).sort((a, b) => by[1] > 0 ? a[by[0]] - b[by[0]] : b[by[0]] - a[by[0]]) : [];
  const k = Math.min(3, Math.floor(s.length / 2));   // 最好、最差各取幾個，不重複
  if (k >= 1) {
    const top = s.slice(0, k), bottom = s.slice(-k).reverse();
    rank = `\n依 ${by[2]} 排（花費太少的不排）：\n最好：\n${top.map(x => "・" + x.name + "：" + line(x)).join("\n")}\n最差：\n${bottom.map(x => "・" + x.name + "：" + line(x)).join("\n")}`;
  }
  const zero = all.filter(x => (x.spend || 0) > 0 && x.conv === 0).map(x => x.name).slice(0, 10);
  const head = `（系統用程式算好的數字${label ? "，" + label : ""}：共 ${items.length} 列；請以這些數字為準，不要自己重算。金額單位照原表）`;
  return [head, "合計：" + line(t), rank.trim(), zero.length ? `有花費但轉換是 0：${zero.join("、")}` : "",
    items.length <= 40 ? "\n每列：\n" + all.map(x => "・" + x.name + "：" + line(x)).join("\n") : ""].filter(Boolean).join("\n");
}

/* 簡單 CSV／TSV 解析（處理引號） */
export function parseDelimited(text) {
  const sep = (text.split("\n")[0].match(/\t/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
