/* 勞健保計算：勞健保計算機（/labor-health/）和月薪對照頁（/salary/，scripts/build_salary.js 產生）共用同一套公式。
   數字一律來自 rates.js 的 insurance。o: { pt 部分工時, senior 65 歲以上或已領老年給付, dep 眷屬人數, vol 勞退自提率, occRate 職災行業別費率 } */
(function (root) {
  function ttInsurance(R, w, o) {
    o = o || {};
    const I = R.insurance, L = I.li, N = I.nhi, r = Math.round;
    const pt = !!o.pt, senior = !!o.senior, dep = +o.dep || 0, vol = +o.vol || 0;
    const occRate = o.occRate == null ? I.occ.industryAvg : o.occRate;
    /* 等於或剛好高於月薪的那一級，超過上限就用上限 */
    const grade = (list, w, max) => { const g = list.find(x => x >= w) ?? list[list.length - 1]; return Math.min(g, max ?? g); };
    const liList = pt ? I.liGrades : I.liGrades.filter(x => x >= R.basicWage);
    const all = [...new Set([...I.liGrades, ...I.nhiGrades])].sort((a, b) => a - b);
    const occList = pt ? all : all.filter(x => x >= R.basicWage);
    const pList = [...I.pensionLow, ...I.nhiGrades.filter(x => x <= I.pensionMax)];
    const gLI = w ? grade(liList, w, L.max) : 0;
    const gOcc = w ? grade(occList, w, I.occ.max) : 0;
    const gP = w ? grade(pt ? pList : pList.filter(x => x >= R.basicWage), w, I.pensionMax) : 0;
    const gN = w ? grade(I.nhiGrades, w) : 0;
    const e = {}, b = {};
    e.li = senior ? 0 : r(gLI * L.ordinary * L.worker) + r(gLI * L.employment * L.worker);
    b.li = senior ? 0 : r(gLI * L.ordinary * L.employer) + r(gLI * L.employment * L.employer);
    e.occ = 0; b.occ = r(gOcc * (occRate + I.occ.commute));
    b.arr = senior ? 0 : r(gLI * I.arrears);
    const nhiSelf = r(gN * N.rate * N.worker);
    e.nhi = nhiSelf * (1 + Math.min(dep, N.maxDependents));
    b.nhi = r(gN * N.rate * N.employer * (1 + N.avgDependents));
    e.pen = r(gP * vol); b.pen = r(gP * I.pension);
    const eT = e.li + e.nhi + e.pen, bT = b.li + b.occ + b.arr + b.nhi + b.pen;
    return { w, pt, senior, dep, vol, occRate, gLI, gOcc, gP, gN, nhiSelf, e, b, eT, bT, take: w - eT, cost: w + bT };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = ttInsurance; else root.ttInsurance = ttInsurance;
})(this);
