#!/usr/bin/env python3
"""每日全站檢查（GitHub Actions 每天跑，不用 Claude）。

用法：BASE=https://taxtools.tw python3 scripts/sitecheck.py
      BASE=http://127.0.0.1:8787 python3 scripts/sitecheck.py   （本機）
輸出：report.md（給人和每日簡報看），有問題時結束碼 1。

檢查：sitemap 每一頁 × 桌機 1280／手機 390
  - HTTP 狀態、<title>、canonical
  - JS 錯誤（pageerror、console error）
  - 版面水平溢出
  - 站內連結是否 404
  - 統編查詢 API（只在正式網址）
User-Agent 帶 "taxtools-monitor"，lib/stats.js 會把它當機器人，不算進流量統計。
"""
import os, re, sys, time, json, urllib.request
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://taxtools.tw").rstrip("/")
PROD = "https://taxtools.tw"
UA_TAIL = " taxtools-monitor"
VIEWPORTS = {"桌機": (1280, 800), "手機": (390, 844)}
IGNORE_CONSOLE = re.compile(r"favicon|googletagmanager|fonts\.g|ERR_BLOCKED|net::ERR_ABORTED|/api/track|/og/cards/", re.I)  # 圖卡缺月份時頁面會 onerror 自動移除
LOCAL = not BASE.startswith(PROD)


def fetch(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0" + UA_TAIL, "DNT": "1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def pages():
    st, xml = fetch(BASE + "/sitemap.xml")
    if st != 200:
        sys.exit(f"讀不到 sitemap.xml（{st}）")
    return [loc.replace(PROD, BASE) for loc in re.findall(r"<loc>(.*?)</loc>", xml)]


def main():
    t0 = time.time()
    urls = pages()
    problems, links = [], set()
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vname, (w, h) in VIEWPORTS.items():
            ctx = b.new_context(viewport={"width": w, "height": h},
                                user_agent=f"Mozilla/5.0 (X11; Linux x86_64) Chrome/130{UA_TAIL}",
                                extra_http_headers={"DNT": "1"})
            for url in urls:
                path = urlparse(url).path
                page = ctx.new_page()
                errs = []
                page.on("pageerror", lambda e: errs.append(f"JS 錯誤：{e}"))
                # 「Failed to load resource」不含網址，改由 response／requestfailed 回報，才知道是哪個檔
                page.on("console", lambda m: m.type == "error" and not IGNORE_CONSOLE.search(m.text)
                        and not m.text.startswith("Failed to load resource")
                        and errs.append(f"console：{m.text[:160]}"))

                def on_resp(r):
                    u = r.url
                    if r.status >= 400 and u.startswith(BASE) and not (LOCAL and "/api/" in u) \
                            and not IGNORE_CONSOLE.search(u):
                        errs.append(f"資源 HTTP {r.status}：{u.replace(BASE, '')}")
                page.on("response", on_resp)
                def on_fail(r):
                    why = r.failure or ""
                    # 關頁時被中止的請求（ERR_ABORTED）不算問題
                    if LOCAL or "ABORTED" in why or IGNORE_CONSOLE.search(r.url):
                        return
                    errs.append(f"資源載入失敗（{why}）：{r.url[:120]}")
                page.on("requestfailed", on_fail)
                try:
                    resp = page.goto(url, wait_until="networkidle", timeout=30000)
                except Exception as e:
                    problems.append((path, vname, f"打不開：{str(e)[:120]}"))
                    page.close(); continue
                if not resp or resp.status != 200:
                    problems.append((path, vname, f"HTTP {resp.status if resp else '無回應'}"))
                info = page.evaluate("""() => ({
                    title: document.title,
                    canon: (document.querySelector('link[rel=canonical]')||{}).href||'',
                    over: document.documentElement.scrollWidth - window.innerWidth,
                    links: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
                })""")
                if not info["title"].strip():
                    problems.append((path, vname, "沒有 <title>"))
                if vname == "桌機" and info["canon"] and not info["canon"].startswith(PROD):
                    problems.append((path, vname, f"canonical 不是正式網址：{info['canon']}"))
                if info["over"] > 1:
                    problems.append((path, vname, f"版面水平溢出 {info['over']}px"))
                for e in errs:
                    problems.append((path, vname, e))
                for href in info["links"]:
                    full = urljoin(url, href)
                    if full.startswith(BASE) and "/api/" not in full:
                        links.add(full.split("#")[0])
                page.close()
            ctx.close()
        b.close()

    bad_links = []
    for l in sorted(links):
        st, _ = fetch(l)
        if st != 200:
            bad_links.append((l.replace(BASE, ""), st))
    for l, st in bad_links:
        problems.append((l, "連結", f"站內連結 HTTP {st}"))

    api_note = "本機略過"
    if not LOCAL:
        st, body = fetch(BASE + "/api/company?ubn=22099131")
        ok = st == 200 and "台灣積體電路" in body
        api_note = "正常" if ok else f"異常（HTTP {st}）"
        if not ok:
            problems.append(("/api/company", "API", f"統編查詢異常（HTTP {st}）"))

    tw = time.strftime("%Y-%m-%d %H:%M", time.gmtime(time.time() + 8 * 3600))
    lines = [f"# 每日全站檢查 {tw}（台北）", "",
             f"- 結果：{'❌ 有 ' + str(len(problems)) + ' 個問題' if problems else '✅ 全部通過'}",
             f"- 頁面：{len(urls)} 頁 × 桌機／手機；站內連結 {len(links)} 個；統編 API：{api_note}",
             f"- 耗時：{time.time() - t0:.0f} 秒", ""]
    if problems:
        lines += ["| 頁面 | 檢查 | 問題 |", "| --- | --- | --- |"]
        lines += [f"| {a} | {b_} | {c.replace('|', '／')} |" for a, b_, c in problems[:80]]
        if len(problems) > 80:
            lines.append(f"\n另有 {len(problems) - 80} 個問題未列出。")
    open("report.md", "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
