// 產生「月薪 X 元勞健保扣多少」對照頁：/salary/ 總表與 /salary/<月薪>/ 各頁。
// 數字全部由 assets/rates.js ＋ assets/insurance.js（和勞健保計算機同一套公式）算出。
// 改 rates.js 後重跑：node scripts/build_salary.js && python3 scripts/seo.py
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "assets/rates.js"), "utf8"), ctx);
const R = ctx.window.RATES, I = R.insurance;
const tt = require(path.join(ROOT, "assets/insurance.js"));

const n = v => Math.round(v).toLocaleString("en-US");
const roc = iso => { const [y, m, d] = iso.split("-").map(Number); return `${y - 1911} 年 ${m} 月 ${d} 日`; };
const ver = (fs.readFileSync(path.join(ROOT, "guide/rent-withholding/index.html"), "utf8").match(/base\.css\?v=(\d+)/) || [])[1];
const Y = R.year, PUB = "2026-10-31", DATE = R.checked > PUB ? R.checked : PUB;  // 最後更新＝上線日或數字最後確認日，取較晚的

const AMOUNTS = [R.basicWage];
for (let w = 30000; w <= 60000; w += 1000) AMOUNTS.push(w);
for (let w = 65000; w <= 100000; w += 5000) AMOUNTS.push(w);
AMOUNTS.push(120000, 150000, 200000);

const LAW = [
  ["https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0050001", "勞工保險條例（普通事故保險費率、負擔比例）"],
  ["https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0050021", "就業保險法（就業保險費率 1%）"],
  ["https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0050031", "勞工職業災害保險及保護法（職災保險由雇主全額負擔）"],
  ["https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0030020", "勞工退休金條例（雇主提繳 6%、勞工自提 0–6%）"],
  ["https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=L0060001", "全民健康保險法（健保費率、負擔比例、眷屬最多計 3 口）"],
];

const head = (title, desc, url, extraCss = "") => `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="https://taxtools.tw${url}">
<meta property="article:published_time" content="${PUB}">
<meta property="article:modified_time" content="${DATE}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#F5F3EE">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<meta name="tt-font" content="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&display=swap">
<link rel="stylesheet" href="/assets/base.css?v=${ver}">
<link rel="stylesheet" href="/assets/nav.css?v=${ver}">
<link rel="stylesheet" href="/assets/guide.css?v=${ver}">${extraCss}
<!--seo-->
<!--/seo-->
</head>
<body>
<header class="site-head">
  <a class="site-brand" href="/"><img src="/icon-192.png" alt="">稅務小工具</a>
  <nav class="site-nav" aria-label="工具"></nav>
</header>
`;
const foot = `
  <p class="site-foot">依勞工保險條例、就業保險法、勞工職業災害保險及保護法、勞工退休金條例、全民健康保險法，以及 ${Y} 年 1 月 1 日起的投保薪資分級表計算（勞保普通事故 ${+(I.li.ordinary * 100).toFixed(2)}%、就保 ${+(I.li.employment * 100).toFixed(2)}%、健保 ${+(I.nhi.rate * 100).toFixed(2)}%、平均眷口數 ${I.nhi.avgDependents}；職災保險以全行業平均 ${+(I.occ.industryAvg * 100).toFixed(2)}% 加上下班 ${+(I.occ.commute * 100).toFixed(2)}% 計）。以全職、整月投保、未滿 65 歲計算，僅供參考，實際以勞保局、健保署繳款單為準。數字最後確認：${roc(R.checked)}。</p>
</div>
<script src="/assets/nav.js?v=${ver}"></script>
</body>
</html>
`;
const lawList = `<h2 id="law">法規與資料來源</h2>
    <ul class="law">
${LAW.map(([u, t]) => `      <li><a href="${u}" rel="noopener">全國法規資料庫：${t}</a></li>`).join("\n")}
      <li><a href="/rates/">本站 ${Y} 年稅務與勞健保數字速查（含投保級距與費率、法條依據）</a></li>
    </ul>`;

