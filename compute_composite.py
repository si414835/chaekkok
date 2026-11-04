"""
책콕: 트렌드 단계·모멘텀 계산 → 종합 순위 (파이프라인 4~7단계)

계산은 Supabase의 SQL 함수가 한다 (supabase/sql/book_state.sql 참고).
  refresh_book_state(날짜) : 책 x 날짜 특징, 모멘텀 점수, 신뢰도, 트렌드 4단계, 이유 한 줄 -> book_state
  refresh_spotted()        : 처음 포착한 날과 그 뒤 분야 TOP10 진입일 -> spotted_log (적중률 페이지)

이 스크립트는
  1) 10개 분야가 모두 수집된 가장 최근 날짜를 고르고
  2) 그날 계산을 새로 하고 (예전 계산은 지운 뒤)
  3) 스테디셀러를 뺀 모멘텀 점수를 '종합' 순위(trend_type='composite')로 저장한다.

모멘텀 가중치 (정리본 1차 가중치 + 새로 붙인 신호):
  분야 내 순위 상승(목록 크기로 나눔) 35 · 신규 진입 15 · 전국 급상승 10 · 지난달 대출 증가 10
  최근 출간 10 · 사서 추천 5 · 지역 확산 5 · 유튜브 급증 5 · 검색 급증 5
  분야 TOP10에 머문 날이 2/3 이상이면 15점 감점, 90% 이상이면 '스테디'로 분리
"""

import os
from supabase import create_client

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


def latest_complete_date():
    rows = (supabase.table("v_popular_complete_dates").select("snapshot_date")
            .order("snapshot_date", desc=True).limit(1).execute().data)
    return rows[0]["snapshot_date"] if rows else None


def fetch_state(d):
    out, start = [], 0
    while True:
        rows = (supabase.table("book_state").select("isbn13, momentum, stage")
                .eq("snapshot_date", d).range(start, start + 999).execute().data or [])
        out += rows
        if len(rows) < 1000:
            return out
        start += 1000


def main():
    d = latest_complete_date()
    if not d:
        print("::warning::10개 분야가 모두 수집된 날이 없어 계산을 건너뜀")
        return

    # 같은 날을 다시 계산할 때, 이제는 후보에서 빠진 책이 남지 않도록 먼저 지운다
    supabase.table("book_state").delete().eq("snapshot_date", d).execute()
    n = supabase.rpc("refresh_book_state", {"p_date": d}).execute().data
    spotted = supabase.rpc("refresh_spotted", {}).execute().data
    print(f"[단계 계산] {d}: {n}권 · 포착 기록 누적 {spotted}권")
    try:  # 적중률 비교 기준(전체 평균)도 하루 한 번 다시 계산
        supabase.rpc("refresh_hit_baseline", {}).execute()
    except Exception as e:
        print(f"::warning::적중률 비교 기준 계산 실패: {type(e).__name__}")

    state = fetch_state(d)
    stages = {}
    for r in state:
        stages[r["stage"] or "없음"] = stages.get(r["stage"] or "없음", 0) + 1
    print("  단계별: " + ", ".join(f"{k} {v}" for k, v in sorted(stages.items())))

    rows = [
        {"isbn13": r["isbn13"], "snapshot_date": d, "trend_type": "composite", "score": float(r["momentum"])}
        for r in state
        if r["stage"] != "스테디" and r["momentum"] is not None and float(r["momentum"]) > 0
    ]
    if not rows:
        print("::warning::종합 순위에 올릴 책이 없어 기존 순위를 그대로 둠")
        return
    supabase.table("trend_scores").delete().eq("trend_type", "composite").eq("snapshot_date", d).execute()
    for i in range(0, len(rows), 500):
        supabase.table("trend_scores").upsert(rows[i:i + 500], on_conflict="isbn13,snapshot_date,trend_type").execute()
    top = sorted(rows, key=lambda x: -x["score"])[:5]
    print(f"[종합] {len(rows)}권 저장 · 상위: " + ", ".join(f"{r['isbn13']}({r['score']})" for r in top))


if __name__ == "__main__":
    main()
