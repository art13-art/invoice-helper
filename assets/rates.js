/* All tax figures used by taxtools.tw live here. Update this file when the law changes; every tool reads from it.
   checked: the date these figures were last verified against official sources. */
window.RATES = {
  checked: "2026-10-25",
  year: 115,
  basicWage: 29500,                                      // 基本工資（115/1/1 起）
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
  sources: {
    rent: "所得稅法第 88、89、92 條；各類所得扣繳率標準",
    fee: "所得稅法第 4、88、92 條；各類所得扣繳率標準；薪資所得扣繳辦法",
    nhi: "全民健康保險法第 31、33 條；健保署扣取及繳納補充保險費實務手冊",
  }
};