const nextOf = (list, g) => list.find(x => x > g);
const rows = [];

for (const w of AMOUNTS) {
  const c = tt(R, w, {});
  const v6 = tt(R, w, { vol: 0.06 });
  const isMin = w === R.basicWage;
  const W = n(w), url = `/salary/${w}/`;
  rows.push({ w, c });
  const liCap = c.gLI >= I.li.max, nhiNext = nextOf(I.nhiGrades, c.gN);
  const title = `月薪 ${W} 勞健保扣多少？實領 ${n(c.take)} 元（${Y} 年）｜稅務小工具`;
  const desc = `月薪 ${W} 元${isMin ? "（最低工資）" : ""}勞健保怎麼扣：投保級距 ${n(c.gN)} 元，員工每月自付勞保（含就保）${n(c.e.li)} 元、健保 ${n(c.e.nhi)} 元，實領 ${n(c.take)} 元；老闆另外負擔 ${n(c.bT)} 元（含勞退 6% ${n(c.b.pen)} 元）。依 ${Y} 年費率與投保級距計算，附眷屬加保與年度金額。`;

  // 級距說明（這個金額特有的資訊）
  const gradeLine = c.gN === w
    ? `月薪 ${W} 元剛好等於健保投保金額分級表上的一級，所以直接用 ${W} 元計算。`
    : `勞健保不是用月薪直接乘費率，而是先對到「等於或剛好高於月薪」的投保級距。月薪 ${W} 元落在 ${n(c.gN)} 元這一級，所以保費按 ${n(c.gN)} 元計算。`;
  const capLine = [
    liCap ? `勞保和就業保險最高只算到 ${n(I.li.max)} 元，月薪再高，勞保費也不會增加。` : "",
    c.gP >= I.pensionMax ? `勞退提繳最高算到 ${n(I.pensionMax)} 元。` : "",
    w >= I.nhiGrades[I.nhiGrades.length - 1] ? `健保最高算到 ${n(I.nhiGrades[I.nhiGrades.length - 1])} 元。` : "",
  ].join("");
  let jump = "";
  if (nhiNext) {
    const up = tt(R, nhiNext, {});
    jump = `月薪只要超過 ${n(c.gN)} 元，就會跳到 ${n(nhiNext)} 元那一級：員工每月健保多 ${n(up.e.nhi - c.e.nhi)} 元${up.e.li - c.e.li ? `、勞保多 ${n(up.e.li - c.e.li)} 元` : ""}，老闆每月多負擔 ${n(up.bT - c.bT)} 元。`;
  }

  const depRows = [0, 1, 2, 3].map(k => `        <tr><td>本人${k ? `＋眷屬 ${k} 人` : ""}</td><td class="n">${n(c.nhiSelf * (1 + k))} 元</td><td class="n">${n(c.take - c.nhiSelf * k)} 元</td></tr>`).join("\n");
  const idx = AMOUNTS.indexOf(w), prev = AMOUNTS[idx - 1], next = AMOUNTS[idx + 1];

  const faq = [
    [`月薪 ${W} 元，勞保、健保為什麼用 ${n(c.gN)} 元計算？`, c.gN === w
      ? `因為 ${W} 元剛好是投保級距表上的一級。勞健保都是先把月薪對到投保級距，再用級距金額乘費率。`
      : `勞健保是先把月薪對到投保級距表上「等於或剛好高於月薪」的那一級，再用級距金額乘費率。月薪 ${W} 元對到的是 ${n(c.gN)} 元${liCap ? `（勞保則以上限 ${n(I.li.max)} 元計算）` : ""}，所以保費比直接用 ${W} 元算稍高一點。`],
    [`月薪 ${W} 元，健保加 2 個眷屬要扣多少？`, `每多 1 個眷屬，就多一份本人的健保費 ${n(c.nhiSelf)} 元。加 2 個眷屬，健保每月扣 ${n(c.nhiSelf * 3)} 元，實領變成 ${n(c.take - c.nhiSelf * 2)} 元；眷屬最多算 3 人，第 4 人起不用再多繳。`],
    [`月薪 ${W} 元，老闆每月要多付多少？`, `老闆每月另外負擔 ${n(c.bT)} 元：勞保＋就保 ${n(c.b.li)} 元、健保 ${n(c.b.nhi)} 元、職災保險約 ${n(c.b.occ)} 元、工資墊償基金 ${n(c.b.arr)} 元、勞退 6% ${n(c.b.pen)} 元。每月人事成本約 ${n(c.cost)} 元，一年約 ${n(c.cost * 12)} 元（不含年終與加班費）。`],
    [`月薪 ${W} 元，勞退自提 6% 會少領多少？`, `自提 6% 每月從薪水扣 ${n(v6.e.pen)} 元，實領變成 ${n(v6.take)} 元；這筆錢存進自己的勞退專戶，不是被拿走。自提金額一年 ${n(v6.e.pen * 12)} 元可以不計入當年度薪資所得，綜所稅稅率 5% 的人約少繳 ${n(v6.e.pen * 12 * 0.05)} 元。`],
  ];

  const body = `<div class="wrap" role="main">
  <div class="page-head">
    <p class="crumb"><a href="/">稅務小工具</a>›<a href="/salary/">月薪勞健保對照表</a></p>
    <h1>月薪 ${W} 元勞健保扣多少？${Y} 年實領 ${n(c.take)} 元</h1>
    <p class="meta">最後更新：${roc(DATE)}・依 ${Y} 年勞保、健保、勞退費率與投保級距計算</p>
  </div>

  <article class="art">
    <div class="answer"><p><b>月薪 ${W} 元勞健保扣多少？</b>${Y} 年${isMin ? "最低工資 " + W + " 元的" : "月薪 " + W + " 元的"}全職員工，勞保投保級距 ${liCap ? n(I.li.max) + " 元（勞保上限）" : n(c.gLI) + " 元"}、健保投保金額 ${n(c.gN)} 元：員工每月自付勞保（含就業保險）${n(c.e.li)} 元、健保 ${n(c.e.nhi)} 元，合計 ${n(c.eT)} 元，每月實領 ${n(c.take)} 元。老闆另外負擔 ${n(c.bT)} 元，其中勞退 6% 提繳 ${n(c.b.pen)} 元存進員工的勞退專戶，每月人事成本約 ${n(c.cost)} 元。</p></div>

    <h2 id="detail">月薪 ${W} 元：員工與老闆各付多少</h2>
    <p>員工自付勞保 ${n(c.e.li)} 元、健保 ${n(c.e.nhi)} 元；老闆負擔勞保、就保、職災、墊償基金、健保與勞退 6%，合計 ${n(c.bT)} 元（每月，以 ${Y} 年費率計）。</p>
    <div class="tbl"><table>
      <thead><tr><th>項目</th><th>投保金額</th><th>員工</th><th>老闆</th></tr></thead>
      <tbody>
        <tr><td>勞保普通事故（${+(I.li.ordinary * 100).toFixed(2)}%）</td><td class="n">${n(c.gLI)}</td><td class="n">${n(Math.round(c.gLI * I.li.ordinary * I.li.worker))}</td><td class="n">${n(Math.round(c.gLI * I.li.ordinary * I.li.employer))}</td></tr>
        <tr><td>就業保險（${+(I.li.employment * 100).toFixed(2)}%）</td><td class="n">${n(c.gLI)}</td><td class="n">${n(Math.round(c.gLI * I.li.employment * I.li.worker))}</td><td class="n">${n(Math.round(c.gLI * I.li.employment * I.li.employer))}</td></tr>
        <tr><td>職災保險（老闆全額）</td><td class="n">${n(c.gOcc)}</td><td class="n">0</td><td class="n">${n(c.b.occ)}</td></tr>
        <tr><td>工資墊償基金（老闆全額）</td><td class="n">${n(c.gLI)}</td><td class="n">0</td><td class="n">${n(c.b.arr)}</td></tr>
        <tr><td>健保（員工 30%、老闆 60%）</td><td class="n">${n(c.gN)}</td><td class="n">${n(c.e.nhi)}</td><td class="n">${n(c.b.nhi)}</td></tr>
        <tr><td>勞退（老闆 6%）</td><td class="n">${n(c.gP)}</td><td class="n">0</td><td class="n">${n(c.b.pen)}</td></tr>
        <tr><td><b>合計</b></td><td></td><td class="n"><b>${n(c.eT)}</b></td><td class="n"><b>${n(c.bT)}</b></td></tr>
      </tbody>
    </table></div>
    <div class="tools">
      <a href="/labor-health/?s=${w}"><b>用勞健保計算機改條件 →</b><span>已帶入月薪 ${W} 元，可以改眷屬人數、勞退自提、部分工時或 65 歲以上。</span></a>
    </div>

    <h2 id="grade">投保級距：為什麼是 ${n(c.gN)} 元</h2>
    <p>${gradeLine}${capLine}</p>
    ${jump ? `<p>${jump}</p>` : ""}

    <h2 id="dependents">健保加眷屬：每多 1 人多扣 ${n(c.nhiSelf)} 元</h2>
    <p>眷屬（無職業的配偶、父母、祖父母，以及未滿 20 歲無職業、在學或無謀生能力的子女等）依附員工加保，每人的健保費和員工本人一樣是 ${n(c.nhiSelf)} 元，最多算 3 人。</p>
    <div class="tbl"><table>
      <thead><tr><th>健保投保人數</th><th>員工每月健保</th><th>每月實領</th></tr></thead>
      <tbody>
${depRows}
      </tbody>
    </table></div>

    <h2 id="year">一年下來：員工實領 ${n(c.take * 12)} 元</h2>
    <p>以 12 個月計，員工一年自付勞健保 ${n(c.eT * 12)} 元、實領 ${n(c.take * 12)} 元；老闆一年負擔 ${n(c.bT * 12)} 元，人事成本約 ${n(c.cost * 12)} 元（不含年終獎金、加班費；全年獎金累計超過當月健保投保金額 4 倍的部分，另扣 2.11% 補充保費）。</p>

    <section class="card faq">
      <h2>常見問題</h2>
${faq.map(([q, a]) => `      <details><summary>${q}</summary><p>${a}</p></details>`).join("\n")}
    </section>

    <h2 id="more">其他月薪</h2>
    <ul class="more">
${prev ? `      <li><a href="/salary/${prev}/">月薪 ${n(prev)} 元勞健保扣多少</a></li>\n` : ""}${next ? `      <li><a href="/salary/${next}/">月薪 ${n(next)} 元勞健保扣多少</a></li>\n` : ""}      <li><a href="/salary/">所有月薪的勞健保對照表</a></li>
      <li><a href="/overtime-pay/">加班費計算機</a></li>
      <li><a href="/guide/labor-report/">勞報單怎麼填？扣繳 10%、補充保費 2.11%</a></li>
    </ul>

    ${lawList}
  </article>
${foot}`;
  const dir = path.join(ROOT, "salary", String(w));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), head(title, desc, url) + body);
}

