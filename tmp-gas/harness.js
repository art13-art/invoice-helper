// Test harness: runs inside the Apps Script editor page. Builds doGet() HTML from the open editor files plus theme.gs,
// adds a fake google.script.run with sample data, and shows it in a phone-sized frame.
window.__harness=async function(opts){
  opts=opts||{};
  const base='https://invoice-helper-eok.pages.dev/tmp-gas/';
  const theme=opts.noTheme?'function themeHtml_(){return ""}':await (await fetch(base+'theme.gs?'+Date.now(),{cache:'no-store'})).text();
  const models=monaco.editor.getModels().map(m=>m.getValue()).filter(s=>s.indexOf('function themeHtml_')<0);
  const Html={createHtmlOutput:h=>{const o={getContent:()=>h,setTitle(){return o},addMetaTag(){return o}};return o}};
  let html=new Function('HtmlService',models.join('\n')+'\n'+theme+'\nvar h=doGet().getContent();if(h.indexOf("themeHtml_")<0&&!/class="t-title"/.test(h))h=h.replace("</body>",function(){return themeHtml_()+"</body>"});return h;')(Html);
  const cats=['餐飲','交通','住宿','生活用品','服飾','醫療','娛樂','美容／個人照護','採購／材料','辦公室用品採購','廣告行銷','人事薪資','租金','水電瓦斯','軟體／訂閱','設備','運費','手續費','稅費','保險','業務收入','其他','每月訂閱制'];
  const data={
    getTransactionPreview:{ok:true,category:opts.cat||'餐飲',categories:cats},
    getAccountOptions:{banks:['國泰世華','台新 Richart'],cards:['玉山卡','國泰 CUBE 卡']},
    getSubscriptions:{today:'2026-10-26',items:[{id:'S1',version:'v',name:'ChatGPT',amount:600,day:5,payment:'信用卡',account:'玉山卡',active:true,notes:'',result:'2026-10 已記帳'}]},
    getRecentEntries:{ok:true,categories:cats,hasMore:true,nextCursor:{},entries:[
      {id:'a',version:'v',date:'2026-10-26',entity:'個人',flow:'支出',amount:680,category:'餐飲',payment:'信用卡',account:'玉山卡',text:'午餐 玉山卡',notes:'',voided:false},
      {id:'b',version:'v',date:'2026-10-25',entity:'個人',flow:'收入',amount:12800,category:'業務收入',payment:'銀行轉帳',account:'國泰世華',text:'課程收入',notes:'十月講座',voided:false},
      {id:'c',version:'v',date:'2026-10-24',entity:'個人',flow:'支出',amount:250,category:'美容／個人照護',payment:'待確認',account:'',text:'理髮',notes:'',voided:true,restorable:true}]},
    getCategoryManager:{categories:cats,protectedCategories:['每月訂閱制'],counts:{'餐飲':12,'交通':4}},
  };
  const shim='<script>window.__D='+JSON.stringify(data)+';window.google={script:{get run(){let ok=()=>{},fail=()=>{};const p=new Proxy({},{get(_,k){if(k==="withSuccessHandler")return f=>{ok=f;return p};if(k==="withFailureHandler")return f=>{fail=f;return p};return (...a)=>setTimeout(()=>ok(JSON.parse(JSON.stringify(window.__D[k]||{ok:true,message:"ok",categories:[]}))),30)}});return p}}};<\/script>';
  html=html.replace('<head>','<head>'+shim+(opts.dark?'<style>:root{color-scheme:dark}</style>':''));
  if(opts.dark)html=html.replace(/@media \(prefers-color-scheme:dark\)\{/g,'@media all{');
  html=html.replace('</body>','<script>'+(opts.after||'')+'<\/script></body>');
  const url=URL.createObjectURL(new Blob([html],{type:'text/html'}));
  let f=document.getElementById('__hf');
  if(!f){f=document.createElement('iframe');f.id='__hf';document.documentElement.appendChild(f)}
  const w=opts.w||390,hh=opts.h||844;
  f.style.cssText='position:fixed;left:0;top:0;width:'+w+'px;height:'+hh+'px;z-index:2147483647;border:0;background:#fff';
  f.src=url;
  await new Promise(r=>f.onload=r);
  await new Promise(r=>setTimeout(r,400));
  return 'ok '+html.length;
};
'harness loaded';
