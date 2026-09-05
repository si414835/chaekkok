"""
책콕: 유튜브 언급량 수집 스크립트

오늘의 급상승(rising) + 인기대출(popular) 도서 중 최대 50권만 골라
유튜브에 얼마나 언급되는지(영상 개수) 확인해서 book_signals 테이블에 저장합니다.
할당량(하루 10,000유닛) 안에서 안전하게 쓰기 위해 50권으로 제한합니다.
"""

import os
from datetime import datetime, timedelta, timezone
import requests
from supabase import create_client

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"

MAX_BOOKS_PER_RUN = 50  # 하루 쿼터 안전 마진 (50권 x 100유닛 = 5,000유닛)


def kst_today_str():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d")


def get_target_books():
    """오늘 급상승/인기대출에 있는 책 중 최대 MAX_BOOKS_PER_RUN권을 뽑는다."""
    rows = (
        supabase.table("trend_scores")
        .select("isbn13, trend_type, snapshot_date, rank_diff, loan_count, books(isbn13, title, author)")
        .order("snapshot_date", desc=True)
        .execute()
        .data
    )

    latest_by_type = {}
    for r in rows:
        t = r["trend_type"]
        if t not in latest_by_type or r["snapshot_date"] > latest_by_type[t]:
            latest_by_type[t] = r["snapshot_date"]

    latest = [r for r in rows if r["books"] and r["snapshot_date"] == latest_by_type.get(r["trend_type"])]

    rising = sorted(
        [r for r in latest if r["trend_type"] == "rising"],
        key=lambda r: r.get("rank_diff") or 0,
        reverse=True,
    )
    popular = sorted(
        [r for r in latest if r["trend_type"] == "popular"],
        key=lambda r: r.get("loan_count") or 0,
        reverse=True,
    )

    seen = set()
    targets = []
    for r in rising + popular:
        isbn13 = r["books"]["isbn13"]
        if isbn13 in seen:
            continue
        seen.add(isbn13)
        targets.append(r["books"])
        if len(targets) >= MAX_BOOKS_PER_RUN:
            break

    return targets


def search_youtube_count(title: str, author: str):
    """책 제목으로 유튜브 검색 후, 대략적인 전체 결과 수(totalResults)를 반환."""
    query = f'"{title}" 책'
    params = {
        "key": YOUTUBE_API_KEY,
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": 1,
        "relevanceLanguage": "ko",
        "regionCode": "KR",
    }
    res = requests.get(YOUTUBE_SEARCH_URL, params=params, timeout=15)
    if res.status_code != 200:
        print(f"  [경고] '{title}' 검색 실패: {res.status_code} {res.text[:200]}")
        return None
    data = res.json()
    return data.get("pageInfo", {}).get("totalResults", 0)


def main():
    targets = get_target_books()
    print(f"검색 대상: {len(targets)}권")

    today = kst_today_str()
    saved = 0

    for book in targets:
        count = search_youtube_count(book["title"], book.get("author") or "")
        if count is None:
            continue

        row = {
            "isbn13": book["isbn13"],
            "signal_date": today,
            "source": "youtube",
            "mention_count": count,
        }
        supabase.table("book_signals").upsert(
            row, on_conflict="isbn13,signal_date,source"
        ).execute()
        saved += 1
        print(f"  {book['title']}: {count}건")

    print(f"\n[youtube] {saved}건 저장")


if __name__ == "__main__":
    main()
