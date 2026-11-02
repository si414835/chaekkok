"""
책콕: 종합 트렌드 점수 계산 ("뜨기 시작하는 책"을 먼저 찾는 점수)

책콕은 이미 유명한 스테디셀러가 아니라 '이제 막 뜨기 시작한 책'을 먼저 보여주는 게 목표다.
그래서 꾸준히 많이 빌리는 책(인기대출)의 비중은 낮추고, 최근에 갑자기 오른 신호의 비중을 높인다.

가중치 (전체 신호 기준, 데이터가 있는 신호끼리 다시 100%로 맞춤):
  급상승(도서관, 최근 14일 중 최대 상승폭)   30
  대출 급증(이용분석, 지난달 vs 직전 3개월)  20   <- 이용분석 데이터가 있는 책만
  인기대출(도서관, 최근 30일 대출 수)        10
  뉴스 15 / 카페 15 / 블로그 7               <- 아직 미연동
  유튜브 13 / 구글트렌드 10

스테디셀러 처리 (최근 21일 중 10개 분야가 모두 수집된 날 기준):
  분야별 TOP10에 머문 날이 90% 이상  -> 종합 순위에서 제외
  분야별 TOP10에 머문 날이 2/3 이상  -> 15점 감점
어린이 책(ISBN 부가기호 7)은 화면에서도 따로 보여주므로 종합 점수 계산에서 뺀다.
"""

import os
from datetime import datetime, timedelta, timezone
from supabase import create_client

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
KST = timezone(timedelta(hours=9))

MASTER_WEIGHTS = {
    "rising": 30,
    "momentum": 20,
    "popular": 10,
    "news": 15,
    "cafe": 15,
    "blog": 7,
    "youtube": 13,
    "google_trends": 10,
}
# 이 신호들은 데이터가 있는 책에만 점수를 매긴다 (없는 책은 그 가중치를 빼고 계산)
PARTIAL_SIGNALS = {"momentum"}

STEADY_WINDOW_DAYS = 21
STEADY_TOP_RANK = 10
STEADY_MIN_DAYS = 7          # 완전 수집된 날이 이보다 적으면 스테디 판정을 하지 않음
STEADY_PENALTY_RATIO = 2 / 3  # 완전 수집일의 2/3 이상 TOP10 -> 감점
STEADY_PENALTY = 15
STEADY_EXCLUDE_RATIO = 0.9   # 90% 이상 TOP10 -> 제외


def today_str():
    return datetime.now(KST).strftime("%Y-%m-%d")


def days_ago(n):
    return (datetime.now(KST) - timedelta(days=n)).strftime("%Y-%m-%d")


def fetch_all(query_fn, page=1000):
    """Supabase는 한 번에 1,000건까지만 주므로 나눠서 모두 받는다."""
    out, start = [], 0
    while True:
        rows = query_fn().range(start, start + page - 1).execute().data or []
        out += rows
        if len(rows) < page:
            return out
        start += page


def min_max_normalize(values):
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    if hi == lo:
        return {k: 50.0 for k in values}
    return {k: (v - lo) / (hi - lo) * 100 for k, v in values.items()}


# ---------- 신호 ----------

def signal_rising():
    """최근 14일 급상승 기록 중 책별 최대 상승폭."""
    rows = fetch_all(lambda: supabase.table("trend_scores").select("isbn13, rank_diff")
                     .eq("trend_type", "rising").gte("snapshot_date", days_ago(14)))
    out = {}
    for r in rows:
        out[r["isbn13"]] = max(out.get(r["isbn13"], 0), r["rank_diff"] or 0)
    return out


def latest_complete_popular_date():
    rows = (supabase.table("v_popular_complete_dates").select("snapshot_date")
            .order("snapshot_date", desc=True).limit(1).execute().data)
    return rows[0]["snapshot_date"] if rows else None


def signal_popular():
    d = latest_complete_popular_date()
    if not d:
        return {}
    rows = fetch_all(lambda: supabase.table("trend_scores").select("isbn13, loan_count")
                     .eq("trend_type", "popular").eq("snapshot_date", d))
    return {r["isbn13"]: r["loan_count"] or 0 for r in rows}


def signal_momentum():
    """지난달 대출 / 직전 3개월 평균 대출 - 1  (최근에 갑자기 많이 빌리기 시작했는지)."""
    rows = fetch_all(lambda: supabase.table("book_usage").select("isbn13, loan_history"))
    out = {}
    for r in rows:
        hist = [h.get("loanCnt") for h in (r.get("loan_history") or []) if h.get("loanCnt") is not None]
        if len(hist) < 4:
            continue
        prev = sum(hist[-4:-1]) / 3
        if prev <= 0:
            continue
        growth = hist[-1] / prev - 1
        out[r["isbn13"]] = max(-1.0, min(3.0, growth))
    return out


