// 由 assets/rates.js 產生「稅務數字速查」頁（/rates/）與機器可讀的 /rates.json。
// 計算機和這一頁用同一份數字，改 rates.js 後重跑：node scripts/build_rates.js && python3 scripts/seo.py
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "assets/rates.js"), "utf8"), ctx);
const R = ctx.window.RATES;

const n = v => Number(v).toLocaleString("en-US");
const pct = v => `${+(v * 100).toFixed(4)}%`;
const roc = iso => { const [y, m, d] = iso.split("-").map(Number); return `${y - 1911} 年 ${m} 月 ${d} 日`; };
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const P = R.pit, I = R.insurance;

const sections = [
  { id: "wage", h: `${R.year} 年最低工資（基本工資）`, lead: `${R.year} 年（${R.year + 1911} 年）最低工資每月 ${n(R.basicWage)} 元、每小時 196 元，${R.year} 年 1 月 1 日起適用；114 年起「基本工資」依最低工資法改稱「最低工資」。`,
    rows: [["每月最低工資", `${n(R.basicWage)} 元`, "最低工資法；勞動部公告"], ["每小時最低工資", "196 元", "最低工資法；勞動部公告"],
           ...(R.nextMinWage ? [[`${+R.nextMinWage.from.slice(0, 4) - 1911} 年 1 月 1 日起`, `每月 ${n(R.nextMinWage.month)} 元、每小時 ${n(R.nextMinWage.hour)} 元`, "行政院 115 年 10 月 14 日核定"]] : [])], tool: ["/overtime-pay/", "加班費計算機"] },
  { id: "vat", h: "營業稅", lead: `加值型營業稅稅率 ${pct(R.vat.rate)}，含稅金額 ÷ ${1 + R.vat.rate} 就是未稅金額。`,
    rows: [["加值型營業稅稅率", pct(R.vat.rate), "加值型及非加值型營業稅法第 10 條"],
           ["小規模營業人（查定課徵）", "1%", "加值型及非加值型營業稅法第 13 條"],
           ["小規模營業人起徵點（114 年 1 月 1 日起）", "買賣業每月 10 萬元、勞務業每月 5 萬元", "財政部公告"]], tool: ["/tax-included/", "含稅未稅計算機"] },
  { id: "withholding", h: "各類所得扣繳率（居住者）", lead: `公司付房租、執行業務報酬給境內居住的個人，扣繳率 ${pct(R.rent.resident)}；每次應扣稅額不超過 ${n(R.rent.exemptTaxAtOrBelow)} 元（給付 2 萬元以下）免扣繳。`,
    rows: [["租賃所得（格式代號 51）", `${pct(R.rent.resident)}；每次扣繳稅額 ≤ ${n(R.rent.exemptTaxAtOrBelow)} 元免扣`, R.sources.rent],
           ["執行業務、稿費等（9A、9B）", `${pct(R.fee.resident)}；每次扣繳稅額 ≤ ${n(R.fee.exemptTaxAtOrBelow)} 元免扣`, R.sources.fee],
           ["稿費、版稅、講演鐘點費免稅額", `全年合計 ${n(R.fee.royaltyAnnualTaxFree)} 元`, "所得稅法第 4 條第 1 項第 23 款"],
           ["非固定薪資、兼職薪資（50）", `每次給付達 ${n(R.salary.nonFixedMin)} 元扣 ${pct(R.salary.nonFixedRate)}`, "薪資所得扣繳辦法"]], tool: ["/rent-withholding/", "租金扣繳計算機"] },
  { id: "nonresident", h: "各類所得扣繳率（非居住者）", lead: `付給非居住者（一年在台未滿 183 天）的租金、執行業務報酬扣繳率 ${pct(R.rent.nonResident)}。`,
    rows: [["租賃所得", pct(R.rent.nonResident), R.sources.rent],
           ["執行業務、稿費等", `${pct(R.fee.nonResident)}；稿費等每次給付 ≤ ${n(R.fee.nonResident9BExemptAtOrBelow)} 元免扣`, R.sources.fee],
           ["薪資", `${pct(R.salary.nonResidentHigh)}；全月給付 ≤ ${n(R.salary.nonResidentLowMax)} 元（最低工資 1.5 倍）扣 ${pct(R.salary.nonResidentLow)}`, "各類所得扣繳率標準"]], tool: ["/labor-report/", "勞報單扣繳計算機"] },
  { id: "nhi", h: "二代健保補充保費", lead: `補充保費費率 ${pct(R.nhi.rate)}，執行業務、租金、股利、利息等單次給付達 ${n(R.nhi.minPerPayment)} 元起扣，兼職薪資單次達最低工資 ${n(R.nhi.partTimeMin)} 元起扣。`,
    rows: [["補充保費費率", pct(R.nhi.rate), R.sources.nhi],
           ["執行業務、租金、股利、利息起扣", `單次給付達 ${n(R.nhi.minPerPayment)} 元，上限 ${n(R.nhi.capPerPayment)} 元`, R.sources.nhi],
           ["兼職薪資起扣", `單次給付達 ${n(R.nhi.partTimeMin)} 元（最低工資）`, R.sources.nhi]], tool: ["/labor-report/", "勞報單扣繳計算機"] },
  { id: "insurance", h: "勞保、健保、勞退費率", lead: `勞保（含就業保險）費率 ${pct(I.li.ordinary + I.li.employment)}，勞工自付 ${pct(I.li.worker)}；健保費率 ${pct(I.nhi.rate)}，勞工自付 ${pct(I.nhi.worker)}；雇主勞退提繳 ${pct(I.pension)}。`,
    rows: [["勞保普通事故＋就業保險", `${pct(I.li.ordinary)}＋${pct(I.li.employment)}；勞工 ${pct(I.li.worker)}、雇主 ${pct(I.li.employer)}、政府 10%`, "勞工保險條例、就業保險法"],
           ["勞保投保薪資", `最低 ${n(I.liGrades[0])} 元（部分工時）、最高 ${n(I.li.max)} 元`, "勞工保險投保薪資分級表"],
           ["職災保險", `上下班 ${pct(I.occ.commute)}＋行業別費率（平均 ${pct(I.occ.industryAvg)}），雇主全額；投保上限 ${n(I.occ.max)} 元`, "勞工職業災害保險及保護法"],
           ["健保", `${pct(I.nhi.rate)}；勞工 ${pct(I.nhi.worker)}、雇主 ${pct(I.nhi.employer)}；平均眷口數 ${I.nhi.avgDependents}`, "全民健康保險法"],
           ["健保投保金額", `${n(I.nhiGrades[0])}–${n(I.nhiGrades[I.nhiGrades.length - 1])} 元`, "全民健康保險投保金額分級表"],
           ["勞退雇主提繳", `${pct(I.pension)}，月提繳工資上限 ${n(I.pensionMax)} 元；勞工可自提 0–6%`, "勞工退休金條例第 14 條"]], tool: ["/labor-health/", "勞健保計算機"] },
  { id: "pit", h: `綜合所得稅（${R.year} 年度，${R.year + 1} 年 5 月申報）`, lead: `${R.year} 年度免稅額每人 ${n(P.exemption)} 元、標準扣除額單身 ${n(P.standard)} 元、薪資所得特別扣除額 ${n(P.salary)} 元，課稅級距 5%–40%。`,
    rows: [["免稅額", `每人 ${n(P.exemption)} 元；年滿 70 歲 ${n(P.exemption70)} 元`, "所得稅法第 17 條；財政部公告"],
           ["標準扣除額", `單身 ${n(P.standard)} 元、夫妻合併 ${n(P.standardMarried)} 元`, "所得稅法第 17 條"],
           ["薪資所得、身心障礙特別扣除額", `每人 ${n(P.salary)} 元`, "所得稅法第 17 條"],
           ["儲蓄投資特別扣除額", `${n(P.savings)} 元`, "所得稅法第 17 條"],
           ["長期照顧特別扣除額", `每人 ${n(P.longTermCare)} 元`, "所得稅法第 17 條"],
           ["房屋租金支出特別扣除額", `${n(P.rent)} 元`, "所得稅法第 17 條"],
           ["幼兒學前特別扣除額", `第 1 名 ${n(P.preschool[0])} 元，第 2 名起每名 ${n(P.preschool[1])} 元`, "所得稅法第 17 條"],
           ["基本生活所需費用", `每人 ${n(P.basicLiving)} 元（${P.basicLivingYear} 年度數字，${R.year} 年度公告後更新）`, "納稅者權利保護法第 4 條"],
           ...P.brackets.map((b, i) => [`課稅級距 ${pct(b[1])}`, i === 0 ? `綜合所得淨額 0–${n(b[0])} 元` : b[0] === Infinity ? `${n(P.brackets[i - 1][0] + 1)} 元以上（累進差額 ${n(b[2])}）` : `${n(P.brackets[i - 1][0] + 1)}–${n(b[0])} 元（累進差額 ${n(b[2])}）`, "所得稅法第 5 條；財政部公告"])],
    tool: ["/income-tax/", "綜所稅試算"] },
  { id: "lease", h: "租賃所得", lead: `房東出租房屋的租賃所得，可直接減除 ${pct(R.lease.expenseRate)} 必要損耗及費用；押金按郵政儲金一年期定期儲金固定利率 ${pct(R.lease.depositRate)} 設算租金。`,
    rows: [["必要損耗及費用", `租金收入的 ${pct(R.lease.expenseRate)}`, "所得稅法第 14 條；財政部公告"],
           ["押金設算租金利率", pct(R.lease.depositRate), "所得稅法第 14 條"],
           ["社會住宅包租代管", `每屋每月 ${n(R.lease.socialMonthlyFree)} 元免稅，超過部分減除 ${pct(R.lease.socialExpenseRate)}`, "租賃住宅市場發展及管理條例第 17 條"],
           ["公益出租人", `每屋每月 ${n(R.lease.publicMonthlyFree)} 元免稅`, "住宅法第 15 條"]], tool: ["/landlord-tax/", "房東租金報稅"] },
];

