"""Builds the printable yearly deadline sheet /tax-calendar/<year>/ from assets/deadlines.json.
Run after build_deadlines.py:  python3 scripts/build_yearly.py 2027"""
import json, sys, pathlib, datetime as dt, html
ROOT = pathlib.Path(__file__).resolve().parent.parent
Y = int(sys.argv[1]) if len(sys.argv) > 1 else dt.date.today().year + 1
D = json.loads((ROOT / "assets/deadlines.json").read_text())
ROLE = D["roles"]
W = "一二三四五六日"
items = [i for i in D["items"] if i["due"].startswith(str(Y))]
main = [i for i in items if i["kind"] == "main"]
monthly = [i for i in items if i["kind"] != "main"]
def d(s): return dt.date.fromisoformat(s)
def md(s): x = d(s); return f"{x.month}/{x.day}（{W[x.weekday()]}）"
rows = []
for m in range(1, 13):
    ms = [i for i in main if d(i["due"]).month == m]
    for k, i in enumerate(ms):
        moved = f'<small>原 {d(i["orig"]).month}/{d(i["orig"]).day}，遇假日順延</small>' if i.get("orig") else ""
        link = f' <a href="{i["link"]}">試算</a>' if i.get("link") else ""
        rows.append(f'<tr>{f"<th rowspan={len(ms)} scope=rowgroup>{m} 月</th>" if k == 0 else ""}<td class="n">{md(i["due"])}{moved}</td><td><b>{html.escape(i["title"])}</b><span>{html.escape(i["desc"])}{link}</span></td><td class="r">{"、".join(ROLE[r] for r in i["roles"])}</td></tr>')
roc = Y - 1911
mon = sorted({(d(i["due"]).month, i["title"].split(" ")[0] if False else i["id"].split("-")[0]) for i in monthly})
title = f"{roc} 年報稅行事曆總表（{Y}）｜營業稅、扣繳、綜所稅、房屋稅期限一頁看完"
desc = f"{roc} 年（{Y} 年）全年報稅、繳費期限一頁看完：營業稅、扣繳憑單、綜所稅、房屋稅、地價稅、牌照稅，已依假日順延，可以列印或存成 PDF。"
page = f'''<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
<link rel="canonical" href="https://taxtools.tw/tax-calendar/{Y}/">
<meta name="description" content="{desc}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#F5F3EE">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<meta name="tt-font" content="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&display=swap">
<link rel="stylesheet" href="/assets/base.css?v=2026102802">
<link rel="stylesheet" href="/assets/nav.css?v=2026102802">
<link rel="stylesheet" href="/assets/guide.css?v=2026102802">
<style>
.yr{{max-width:980px}}
.yr table{{border-collapse:collapse;width:100%;font-size:15px;line-height:1.55}}
.yr th,.yr td{{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid var(--line)}}
.yr thead th{{background:var(--sunk);color:var(--muted);font-size:13.5px;border-top:0}}
.yr tbody th{{font-family:var(--f-head);color:var(--accent);white-space:nowrap;font-size:17px}}
.yr td.n{{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:700}}
.yr td.n small{{display:block;font-weight:400;color:var(--muted);font-size:12.5px}}
.yr td b{{display:block}}
.yr td span{{color:var(--muted);font-size:14px}}
.yr td.r{{color:var(--muted);font-size:14px;white-space:nowrap}}
.yr col.c1{{width:4.5em}} .yr col.c2{{width:9.5em}} .yr col.c4{{width:11em}}
.monthly{{display:grid;gap:4px;font-size:15px}}
@media (max-width:640px){{.yr td.r{{white-space:normal}}}}
@media print{{
  @page{{size:A4;margin:12mm}}
  body{{background:#fff;font-size:11pt}}
  .site-head,.no-print,.foot-links,.fb-head{{display:none!important}}
  .wrap{{padding:0;gap:8px}}
  .yr table{{font-size:10pt}} .yr td span,.yr td.n small{{display:none}} .yr th,.yr td{{padding:3px 6px}} .page-head p{{font-size:9.5pt}} .monthly p{{font-size:9.5pt;margin:0}} .monthly h2{{font-size:11pt!important}} .site-foot{{font-size:8pt}}
  .yr tbody tr{{break-inside:avoid}} a{{color:inherit;text-decoration:none}}
}}
</style>
</head>
<body>
<header class="site-head">
  <a class="site-brand" href="/"><img src="/icon-192.png" alt="">稅務小工具</a>
  <nav class="site-nav" aria-label="工具"></nav>
</header>

<div class="wrap" role="main">
  <div class="page-head">
    <p class="crumb no-print"><a href="/">稅務小工具</a>›<a href="/tax-calendar/">報稅行事曆</a></p>
    <h1>{roc} 年報稅行事曆總表</h1>
    <p>{roc} 年（{Y} 年）全年的報稅、繳費期限，已依行政院人事行政總處辦公日曆表順延假日。可以直接列印，或存成 PDF 貼在辦公室。</p>
    <div class="actions no-print" style="margin-top:8px"><button type="button" class="btn primary" onclick="print()">列印／存成 PDF</button><a class="btn" style="display:inline-flex;align-items:center;text-decoration:none" href="/tax-calendar/">訂閱到手機行事曆</a></div>
  </div>

  <div class="yr">
    <table>
      <colgroup><col class="c1"><col class="c2"><col><col class="c4"></colgroup>
      <thead><tr><th>月份</th><th>期限</th><th>要做的事</th><th>誰要做</th></tr></thead>
      <tbody>
{chr(10).join(rows)}
      </tbody>
    </table>
  </div>

  <section class="yr monthly">
    <h2 style="font-family:var(--f-head);font-size:19px;margin:8px 0 0">每個月固定要做的事（公司・行號）</h2>
    <p>每月 10 日前：繳納上個月代扣的所得稅（遇假日順延）。</p>
    <p>每月月底前：繳納上個月的勞保、健保、勞退保費，以及上個月代扣的二代健保補充保費（遇假日順延）。</p>
  </section>

  <p class="site-foot">期限依所得稅法、加值型及非加值型營業稅法、全民健康保險法、勞工保險條例、房屋稅條例、土地稅法、使用牌照稅法等規定整理，假日依行政院人事行政總處辦公日曆表順延。若主管機關另行公告延長，以公告為準。資料更新：{D["generated"][:10] if "generated" in D else ""}・taxtools.tw</p>
</div>
<script src="/assets/nav.js?v=2026102802"></script>
</body>
</html>
'''
out = ROOT / "tax-calendar" / str(Y) / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page)
print(out, len(rows), "rows")
