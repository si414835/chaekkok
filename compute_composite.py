"""
책콕: 복합 트렌드 스코어 계산 스크립트

정보나루(급상승/인기대출) + 유튜브 + 구글트렌드 데이터를 모아서
하나의 "종합 추천" 점수(0~100)로 합산해 trend_scores 테이블에
trend_type='composite'로 저장합니다.

가중치 (전체 7개 신호 기준):
  급상승(도서관)   25%
  인기대출(도서관) 15%
  뉴스            15%  <- 아직 미연동
  카페            15%  <- 아직 미연동
  블로그           7%  <- 아직 미연동
  유튜브          13%
  구글트렌드      10%

지금은 뉴스/카페/블로그가 없으므로, 살아있는 신호(급상승/인기대출/유튜브/구글트렌드)의
가중치 합(63%)으로 나눠서 100%로 재조정합니다. 나중에 뉴스/카페/블로그가
book_signals에 추가되면 코드 수정 없이 자동으로 7개 전부 반영됩니다.
"""

import os
from datetime import datetime, timedelta, timezone
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 전체 신호 기준 마스터 가중치 (합계 100)
MASTER_WEIGHTS = {
    "rising": 25,      # trend_scores, trend_type='rising', 값=rank_diff
    "popular": 15,     # trend_scores, trend_type='popular', 값=loan_count
    "news": 15,        # book_signals, source='news'  (미연동)
    "cafe": 15,        # book_signals, source='cafe'   (미연동)
    "blog": 7,         # book_signals, source='blog'   (미연동)
    "youtube": 13,     # book_signals, source='youtube'
    "google_trends": 10,  # book_signals, source='google_trends'
}


def kst_today_str():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d")


def min_max_normalize(values: dict) -> dict:
    """isbn13 -> raw값 딕셔너리를 받아 0~100 정규화. 값이 다 같으면 전부 50점 처리."""
    if not values:
        return {}
    nums = list(values.values())
    lo, hi = min(nums), max(nums)
    if hi == lo:
        return {k: 50.0 for k in values}
    return {k: (v - lo) / (hi - lo) * 100 for k, v in values.items()}


def get_latest_trend_scores(trend_type: str, value_field: str) -> dict:
    """trend_scores에서 특정 trend_type의 최신 날짜 데이터를 {isbn13: 값}으로 반환."""
    rows = (
        supabase.table("trend_scores")
        .select(f"isbn13, snapshot_date, {value_field}")
        .eq("trend_type", trend_type)
        .order("snapshot_date", desc=True)
        .execute()
        .data
    )
    if not rows:
        return {}
    latest_date = rows[0]["snapshot_date"]
    return {
        r["isbn13"]: (r[value_field] or 0)
        for r in rows
        if r["snapshot_date"] == latest_date
    }


def get_latest_book_signals(source: str) -> dict:
    """book_signals에서 특정 source의 최신 날짜 데이터를 {isbn13: 값}으로 반환."""
    rows = (
        supabase.table("book_signals")
        .select("isbn13, signal_date, mention_count")
        .eq("source", source)
        .order("signal_date", desc=True)
        .execute()
        .data
    )
    if not rows:
        return {}
    latest_date = rows[0]["signal_date"]
    return {
        r["isbn13"]: (r["mention_count"] or 0)
        for r in rows
        if r["signal_date"] == latest_date
    }


def main():
    raw_signals = {
        "rising": get_latest_trend_scores("rising", "rank_diff"),
        "popular": get_latest_trend_scores("popular", "loan_count"),
        "youtube": get_latest_book_signals("youtube"),
        "google_trends": get_latest_book_signals("google_trends"),
        "news": get_latest_book_signals("news"),
        "cafe": get_latest_book_signals("cafe"),
        "blog": get_latest_book_signals("blog"),
    }

    # 실제로 데이터가 있는 신호만 사용 + 가중치 재조정
    active = {k: v for k, v in raw_signals.items() if v}
    if not
