// Subscribable tax calendar: GET /api/calendar?roles=company,person,landlord,car&monthly=1
// Reads the same /assets/deadlines.json the page uses and returns an iCalendar feed with reminders.
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const roles = (u.searchParams.get("roles") || "company,person,landlord,car").split(",").filter(Boolean);
  const monthly = u.searchParams.get("monthly") !== "0";
  const res = await env.ASSETS.fetch(new URL("/assets/deadlines.json", u.origin));
  const data = await res.json();
  const esc = t => String(t).replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const ymd = s => s.replace(/-/g, "");
  const next = s => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const fold = line => { const out = []; let cur = ""; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = " " + ch; } else cur += ch; } out.push(cur); return out.join("\r\n"); };
  const ev = data.items.filter(it => it.roles.some(r => roles.includes(r)) && (monthly || it.kind !== "monthly")).map(it => [
    "BEGIN:VEVENT", `UID:${it.id}@taxtools.tw`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(it.due)}`, `DTEND;VALUE=DATE:${ymd(next(it.due))}`,
    `SUMMARY:${esc("截止｜" + it.title)}`,
    `DESCRIPTION:${esc((it.start ? `期間：${it.start.slice(5).replace("-", "/")}～${it.due.slice(5).replace("-", "/")}\n` : "") + it.desc + (it.orig ? "\n（原本期限遇假日，順延到這天）" : "") + "\n稅務小工具 taxtools.tw")}`,
    ...(it.link ? [`URL:${u.origin}${it.link}`] : []),
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(it.title)}`, `TRIGGER:-P${it.kind === "monthly" ? 2 : 7}D`, "END:VALARM",
    "END:VEVENT"].map(fold).join("\r\n"));
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//taxtools.tw//tax calendar//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    fold("X-WR-CALNAME:報稅行事曆（稅務小工具）"), "X-WR-TIMEZONE:Asia/Taipei", "REFRESH-INTERVAL;VALUE=DURATION:P1D", "X-PUBLISHED-TTL:P1D",
    ...ev, "END:VCALENDAR"].join("\r\n");
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=21600",
    "content-disposition": 'inline; filename="taxtools-calendar.ics"' } });
}