// 總表 /salary/
const tableRows = rows.map(({ w, c }) => `        <tr><td><a href="/salary/${w}/">${n(w)}</a></td><td class="n">${n(c.gN)}</td><td class="n">${n(c.e.li)}</td><td class="n">${n(c.e.nhi)}</td><td class="n">${n(c.take)}</td><td class="n">${n(c.bT)}</td></tr>`).join("\n");
const m = rows.find(r => r.w === 35000).c;
const idxTitle = `${Y} 年月薪勞健保對照表：月薪 3 萬到 20 萬扣多少、實領多少｜稅務小工具`;
const idxDesc = `${Y} 年月薪勞健保對照表：從最低工資 ${n(R.basicWage)} 元到 20 萬元，每個月薪的投保級距、員工自付勞保與健保、實領金額，以及老闆負擔。例如月薪 35,000 元，員工自付勞保 ${n(m.e.li)} 元、健保 ${n(m.e.nhi)} 元，實領 ${n(m.take)} 元。`;
const idx = `<div class="wrap" role="main">
  <div class="page-head">
    <p class="crumb"><a href="/">稅務小工具</a>›<a href="/labor-health/">勞健保計算機</a></p>
    <h1>${Y} 年月薪勞健保對照表：扣多少、實領多少</h1>
    <p class="meta">最後更新：${roc(DATE)}・依 ${Y} 年勞保、健保、勞退費率與投保級距計算</p>
  </div>

  <article class="art">
    <div class="answer"><p><b>月薪勞健保扣多少？</b>${Y} 年全職員工自付的勞保（含就業保險）約是投保級距的 ${+(((I.li.ordinary + I.li.employment) * I.li.worker) * 100).toFixed(2)}%，健保是 ${+((I.nhi.rate * I.nhi.worker) * 100).toFixed(3)}%（每多 1 個眷屬再加一份）。例如月薪 35,000 元對到 ${n(m.gN)} 元的級距，每月扣勞保 ${n(m.e.li)} 元、健保 ${n(m.e.nhi)} 元，實領 ${n(m.take)} 元；最低工資 ${n(R.basicWage)} 元實領 ${n(rows[0].c.take)} 元。勞保最高算到 ${n(I.li.max)} 元，健保最高算到 ${n(I.nhiGrades[I.nhiGrades.length - 1])} 元。</p></div>

    <h2 id="table">月薪勞健保對照表（${Y} 年，每月）</h2>
    <p>下表以全職、未滿 65 歲、沒有眷屬、不自提勞退計算，單位是元。點月薪可以看那個金額的明細、加眷屬的金額和老闆成本。</p>
    <div class="tbl"><table>
      <thead><tr><th>月薪</th><th>投保級距</th><th>員工勞保</th><th>員工健保</th><th>實領</th><th>老闆負擔</th></tr></thead>
      <tbody>
${tableRows}
      </tbody>
    </table></div>
    <div class="tools">
      <a href="/labor-health/"><b>勞健保計算機 →</b><span>輸入任何月薪，加眷屬、勞退自提、部分工時都能算。</span></a>
    </div>

    <section class="card faq">
      <h2>常見問題</h2>
      <details><summary>表上沒有我的月薪怎麼辦？</summary><p>找比你的月薪高、最接近的那一級投保級距，保費就和那一列相同；或直接用勞健保計算機輸入月薪。勞健保是按投保級距計算，月薪落在同一級的人，保費都一樣。</p></details>
      <details><summary>老闆負擔包含哪些？</summary><p>包含勞保與就業保險的 70%、職災保險（以全行業平均費率 ${+(I.occ.industryAvg * 100).toFixed(2)}% 加上下班 ${+(I.occ.commute * 100).toFixed(2)}% 估算）、工資墊償基金 ${+(I.arrears * 100).toFixed(3)}%、健保 60%（按平均眷口數 ${I.nhi.avgDependents} 計），以及勞退 6% 提繳。</p></details>
    </section>

    ${lawList}
  </article>
${foot}`;
fs.writeFileSync(path.join(ROOT, "salary", "index.html"), head(idxTitle, idxDesc, "/salary/") + idx);
console.log("salary pages:", AMOUNTS.length + 1);
