// Looks up a Taiwan business name by 統一編號 from the Ministry of Economic Affairs open data (GCIS).
// Runs on Cloudflare Pages Functions so the browser avoids cross-origin limits; results are cached for a day.
const COMPANY = "https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6";   // 公司登記基本資料
const BUSINESS = "https://data.gcis.nat.gov.tw/od/data/api/426D5542-5F05-43EB-83F9-F1300F14E1F1";  // 商業登記基本資料

async function query(base, field, ubn) {
  const url = `${base}?$format=json&$filter=${field}%20eq%20${ubn}&$skip=0&$top=1`;
  const r = await fetch(url, { headers: { "User-Agent": "taxtools.tw invoice helper" }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return null;
  const text = await r.text();
  if (!text.trim()) return null;
  try { const rows = JSON.parse(text); return Array.isArray(rows) && rows.length ? rows[0] : null; } catch { return null; }
}

export async function onRequestGet({ request }) {
  const ubn = new URL(request.url).searchParams.get("ubn") || "";
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" } });
  if (!/^\d{8}$/.test(ubn)) return json({ error: "統一編號需為 8 碼數字" }, 400);
  try {
    const c = await query(COMPANY, "Business_Accounting_NO", ubn);
    if (c && c.Company_Name) return json({ name: c.Company_Name.trim(), status: (c.Company_Status_Desc || "").trim(), kind: "公司" });
    const b = await query(BUSINESS, "President_No", ubn);
    if (b && b.Business_Name) return json({ name: b.Business_Name.trim(), status: (b.Business_Current_Status_Desc || "").trim(), kind: "商業" });
    return json({ name: null });
  } catch (e) {
    return json({ error: "查詢服務暫時無法使用" }, 502);
  }
}
