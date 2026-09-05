"""
책콕: 구글 트렌드(검색 관심도) 수집 스크립트

비공식 라이브러리(pytrends)를 사용합니다. 공식 API가 아니라서 너무 빠르게
여러 번 요청하면 구글이 일시적으로 차단할 수 있어, 요청 사이에 텀을 두고
대상 책 수도 20권으로 제한합니다.

값 의미: 0~100 사이 점수 (그 책 제목의 최근 1개월간 검색 관심도 중 상대적 위치,
100이면 최근 1개월 중 가장 관심이 높았던 시점). book_signals 테이블에
source='google_trends'로 저장합니다.
"""

import os
import re
import time
from datetime import datetime, timedelta, timezone
from pytrends.request import TrendReq
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_BOOKS_PER_RUN = 20  # 비공식 API라 차단 위험 있어 보수적으로 제한
REQUEST_DELAY_SEC = 3   # 요청 사이 대기 시간 (차단 방지)


def kst_today_str():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d")


def get_target_books():
    """오늘 급상승/인기대출 상위 도서 중 최대 MAX_BOOKS_PER_RUN권을 뽑는다 (중복 제목 제거)."""
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

    seen_queries = set()
    targets = []
    for r in rising + popular:
        query = build_query(r["books"]["title"], r["books"].get("author") or "")
        if query in seen_queries:
            continue
        seen_queries.add(query)
        targets.append({"isbn13": r["books"]["isbn13"], "title": r["books"]["title"], "query": query})
        if len(targets) >= MAX_BOOKS_PER_RUN:
            break

    return targets


def clean_title(title: str) -> str:
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
    """제목이 짧고 흔한 단어(예: '모순')일 때 관계없는 검색어와 섞이지 않도록
    항상 저자명을 같이 붙여서 검색한다."""
    title_only = clean_title(title)
    a = clean_author(author)
    return f"{title_only} {a}".strip() if a else title_only


def fetch_trend_score(pytrends, query: str):
    """최근 7일 검색 관심도의 평균(0~100)을 반환. 하루짜리 우연한 스파이크에
    점수가 크게 흔들리지 않도록 보수적으로 평균을 낸다. 실패 시 None."""
    try:
        pytrends.build_payload([query], timeframe="today 1-m", geo="KR")
        df = pytrends.interest_over_time()
        if df.empty:
            return 0
        recent = df[query].tail(7)
        return round(recent.mean())
    except Exception as e:
        print(f"  [경고] '{query}' 조회 실패: {e}")
        return None


def main():
    targets = get_target_books()
    print(f"검색 대상: {len(targets)}권")

    pytrends = TrendReq(hl="ko", tz=540)  # tz=540 -> 한국시간(UTC+9, 분 단위)
    today = kst_today_str()
    saved = 0

    for i, book in enumerate(targets):
        score = fetch_trend_score(pytrends, book["query"])
        if score is None:
            continue

        row = {
            "isbn13": book["isbn13"],
            "signal_date": today,
            "source": "google_trends",
            "mention_count": score,
        }
        supabase.table("book_signals").upsert(
            row, on_conflict="isbn13,signal_date,source"
        ).execute()
        saved += 1
        print(f"  {book['title']} (검색어: '{book['query']}'): {score}점")

        if i < len(targets) - 1:
            time.sleep(REQUEST_DELAY_SEC)  # 차단 방지용 대기

    print(f"\n[google_trends] {saved}건 저장")


if __name__ == "__main__":
    main()
