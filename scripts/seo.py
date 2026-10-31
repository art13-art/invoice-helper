"""Search-engine housekeeping. Run after adding or editing a page:  python3 scripts/seo.py

For every */index.html it writes, between <!--seo--> markers in <head>:
  - Open Graph / Twitter share tags (title, description, url, share image)
  - JSON-LD: WebApplication for tools, FAQPage built from the page's .faq <details>
and regenerates sitemap.xml and robots.txt.
"""
import datetime as dt, html, json, pathlib, re

SITE = "https://taxtools.tw"
ROOT = pathlib.Path(__file__).resolve().parent.parent
TODAY = dt.date.today().isoformat()
NOT_TOOLS = {"", "privacy", "join", "guide", "embed", "rates", "about", "salary"}

def text(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s))).strip()

ORG = {"@type": "Organization", "name": "稅務小工具", "alternateName": "taxtools.tw", "url": f"{SITE}/",
       "logo": f"{SITE}/icon-512.png", "email": "art13@doesart13.com", "publishingPrinciples": f"{SITE}/about/"}
# 歡迎搜尋引擎與 AI 搜尋、AI 助理的爬蟲讀取公開內容（GEO：讓 AI 讀得到才會引用）
AI_BOTS = ["Googlebot", "Bingbot", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
           "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot", "Applebot-Extended", "DuckAssistBot", "Meta-ExternalAgent", "CCBot"]
pages = []
for f in sorted([ROOT / "index.html", *ROOT.glob("*/index.html"), *ROOT.glob("guide/*/index.html"), *ROOT.glob("tax-calendar/*/index.html"), *ROOT.glob("salary/*/index.html")]):
    rel = f.parent.relative_to(ROOT).as_posix()
    rel = "" if rel == "." else rel
    if rel.startswith(("scripts", "functions", "lib", "assets", "join", "db", "admin", "worker", "tests")):
        continue
    src = f.read_text()
    title = text(re.search(r"<title>(.*?)</title>", src, re.S).group(1))
    m = re.search(r'<meta name="description" content="([^"]*)"', src)
    desc = html.unescape(m.group(1)) if m else ""
    url = f"{SITE}/{rel}/" if rel else f"{SITE}/"
    ogf = ROOT / "og" / ((rel.replace("/", "-") or "home") + ".png")
    img = f"{SITE}/og/{ogf.name}" if ogf.exists() else f"{SITE}/og.png"
    blocks = [
        f'<meta property="og:type" content="{"article" if rel.startswith("guide/") else "website"}">',
        f'<meta property="og:site_name" content="稅務小工具">',
        f'<meta property="og:locale" content="zh_TW">',
        f'<meta property="og:title" content="{html.escape(title)}">',
        f'<meta property="og:description" content="{html.escape(desc)}">',
        f'<meta property="og:url" content="{url}">',
        f'<meta property="og:image" content="{img}">',
        f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
        f'<meta name="twitter:card" content="summary_large_image">',
    ]
    ld = []
    if rel.startswith("guide/"):
        pub = re.search(r'<meta property="article:published_time" content="([^"]+)"', src)
        mod = re.search(r'<meta property="article:modified_time" content="([^"]+)"', src)
        h1 = text(re.search(r"<h1>(.*?)</h1>", src, re.S).group(1))
        org = ORG
        ld.append({"@context": "https://schema.org", "@type": "Article", "headline": h1, "description": desc, "url": url,
                   "mainEntityOfPage": url, "inLanguage": "zh-Hant-TW", "image": img,
                   "datePublished": pub.group(1) if pub else TODAY, "dateModified": mod.group(1) if mod else TODAY,
                   "author": org, "publisher": org})
        ld.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "稅務小工具", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "報稅解答", "item": f"{SITE}/guide/"},
            {"@type": "ListItem", "position": 3, "name": h1, "item": url}]})
    if rel.startswith("salary/"):
        h1 = text(re.search(r"<h1>(.*?)</h1>", src, re.S).group(1))
        ld.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "稅務小工具", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "月薪勞健保對照表", "item": f"{SITE}/salary/"},
            {"@type": "ListItem", "position": 3, "name": h1, "item": url}]})
    if rel == "rates":
        mod = re.search(r'<meta property="article:modified_time" content="([^"]+)"', src)
        ld.append({"@context": "https://schema.org", "@type": "Dataset", "name": title.split("｜")[0], "description": desc, "url": url,
                   "inLanguage": "zh-Hant-TW", "isAccessibleForFree": True, "dateModified": mod.group(1) if mod else TODAY,
                   "creator": ORG, "publisher": ORG, "spatialCoverage": "Taiwan",
                   "keywords": ["扣繳率", "二代健保補充保費", "基本工資", "綜所稅級距", "勞健保費率", "營業稅"],
                   "distribution": [{"@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": f"{SITE}/rates.json"}]})
    if rel == "about":
        ld.append({"@context": "https://schema.org", "@type": "AboutPage", "name": title.split("｜")[0], "url": url, "about": ORG, "inLanguage": "zh-Hant-TW"})
    if rel and rel not in NOT_TOOLS and "/" not in rel:
        ld.append({"@context": "https://schema.org", "@type": "WebApplication", "name": title.split("｜")[0],
                   "url": url, "description": desc, "inLanguage": "zh-Hant-TW", "applicationCategory": "FinanceApplication",
                   "operatingSystem": "Any", "isAccessibleForFree": True, "offers": {"@type": "Offer", "price": "0", "priceCurrency": "TWD"}})
    if not rel:
        ld.append({"@context": "https://schema.org", "@type": "WebSite", "name": "稅務小工具", "alternateName": "taxtools.tw", "url": f"{SITE}/", "inLanguage": "zh-Hant-TW"})
        ld.append({"@context": "https://schema.org", **ORG})
    faq = re.search(r'<section class="card faq">(.*?)</section>', src, re.S)
    if faq:
        qa = re.findall(r"<summary>(.*?)</summary>\s*<p>(.*?)</p>", faq.group(1), re.S)
        if qa:
            ld.append({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
                {"@type": "Question", "name": text(q), "acceptedAnswer": {"@type": "Answer", "text": text(a)}} for q, a in qa]})
    for obj in ld:
        blocks.append('<script type="application/ld+json">' + json.dumps(obj, ensure_ascii=False).replace("</", "<\\/") + "</script>")
    seo = "<!--seo-->\n" + "\n".join(blocks) + "\n<!--/seo-->"
    if "<!--seo-->" in src:
        src = re.sub(r"<!--seo-->.*?<!--/seo-->", lambda _: seo, src, flags=re.S)
    else:
        src = src.replace("</head>", seo + "\n</head>", 1)
    f.write_text(src)
    mod = re.search(r'<meta property="article:modified_time" content="([^"]+)"', src)
    pages.append((url, mod.group(1) if mod else TODAY, 1.0 if not rel else 0.7 if rel.startswith(("guide", "tax-calendar/", "salary")) else 0.5 if rel in NOT_TOOLS else 0.8))
    print(f"{url:45} faq={len(qa) if faq else 0}")

