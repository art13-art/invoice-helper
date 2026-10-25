/* Shared helpers for taxtools calculators. */
function toast(msg){ const t=document.getElementById("toast"); if(!t) return; t.textContent=msg; t.classList.add("on"); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove("on"),1800); }
function copyText(t,okMsg){
  const done=()=>toast(okMsg||"已複製");
  const fallback=()=>{ const ta=document.createElement("textarea"); ta.value=t; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); done(); }catch(e){ toast("無法自動複製，請手動選取"); } ta.remove(); };
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done,fallback); else fallback();
}
/* items: [[Date, title, description], ...]; all-day events with a reminder 3 days before */
function downloadICS(items,label,filename){
  const pad=n=>String(n).padStart(2,"0"), ymd=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const now=new Date(), stamp=`${ymd(now)}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const esc=t=>t.replace(/[\\,;]/g,m=>"\\"+m).replace(/\n/g,"\\n");
  const ev=items.map(([d,t,w],i)=>{ const e=new Date(d); e.setDate(e.getDate()+1);
    return ["BEGIN:VEVENT",`UID:${ymd(d)}-${i}-${now.getTime()}@taxtools.tw`,`DTSTAMP:${stamp}`,`DTSTART;VALUE=DATE:${ymd(d)}`,`DTEND;VALUE=DATE:${ymd(e)}`,
      `SUMMARY:${esc(label+"："+t)}`,`DESCRIPTION:${esc(w+" （"+label+"・taxtools.tw）")}`,
      "BEGIN:VALARM","ACTION:DISPLAY",`DESCRIPTION:${esc(t)}`,"TRIGGER:-P3D","END:VALARM","END:VEVENT"].join("\r\n"); });
  const ics=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//taxtools.tw//calc//ZH","CALSCALE:GREGORIAN",...ev,"END:VCALENDAR"].join("\r\n");
  const blob=new Blob([ics],{type:"text/calendar;charset=utf-8"}), a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=filename||"稅務期限.ics"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000); toast("已產生行事曆檔，打開就能加入");
}
/* NHI supplementary premium for one payment. status: "normal" | "vulnerable" | "exempt"; kind: "fee"|"rent" (2萬 threshold) or "parttime" (基本工資) */
function nhiPremium(P,kind,status){
  const N=window.RATES.nhi;
  if(status==="exempt") return 0;
  const min=kind==="parttime"?N.partTimeMin:(status==="vulnerable"?N.vulnerableMin:N.minPerPayment);
  return P>=min?Math.round(Math.min(P,N.capPerPayment)*N.rate):0;
}
/* smallest payment whose net reaches the target; net is not monotonic around thresholds, so test candidates and prefer round numbers */
function solveGross(T,split,rates){
  if(split(T).net>=T) return split(T);
  const cands=[];
  rates.forEach(r=>{ if(r<=0||r>=1) return; const e=Math.ceil(T/(1-r)); for(let p=Math.max(T,e-40);p<=e+40;p++){ const s=split(p); if(s.net>=T) cands.push(s); } });
  if(!cands.length){ let p=T; while(p<T*2){ const s=split(p); if(s.net>=T) return s; p++; } return split(T); }
  const tz=n=>{let z=0;while(n>0&&n%10===0){z++;n/=10;}return z;};
  const min=Math.min(...cands.map(c=>c.net-T));
  const near=cands.filter(c=>c.net-T<=min+3);
  near.sort((a,b)=>tz(b.P)-tz(a.P)||a.P-b.P);
  return near[0];
}
