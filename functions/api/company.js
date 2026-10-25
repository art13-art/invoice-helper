// Taiwan business registry lookup.
//   GET /api/company?ubn=12345678  → one record with details
//   GET /api/company?q=關鍵字       → up to 20 active companies whose name contains the keyword
//   add &debug=1 to see which upstream answered or failed
// Source 1: Ministry of Economic Affairs open data (data.gcis.nat.gov.tw).
// Source 2 (fallback): g0v company mirror (company.g0v.ronny.tw), built from the same registry data.
// The government host sometimes refuses or times out on requests from overseas data centres,
// so each source has a short timeout and the next one is tried.
const API = "https://data.gcis.nat.gov.tw/od/data/api/";
const COMPANY = "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";   // 公司登記基本資料（依統編）
const BUSINESS = "426D5542-5F05-43EB-83F9-F1300F14E1F1";  // 商業登記基本資料（依統編）
const BY_NAME = "6BBA2268-1367-4B42-9CCA-BC17499EBE8C";   // 公司登記關鍵字查詢
const G0V = "https://company.g0v.ronny.tw/api/";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; taxtools.tw; +https://taxtools.tw)", "Accept": "application/json" };

async function fetchJSON(url, ms = 7000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms), cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = (await r.text()).trim();
  if (!text) return null;
  if (text[0] === "<") throw new Error("HTML instead of JSON");
  return JSON.parse(text);
}
async function gcis(id, filter, top = 1) {
  const rows = await fetchJSON(`${API}${id}?$format=json&$filter=${encodeURIComponent(filter)}&$skip=0&$top=${top}`);
  return Array.isArray(rows) ? rows : [];
}
const pick = (o, ...keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && typeof v !== "object" && String(v).trim() !== "") return String(v).trim(); } return ""; };
const num = v => { const n = Number(String(v || "").replace(/[^\d]/g, "")); return n || 0; };
const roc = d => d && typeof d === "object" && d.year ? String(d.year - 1911).padStart(3, "0") + String(d.month).padStart(2, "0") + String(d.day).padStart(2, "0") : (typeof d === "string" ? d : "");

function company(c) {
  return { kind: "公司", ubn: pick(c, "Business_Accounting_NO"), name: pick(c, "Company_Name"),
    status: pick(c, "Company_Status_Desc"), address: pick(c, "Company_Location"),
    owner: pick(c, "Responsible_Name"), capital: num(pick(c, "Paid_In_Capital_Amount", "Capital_Stock_Amount")),
    setup: pick(c, "Company_Setup_Date"), changed: pick(c, "Change_Of_Approval_Data"), authority: pick(c, "Register_Organization_Desc") };
}
function business(b) {
  return { kind: "商業（行號）", ubn: pick(b, "President_No"), name: pick(b, "Business_Name"),
    status: pick(b, "Business_Current_Status_Desc", "Business_Current_Status"), address: pick(b, "Business_Address"),
    owner: pick(b, "Responsible_Name"), capital: num(pick(b, "Business_Register_Funds", "Capital_Amount")),
    setup: pick(b, "Business_Setup_Approve_Date", "Setup_Date"), changed: pick(b, "Business_Last_Change_Date"), authority: pick(b, "Agency_Desc", "Agency") };
}
function g0vRecord(ubn, d) {
  const isCo = !!pick(d, "公司名稱");
  return { kind: isCo ? "公司" : "商業（行號）", ubn,
    name: pick(d, "公司名稱", "商業名稱", "名稱"), status: pick(d, "公司狀況", "現況", "登記現況"),
    address: pick(d, "公司所在地", "地址"), owner: pick(d, "代表人姓名", "負責人姓名"),
    capital: num(pick(d, "實收資本額(元)", "資本總額(元)", "資本額(元)")),
    setup: roc(d["核准設立日期"]), changed: roc(d["最後核准變更日期"]), authority: pick(d, "登記機關") };
}

async function byUbn(ubn, log) {
  try {
    const c = (await gcis(COMPANY, `Business_Accounting_NO eq ${ubn}`))[0];
    if (c && pick(c, "Company_Name")) { log.push("gcis company: hit"); return company(c); }
    const b = (await gcis(BUSINESS, `President_No eq ${ubn}`))[0];
    if (b && pick(b, "Business_Name")) { log.push("gcis business: hit"); return business(b); }
    log.push("gcis: not found"); return { name: null };
  } catch (e) { log.push("gcis: " + e.message); }
  try {
    const j = await fetchJSON(`${G0V}show/${ubn}`);
    const d = j && j.data;
    if (d && (pick(d, "公司名稱", "商業名稱", "名稱"))) { log.push("g0v: hit"); return g0vRecord(ubn, d); }
    log.push("g0v: not found"); return { name: null };
  } catch (e) { log.push("g0v: " + e.message); }
  return null;
}

async function byName(q, log) {
  try {
    const rows = await gcis(BY_NAME, `Company_Name like ${q} and Company_Status eq 01`, 20);
    log.push("gcis search: " + rows.length);
    return rows.map(r => ({ ubn: pick(r, "Business_Accounting_NO"), name: pick(r, "Company_Name"),
      status: pick(r, "Company_Status_Desc") || "核准設立", address: pick(r, "Company_Location") })).filter(r => r.ubn && r.name);
  } catch (e) { log.push("gcis search: " + e.message); }
  try {
    const j = await fetchJSON(`${G0V}search?q=${encodeURIComponent(q)}`);
    const rows = (j && Array.isArray(j.data)) ? j.data : [];
    log.push("g0v search: " + rows.length);
    return rows.map(r => ({ ubn: pick(r, "統一編號"), name: pick(r, "公司名稱", "商業名稱", "名稱"),
      status: pick(r, "公司狀況", "現況"), address: pick(r, "公司所在地", "地址") }))
      .filter(r => r.ubn && r.name && (!r.status || /核准設立|核准登記|營業中/.test(r.status))).slice(0, 20);
  } catch (e) { log.push("g0v search: " + e.message); }
  return null;
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const ubn = (u.searchParams.get("ubn") || "").trim();
  const q = (u.searchParams.get("q") || "").trim();
  const debug = u.searchParams.has("debug");
  const log = [];
  const json = (body, status = 200) => new Response(JSON.stringify(debug ? { ...body, log } : body), {
    status, headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 && !debug ? "public, max-age=86400" : "no-store" } });
  const down = { error: "查詢服務暫時無法使用，請稍後再試" };
  if (ubn) {
    if (!/^\d{8}$/.test(ubn)) return json({ error: "統一編號需為 8 碼數字" }, 400);
    const r = await byUbn(ubn, log);
    return r ? json(r) : json(down, 502);
  }
  if (q) {
    if (q.length < 2 || q.length > 40 || /[<>'"%]/.test(q)) return json({ error: "請輸入 2 個字以上的公司名稱" }, 400);
    const r = await byName(q, log);
    return r ? json({ results: r }) : json(down, 502);
  }
  return json({ error: "請提供 ubn 或 q" }, 400);
}
