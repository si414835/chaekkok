"""
책콕: 정보나루 하루 호출 수를 DB(api_usage)에 같이 세서, 한도를 넘지 않게 막는다.

정보나루는 서버 IP를 등록하지 않은 키를 하루 500건에서 막는다
(실제 응답: "1일 500건 이상 요청 시 IP 등록이 필요합니다", 2026-11-03 확인).
GitHub Actions·Supabase는 IP가 매번 바뀌어 등록할 수 없으므로,
수집 스크립트는 수집분(batch) BATCH_LIMIT(기본 400)까지만 쓰고, 화면(Edge Function)은 따로 하루 90회까지만 쓴다
(supabase/sql/api_budget.sql: add_batch_calls · spend_edge_call). 전체 합계는 TOTAL_LIMIT(495)를 넘지 않는다.
"""
import os

BATCH_LIMIT = int(os.environ.get("API_DAILY_BATCH_LIMIT", "400"))
TOTAL_LIMIT = 495


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
        r = _sb.rpc("add_batch_calls", {"n": 1}).execute().data or {}
    except Exception as e:  # 카운터 기록이 안 되면 안전하게 멈춘다
        raise BudgetExceeded(f"호출 수 기록 실패: {type(e).__name__}")
    batch, total = r.get("batch"), r.get("total")
    if isinstance(batch, int) and batch > BATCH_LIMIT:
        raise BudgetExceeded(f"오늘 정보나루 호출이 수집 한도 {BATCH_LIMIT}회에 닿음")
    if isinstance(total, int) and total > TOTAL_LIMIT:
        raise BudgetExceeded(f"오늘 정보나루 호출이 하루 전체 한도 {TOTAL_LIMIT}회에 닿음")


def is_limit_error(msg):
    """정보나루가 하루 한도로 막았다는 응답이면 True (재시도해도 소용없음)."""
    s = str(msg)
    return "500건" in s or "IP 등록" in s


# ---------- 고정 IP 중계 서버 (2026-11-26) ----------
# 정보나루는 서버 IP를 등록하면 하루 30,000건까지 허용한다(정보나루 공지 2023-11-10 「Open API 호출제한 안내」).
# GitHub Actions는 IP가 매번 바뀌어서, 오라클 무료 서버(고정 공인 IP)의 tinyproxy를 거쳐 부른다.
# GitHub Secret D4L_PROXY = http://chaekkok:<비밀번호>@<공인IP>:8888 (없으면 지금처럼 바로 부름)
# 중계 서버가 꺼졌거나 막히면 그 실행에서는 바로 부르는 방식으로 돌아간다 → 수집이 멈추지 않는다.
_proxy_url = os.environ.get("D4L_PROXY") or None
_proxy_down = False


def proxy_on():
    return bool(_proxy_url) and not _proxy_down


def d4l_get(url, **kwargs):
    """정보나루 GET. 중계 서버가 있으면 거쳐 가고, 중계 서버 쪽 문제면 바로 부른다(호출 수는 이미 spend()로 1회 셈)."""
    global _proxy_down
    import requests
    if proxy_on():
        try:
            res = requests.get(url, proxies={"http": _proxy_url, "https": _proxy_url}, **kwargs)
            if res.status_code == 407 or (res.status_code >= 400 and "tinyproxy" in (res.headers.get("Server") or "").lower()):
                # 407 비밀번호 틀림, tinyproxy가 직접 낸 오류(필터 403·연결 실패 500/502 등): 정보나루까지 안 간 것
                raise requests.exceptions.ProxyError(f"중계 서버 응답 {res.status_code}")
            return res
        except requests.exceptions.ProxyError as e:
            _proxy_down = True
            print(f"  [중계 서버] 쓸 수 없어 이번 실행은 바로 부름: {type(e).__name__}")
        except requests.exceptions.ConnectTimeout as e:
            # 중계 서버 자체에 못 붙음 (오라클 서버 꺼짐 등)
            _proxy_down = True
            print(f"  [중계 서버] 연결 안 됨, 이번 실행은 바로 부름: {type(e).__name__}")
    return requests.get(url, **kwargs)