def signal_book(source):
    rows = (supabase.table("book_signals").select("isbn13, signal_date, mention_count")
            .eq("source", source).order("signal_date", desc=True).limit(1000).execute().data)
    if not rows:
        return {}
    latest = rows[0]["signal_date"]
    return {r["isbn13"]: r["mention_count"] or 0 for r in rows if r["signal_date"] == latest}


# ---------- 스테디셀러 · 어린이 책 ----------

def steady_info():
    """책별로 최근 21일 중 분야별 TOP10에 머문 날 수, 그리고 '10개 분야가 모두 수집된 날' 수.
    수집이 일부만 된 날을 세면 스테디셀러가 덜 상위권이었던 것처럼 보이므로 완전한 날만 센다."""
    complete = {r["snapshot_date"] for r in (supabase.table("v_popular_complete_dates").select("snapshot_date")
                .gte("snapshot_date", days_ago(STEADY_WINDOW_DAYS)).execute().data or [])}
    rows = fetch_all(lambda: supabase.table("trend_scores").select("isbn13, snapshot_date, rank")
                     .eq("trend_type", "popular").gte("snapshot_date", days_ago(STEADY_WINDOW_DAYS)))
    top_days = {}
    for r in rows:
        if r["snapshot_date"] in complete and r["rank"] is not None and r["rank"] <= STEADY_TOP_RANK:
            top_days.setdefault(r["isbn13"], set()).add(r["snapshot_date"])
    return {k: len(v) for k, v in top_days.items()}, len(complete)


def child_isbns(isbns):
    kids, isbns = set(), list(isbns)
    for i in range(0, len(isbns), 200):
        rows = (supabase.table("books").select("isbn13, addition_symbol")
                .in_("isbn13", isbns[i:i + 200]).execute().data or [])
        kids |= {r["isbn13"] for r in rows if (r.get("addition_symbol") or "").startswith("7")}
    return kids


# ---------- 계산 ----------

def main():
    raw = {
        "rising": signal_rising(),
        "momentum": signal_momentum(),
        "popular": signal_popular(),
        "youtube": signal_book("youtube"),
        "google_trends": signal_book("google_trends"),
        "news": signal_book("news"),
        "cafe": signal_book("cafe"),
        "blog": signal_book("blog"),
    }
    active = {k: v for k, v in raw.items() if v}
    if not active:
        print("사용 가능한 신호가 없습니다. 종료합니다.")
        return

    candidates = set()
    for v in active.values():
        candidates |= set(v)
    kids = child_isbns(candidates)
    candidates -= kids
    norm = {k: min_max_normalize({i: x for i, x in v.items() if i not in kids}) for k, v in active.items()}

    top_days, total_days = steady_info()
    print(f"신호: {', '.join(f'{k}({len(v)})' for k, v in active.items())}")
    print(f"어린이 책 제외: {len(kids)}권 / 10개 분야 완전 수집일(최근 {STEADY_WINDOW_DAYS}일): {total_days}일")

    rows, excluded, penalized = [], 0, 0
    today = today_str()
    for isbn in candidates:
        weights = {k: MASTER_WEIGHTS[k] for k in active
                   if k not in PARTIAL_SIGNALS or isbn in norm[k]}
        wsum = sum(weights.values())
        score = sum(norm[k].get(isbn, 0) * w for k, w in weights.items()) / wsum

        days = top_days.get(isbn, 0)
        if total_days >= STEADY_MIN_DAYS:
            if days >= total_days * STEADY_EXCLUDE_RATIO:
                excluded += 1
                continue  # 3주 내내 상위권 = 이미 다 아는 스테디셀러
            if days >= total_days * STEADY_PENALTY_RATIO:
                score -= STEADY_PENALTY
                penalized += 1
        if score <= 0:
            continue
        rows.append({"isbn13": isbn, "snapshot_date": today, "trend_type": "composite",
                     "score": round(score, 1)})

    # 오늘 계산을 새로 쓴다 (예전 계산에 있던, 이제는 빠져야 할 책이 남지 않게)
    supabase.table("trend_scores").delete().eq("trend_type", "composite").eq("snapshot_date", today).execute()
    for i in range(0, len(rows), 500):
        supabase.table("trend_scores").upsert(rows[i:i + 500], on_conflict="isbn13,snapshot_date,trend_type").execute()

    print(f"[composite] {len(rows)}권 저장 · 스테디셀러 제외 {excluded}권 · 감점 {penalized}권")
    for r in sorted(rows, key=lambda x: -x["score"])[:10]:
        print(f"  {r['score']:5.1f}  {r['isbn13']}")


if __name__ == "__main__":
    main()
