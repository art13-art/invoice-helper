/* All tax figures used by taxtools.tw live here. Update this file when the law changes; every tool reads from it.
   checked: the date these figures were last verified against official sources. */
window.RATES = {
  checked: "2026-10-25",
  year: 115,
  basicWage: 29500,                                     // 基本工資（115/1/1 起）
  salaryDeduction: 227000,                               // 115 年度薪資所得特別扣除額（財政部 114/11/27 公告）
  vat: { rate: 0.05 },                                   // 加值型營業稅 5%
  rent: {                                                // 各類所得扣繳率標準：租賃所得
    resident: 0.10, nonResident: 0.20,
    exemptTaxAtOrBelow: 2000,                            // 每次應扣繳稅額不超過 2,000 元免扣繳（居住者）
  },
  fee: {                                                 // 執行業務報酬 9A／稿費版稅講演鐘點費 9B
    resident: 0.10, exemptTaxAtOrBelow: 2000,
    nonResident: 0.20, nonResident9BExemptAtOrBelow: 5000, // 非居住者稿費等每次給付不超過 5,000 元免扣繳
    royaltyAnnualTaxFree: 180000,                        // 稿費、版稅、講演鐘點費全年 18 萬元內免稅（所得稅法第 4 條第 1 項第 23 款）
  },
  salary: {                                              // 薪資 50（非固定、兼職）
    nonFixedRate: 0.05, nonFixedMin: 90501,              // 115 年：每次給付達 90,501 元扣 5%
    nonResidentHigh: 0.18, nonResidentLow: 0.06, nonResidentLowMax: 44250, // 全月給付不超過基本工資 1.5 倍扣 6%
  },
  nhi: {                                                 // 全民健康保險法 補充保險費
    rate: 0.0211, minPerPayment: 20000, capPerPayment: 10000000,
    vulnerableMin: 29500,                                // 中低收入戶等特定弱勢：單次未達基本工資免扣（執行業務、股利、利息、租金）
    partTimeMin: 29500,                                  // 兼職薪資：單次達基本工資才扣
  },
  // 勞保、就保、職災、勞退、健保（115/1/1 起）
  insurance: {
    li: { ordinary: 0.115, employment: 0.01, worker: 0.2, employer: 0.7, max: 45800 },   // 勞保普通事故 11.5%＋就保 1%；勞工 20%、雇主 70%、政府 10%
    occ: { commute: 0.0007, industryAvg: 0.0014, max: 72800 },                         // 職災保險：上下班 0.07%＋行業別（平均 0.14%，0.05%–0.89%），雇主全額
    arrears: 0.00025,                                                                  // 積欠工資墊償基金 0.025%，雇主全額
    pension: 0.06,                                                                      // 勞退雇主提繳 6%；勞工自提 0–6%
    nhi: { rate: 0.0517, worker: 0.3, employer: 0.6, avgDependents: 0.56, maxDependents: 3 }, // 健保 5.17%；平均眷口數 0.56（113/1/1 起）
    // 勞保投保薪資分級表（部分工時可適用 29,500 以下各級；職災保險上限 72,800）
    liGrades: [11100,12540,13500,15840,16500,17280,17880,19047,20008,21009,22000,23100,24000,25250,26400,27600,28590,29500,30300,31800,33300,34800,36300,38200,40100,42000,43900,45800],
    // 健保投保金額分級表；29,500 以上與勞退月提繳工資分級表相同
    nhiGrades: [29500,30300,31800,33300,34800,36300,38200,40100,42000,43900,45800,48200,50600,53000,55400,57800,60800,63800,66800,69800,72800,76500,80200,83900,87600,92100,96600,101100,105600,110100,115500,120900,126300,131700,137100,142500,147900,150000,156400,162800,169200,175600,182000,189500,197000,204500,212000,219500,228200,236900,245600,254300,263000,273000,283000,293000,303000,313000],
    pensionLow: [1500,3000,4500,6000,7500,8700,9900,11100,12540,13500,15840,16500,17280,17880,19047,20008,21009,22000,23100,24000,25250,26400,27600,28590], // 勞退 29,500 以下各級
    pensionMax: 150000,
  },
  // 綜合所得稅 115 年度（116 年 5 月申報）
  pit: {
    exemption: 101000, exemption70: 151500,
    standard: 136000, standardMarried: 272000,
    salary: 227000, disability: 227000, savings: 270000, tuition: 25000, longTermCare: 180000, rent: 180000,
    preschool: [150000, 225000],                          // 第 1 名 15 萬，第 2 名起每名 22.5 萬
    insurancePerPerson: 24000, mortgageInterest: 300000,
    basicLiving: 213000, basicLivingYear: 114,            // 基本生活所需費用：115 年度尚未公告，暫用 114 年度 21.3 萬
    brackets: [[610000,0.05,0],[1380000,0.12,42700],[2770000,0.20,153100],[5190000,0.30,430100],[Infinity,0.40,949100]],
    dividendCreditRate: 0.085, dividendCreditCap: 80000, dividendSeparateRate: 0.28,
  },
  // 租賃所得
  lease: {
    expenseRate: 0.43,                                    // 一般出租：必要損耗及費用 43%
    depositRate: 0.01725,                                 // 押金設算租金：當年 1/1 郵政儲金一年期定期儲金固定利率
    socialMonthlyFree: 15000, socialExpenseRate: 0.60,    // 社會住宅包租代管：每屋每月 1.5 萬免稅，超過部分減除 60%
    publicMonthlyFree: 15000,                             // 公益出租人：每屋每月 1.5 萬免稅，超過部分減除 43%
  },
  sources: {
    rent: "所得稅法第 88、89、92 條；各類所得扣繳率標準",
    fee: "所得稅法第 4、88、92 條；各類所得扣繳率標準；薪資所得扣繳辦法",
    nhi: "全民健康保險法第 31、33 條；健保署扣取及繳納補充保險費實務手冊",
  }
};
