"""임시: loanItemSrch 한 번에 몇 권까지 주는지 확인 (키는 출력하지 않음)"""
import os, requests
from datetime import datetime, timedelta, timezone
KEY = os.environ["DATA4LIBRARY_KEY"]
KST = timezone(timedelta(hours=9))
end = (datetime.now(KST) - timedelta(days=1)).strftime("%Y-%m-%d")
start = (datetime.now(KST) - timedelta(days=31)).strftime("%Y-%m-%d")
def go(**p):
    q = {"authKey": KEY, "format": "json", "startDt": start, "endDt": end, **p}
    r = requests.get("http://data4library.kr/api/loanItemSrch", params=q, timeout=90).json()
    resp = r.get("response", {})
    docs = resp.get("docs", [])
    last = docs[-1]["doc"].get("ranking") if docs else None
    print(p, "numFound=", resp.get("numFound"), "got=", len(docs), "lastRank=", last, "err=", resp.get("error"))
for ps in (100, 200, 300, 500):
    go(pageNo=1, pageSize=ps, kdc=8, from_age=14, to_age=99)
go(pageNo=2, pageSize=100, kdc=8, from_age=14, to_age=99)
go(pageNo=1, pageSize=300, kdc=5, from_age=14, to_age=99)
