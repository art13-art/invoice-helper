// Taiwan business registry lookup (Ministry of Economic Affairs open data, data.gcis.nat.gov.tw).
//   GET /api/company?ubn=12345678  → one record with details
//   GET /api/company?q=關鍵字       → up to 20 active companies whose name contains the keyword
// Runs as a Cloudflare Pages Function so browsers avoid cross-origin limits; answers are cached for a day.
const API = "https://data.gcis.nat.gov.tw/od/data/api/";
const COMPANY = "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";   // 公司登記基本資料（依統編）
const BUSINESS = "426D5542-5F05-43EB-83F9-F1300F14E1F1";  // 商業登記基本資料（依統編）
const BY_NAME = "6BBA2268-1367-4B42-9CCA-BC17499EBE8C";   // 公司登記關鍵字查詢

async function get(id, filter, top = 1) {
  const url = `${API}${id}?$format=json&$filter=${encodeURIComponent(filter).replace(/%20/g, "%20")}&$skip=0&$top=${top}`;
  const r = await fetch(url, { headers: { "User-Agent": "taxtools.tw" }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) throw new Error("upstream " + r.status);
  const text = (await r.text()).trim();
  if (!text) return [];
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? rows : [];
}
const pick = (o, ...keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); } return ""; };
const num = v => { const n = Number(String(v || "").replace(/[^\d]/g, "")); return n || 0; };

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

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const ubn = (u.searchParams.get("ubn") || "").trim();
  const q = (u.searchParams.get("q") || "").trim();
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": status === 200 ? "public, max-age=86400" : "no-store" } });
  try {
    if (ubn) {
      if (!/^\d{8}$/.test(ubn)) return json({ error: "統一編號需為 8 碼數字" }, 400);
      const c = (await get(COMPANY, `Business_Accounting_NO eq ${ubn}`))[0];
      if (c && pick(c, "Company_Name")) return json(company(c));
      const b = (await get(BUSINESS, `President_No eq ${ubn}`))[0];
      if (b && pick(b, "Business_Name")) return json(business(b));
      return json({ name: null });
    }
    if (q) {
      if (q.length < 2 || q.length > 40 || /[<>'"%]/.test(q)) return json({ error: "請輸入 2 個字以上的公司名稱" }, 400);
      const rows = await get(BY_NAME, `Company_Name like ${q} and Company_Status eq 01`, 20);
      return json({ results: rows.map(r => ({ ubn: pick(r, "Business_Accounting_NO"), name: pick(r, "Company_Name"),
        status: pick(r, "Company_Status_Desc") || "核准設立", address: pick(r, "Company_Location") })).filter(r => r.ubn && r.name) });
    }
    return json({ error: "請提供 ubn 或 q" }, 400);
  } catch (e) {
    return json({ error: "查詢服務暫時無法使用，請稍後再試" }, 502);
  }
}
