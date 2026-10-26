/* Shared sign-in helpers for 報稅帳本, /join/ and /firm/: Google Identity Services button, API calls with our session cookie. */
window.TT_AUTH=(function(){
  const GOOGLE_CLIENT_ID="PENDING.apps.googleusercontent.com";
  const ready=!/^PENDING/.test(GOOGLE_CLIENT_ID);
  const api=(p,body)=>fetch(p,{method:body?"POST":"GET",headers:body?{"content-type":"application/json","x-tt":"1"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin"})
    .then(async r=>{ let j={}; try{ j=await r.json(); }catch(e){} if(!r.ok){ const e=new Error(j.error||"連線失敗，請稍後再試"); e.status=r.status; throw e; } return j; });
  let gsi=null;
  function loadGsi(){ if(gsi) return gsi; gsi=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true; s.onload=()=>res(window.google); s.onerror=()=>{ gsi=null; rej(new Error("Google 登入載入失敗，請檢查網路後重新整理")); }; document.head.appendChild(s); }); return gsi; }
  /* Draw the "Sign in with Google" button into el; onUser(user) runs after the session cookie is set. */
  async function button(el,onUser,onError){
    if(!ready){ el.innerHTML=`<p class="hint" style="margin:0">雲端登入即將開放。</p>`; return; }
    try{
      const g=await loadGsi();
      g.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID,ux_mode:"popup",auto_select:false,itp_support:true,callback:async resp=>{
        try{ const j=await api("/api/auth/google",{credential:resp.credential}); onUser(j.user); }catch(e){ (onError||alert)(e.message); }
      }});
      const dark=matchMedia("(prefers-color-scheme: dark)").matches;
      g.accounts.id.renderButton(el,{theme:dark?"filled_black":"outline",size:"large",shape:"pill",text:"signin_with",locale:"zh-TW",width:Math.min(320,el.clientWidth||320)});
    }catch(e){ el.innerHTML=`<p class="msg">${e.message}</p>`; }
  }
  const me=()=>api("/api/auth/me").then(j=>j.user).catch(e=>e.status?null:undefined);   // undefined = offline
  const logout=()=>{ try{ google.accounts.id.disableAutoSelect(); }catch(e){} return api("/api/auth/logout",{}); };
  return {ready,api,button,me,logout};
})();
