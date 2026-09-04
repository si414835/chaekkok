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

def get_with_retry(url, params, max_retries=3, timeout=30):
    """일시적인 타임아웃/네트워크 오류에 대비해 최대 3번까지 재시도."""
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            res = requests.get(url, params=params, timeout=timeout)
            res.raise_for_status()
            return res.json()
        except (requests.exceptions.ConnectTimeout, requests.exceptions.ConnectionError) as e:
            last_error = e
            wait = attempt * 5
            print(f"  [재시도 {attempt}/{max_retries}] 연결 실패, {wait}초 후 재시도: {e}")
            time.sleep(wait)
    raise last_error


def clean_class_nm(class_nm):
    if class_nm and "null" in class_nm:
        return None
    return class_nm or None


def upsert_book(doc: dict):
    """books 테이블에 도서 기본 정보를 upsert. isbn13 없는 항목은 건너뜀."""
    isbn13 = doc.get("isbn13")
    if not isbn13:
        return None

    book_row = {
        "isbn13": isbn13,
        "title": (doc.get("bookname") or "").strip(),
        "author": doc.get("authors"),
        "publisher": doc.get("publisher"),
        "pub_year": doc.get("publication_year"),
        "class_no": doc.get("class_no") or None,
        "class_name": clean_class_nm(doc.get("class_nm")),
        "cover_url": doc.get("bookImageURL"),
        "detail_url": doc.get("bookDtlUrl"),
    }
    supabase.table("books").upsert(book_row, on_conflict="isbn13").execute()
    return isbn13


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

    count = 0
    for result in results:
        date_block = result.get("result", {})
        snapshot_date = date_block.get("date")
        for item in date_block.get("docs", []):
            doc = item.get("doc", {})
            isbn13 = upsert_book(doc)
            if not isbn13:
                continue
            trend_row = {
                "isbn13": isbn13,
                "snapshot_date": snapshot_date,
                "rank_diff": doc.get("difference"),
                "base_week_rank": doc.get("baseWeekRank"),
                "past_week_rank": doc.get("pastWeekRank"),
                "trend_type": "rising",
            }
            supabase.table("trend_scores").upsert(
                trend_row, on_conflict="isbn13,snapshot_date,trend_type"
            ).execute()
            count += 1
    print(f"[hotTrend] {count}건 저장")


# ---------- 2. 인기대출도서 (loanItemSrch) ----------

def fetch_loan_items(page_no: int, page_size: int = 50):
    end_dt = kst_yesterday_str()
    start_dt = (kst_today() - timedelta(days=30)).strftime("%Y-%m-%d")
    params = {
        "authKey": DATA4LIBRARY_KEY,
        "format": "json",
        "startDt": start_dt,
        "endDt": end_dt,
        "pageNo": page_no,
        "pageSize": page_size,
    }
    return get_with_retry(LOAN_ITEM_URL, params)


def collect_loan_items():
    """최근 30일 인기대출도서 상위 50권을 가져와 'popular' 트렌드로 저장."""
    data = fetch_loan_items(page_no=1, page_size=50)
    docs = data.get("response", {}).get("docs", [])
    snapshot_date = kst_today_str()

    count = 0
    for item in docs:
        doc = item.get("doc", {})
        isbn13 = upsert_book(doc)
        if not isbn13:
            continue
        trend_row = {
            "isbn13": isbn13,
            "snapshot_date": snapshot_date,
            "loan_count": doc.get("loan_count"),
            "rank": doc.get("ranking"),
            "trend_type": "popular",
        }
        supabase.table("trend_scores").upsert(
            trend_row, on_conflict="isbn13,snapshot_date,trend_type"
        ).execute()
        count += 1
    print(f"[loanItemSrch] {count}건 저장")


def main():
    collect_hot_trend()

    try:
        collect_loan_items()
    except Exception as e:
        # loanItemSrch가 실패해도 hotTrend 결과는 이미 저장됐으니 전체 실패로 처리하지 않음
        print(f"[loanItemSrch] 수집 실패 (다음 실행에서 재시도됨): {e}")

    print("\n전체 수집 완료")


if __name__ == "__main__":
    main()
