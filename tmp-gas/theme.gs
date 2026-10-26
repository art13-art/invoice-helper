// 視覺樣式：只改外觀，不改任何記帳邏輯或資料。
// doGet 最後把 themeHtml_() 放在 </body> 前面，讓這裡的樣式蓋過前面各功能的預設樣式。
// 要恢復原本外觀：把 doGet 裡呼叫 themeHtml_() 的那一行刪掉即可。
function themeHtml_(){
  return `<style>
:root{
  color-scheme:light dark;
  --bg:#F3F1EC;--card:#FFFFFF;--ink:#1D2530;--muted:#6A727E;--line:#E7E3DB;
  --field:#FAF9F6;--fieldline:#D9D4CA;--soft:#F1F5F9;
  --accent:#2554A6;--accent-ink:#FFFFFF;--accent-soft:#E8EEF9;--ring:rgba(37,84,166,.18);
  --out:#C4532E;--out-soft:#FBEEE8;--in:#1D8558;--in-soft:#E5F3EB;
  --ok-bg:#E6F3EC;--ok-ink:#145C3B;--warn-bg:#FFF3D9;--warn-ink:#704B00;--err-bg:#FCEBE8;--err-ink:#A3271C;
  --shadow:0 1px 2px rgba(29,37,48,.05),0 8px 24px rgba(29,37,48,.06);
  --chev:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%236A727E' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
}
@media (prefers-color-scheme:dark){:root{
  --bg:#12161B;--card:#1B2028;--ink:#E8EBEF;--muted:#9AA3AE;--line:#2A313B;
  --field:#151A20;--fieldline:#363F4A;--soft:#18202A;
  --accent:#7EA5EE;--accent-ink:#0D1A33;--accent-soft:#1F2E48;--ring:rgba(126,165,238,.25);
  --out:#EE8E6C;--out-soft:#3A2219;--in:#5BC891;--in-soft:#173126;
  --ok-bg:#173126;--ok-ink:#9BE3BE;--warn-bg:#382C12;--warn-ink:#F3D58A;--err-bg:#3B1C19;--err-ink:#F6A79C;
  --shadow:0 1px 2px rgba(0,0,0,.3);
  --chev:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%239AA3AE' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
}}
html,body{background:var(--bg)}
body{color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}
.wrap{padding:max(16px,env(safe-area-inset-top)) 14px max(32px,env(safe-area-inset-bottom))}

/* 標題 */
h1.t-title{display:flex;align-items:center;gap:10px;margin:2px 4px 2px;font-size:22px;font-weight:800;letter-spacing:.02em}
.t-logo{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--accent-soft);font-size:19px;flex:none}
.t-date{margin:0 4px 0 50px;font-size:14px;color:var(--muted)}

/* 卡片 */
.t-card,#subscriptionList,.history{background:var(--card);border:0;border-radius:20px;padding:18px 16px 20px;box-shadow:var(--shadow);margin-top:14px}
.t-card>.label:first-child{margin-top:0}

/* 標籤 */
.label,.history-dialog label{display:flex;align-items:center;gap:8px;margin:18px 0 8px;font-size:15px;font-weight:700;color:var(--ink);letter-spacing:.02em}
.required{padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--muted);font-size:12px;font-weight:600}
.label span[style]{color:var(--muted)}

/* 選擇按鈕 */
.choices{gap:8px}
.choice,.history .history-entity{min-height:50px;border:1.5px solid var(--fieldline);border-radius:14px;background:var(--field);color:var(--ink);font-size:17px;font-weight:700;transition:background .15s,border-color .15s,box-shadow .15s}
.choice.selected,.history .history-entity.selected{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);box-shadow:0 4px 14px var(--ring)}
#flowChoices .choice[data-value="支出"].selected{background:var(--out);border-color:var(--out);box-shadow:0 4px 14px rgba(196,83,46,.22)}
#flowChoices .choice[data-value="收入"].selected{background:var(--in);border-color:var(--in);box-shadow:0 4px 14px rgba(29,133,88,.22)}
@media (prefers-color-scheme:dark){#flowChoices .choice.selected{color:#12161B}}

/* 輸入欄位 */
input,textarea,select{border:1.5px solid var(--fieldline);border-radius:14px;background:var(--field);color:var(--ink);font-size:17px;padding:12px 14px;transition:border-color .15s,box-shadow .15s,background .15s}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.75}
input:focus,textarea:focus,select:focus{border-color:var(--accent);background-color:var(--card);box-shadow:0 0 0 4px var(--ring)}
select{-webkit-appearance:none;appearance:none;padding-right:40px;background-image:var(--chev);background-repeat:no-repeat;background-position:right 14px center}
input:disabled,textarea:disabled,select:disabled{opacity:.6}
#amount{min-height:58px;font-size:28px;font-weight:800;letter-spacing:.01em;font-variant-numeric:tabular-nums}
textarea{height:72px;min-height:72px}
#categoryHint{color:var(--muted)}
[style*="color:#666"],[style*="color:#555"]{color:var(--muted)!important}
#catAddMsg{color:var(--err-ink)!important}

/* 分類旁的小按鈕 */
.cat-tools{gap:8px;margin-top:10px}
#retryCategory,.cat-tools button{min-height:38px;padding:6px 14px!important;border:1px solid var(--line)!important;border-radius:999px;background:var(--card)!important;color:var(--accent)!important;text-decoration:none!important;font-size:14px!important;font-weight:600}
#retryCategory:disabled,.cat-tools button:disabled{opacity:.5}
.cat-add{margin-top:10px}
.cat-add input{font-size:17px}
.cat-add button,.cat-row button.ok{border:0!important;background:var(--accent)!important;color:var(--accent-ink)!important;border-radius:12px}
.cat-add button.ghost{border:1.5px solid var(--fieldline)!important;background:var(--card)!important;color:var(--ink)!important}

/* 記帳按鈕 */
.submit{min-height:56px;margin-top:20px;border-radius:16px;background:var(--accent);color:var(--accent-ink);font-size:19px;letter-spacing:.12em;box-shadow:0 6px 18px var(--ring);transition:transform .08s,opacity .15s}
.submit:active{transform:scale(.985)}

/* 結果訊息 */
#result{margin-top:12px;padding:12px 14px;border-radius:14px;font-size:15px;line-height:1.6}
.ok{background:var(--ok-bg);color:var(--ok-ink)}.warn{background:var(--warn-bg);color:var(--warn-ink)}.error{background:var(--err-bg);color:var(--err-ink)}
#learnBox{margin-top:12px;padding:14px;border-radius:16px;background:var(--warn-bg)}
#learnBox .label{margin-top:0;color:var(--warn-ink)}
#learnBox input,#learnBox select{background-color:var(--card)}
#learnButton{min-height:48px;margin-top:4px;font-size:16px;letter-spacing:.04em}

/* 每月訂閱 */
.sub-box{border:1px solid var(--line);border-radius:16px;background:var(--soft);color:var(--ink)}
#subscriptionPanel{margin-top:12px}
.sub-box strong{font-size:16px}
#subscriptionList>strong,.history h2{display:block;font-size:18px;font-weight:800;letter-spacing:.02em}
.sub-box label{font-size:14px;color:var(--ink)}
.sub-note,.history-note,#historyCount,.cat-note,.history-meta{color:var(--muted)}
.sub-item{border-top:1px solid var(--line)}
.sub-box button,.history button,.history-dialog button,.cat-foot button{min-height:42px;padding:8px 16px;border:1.5px solid var(--fieldline);border-radius:12px;background:var(--card);color:var(--ink);font-size:15px;font-weight:600}
.sub-box button:disabled,.history button:disabled{opacity:.45}

/* 查看帳目 */
.history-head h2{margin:0}
.history .history-entity{min-height:44px;padding:8px 4px;font-size:15px}
.history-card{margin:10px 0;padding:14px 14px 12px;border:1px solid var(--line);border-left:4px solid var(--out);border-radius:14px;background:var(--field)}
.history-card.t-in{border-left-color:var(--in)}
.history-card.voided{background:var(--soft);border-left-color:var(--fieldline);opacity:.75}
.history-title{font-size:17px;font-variant-numeric:tabular-nums}
.history-meta{font-size:14px}
.history-text{color:var(--ink)}
.history button.danger,.history-dialog button.danger{color:var(--err-ink);border-color:var(--err-bg)}
.history-dialog button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
#loadMoreHistory{background:var(--soft)}
#editError{color:var(--err-ink)}

/* 對話框 */
.history-dialog,#catDialog{background:var(--card);color:var(--ink);border-radius:22px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
.history-dialog::backdrop,#catDialog::backdrop{background:rgba(18,22,27,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.history-dialog label{margin:14px 0 6px;font-size:14px}
.cat-row{border-top:1px solid var(--line)}
.cat-row button{border:1px solid var(--fieldline);border-radius:12px;background:var(--field);color:var(--ink)}
.cat-row button.del{color:var(--err-ink)}
.cat-row button.del.arm{background:var(--err-ink);border-color:var(--err-ink);color:var(--card)}
.cat-row .n small{color:var(--muted)}
#catMsg.err{color:var(--err-ink)}
.cat-foot button{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}

@media screen and (max-height:700px){.wrap{padding-top:10px}h1.t-title{font-size:20px}.label{margin-top:14px}.choice{min-height:46px}#amount{min-height:52px;font-size:25px}.submit{min-height:52px}}
</style>
<script>(function(){try{
 var main=document.querySelector('main.wrap'),h1=main&&main.querySelector('h1');
 if(h1&&!h1.classList.contains('t-title')){
  var label=h1.textContent.replace('💰','').trim()||'AI 財務記帳';
  h1.classList.add('t-title');h1.textContent='';
  var logo=document.createElement('span');logo.className='t-logo';logo.setAttribute('aria-hidden','true');logo.textContent='💰';
  h1.appendChild(logo);h1.appendChild(document.createTextNode(label));
  var d=document.createElement('p');d.className='t-date';
  d.textContent=new Date().toLocaleDateString('zh-TW',{month:'long',day:'numeric',weekday:'long'});
  h1.after(d);
 }
 var first=main&&main.querySelector(':scope > .label'),stop=document.getElementById('subscriptionList')||document.getElementById('historyMount');
 if(first&&stop&&stop.parentNode===main){
  var card=document.createElement('section');card.className='t-card';main.insertBefore(card,first);
  var n=card.nextSibling;while(n&&n!==stop){var nx=n.nextSibling;card.appendChild(n);n=nx}
 }
 var tools=document.querySelector('.cat-tools'),retry=document.getElementById('retryCategory');
 if(tools&&retry)tools.insertBefore(retry,tools.firstChild);
 var list=document.getElementById('historyList');
 if(list){var tag=function(){list.querySelectorAll('.history-card').forEach(function(c){var t=c.querySelector('.history-title');c.classList.toggle('t-in',!!t&&t.textContent.indexOf('· 收入')>=0)})};
  new MutationObserver(tag).observe(list,{childList:true});tag()}
}catch(e){}})();</script>`;
}
