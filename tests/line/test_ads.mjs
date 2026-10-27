const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { toBlocks } = await import(R + "/lib/files.js");
const { adSummary } = await import(R + "/lib/adstats.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
// Meta 中文匯出
const meta = ["報告開始,報告結束,行銷活動名稱,觸及人數,曝光次數,連結點擊次數,連結點擊率,花費金額 (TWD),每次連結點擊成本,購買次數,購買轉換值",
  '2026-10-01,2026-10-26,秋季新品,"12,000","30,000",600,2.00%,"6,000",10,30,"24,000"',
  "2026-10-01,2026-10-26,再行銷,5000,10000,400,4.00%,2000,5,20,16000",
  "2026-10-01,2026-10-26,品牌曝光,40000,80000,400,0.50%,4000,10,0,0",
  "2026-10-01,2026-10-26,節慶活動,8000,20000,300,1.50%,3000,10,10,6000",
  "2026-10-01,2026-10-26,總計,,140000,1700,,15000,,60,46000"].join("\n");
const b = await toBlocks(new TextEncoder().encode(meta), "text/csv", "meta.csv");
const s = b[0].text;
t(/共 4 列/.test(s), "rows " + s.slice(0, 80));
t(/合計：曝光 140,000｜點擊 1,700｜CTR 1.21%｜花費 15,000｜CPC 8.82｜CPM 107.1｜轉換 60｜CPA 250.0｜CVR 3.53%｜營收 46,000｜ROAS 3.07/.test(s), "totals " + s.split("\n")[1]);
t(/依 ROAS 排/.test(s) && /最好：\n・再行銷/.test(s) && /最差：\n・品牌曝光/.test(s), "ranking\n" + s);
t(/有花費但轉換是 0：品牌曝光/.test(s), "zero conv");
t(b[1].text.includes("秋季新品"), "raw text kept");
// Google Ads English
const g = [["Campaign", "Impr.", "Clicks", "CTR", "Cost", "Conversions", "Conv. value"], ["A", "1000", "50", "5%", "100", "5", "500"], ["B", "2000", "20", "1%", "200", "1", "100"]];
const gs = adSummary(g);
t(gs && /合計：曝光 3,000｜點擊 70｜CTR 2.33%｜花費 300/.test(gs) && /ROAS 2.00/.test(gs), "google ads " + gs);
// 非廣告表格不動
t(adSummary([["姓名", "電話"], ["王", "09"]]) === null, "non-ad table ignored");
console.log(`${ok} passed, ${bad} failed`);
