"""
책콕: 국립중앙도서관 사서추천도서 수집 스크립트

사서들이 직접 선정한 추천도서를 가져와 trend_scores 테이블에
trend_type='recommended'로 저장합니다. 이 데이터가 "신간 화제작" 탭을 채웁니다.

snapshot_date는 수집 실행일이 아니라, 실제 "추천 등록일(regdate)"을 사용해서
최신 추천이 자연스럽게 위로 오도록 합니다.
"""

import os
import re
import html
import time
from datetime import datetime, timedelta, timezone
import requests
import xml.etree.ElementTree as ET
from supabase import create_client

NL_KEY = os.environ["NL_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

SASEO_URL = "https://nl.go.kr/NL/search/openApi/saseoApi.do"


def get_with_retry(url, params, max_retries=3, timeout=60):
    """국립중앙도서관 서버가 느리거나 순간적으로 끊길 때를 대비해 재시도."""
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            res = requests.get(url, params=params, timeout=timeout)
            res.raise_for_status()
            return res.text
        except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as e:
            last_error = e
            wait = attempt * 10
            print(f"  [재시도 {attempt}/{max_retries}] 응답 지연, {wait}초 후 재시도: {e}")
            time.sleep(wait)
    raise last_error


def kst_today():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst)


def strip_html(text):
    """추천사에 섞인 HTML 태그 제거하고 순수 텍스트만 남긴다."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_regdate(regdate_str):
    """'2026.05.28' -> '2026-05-28' (Supabase date 컬럼 형식에 맞춤)"""
    try:
        return datetime.strptime(regdate_str, "%Y.%m.%d").strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return kst_today().strftime("%Y-%m-%d")


def fetch_recommendations():
    """최근 6개월간 등록된 사서추천도서를 가져온다."""
    end_dt = kst_today()
    start_dt = end_dt - timedelta(days=180)
    params = {
        "key": NL_KEY,
        "startRowNumApi": 1,
        "endRowNumApi": 50,
        "start_date": start_dt.strftime("%Y%m%d"),
        "end_date": end_dt.strftime("%Y%m%d"),
    }
    return get_with_retry(SASEO_URL, params)


def upsert_book(item):
    isbn13 = (item.findtext("recomisbn") or "").strip()
    if not isbn13:
        return None

    book_row = {
        "isbn13": isbn13,
        "title": (item.findtext("recomtitle") or "").strip(),
        "author": (item.findtext("recomauthor") or "").strip(),
        "publisher": (item.findtext("recompublisher") or "").strip(),
        "class_name": (item.findtext("drCodeName") or "").strip() or None,
        "cover_url": (item.findtext("mokchFilePath") or "").strip() or None,
    }
    supabase.table("books").upsert(book_row, on_conflict="isbn13").execute()
    return isbn13


def collect():
    xml_text = fetch_recommendations()
    root = ET.fromstring(xml_text)
    items = root.findall(".//item")

    count = 0
    for item in items:
        isbn13 = upsert_book(item)
        if not isbn13:
            continue

        snapshot_date = parse_regdate(item.findtext("regdate"))
        description = strip_html(item.findtext("recomcontens"))[:500]  # 너무 길면 잘라서 저장

        trend_row = {
            "isbn13": isbn13,
            "snapshot_date": snapshot_date,
            "trend_type": "recommended",
        }
        supabase.table("trend_scores").upsert(
            trend_row, on_conflict="isbn13,snapshot_date,trend_type"
        ).execute()

        # 추천사(description)는 book_signals에 참고용으로 남겨둠 (선택사항, 실패해도 무시)
        try:
            supabase.table("book_signals").upsert(
                {
                    "isbn13": isbn13,
                    "signal_date": snapshot_date,
                    "source": "nl_recommend_note",
                    "mention_count": None,
                },
                on_conflict="isbn13,signal_date,source",
            ).execute()
        except Exception:
            pass

        count += 1

    print(f"[사서추천도서] {count}건 저장 (전체 {len(items)}건 중)")


if __name__ == "__main__":
    collect()
