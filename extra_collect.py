"""
책콕: 추가 데이터 수집 (정보나루)

1) 이달의 키워드 (monthlyKeywords)      -> monthly_keywords
2) 연령·성별 인기대출 (loanItemSrch)     -> demo_popular (+ books)
3) 도서별 이용분석 (usageAnalysisList)   -> book_usage
   같이 빌린 책, 키워드, 월별 대출 추이, 연령·성별 대출 그룹

정보나루 서버가 자주 연결을 끊어서, 호출마다 재시도하고
한 부분이 실패해도 나머지는 계속 진행한다.
"""

import os
import re
import time
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client

KEY = os.environ["DATA4LIBRARY_KEY"]
supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
BASE = "http://data4library.kr/api/"
KST = timezone(timedelta(hours=9))

# 연령대: (이름, from_age, to_age). 'all'은 전체 연령
AGE_GROUPS = [("all", None, None), ("10", 10, 19), ("20", 20, 29), ("30", 30, 39),
              ("40", 40, 49), ("50", 50, 59), ("60", 60, 99)]
# 성별: 정보나루 gender 코드 그대로 저장 ('all'은 전체). 화면에서 남/여로 바꿔 보여준다.
GENDERS = ["all", "0", "1"]
DEMO_PAGE_SIZE = 50
USAGE_LIMIT = 60           # 하루에 이용분석을 새로 받을 책 수
USAGE_REFRESH_DAYS = 7     # 이 기간 안에 받은 책은 건너뜀


def now_kst():
    return datetime.now(KST)


def safe_err(e):
    """오류 메시지에 인증키가 찍히지 않게 가린다."""
    return re.sub(r"authKey=[^&\s'\"]+", "authKey=***", str(e))[:300]


def call(api, params, retries=(5, 15, 30)):
    p = {"authKey": KEY, "format": "json", **params}
    last = None
    for attempt, wait in enumerate((0,) + tuple(retries)):
        if wait:
            time.sleep(wait)
        try:
            res = requests.get(BASE + api, params=p, timeout=60)
            res.raise_for_status()
            data = res.json()
            err = (data.get("response") or {}).get("error")
            if err:
                raise RuntimeError(f"API 오류: {err}")
            return data
        except Exception as e:  # 연결 끊김, JSON 아님, API 오류 모두 재시도
            last = e
            print(f"  [재시도 {attempt + 1}] {api}: {safe_err(e)}")
    raise RuntimeError(safe_err(last))


def log_run(part, status, rows=0, error=None):
    try:
        supabase.table("collect_runs").insert({
            "run_date": now_kst().strftime("%Y-%m-%d"),
            "source": "extra",
            "part": part,
            "status": status,
            "rows_saved": rows,
            "error": safe_err(error) if error else None,
        }).execute()
    except Exception as e:
        print(f"  [기록 실패] {safe_err(e)}")


def find_dicts_with(obj, key):
    """응답 어디에 있든 key를 가진 dict를 모두 찾는다 (응답 구조 변화 대비)."""
    out = []
    if isinstance(obj, dict):
        if key in obj:
            out.append(obj)
        for v in obj.values():
            out.extend(find_dicts_with(v, key))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(find_dicts_with(v, key))
    return out


