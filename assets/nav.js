/* One menu for every page: edit TOOLS to add a tool everywhere. */
(function(){
  // 網站字型在頁面載入完成後才套用：先用系統字型顯示內容，不讓字型拖慢第一次畫面
  const fonts=()=>document.querySelectorAll("link[data-font]").forEach(l=>{ l.media="all"; });
  if(document.readyState==="complete") fonts(); else addEventListener("load",fonts);
})();
(function(){
  const TOOLS=[["/invoice-helper/","手開發票"],["/rent-withholding/","租金扣繳"],["/labor-report/","勞報扣繳"],["/tax-included/","含稅換算"],["/company-lookup/","統編查詢"],["/labor-health/","勞健保"],["/income-tax/","綜所稅"],["/landlord-tax/","房東報稅"],["/tax-calendar/","報稅行事曆"],["/ledger/","帳本"]];
  const nav=document.querySelector(".site-nav"); if(!nav) return;
  const here=location.pathname.replace(/index\.html$/,"");
  nav.innerHTML=TOOLS.map(([h,t])=>`<a href="${h}"${here===h?' aria-current="page"':""}>${t}</a>`).join("");
  const cur=nav.querySelector('[aria-current="page"]'); if(cur&&nav.scrollWidth>nav.clientWidth) nav.scrollLeft=cur.offsetLeft-16;
  // shared links under every page's footer note
  const foot=document.querySelector(".site-foot");
  if(foot&&!document.querySelector(".foot-links")){
    const p=document.createElement("p"); p.className="foot-links";
    p.innerHTML=`<a href="/">所有工具</a><a href="/guide/">報稅解答</a><a href="#" data-feedback>意見回饋</a><a href="/privacy/">隱私權政策與使用條款</a><span>非政府官方網站</span>`;
    foot.after(p);
  }
  if(/^\/admin\b/.test(here)) return;

  // 匿名瀏覽統計：只記哪一頁、從哪個網站來、手機或電腦；不用 Cookie、不存 IP
  try{
    if(navigator.doNotTrack!=="1"&&!/^(localhost|127\.)/.test(location.hostname)){
      const body=JSON.stringify({p:location.pathname,r:document.referrer||""});
      if(!(navigator.sendBeacon&&navigator.sendBeacon("/api/track",new Blob([body],{type:"text/plain"}))))
        fetch("/api/track",{method:"POST",body,keepalive:true}).catch(()=>{});
    }
  }catch(e){}

  // 意見回饋：頁首按鈕＋頁尾連結，打開同一個表單
  // 頁首右側的「意見回饋」（不用浮動按鈕，避免蓋住計算結果）
  const head=document.querySelector(".site-head");
  if(head&&!head.querySelector(".fb-head")){ const fb=document.createElement("button"); fb.type="button"; fb.className="fb-head"; fb.setAttribute("data-feedback",""); fb.textContent="意見回饋"; head.appendChild(fb); }
  let dlg=null;
  function open(){
    if(!dlg){
      dlg=document.createElement("dialog"); dlg.className="fb-dlg"; dlg.setAttribute("aria-labelledby","fb-title");
      dlg.innerHTML=`<form method="dialog" class="fb-form">
        <h2 id="fb-title">意見回饋</h2>
        <p class="fb-sub">算錯了、看不懂、想要新工具，都可以告訴我們。</p>
        <div class="fb-kinds" role="radiogroup" aria-label="類型">${["建議","錯誤","問題","其他"].map((k,i)=>`<label><input type="radio" name="kind" value="${k}"${i?"":" checked"}>${k}</label>`).join("")}</div>
        <label class="fb-lbl" for="fb-text">內容</label>
        <textarea id="fb-text" name="text" rows="5" maxlength="2000" required placeholder="例如：勞健保試算的眷屬人數超過 3 人時，金額好像不對"></textarea>
        <label class="fb-lbl" for="fb-contact">聯絡方式（選填，需要回覆時才會用到）</label>
        <input id="fb-contact" name="contact" maxlength="120" autocomplete="email" placeholder="Email 或 LINE ID">
        <p class="fb-msg" role="status"></p>
        <div class="fb-act"><button type="button" class="btn" value="cancel" data-close>取消</button><button type="submit" class="btn primary">送出</button></div>
      </form>`;
      document.body.appendChild(dlg);
      dlg.querySelector("[data-close]").onclick=()=>dlg.close();
      dlg.addEventListener("click",e=>{ if(e.target===dlg) dlg.close(); });
      dlg.querySelector("form").addEventListener("submit",async e=>{
        e.preventDefault();
        const f=e.target, msg=f.querySelector(".fb-msg"), btn=f.querySelector("[type=submit]");
        const data={kind:f.kind.value,text:f.text.value,contact:f.contact.value,page:location.pathname};
        btn.disabled=true; msg.textContent="送出中…";
        try{
          const r=await fetch("/api/feedback",{method:"POST",headers:{"content-type":"application/json","x-tt":"1"},body:JSON.stringify(data),credentials:"same-origin"});
          const j=await r.json().catch(()=>({}));
          if(!r.ok) throw new Error(j.error||"送出失敗，請稍後再試");
          f.reset(); msg.textContent="收到了，謝謝你！"; setTimeout(()=>{ dlg.close(); msg.textContent=""; },1400);
        }catch(err){ msg.textContent=err.message; }
        btn.disabled=false;
      });
    }
    dlg.showModal(); setTimeout(()=>dlg.querySelector("textarea").focus(),30);
  }
  document.addEventListener("click",e=>{ const t=e.target.closest("[data-feedback]"); if(t){ e.preventDefault(); open(); } });
})();
