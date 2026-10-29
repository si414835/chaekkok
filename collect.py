"""
책콕 데이터 수집 스크립트 (정보나루 hotTrend + loanItemSrch, v3)

GitHub Actions에서 매일 자동 실행됩니다.
v3: 인기대출도서(loanItemSrch) 수집 추가 -> '꾸준한 인기' 탭 + 카테고리 필터용 데이터 확보
"""

import os
import time
from datetime import datetime, timedelta, timezone
import requests
from supabase import create_client

DATA4LIBRARY_KEY = os.environ["DATA4LIBRARY_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

HOT_TREND_URL = "http://data4library.kr/api/hotTrend"
LOAN_ITEM_URL = "http://data4library.kr/api/loanItemSrch"


def kst_today():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst)


def kst_yesterday_str():
    return (kst_today() - timedelta(days=1)).strftime("%Y-%m-%d")


def kst_today_str():
    return kst_today().strftime("%Y-%m-%d")


# ---------- 공통 유틸 ----------

def get_with_retry(url, params, max_retries=4, timeout=60):
    """타임아웃, 연결 오류, 서버 오류(5xx), API 오류 응답까지 재시도한다.
    기존에는 연결 실패만 재시도해서, 응답이 느리면 그 자리에서 수집이 멈췄다."""
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            res = requests.get(url, params=params, timeout=timeout)
            res.raise_for_status()
            data = res.json()
            api_error = (data.get("response") or {}).get("error")
            if api_error:
                raise RuntimeError(f"API 오류 응답: {api_error}")
            return data
        except (requests.exceptions.RequestException, ValueError, RuntimeError) as e:
            last_error = e
            wait = [5, 15, 30, 60][attempt - 1]
            print(f"  [재시도 {attempt}/{max_retries}] {type(e).__name__}, {wait}초 후 재시도: {e}")
            time.sleep(wait)
    raise last_error


def log_run(source, part, status, rows_saved=0, error=None):
    """collect_runs 테이블에 소스·분야별 결과를 남긴다. 기록 실패는 수집을 막지 않는다."""
    try:
        supabase.table("collect_runs").insert({
            "run_date": kst_today_str(),
            "source": source,
            "part": part,
            "status": status,
            "rows_saved": rows_saved,
            "error": (str(error)[:500] if error else None),
        }).execute()
    except Exception as e:
        print(f"  [기록 실패] collect_runs: {e}")


def book_row_from_doc(doc):
    return {
        "isbn13": doc.get("isbn13"),
        "title": (doc.get("bookname") or "").strip(),
        "author": doc.get("authors"),
        "publisher": doc.get("publisher"),
        "pub_year": doc.get("publication_year"),
        "class_no": doc.get("class_no") or None,
        "class_name": clean_class_nm(doc.get("class_nm")),
        "cover_url": doc.get("bookImageURL"),
        "detail_url": doc.get("bookDtlUrl"),
        "addition_symbol": doc.get("addition_symbol") or None,
    }


def bulk_upsert(table, rows, on_conflict, key_fields):
    """한 번에 저장한다. 같은 키가 한 묶음에 두 번 있으면 Postgres가 거부하므로 중복을 먼저 뺀다."""
    unique = {}
    for r in rows:
        unique[tuple(r[k] for k in key_fields)] = r
    rows = list(unique.values())
    if rows:
        supabase.table(table).upsert(rows, on_conflict=on_conflict).execute()
    return len(rows)


def clean_class_nm(class_nm):
    if class_nm and "null" in class_nm:
        return None
    return class_nm or None


# ---------- 1. 대출 급상승 도서 (hotTrend) ----------

def fetch_hot_trend():
    params = {
        "authKey": DATA4LIBRARY_KEY,
        "format": "json",
        "searchDt": kst_yesterday_str(),
    }
    return get_with_retry(HOT_TREND_URL, params)


def collect_hot_trend():
    data = fetch_hot_trend()
    results = data.get("response", {}).get("results", [])

    book_rows, trend_rows = [], []
    for result in results:
        date_block = result.get("result", {})
        snapshot_date = date_block.get("date")
        for item in date_block.get("docs", []):
            doc = item.get("doc", {})
            if not doc.get("isbn13"):
                continue
            book_rows.append(book_row_from_doc(doc))
            trend_rows.append({
                "isbn13": doc["isbn13"],
                "snapshot_date": snapshot_date,
                "rank_diff": doc.get("difference"),
                "base_week_rank": doc.get("baseWeekRank"),
                "past_week_rank": doc.get("pastWeekRank"),
                "trend_type": "rising",
            })
    bulk_upsert("books", book_rows, "isbn13", ["isbn13"])
    count = bulk_upsert("trend_scores", trend_rows, "isbn13,snapshot_date,trend_type",
                        ["isbn13", "snapshot_date", "trend_type"])
    print(f"[hotTrend] {count}건 저장")
    return count


