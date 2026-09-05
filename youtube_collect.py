"""
책콕: 유튜브 언급량 수집 스크립트 (v2)

오늘의 급상승(rising) + 인기대출(popular) 도서 중 최대 50권만 골라
유튜브에서 "책 관련" 언급이 얼마나 되는지 확인해서 book_signals 테이블에 저장합니다.

v2 개선사항:
- 같은 제목(시리즈)은 한 번만 검색하고 결과를 재사용 (할당량 절약)
- totalResults(전체 검색결과 수) 대신, 상위 10개 영상의 제목/설명에
  "책", "서평", "북리뷰" 등 책 관련 키워드가 실제로 있는지 확인해서 카운트
  -> "흔한남매"처럼 유튜버/브랜드명과 겹치는 제목이 실제 콘텐츠와 무관하게
     부풀려지는 문제를 방지
"""

import os
import re
from datetime import datetime, timedelta, timezone
import requests
from supabase import create_client

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"

MAX_BOOKS_PER_RUN = 50  # 하루 쿼터 안전 마진 (중복 제거 후 기준, 50건 x 100유닛 = 5,000유닛)

BOOK_KEYWORDS = [
    "책", "도서", "서평", "북리뷰", "북튜브", "완독", "독후감",
    "동화책", "그림책", "소설", "출판", "읽고", "독서",
]


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


def clean_title(title: str) -> str:
    """정보나루 제목에 붙은 부제/저자 정보(':', '=', '/' 뒤쪽)를 잘라내고 핵심 제목만 남긴다."""
    title = title or ""
    for sep in [":", "=", "/"]:
        idx = title.find(sep)
        if idx != -1:
            title = title[:idx]
    return title.strip()


def clean_author(author: str) -> str:
    """"지은이: 김애란" 같은 역할 라벨을 제거하고 첫 번째 저자 이름만 남긴다."""
    if not author:
        return ""
    author = re.sub(r"(지은이|지음|글쓴이|저자|옮긴이|엮은이|원작|글|그림)\s*[:：]?", "", author)
    author = re.split(r"[;,]", author)[0]
    return author.strip()


def build_query(title: str, author: str) -> str:
    query = clean_title(title)
    if len(query) <= 2:
        a = clean_author(author)
        if a:
            query = f"{query} {a}"
    return f"{query} 책"


def search_book_mentions(query: str):
    """상위 10개 영상을 가져와서, 제목/설명에 책 관련 키워드가 있는 것만 센다."""
    params = {
        "key": YOUTUBE_API_KEY,
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": 10,
        "relevanceLanguage": "ko",
        "regionCode": "KR",
    }
    res = requests.get(YOUTUBE_SEARCH_URL, params=params, timeout=15)
    if res.status_code != 200:
        print(f"  [경고] '{query}' 검색 실패: {res.status_code} {res.text[:200]}")
        return None

    items = res.json().get("items", [])
    relevant = 0
    for item in items:
        snippet = item.get("snippet", {})
        text = (snippet.get("title", "") + " " + snippet.get("description", "")).lower()
        if any(kw in text for kw in BOOK_KEYWORDS):
            relevant += 1
    return relevant


def main():
    targets = get_target_books()
    print(f"검색 대상: {len(targets)}권")

    today = kst_today_str()
    saved = 0
    query_cache = {}  # 같은 제목(시리즈)은 한 번만 검색

    for book in targets:
        query = build_query(book["title"], book.get("author") or "")

        if query in query_cache:
            count = query_cache[query]
            print(f"  {book['title']}: {count}건 (캐시 재사용, 쿼리='{query}')")
        else:
            count = search_book_mentions(query)
            if count is None:
                continue
            query_cache[query] = count
            print(f"  {book['title']}: {count}건 (쿼리='{query}')")

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

    print(f"\n[youtube] {saved}건 저장 (실제 API 호출: {len(query_cache)}회)")


if __name__ == "__main__":
    main()
