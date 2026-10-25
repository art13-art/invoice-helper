/* One menu for every page: edit TOOLS to add a tool everywhere. */
(function(){
  const TOOLS=[["/invoice-helper/","手開發票"],["/rent-withholding/","租金扣繳"],["/labor-report/","勞報扣繳"],["/tax-included/","含稅換算"],["/company-lookup/","統編查詢"],["/labor-health/","勞健保"],["/income-tax/","綜所稅"],["/landlord-tax/","房東報稅"],["/tax-calendar/","報稅行事曆"],["/ledger/","帳本"]];
  const nav=document.querySelector(".site-nav"); if(!nav) return;
  const here=location.pathname.replace(/index\.html$/,"");
  nav.innerHTML=TOOLS.map(([h,t])=>`<a href="${h}"${here===h?' aria-current="page"':""}>${t}</a>`).join("");
  const cur=nav.querySelector('[aria-current="page"]'); if(cur&&nav.scrollWidth>nav.clientWidth) nav.scrollLeft=cur.offsetLeft-16;
})();
