/* All tax figures used by taxtools.tw live here. Update this file when the law changes; every tool reads from it.
   checked: the date these figures were last verified against official sources. */
window.RATES = {
  checked: "2026-10-25",
  vat: { rate: 0.05 },                                   // 加值型營業稅 5%
  rent: {                                                // 各類所得扣繳率標準：租賃所得
    resident: 0.10, nonResident: 0.20,
    exemptTaxAtOrBelow: 2000,                            // 每次應扣繳稅額不超過 2,000 元免扣繳（居住者）
  },
  nhi: {                                                 // 全民健康保險法 補充保險費
    rate: 0.0211, minPerPayment: 20000, capPerPayment: 10000000,
  },
  sources: {
    rent: "所得稅法第 88、89、92 條；各類所得扣繳率標準",
    nhi: "全民健康保險法第 31、33 條；健保署補充保險費規定",
  }
};