# ---------- 2. 인기대출도서 (loanItemSrch) ----------

# KDC(도서 분류) 10개 대분류 전부 수집 - 탭마다 빈 곳이 없도록.
# 0=총류 1=철학 2=종교 3=사회과학 4=자연과학 5=기술과학 6=예술 7=언어 8=문학 9=역사
# 기본은 30권씩. 다만 총류(0)/종교(2)/자연과학(4)/언어(7)는 상위권이 거의
# 아동서로 채워져서 성인책이 안 보이는 게 확인됐음 -> 더 깊이(100권)까지 파봐서
# 순위가 낮더라도 성인 대상 도서가 있는지 확인해본다.
KDC_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
DEEP_SEARCH_KDC = {0, 2, 4, 7}
DEFAULT_PAGE_SIZE = 30
DEEP_PAGE_SIZE = 100


def fetch_loan_items(page_no: int, page_size: int = 30, kdc=None, from_age=20, to_age=99):
    end_dt = kst_yesterday_str()
    start_dt = (kst_today() - timedelta(days=30)).strftime("%Y-%m-%d")
    params = {
        "authKey": DATA4LIBRARY_KEY,
        "format": "json",
        "startDt": start_dt,
        "endDt": end_dt,
        "pageNo": page_no,
        "pageSize": page_size,
        "from_age": from_age,
        "to_age": to_age,
    }
    if kdc is not None:
        params["kdc"] = kdc
    return get_with_retry(LOAN_ITEM_URL, params)


def _save_loan_docs(docs, snapshot_date):
    book_rows, trend_rows = [], []
    for item in docs:
        doc = item.get("doc", {})
        if not doc.get("isbn13"):
            continue
        book_rows.append(book_row_from_doc(doc))
        trend_rows.append({
            "isbn13": doc["isbn13"],
            "snapshot_date": snapshot_date,
            "loan_count": doc.get("loan_count"),
            "rank": doc.get("ranking"),
            "trend_type": "popular",
        })
    bulk_upsert("books", book_rows, "isbn13", ["isbn13"])
    return bulk_upsert("trend_scores", trend_rows, "isbn13,snapshot_date,trend_type",
                       ["isbn13", "snapshot_date", "trend_type"])


def _collect_one_part(part, snapshot_date):
    """part = KDC 숫자(0~9) 또는 'child'. 저장 건수를 돌려준다."""
    if part == "child":
        data = fetch_loan_items(page_no=1, page_size=40, kdc=None, from_age=0, to_age=13)
    else:
        page_size = DEEP_PAGE_SIZE if part in DEEP_SEARCH_KDC else DEFAULT_PAGE_SIZE
        data = fetch_loan_items(page_no=1, page_size=page_size, kdc=part, from_age=14, to_age=99)
    docs = data.get("response", {}).get("docs", [])
    if not docs:
        raise RuntimeError("응답에 도서가 0건")
    return _save_loan_docs(docs, snapshot_date)


def collect_loan_items():
    """분야(KDC) 10개 + 어린이 목록을 하나씩 수집한다.
    한 분야가 실패해도 나머지는 계속 받고, 실패한 분야만 마지막에 한 번 더 시도한다.
    (예전에는 한 분야에서 오류가 나면 뒤 분야를 통째로 건너뛰어 '일부 분야만 저장된 날'이 생겼다.)"""
    snapshot_date = kst_today_str()
    parts = KDC_CODES + ["child"]
    total, failed = 0, []

    for round_no in (1, 2):
        todo = parts if round_no == 1 else failed
        if round_no == 2:
            if not failed:
                break
            print(f"[loanItemSrch] 실패한 {len(failed)}개 분야 60초 후 재시도: {failed}")
            time.sleep(60)
        failed = []
        for part in todo:
            try:
                count = _collect_one_part(part, snapshot_date)
                total += count
                log_run("popular", str(part), "ok", count)
                print(f"[loanItemSrch] {part}: {count}건 저장")
            except Exception as e:
                failed.append(part)
                print(f"[loanItemSrch] {part}: 실패 - {e}")
                if round_no == 2:
                    log_run("popular", str(part), "failed", 0, e)
            time.sleep(1)  # 정보나루 서버 부담 줄이기

    print(f"[loanItemSrch] 총 {total}건 저장, 최종 실패 분야: {failed or '없음'}")
    if failed:
        # 워크플로우 화면에 노란 경고로 표시 (다음 단계는 계속 실행)
        print(f"::warning::인기대출 수집 실패 분야 {failed}. 이 날짜는 앱에서 완성본으로 쓰이지 않습니다.")
    return failed


def main():
    try:
        count = collect_hot_trend()
        log_run("rising", None, "ok", count)
    except Exception as e:
        log_run("rising", None, "failed", 0, e)
        print(f"::warning::hotTrend 수집 실패: {e}")

    collect_loan_items()
    print("\n전체 수집 완료")


if __name__ == "__main__":
    main()
