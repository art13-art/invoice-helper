// 產生文章分享圖（1200×630）：node scripts/og.js  →  og/<name>.png
// 字型用系統的 Noto Sans/Serif CJK TC，版面和網站首頁的 og.png 一致。
const { chromium } = require('playwright');
const path = require('path');
const ITEMS = [
  { name: 'guide', kicker: '報稅解答', title: ['營業稅、發票', '常見問題一次看懂'], sub: '先給答案・附法條來源・附計算工具', chips: ['營業稅怎麼報', '含稅未稅', '發票開錯'] },
  { name: 'guide-vat-filing', kicker: '報稅解答', title: ['營業稅怎麼報？'], sub: '申報期限・計算公式・零申報・逾期罰則', chips: ['單數月 15 日', '銷項 − 進項', '沒銷售也要報'] },
  { name: 'guide-tax-included', kicker: '報稅解答', title: ['含稅未稅怎麼算？'], sub: '營業稅 5% 換算公式・發票寫法', chips: ['未稅 × 1.05', '含稅 ÷ 1.05', '差 1 元的原因'] },
  { name: 'guide-invoice-mistake', kicker: '報稅解答', title: ['發票開錯怎麼辦？'], sub: '作廢重開・收不回來怎麼免罰・折讓單', chips: ['收回作廢', '主動報備免罰', '折讓證明單'] },
];
const html = it => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#F5F3EE;font-family:"Noto Sans CJK TC",sans-serif;color:#1C2330;position:relative;overflow:hidden}
.bar{position:absolute;right:0;top:0;width:22px;height:510px;background:#2554A6}.bar2{position:absolute;right:0;top:510px;width:22px;height:120px;background:#E27B50}
.wrap{padding:72px 80px}
.brand{display:flex;align-items:center;gap:18px;font-size:34px;font-weight:700;letter-spacing:4px}
.logo{width:64px;height:64px;border-radius:14px;background:#2554A6;display:grid;place-items:center}
.logo i{display:grid;place-items:center;width:40px;height:40px;background:#fff;border-radius:4px;border-bottom:4px solid #E27B50;color:#2554A6;font-style:normal;font-size:22px;font-weight:700}
.kicker{display:inline-block;margin-top:46px;font-size:28px;font-weight:700;color:#2554A6;letter-spacing:6px}
h1{font-family:"Noto Serif CJK TC",serif;font-weight:700;font-size:${it.title.length>1?84:96}px;line-height:1.22;letter-spacing:6px;margin-top:10px}
.sub{font-size:32px;color:#566070;margin-top:22px;letter-spacing:2px}
.chips{display:flex;gap:16px;margin-top:40px}
.chips span{padding:10px 24px;border:2px solid #E5E1D8;border-radius:99px;background:#fff;color:#2554A6;font-weight:700;font-size:26px}
.url{position:absolute;right:62px;bottom:40px;font-size:24px;color:#566070;letter-spacing:1px}
</style></head><body><div class="bar"></div><div class="bar2"></div><div class="wrap">
<div class="brand"><div class="logo"><i>票</i></div>稅務小工具</div>
<div class="kicker">${it.kicker}</div><h1>${it.title.join('<br>')}</h1><p class="sub">${it.sub}</p>
<div class="chips">${it.chips.map(c=>`<span>${c}</span>`).join('')}</div></div><div class="url">taxtools.tw</div></body></html>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  for (const it of ITEMS) { await p.setContent(html(it)); await p.screenshot({ path: path.join(__dirname, '..', 'og', it.name + '.png') }); console.log('og/' + it.name + '.png'); }
  await b.close();
})();
