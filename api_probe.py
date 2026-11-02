"""
책콕: 정보나루 API 점검 스크립트 (한 번만 돌려보는 용도)

새로 쓰려는 4가지 API가 실제로 데이터를 얼마나 주는지, 응답 구조가 어떤지
Supabase api_probe 테이블에 기록한다. 결과를 보고 정식 수집 스크립트를 만든다.
  1) loanItemSrchByLib : 지역별 인기대출
  2) loanItemSrch      : 연령/성별 인기대출
  3) usageAnalysisList : 도서별 이용분석 (같이 빌린 책)
  4) monthlyKeywords   : 이달의 키워드
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client

KEY = os.environ["DATA4LIBRARY_KEY"]
supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
BASE = "http://data4library.kr/api/"
KST = timezone(timedelta(hours=9))

# 정보나루 지역코드(시·도). 매뉴얼을 직접 확인하지 못해 응답 건수로 유효 여부를 판단한다.
REGIONS = {
    11: "서울", 21: "부산", 22: "대구", 23: "인천", 24: "광주", 25: "대전", 26: "울산",
    29: "세종", 31: "경기", 32: "강원", 33: "충북", 34: "충남", 35: "전북", 36: "전남",
    37: "경북", 38: "경남", 39: "제주",
}


def call(api, params):
    p = {"authKey": KEY, "format": "json", **params}
    res = requests.get(BASE + api, params=p, timeout=60)
    res.raise_for_status()
    return res.json()


def count_docs(data):
    """응답 안의 docs/keywords 등 목록 길이를 센다."""
    resp = data.get("response", {}) if isinstance(data, dict) else {}
    for k in ("docs", "keywords", "coLoanBooks", "results"):
        v = resp.get(k)
        if isinstance(v, list):
            return len(v)
    return None


def trim(obj, depth=0):
    """샘플 저장용: 목록은 앞 3개만, 너무 깊으면 자른다."""
    if depth > 6:
        return "..."
    if isinstance(obj, list):
        return [trim(x, depth + 1) for x in obj[:3]] + ([f"...총 {len(obj)}개"] if len(obj) > 3 else [])
    if isinstance(obj, dict):
        return {k: trim(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, str) and len(obj) > 200:
        return obj[:200] + "..."
    return obj


def probe(api, label, params, keep_sample=False):
    row = {"api": api, "label": label, "params": params}
    try:
        data = call(api, params)
        row["item_count"] = count_docs(data)
        resp = data.get("response", {})
        if resp.get("error"):
            row["error"] = str(resp.get("error"))[:300]
        if keep_sample or row["item_count"] in (None, 0):
            row["sample"] = trim(data)
    except Exception as e:
        row["error"] = str(e)[:300]
    supabase.table("api_probe").insert(json.loads(json.dumps(row, default=str))).execute()
    print(f"[{api}] {label}: {row.get('item_count')} {row.get('error') or ''}")
    time.sleep(0.5)


def main():
    today = datetime.now(KST)
    end_dt = (today - timedelta(days=1)).strftime("%Y-%m-%d")
    start_dt = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    period = {"startDt": start_dt, "endDt": end_dt, "pageNo": 1, "pageSize": 100}

    # 1) 지역별 인기대출: 17개 시·도 각각 몇 권 나오는지
    for i, (code, name) in enumerate(REGIONS.items()):
        probe("loanItemSrchByLib", f"지역 {name}({code})", {**period, "region": code},
              keep_sample=(i == 0))

    # 2) 연령·성별 인기대출: 성별 코드 0/1 의미와 연령대별 건수 확인
    probe("loanItemSrch", "성별 0", {**period, "gender": 0}, keep_sample=True)
    probe("loanItemSrch", "성별 1", {**period, "gender": 1}, keep_sample=True)
    for lo, hi in [(10, 19), (20, 29), (30, 39), (40, 49), (50, 59), (60, 99)]:
        probe("loanItemSrch", f"{lo}~{hi}세", {**period, "from_age": lo, "to_age": hi})
    probe("loanItemSrch", "20~29세 여성(1)", {**period, "from_age": 20, "to_age": 29, "gender": 1})

    # 3) 도서별 이용분석: 오늘 종합 상위 3권으로 같이 빌린 책 구조 확인
    top = (supabase.table("v_feed").select("isbn13,title").eq("trend_type", "composite")
           .order("score", desc=True).limit(3).execute().data or [])
    for i, b in enumerate(top):
        probe("usageAnalysisList", b["title"][:40], {"isbn13": b["isbn13"]}, keep_sample=(i == 0))

    # 4) 이달의 키워드: 지난달·이번달
    for m in [(today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m"), today.strftime("%Y-%m")]:
        probe("monthlyKeywords", m, {"month": m}, keep_sample=True)


if __name__ == "__main__":
    main()