def to_int(v):
    try:
        return int(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ---------- 1. 이달의 키워드 ----------

def collect_keywords():
    today = now_kst()
    months = [today.strftime("%Y-%m"), (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")]
    total = 0
    for m in months:
        try:
            data = call("monthlyKeywords", {"month": m})
            rows = []
            for d in find_dicts_with(data, "word"):
                word = str(d.get("word") or "").strip()
                if word:
                    rows.append({"month": m, "word": word, "weight": to_int(d.get("weight"))})
            uniq = {r["word"]: r for r in rows}.values()
            if uniq:
                supabase.table("monthly_keywords").upsert(list(uniq), on_conflict="month,word").execute()
            total += len(uniq)
            log_run(f"keywords {m}", "ok", len(uniq))
            print(f"[키워드] {m}: {len(uniq)}개")
        except Exception as e:
            log_run(f"keywords {m}", "failed", 0, e)
            print(f"::warning::이달의 키워드 {m} 실패: {safe_err(e)}")
    return total


# ---------- 2. 연령·성별 인기대출 ----------

def collect_demographics():
    today = now_kst()
    snapshot = today.strftime("%Y-%m-%d")
    period = {
        "startDt": (today - timedelta(days=30)).strftime("%Y-%m-%d"),
        "endDt": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
        "pageNo": 1,
        "pageSize": DEMO_PAGE_SIZE,
    }
    total = 0
    for age, lo, hi in AGE_GROUPS:
        for gender in GENDERS:
            if age == "all" and gender == "all":
                continue  # 전체 인기대출은 collect.py가 이미 모음
            params = dict(period)
            if lo is not None:
                params.update({"from_age": lo, "to_age": hi})
            if gender != "all":
                params["gender"] = gender
            part = f"demo {age}/{gender}"
            try:
                data = call("loanItemSrch", params)
                docs = [d for d in find_dicts_with(data, "isbn13") if d.get("bookname")]
                books, rows = {}, {}
                for d in docs:
                    isbn = d["isbn13"]
                    books[isbn] = {
                        "isbn13": isbn,
                        "title": (d.get("bookname") or "").strip(),
                        "author": d.get("authors"),
                        "publisher": d.get("publisher"),
                        "pub_year": d.get("publication_year"),
                        "class_no": d.get("class_no") or None,
                        "class_name": d.get("class_nm") if d.get("class_nm") and "null" not in d.get("class_nm") else None,
                        "cover_url": d.get("bookImageURL"),
                        "detail_url": d.get("bookDtlUrl"),
                        "addition_symbol": d.get("addition_symbol") or None,
                    }
                    rows[isbn] = {
                        "snapshot_date": snapshot, "age_group": age, "gender": gender,
                        "isbn13": isbn, "rank": to_int(d.get("ranking")),
                        "loan_count": to_int(d.get("loan_count")),
                    }
                if books:
                    supabase.table("books").upsert(list(books.values()), on_conflict="isbn13").execute()
                    supabase.table("demo_popular").upsert(
                        list(rows.values()), on_conflict="snapshot_date,age_group,gender,isbn13").execute()
                total += len(rows)
                log_run(part, "ok", len(rows))
                print(f"[연령·성별] {age}/{gender}: {len(rows)}권")
            except Exception as e:
                log_run(part, "failed", 0, e)
                print(f"::warning::연령·성별 {part} 실패: {safe_err(e)}")
            time.sleep(1)
    return total


# ---------- 3. 도서별 이용분석 ----------

def pick_usage_targets():
    """종합 상위 + 급상승 책 중, 최근에 받지 않은 책."""
    targets = []
    for ttype, order, limit in [("composite", "score", 50), ("rising", "rank_diff", 30)]:
        res = (supabase.table("v_feed").select("isbn13").eq("trend_type", ttype)
               .order(order, desc=True).limit(limit).execute())
        targets += [r["isbn13"] for r in (res.data or [])]
    targets = list(dict.fromkeys(targets))
    since = (datetime.now(timezone.utc) - timedelta(days=USAGE_REFRESH_DAYS)).isoformat()
    fresh = (supabase.table("book_usage").select("isbn13").gte("updated_at", since)
             .in_("isbn13", targets).execute().data or [])
    fresh = {r["isbn13"] for r in fresh}
    return [t for t in targets if t not in fresh][:USAGE_LIMIT]


def parse_usage(data):
    resp = data.get("response", {})

    def items(key, inner):
        return [x.get(inner, x) for x in (resp.get(key) or []) if isinstance(x, dict)]

    keywords = [{"word": k.get("word"), "weight": to_int(k.get("weight"))}
                for k in items("keywords", "keyword") if k.get("word")][:20]
    co_loan = [{"isbn13": b.get("isbn13"), "title": (b.get("bookname") or "").strip(),
                "author": b.get("authors"), "publisher": b.get("publisher")}
               for b in items("coLoanBooks", "book") if b.get("bookname")][:10]
    history = [{"month": h.get("month"), "loanCnt": to_int(h.get("loanCnt")),
                "ranking": to_int(h.get("ranking"))} for h in items("loanHistory", "loan")]
    groups = [{"age": g.get("age"), "gender": g.get("gender"),
               "loanCnt": to_int(g.get("loanCnt")), "ranking": to_int(g.get("ranking"))}
              for g in items("loanGrps", "loanGrp")]
    return keywords, co_loan, history, groups


def collect_usage():
    try:
        targets = pick_usage_targets()
    except Exception as e:
        log_run("usage", "failed", 0, e)
        print(f"::warning::이용분석 대상 조회 실패: {safe_err(e)}")
        return 0
    ok = 0
    for isbn in targets:
        try:
            data = call("usageAnalysisList", {"isbn13": isbn})
            keywords, co_loan, history, groups = parse_usage(data)
            supabase.table("book_usage").upsert({
                "isbn13": isbn, "keywords": keywords, "co_loan": co_loan,
                "loan_history": history, "loan_grps": groups,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="isbn13").execute()
            ok += 1
        except Exception as e:
            print(f"  [이용분석 실패] {isbn}: {safe_err(e)}")
        time.sleep(1)
    status = "ok" if ok == len(targets) else ("failed" if ok == 0 and targets else "partial")
    log_run("usage", status, ok, None if status == "ok" else f"{len(targets) - ok}권 실패")
    print(f"[이용분석] {ok}/{len(targets)}권")
    return ok


def main():
    for step in (collect_keywords, collect_demographics, collect_usage):
        try:
            step()
        except Exception as e:
            print(f"::warning::{step.__name__} 중단: {safe_err(e)}")


if __name__ == "__main__":
    main()
