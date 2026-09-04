"""
책콕 데이터 수집 스크립트 (정보나루 hotTrend 기준, 최종본)

GitHub Actions에서 매일 자동 실행됩니다.
"""

import os
import requests
from supabase import create_client

DATA4LIBRARY_KEY = os.environ["DATA4LIBRARY_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

HOT_TREND_URL = "http://data4library.kr/api/hotTrend"


def fetch_hot_trend():
    """대출 급상승 도서 데이터를 가져온다. 한 번 호출로 최근 며칠치가 함께 온다."""
    params = {
        "authKey": DATA4LIBRARY_KEY,
        "format": "json",
    }
    res = requests.get(HOT_TREND_URL, params=params, timeout=15)
    res.raise_for_status()
    return res.json()


def upsert_book(doc: dict):
    """books 테이블에 도서 기본 정보를 upsert. isbn13 없는 항목은 건너뜀."""
    isbn13 = doc.get("isbn13")
    if not isbn13:
        return None

    class_no = doc.get("class_no") or None
    class_nm = doc.get("class_nm") or None
    # 정보나루가 분류 없는 책에 "null > null > null" 문자열을 주는 경우가 있어 필터링
    if class_nm and "null" in class_nm:
        class_nm = None

    book_row = {
        "isbn13": isbn13,
        "title": (doc.get("bookname") or "").strip(),
        "author": doc.get("authors"),
        "publisher": doc.get("publisher"),
        "pub_year": doc.get("publication_year"),
        "class_no": class_no,
        "class_name": class_nm,
        "cover_url": doc.get("bookImageURL"),
        "detail_url": doc.get("bookDtlUrl"),
    }
    supabase.table("books").upsert(book_row, on_conflict="isbn13").execute()
    return isbn13


def upsert_trend_score(isbn13: str, snapshot_date: str, doc: dict):
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


def main():
    data = fetch_hot_trend()
    results = data.get("response", {}).get("results", [])

    total_books = 0
    total_scores = 0

    for result in results:
        date_block = result.get("result", {})
        snapshot_date = date_block.get("date")
        docs = date_block.get("docs", [])

        print(f"[처리 중] {snapshot_date} — {len(docs)}건")

        for item in docs:
            doc = item.get("doc", {})
            isbn13 = upsert_book(doc)
            if not isbn13:
                continue
            upsert_trend_score(isbn13, snapshot_date, doc)
            total_books += 1
            total_scores += 1

    print(f"\n완료: 도서 {total_books}건, 트렌드 스코어 {total_scores}건 저장")


if __name__ == "__main__":
    main()
