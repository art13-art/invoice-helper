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
NOT_TOOLS = {"", "privacy", "join", "guide"}

def text(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s))).strip()

pages = []
for f in sorted([ROOT / "index.html", *ROOT.glob("*/index.html"), *ROOT.glob("guide/*/index.html")]):
    rel = f.parent.relative_to(ROOT).as_posix()
    rel = "" if rel == "." else rel
    if rel.startswith(("scripts", "functions", "lib", "assets", "join", "db", "admin", "worker", "tests")):
        continue
    src = f.read_text()
    title = text(re.search(r"<title>(.*?)</title>", src, re.S).group(1))
    m = re.search(r'<meta name="description" content="([^"]*)"', src)
    desc = html.unescape(m.group(1)) if m else ""
    url = f"{SITE}/{rel}/" if rel else f"{SITE}/"
    blocks = [
        f'<meta property="og:type" content="{"article" if rel.startswith("guide/") else "website"}">',
        f'<meta property="og:site_name" content="稅務小工具">',
        f'<meta property="og:locale" content="zh_TW">',
        f'<meta property="og:title" content="{html.escape(title)}">',
        f'<meta property="og:description" content="{html.escape(desc)}">',
        f'<meta property="og:url" content="{url}">',
        f'<meta property="og:image" content="{SITE}/og.png">',
        f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
        f'<meta name="twitter:card" content="summary_large_image">',
    ]
    ld = []
    if rel.startswith("guide/"):
        pub = re.search(r'<meta property="article:published_time" content="([^"]+)"', src)
        mod = re.search(r'<meta property="article:modified_time" content="([^"]+)"', src)
        h1 = text(re.search(r"<h1>(.*?)</h1>", src, re.S).group(1))
        org = {"@type": "Organization", "name": "稅務小工具", "url": f"{SITE}/"}
        ld.append({"@context": "https://schema.org", "@type": "Article", "headline": h1, "description": desc, "url": url,
                   "mainEntityOfPage": url, "inLanguage": "zh-Hant-TW", "image": f"{SITE}/og.png",
                   "datePublished": pub.group(1) if pub else TODAY, "dateModified": mod.group(1) if mod else TODAY,
                   "author": org, "publisher": org})
        ld.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "稅務小工具", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "報稅解答", "item": f"{SITE}/guide/"},
            {"@type": "ListItem", "position": 3, "name": h1, "item": url}]})
    if rel and rel not in NOT_TOOLS and not rel.startswith("guide/"):
        ld.append({"@context": "https://schema.org", "@type": "WebApplication", "name": title.split("｜")[0],
                   "url": url, "description": desc, "inLanguage": "zh-Hant-TW", "applicationCategory": "FinanceApplication",
                   "operatingSystem": "Any", "isAccessibleForFree": True, "offers": {"@type": "Offer", "price": "0", "priceCurrency": "TWD"}})
    if not rel:
        ld.append({"@context": "https://schema.org", "@type": "WebSite", "name": "稅務小工具", "alternateName": "taxtools.tw", "url": f"{SITE}/", "inLanguage": "zh-Hant-TW"})
        ld.append({"@context": "https://schema.org", "@type": "Organization", "name": "稅務小工具", "url": f"{SITE}/", "logo": f"{SITE}/icon-512.png", "email": "art13@doesart13.com"})
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
    pages.append((url, 1.0 if not rel else 0.7 if rel.startswith("guide") else 0.5 if rel in NOT_TOOLS else 0.8))
    print(f"{url:45} faq={len(qa) if faq else 0}")

(ROOT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    "".join(f"  <url><loc>{u}</loc><lastmod>{TODAY}</lastmod><priority>{p}</priority></url>\n" for u, p in pages) + "</urlset>\n")
(ROOT / "robots.txt").write_text(f"User-agent: *\nDisallow: /admin/\nAllow: /\nDisallow: /api/\nDisallow: /scripts/\nDisallow: /lib/\nDisallow: /db/\nDisallow: /join/\n\nSitemap: {SITE}/sitemap.xml\n")
print(len(pages), "pages")
