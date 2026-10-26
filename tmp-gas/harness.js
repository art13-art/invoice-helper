// Runs in the Apps Script editor tab: shows a phone-sized frame from the site and sends it the editor's sources.
window.__harness=function(opts){
  opts=opts||{};
  return new Promise((resolve)=>{
    let f=document.getElementById('__hf'); if(f) f.remove();
    f=document.createElement('iframe'); f.id='__hf';
    f.style.cssText='position:fixed;left:0;top:0;width:'+(opts.w||390)+'px;height:'+(opts.h||844)+'px;z-index:2147483647;border:0;background:#fff';
    const on=e=>{ if(e.source!==f.contentWindow) return;
      if(e.data==='view-ready') f.contentWindow.postMessage(Object.assign({sources:monaco.editor.getModels().map(m=>m.getValue())},opts),'*');
      if(e.data==='rendered'){ removeEventListener('message',on); setTimeout(()=>resolve('rendered'),700); } };
    addEventListener('message',on);
    f.src='https://invoice-helper-eok.pages.dev/tmp-gas/view.html?'+Date.now();
    document.documentElement.appendChild(f);
    setTimeout(()=>resolve('timeout'),15000);
  });
};
'harness loaded';