(ROOT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    "".join(f"  <url><loc>{u}</loc><lastmod>{m}</lastmod><priority>{p}</priority></url>\n" for u, m, p in pages) + "</urlset>\n")
DIS = "Disallow: /admin/\nDisallow: /api/\nDisallow: /scripts/\nDisallow: /lib/\nDisallow: /db/\nDisallow: /join/\n"
(ROOT / "robots.txt").write_text(
    "# 稅務小工具 taxtools.tw：歡迎搜尋引擎、AI 搜尋與 AI 助理讀取公開內容，引用時請附原文連結。\n"
    f"# 網站摘要：{SITE}/llms.txt　文章全文：{SITE}/llms-full.txt　稅率資料：{SITE}/rates.json\n\n"
    + "".join(f"User-agent: {b}\nAllow: /\n{DIS}\n" for b in AI_BOTS)
    + f"User-agent: *\nAllow: /\n{DIS}\nSitemap: {SITE}/sitemap.xml\n")
print(len(pages), "pages")

# llms-full.txt：解答文章與數字速查的純文字全文，給 AI 一次讀完（GEO）
def md(src):
    art = re.search(r'<article class="art">(.*?)</article>', src, re.S)
    s = art.group(1) if art else ""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", s, flags=re.S)
    s = re.sub(r"<h2[^>]*>(.*?)</h2>", lambda m: "\n\n## " + text(m.group(1)) + "\n", s, flags=re.S)
    s = re.sub(r"<summary>(.*?)</summary>", lambda m: "\n\n### " + text(m.group(1)) + "\n", s, flags=re.S)
    s = re.sub(r"<tr[^>]*>(.*?)</tr>", lambda m: "\n| " + " | ".join(text(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", m.group(1), re.S)) + " |", s, flags=re.S)
    s = re.sub(r'<a [^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', lambda m: f"{text(m.group(2))}（{m.group(1)}）", s, flags=re.S)
    s = re.sub(r"<li[^>]*>", "\n- ", s)
    s = re.sub(r"</(p|div|ol|ul|table)>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    s = "\n".join(l.strip() for l in re.sub(r"[ \t]+", " ", s).split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s)
    return re.sub(r"(\|\n)\n+(\|)", r"\1\2", s).strip()

full = ["# 稅務小工具（taxtools.tw）解答文章全文", "",
        "> 民間網站，非政府官方。內容依現行法規整理，僅供參考，實際以主管機關規定為準。引用時請附原文連結。", ""]
for f in [ROOT / "rates/index.html", ROOT / "salary/index.html", *sorted(ROOT.glob("guide/*/index.html"))]:
    if not f.exists():
        continue
    src = f.read_text()
    rel = f.parent.relative_to(ROOT).as_posix()
    h1 = text(re.search(r"<h1>(.*?)</h1>", src, re.S).group(1))
    meta = re.search(r'<p class="meta">(.*?)</p>', src, re.S)
    full += [f"---", "", f"# {h1}", "", f"網址：{SITE}/{rel}/", text(meta.group(1)) if meta else "", "", md(src), ""]
(ROOT / "llms-full.txt").write_text("\n".join(full) + "\n")
print("llms-full.txt", len(full), "lines")