const checked = roc(R.checked);
const body = sections.map(s => `
    <h2 id="${s.id}">${esc(s.h)}</h2>
    <p>${esc(s.lead)}</p>
    <div class="tbl"><table>
      <thead><tr><th>項目</th><th>數字</th><th>依據</th></tr></thead>
      <tbody>
${s.rows.map(r => `        <tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join("\n")}
      </tbody>
    </table></div>
    <p class="more-tool">直接算：<a href="${s.tool[0]}">${s.tool[1]} →</a></p>`).join("\n");

const desc = `${R.year} 年（${R.year + 1911}）台灣稅務與勞健保數字一頁看完：最低工資 ${n(R.basicWage)} 元、營業稅 5%、租金與執行業務扣繳 10%、二代健保補充保費 ${pct(R.nhi.rate)}、勞健保費率、綜所稅免稅額與級距，每項附法條依據與最後查證日期。`;
const html = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${R.year} 年稅務與勞健保數字速查：扣繳率、補充保費、最低工資、綜所稅級距｜稅務小工具</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://taxtools.tw/rates/">
<meta property="article:published_time" content="2026-10-30">
<meta property="article:modified_time" content="${R.checked}">
<link rel="alternate" type="application/json" href="/rates.json" title="機器可讀版本">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#F5F3EE">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<meta name="tt-font" content="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&display=swap">
<link rel="stylesheet" href="/assets/base.css?v=2026103101">
<link rel="stylesheet" href="/assets/nav.css?v=2026103101">
<link rel="stylesheet" href="/assets/guide.css?v=2026103101">
<!--seo-->
<!--/seo-->
</head>
<body>
<header class="site-head">
  <a class="site-brand" href="/"><img src="/icon-192.png" alt="">稅務小工具</a>
  <nav class="site-nav" aria-label="工具"></nav>
</header>

<div class="wrap" role="main">
  <div class="page-head">
    <p class="crumb"><a href="/">稅務小工具</a>›<a href="/guide/">報稅解答</a></p>
    <h1>${R.year} 年稅務與勞健保數字速查</h1>
    <p class="meta">最後查證：${checked}・本站所有計算機都使用這一頁的數字</p>
  </div>

  <article class="art">
    <div class="answer"><p>${esc(desc)} 本頁數字與本站計算機共用同一份資料，法規修正時同步更新；機器可讀版本見 <a href="/rates.json">/rates.json</a>。</p></div>
${body}

    <h2 id="about">這些數字怎麼來的</h2>
    <p>每一項都對照財政部、勞動部、勞保局、健保署公告與全國法規資料庫查證，最後查證日期是 ${checked}。每年 11–12 月主管機關公告下一年度數字後更新。發現數字有誤，請用頁面上方的「意見回饋」告訴我們。編輯原則請見<a href="/about/">關於本站</a>。</p>
  </article>

  <p class="site-foot">本頁依現行法規整理，僅供參考，實際以財政部、勞動部等主管機關規定為準。</p>
</div>
<script src="/assets/nav.js?v=2026103101"></script>
</body>
</html>
`;
fs.mkdirSync(path.join(ROOT, "rates"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "rates/index.html"), html);
const json = { source: "https://taxtools.tw/rates/", publisher: "稅務小工具 taxtools.tw（民間，非政府官方）", checked: R.checked, rocYear: R.year,
  note: "數字僅供參考，實際以主管機關規定為準。", sections: sections.map(s => ({ id: s.id, title: s.h, summary: s.lead, items: s.rows.map(r => ({ item: r[0], value: r[1], basis: r[2] })) })),
  raw: { ...R, pit: { ...R.pit, brackets: R.pit.brackets.map(b => [b[0] === Infinity ? null : b[0], b[1], b[2]]) } } };
fs.writeFileSync(path.join(ROOT, "rates.json"), JSON.stringify(json, null, 1));
console.log("rates/index.html, rates.json", sections.length, "sections");
