// 每月報稅期限圖卡（1080×1350，適合 IG／Threads／LINE）：node scripts/cards.js → og/cards/YYYY-MM.png
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/deadlines.json'), 'utf8'));
const W = '日一二三四五六';
const months = [...new Set(D.items.map(i => i.due.slice(0, 7)))].sort();
const html = (ym, items) => {
  const [y, m] = ym.split('-').map(Number);
  const rows = items.map(i => { const d = new Date(i.due + 'T00:00');
    return `<li><span class="d">${d.getMonth()+1}/${d.getDate()}<small>（${W[d.getDay()]}）</small></span><span class="t"><b>${i.title}</b><small>${i.roles.map(r => D.roles[r]).join('、')}${i.orig ? '・遇假日順延' : ''}</small></span></li>`; }).join('');
  const big = items.length > 4;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}body{width:1080px;height:1350px;background:#F5F3EE;font-family:"Noto Sans CJK TC",sans-serif;color:#1C2330;position:relative;overflow:hidden}
.top{height:16px;background:#2554A6}.top2{position:absolute;top:0;right:0;width:220px;height:16px;background:#E27B50}
.wrap{padding:${big?52:70}px 80px 0}
.brand{display:flex;align-items:center;gap:16px;font-size:32px;font-weight:700;letter-spacing:4px}
.logo{width:58px;height:58px;border-radius:13px;background:#2554A6;display:grid;place-items:center}
.logo i{display:grid;place-items:center;width:36px;height:36px;background:#fff;border-radius:4px;border-bottom:4px solid #E27B50;color:#2554A6;font-style:normal;font-size:20px;font-weight:700}
h1{font-family:"Noto Serif CJK TC",serif;font-size:${big?80:92}px;line-height:1.15;margin-top:${big?36:50}px;letter-spacing:4px}
h1 small{display:block;font-size:40px;color:#2554A6;font-family:"Noto Sans CJK TC";letter-spacing:6px;margin-bottom:8px}
ul{list-style:none;padding:0;margin-top:${big?30:44}px;display:grid;gap:${big?12:22}px}
li{display:grid;grid-template-columns:250px 1fr;gap:20px;align-items:center;background:#fff;border:2px solid #E5E1D8;border-radius:20px;padding:${big?12:22}px 26px}
.d{font-size:${big?40:48}px;font-weight:700;color:#2554A6;font-variant-numeric:tabular-nums;line-height:1.1;white-space:nowrap}
.d small{font-size:24px;color:#566070;font-weight:500}
.t b{display:block;font-size:${big?29:36}px;line-height:1.3}.t small{font-size:${big?21:24}px;color:#566070}
.foot{position:absolute;left:80px;right:80px;bottom:44px;display:flex;justify-content:space-between;align-items:flex-end;font-size:26px;color:#566070}
.foot b{font-size:34px;color:#1C2330;letter-spacing:1px}
</style></head><body><div class="top"></div><div class="top2"></div><div class="wrap">
<div class="brand"><div class="logo"><i>票</i></div>稅務小工具</div>
<h1><small>報稅・繳費期限</small>${y-1911} 年 ${m} 月</h1>
<ul>${rows || '<li><span class="t"><b>這個月沒有主要期限</b></span></li>'}</ul></div>
<div class="foot"><span>期限已依假日順延<br>完整行事曆與試算工具</span><b>taxtools.tw</b></div></body></html>`;
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1350 } });
  for (const ym of months) {
    // 圖卡只放主要期限和每月 10 日扣繳；每月保費合併成一行，避免太擠
    const all = D.items.filter(i => i.due.startsWith(ym));
    const main = all.filter(i => i.kind === 'main' || /扣繳稅款/.test(i.title));
    const ins = all.filter(i => i.kind !== 'main' && !/扣繳稅款/.test(i.title));
    const byDay = {}; ins.forEach(i => { (byDay[i.due] = byDay[i.due] || []).push(i); });
    Object.entries(byDay).forEach(([due, list]) => main.push({ due, orig: list[0].orig, roles: ['company'], title: list.map(i => i.title.replace(/^繳納 /, '')).join('、').replace(/^(\d+ 月)(.*)、\1/, '$1$2、').replace(/^/, '繳納 ') }));
    main.sort((a, c) => a.due.localeCompare(c.due));
    await p.setContent(html(ym, main.slice(0, 7)));
    await p.screenshot({ path: path.join(ROOT, 'og/cards', ym + '.png') }); console.log(ym, main.length);
  }
  await b.close();
})();
