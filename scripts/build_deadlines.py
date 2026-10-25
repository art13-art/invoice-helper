"""Builds assets/deadlines.json: Taiwan tax and payroll deadlines, shifted to the next working day
when they fall on a weekend or government holiday. Update HOLIDAYS when the 人事行政總處 publishes
a new year's calendar, then run:  python3 scripts/build_deadlines.py"""
import json, datetime as dt, pathlib

# Government days off besides weekends (行政院人事行政總處辦公日曆表). 116年(2027) has no make-up workdays.
HOLIDAYS = {
  2026: ["2026-10-26", "2026-12-25"],
  2027: ["2027-01-01", "2027-02-04", "2027-02-05", "2027-02-08", "2027-02-09", "2027-02-10", "2027-03-01",
         "2027-04-05", "2027-04-06", "2027-04-30", "2027-06-09", "2027-09-15", "2027-09-28", "2027-10-11",
         "2027-10-25", "2027-12-24", "2027-12-31"],
}
OFF = {dt.date.fromisoformat(d) for ds in HOLIDAYS.values() for d in ds}
START, END = dt.date(2026, 10, 25), dt.date(2027, 12, 31)

def workday(d):
    while d.weekday() >= 5 or d in OFF:
        d += dt.timedelta(days=1)
    return d
def month_end(y, m):
    return (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))

items = []
def add(id_, due, title, roles, desc, start=None, link=None, kind="main"):
    real = workday(due)
    if not (START <= real <= END): return
    items.append({"id": f"{id_}-{due.isoformat()}", "due": real.isoformat(), "orig": due.isoformat() if real != due else None,
                  "start": start.isoformat() if start else None, "title": title, "roles": roles, "desc": desc,
                  "link": link, "kind": kind})

for y in (2026, 2027):
    for m in range(1, 13):
        prev = (m - 2) % 12 + 1
        # 營業稅：單月 1–15 日申報上兩個月
        if m % 2 == 1:
            p1 = (m - 3) % 12 + 1
            add("vat", dt.date(y, m, 15), f"營業稅申報（{p1}–{prev} 月）", ["company"],
                "使用統一發票的營業人，申報上兩個月的銷售額並繳納營業稅；沒有銷售也要零申報。",
                start=dt.date(y, m, 1), link="/tax-included/")
        add("wh", dt.date(y, m, 10), f"繳納 {prev} 月扣繳稅款", ["company"],
            "上個月付薪資、租金、勞報有代扣所得稅的，要在這天前繳到國庫；沒有代扣就不用。",
            link="/labor-report/", kind="monthly")
        add("nhi", month_end(y, m), f"繳納 {prev} 月補充保費", ["company"],
            "上個月代扣的補充保費，以及公司自己的雇主補充保費，在月底前繳給健保署。",
            link="/labor-report/", kind="monthly")
        add("ins", month_end(y, m), f"繳納 {prev} 月勞保、健保、勞退", ["company"],
            "勞保局和健保署寄來的上個月保費繳款單，月底前繳納（多數公司設定自動扣款）。", link="/labor-health/#boss", kind="monthly")
    yr = y  # yearly items in calendar year y
    add("whfile", dt.date(yr, 1, 31), f"申報 {yr - 1912} 年度扣繳憑單", ["company"],
        "上一年度付給個人的薪資、租金、勞報等，向國稅局申報扣繳憑單或免扣繳憑單。1 月有連續 3 天以上國定假日時延長到 2 月 5 日，以財政部公告為準。",
        start=dt.date(yr, 1, 1))
    add("nhifile", dt.date(yr, 1, 31), "申報補充保費扣費明細", ["company"],
        "向健保署申報上一年度代扣補充保費的明細；每次繳費時已經一併申報的就不用再報。")
    add("whgive", dt.date(yr, 2, 10), "把扣繳憑單交給所得人", ["company"],
        "把扣繳憑單寄給員工、房東、接案者，他們報稅要用。申報期間延長時，交付期限延到 2 月 15 日。")
    add("whget", dt.date(yr, 2, 10), "確認收到扣繳憑單", ["person", "landlord"],
        "公司應在這天前把扣繳憑單寄給你；沒收到可以跟對方要，報稅時也能用自然人憑證或健保卡下載所得資料。", link="/labor-report/#payee")
    add("plate", dt.date(yr, 4, 30), "繳納使用牌照稅", ["car"],
        "自用汽機車一年繳一次（150cc 以下機車免稅）；營業用車分 4 月、10 月兩期。", start=dt.date(yr, 4, 1))
    add("pit", dt.date(yr, 5, 31), f"申報 {yr - 1912} 年度綜合所得稅", ["person", "landlord", "company"],
        "個人報上一年度的所得，薪資、租金、勞報、股利都要列入；被扣繳的稅可以抵減，多扣的會退。", start=dt.date(yr, 5, 1), link="/income-tax/")
    add("cit", dt.date(yr, 5, 31), f"申報 {yr - 1912} 年度營利事業所得稅", ["company"],
        "會計年度採曆年制的公司，申報上一年度營利事業所得稅和未分配盈餘。", start=dt.date(yr, 5, 1))
    add("house", dt.date(yr, 5, 31), "繳納房屋稅", ["landlord"],
        "地方稅務局寄發稅單，繳納上一年度 7 月到今年 6 月的房屋稅。自住和出租的稅率不同。", start=dt.date(yr, 5, 1), link="/landlord-tax/")
    add("citpre", dt.date(yr, 9, 30), "營利事業所得稅暫繳申報", ["company"],
        "按上年度應納稅額的一半暫繳。獨資、合夥、小規模營利事業、上年度沒有應納稅額，或暫繳稅額 2,000 元以下的免辦。", start=dt.date(yr, 9, 1))
    add("plate2", dt.date(yr, 10, 31), "營業用車牌照稅（第二期）", ["car"],
        "只有營業用車需要繳第二期；自用車 4 月已經繳過全年。", start=dt.date(yr, 10, 1))
    add("land", dt.date(yr, 11, 30), "繳納地價稅", ["landlord"],
        "地方稅務局寄發稅單，繳納今年度的地價稅。自用住宅用地符合條件可申請 2‰ 優惠稅率（9 月 22 日前申請）。", start=dt.date(yr, 11, 1))

items.sort(key=lambda x: (x["due"], x["kind"] != "main", x["title"]))
out = {"generated": dt.date.today().isoformat(), "range": [START.isoformat(), END.isoformat()],
       "roles": {"company": "公司・行號", "person": "上班族・接案", "landlord": "房東・屋主", "car": "有車"},
       "items": items}
p = pathlib.Path(__file__).resolve().parent.parent / "assets" / "deadlines.json"
p.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(len(items), "items")
for it in items:
    if it["kind"] == "main" or it["orig"]:
        print(it["due"], ("(原 " + it["orig"] + ")") if it["orig"] else "", it["title"])
