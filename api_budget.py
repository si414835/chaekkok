"""
책콕: 정보나루 하루 호출 수를 DB(api_usage)에 같이 세서, 한도를 넘지 않게 막는다.

정보나루는 서버 IP를 등록하지 않은 키를 하루 500건에서 막는다
(실제 응답: "1일 500건 이상 요청 시 IP 등록이 필요합니다", 2026-11-03 확인).
GitHub Actions·Supabase는 IP가 매번 바뀌어 등록할 수 없으므로,
수집 스크립트는 하루 합계 BATCH_LIMIT(기본 400)까지만 쓰고 나머지는 화면(도서관 조회)에 남겨 둔다.
"""
import os

BATCH_LIMIT = int(os.environ.get("API_DAILY_BATCH_LIMIT", "400"))


class BudgetExceeded(Exception):
    pass


_sb = None


def init(supabase_client):
    global _sb
    _sb = supabase_client


def spend():
    """정보나루를 한 번 부르기 직전에 호출한다. 하루 합계가 한도를 넘으면 BudgetExceeded."""
    if _sb is None:
        return
    try:
        total = _sb.rpc("add_api_calls", {"n": 1}).execute().data
    except Exception as e:  # 카운터 기록이 안 되면 안전하게 멈춘다
        raise BudgetExceeded(f"호출 수 기록 실패: {type(e).__name__}")
    if isinstance(total, int) and total > BATCH_LIMIT:
        raise BudgetExceeded(f"오늘 정보나루 호출이 수집 한도 {BATCH_LIMIT}회에 닿음")


def is_limit_error(msg):
    """정보나루가 하루 한도로 막았다는 응답이면 True (재시도해도 소용없음)."""
    s = str(msg)
    return "500건" in s or "IP 등록" in s
