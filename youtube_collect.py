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

import html
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

# 책 상세 '이 책을 이야기한 영상'에 붙일 영상 고르기 (book_videos, 2026-11-24)
# 같은 검색 결과를 다시 쓰므로 유튜브 호출은 늘지 않는다.
# 영상 제목에 책 제목이 있고, 저자 이름이나 아래 말 중 하나가 있어야 붙인다 (『사랑의 기술』 검색에 『독서의 기술』이 섞이는 것 방지).
VIDEO_WORDS = ["서평", "리뷰", "독후감", "북튜브", "책 추천", "책추천", "줄거리", "요약", "완독", "읽고", "독서", "책 소개", "북토크"]
VIDEOS_PER_BOOK = 3


def norm(s: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", (s or "").lower())


def title_core(title: str) -> str:
    """'서리꽃 2권'·'토지 1'·'파친코 (상)'처럼 권 표시를 떼어 영상 제목과 맞춰 본다."""
    t = clean_title(title)
    t = re.sub(r"[\(\[]?\s*(상|하|上|下|\d+\s*(권|부|편)?)\s*[\)\]]?\s*$", "", t).strip()
    return t or clean_title(title)


def pick_videos(items, book):
    t = norm(title_core(book["title"]))
    a = norm(clean_author(book.get("author") or ""))
    out = []
    for item in items:
        vid = (item.get("id") or {}).get("videoId")
        sn = item.get("snippet") or {}
        vt = html.unescape(sn.get("title", ""))
        desc = html.unescape(sn.get("description", ""))
        if not vid or not t or t not in norm(vt):
            continue
        has_author = bool(a) and (a in norm(vt) or a in norm(desc))
        has_word = any(w in (vt + " " + desc) for w in VIDEO_WORDS)
        if len(t) <= 2 and not has_author:
            continue
        if not (has_author or has_word):
            continue
        th = sn.get("thumbnails") or {}
        thumb = (th.get("high") or th.get("medium") or th.get("default") or {}).get("url")
        out.append({
            "video_id": vid,
            "title": vt[:200],
            "channel": html.unescape(sn.get("channelTitle", ""))[:100],
            "thumb": thumb,
            "published_at": sn.get("publishedAt"),
        })
        if len(out) >= VIDEOS_PER_BOOK:
            break
    return out


def save_videos(isbn13, picks):
    """그 책의 영상을 오늘 검색 결과로 바꾼다. 찾은 게 없으면 예전 것은 그대로 두고 30일 뒤 지운다(pg_cron)."""
    if not picks:
        return 0
    supabase.table("book_videos").delete().eq("isbn13", isbn13).execute()
    now = datetime.now(timezone.utc).isoformat()
    rows = [{**v, "isbn13": isbn13, "rank": i + 1, "fetched_at": now} for i, v in enumerate(picks)]
    supabase.table("book_videos").upsert(rows, on_conflict="isbn13,video_id").execute()
    return len(rows)


def kst_today_str():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d")


def is_child_book(book):
    """addition_symbol(형식기호)이 '7'로 시작하면 아동/청소년물 -> 검색 대상에서 제외"""
    sym = book.get("addition_symbol") or ""
    return sym.startswith("7")


def get_target_books():
    """오늘 급상승/인기대출에 있는 책 중 최대 MAX_BOOKS_PER_RUN권을 뽑는다."""
    rows = (
        supabase.table("trend_scores")
        .select("isbn13, trend_type, snapshot_date, rank_diff, loan_count, books(isbn13, title, author, addition_symbol)")
        .order("snapshot_date", desc=True)
        .execute()
        .data
    )

    latest_by_type = {}
    for r in rows:
        t = r["trend_type"]
        if t not in latest_by_type or r["snapshot_date"] > latest_by_type[t]:
            latest_by_type[t] = r["snapshot_date"]

    latest = [
        r for r in rows
        if r["books"]
        and r["snapshot_date"] == latest_by_type.get(r["trend_type"])
        and not is_child_book(r["books"])
    ]

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
        return None, []

    items = res.json().get("items", [])
    relevant = 0
    for item in items:
        snippet = item.get("snippet", {})
        text = (snippet.get("title", "") + " " + snippet.get("description", "")).lower()
        if any(kw in text for kw in BOOK_KEYWORDS):
            relevant += 1
    return relevant, items


def main():
    targets = get_target_books()
    print(f"검색 대상: {len(targets)}권")

    today = kst_today_str()
    saved = 0
    videos = 0
    query_cache = {}  # 같은 제목(시리즈)은 한 번만 검색

    for book in targets:
        query = build_query(book["title"], book.get("author") or "")

        if query in query_cache:
            count, items = query_cache[query]
            if count is None:
                continue  # 이전에 이미 실패한 검색어 - 같은 실행 안에서 재시도 안 함
            print(f"  {book['title']}: {count}건 (캐시 재사용, 쿼리='{query}')")
        else:
            count, items = search_book_mentions(query)
            query_cache[query] = (count, items)  # 실패(None)도 캐시해서 중복 재시도 방지
            if count is None:
                continue
            print(f"  {book['title']}: {count}건 (쿼리='{query}')")

        try:
            videos += save_videos(book["isbn13"], pick_videos(items, book))
        except Exception as e:  # 영상 저장이 실패해도 언급량 수집은 계속
            print(f"  [경고] 영상 저장 실패: {e}")

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

    print(f"\n[youtube] {saved}건 저장, 영상 {videos}개 (실제 API 호출: {len(query_cache)}회)")


if __name__ == "__main__":
    main()
