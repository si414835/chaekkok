"""
책콕: 정보나루 하루 호출 수를 DB(api_usage)에 같이 세서, 한도를 넘지 않게 막는다.

정보나루는 서버 IP를 등록하지 않은 키를 하루 500건에서 막는다
(실제 응답: "1일 500건 이상 요청 시 IP 등록이 필요합니다", 2026-11-03 확인).
GitHub Actions·Supabase는 IP가 매번 바뀌어 등록할 수 없으므로,
수집 스크립트는 수집분(batch) BATCH_LIMIT(기본 400)까지만 쓰고, 화면(Edge Function)은 따로 하루 90회까지만 쓴다
(supabase/sql/api_budget.sql: add_batch_calls · spend_edge_call). 전체 합계는 TOTAL_LIMIT(495)를 넘지 않는다.
"""
import os
import time

BATCH_LIMIT = int(os.environ.get("API_DAILY_BATCH_LIMIT", "400"))
TOTAL_LIMIT = 495
PROXY_BATCH_LIMIT = int(os.environ.get("API_PROXY_BATCH_LIMIT", "28000"))
# 등록 IP 하루 30,000건 중 1,000건 이상은 남긴다 (화면 몫·우리가 세지 못한 시험 호출 몫, 2026-11-26 승환님 요청)
PROXY_TOTAL_LIMIT = int(os.environ.get("API_PROXY_TOTAL_LIMIT", "28500"))


class BudgetExceeded(Exception):
    pass


_sb = None
_last_total = 0  # 마지막으로 본 오늘 호출 합계


def init(supabase_client):
    global _sb
    _sb = supabase_client


def spend():
    """정보나루를 한 번 부르기 직전에 호출한다. 하루 합계가 한도를 넘으면 BudgetExceeded."""
    global _last_total
    if _sb is None:
        return
    # Supabase 연결이 잠깐 끊기는 일(RemoteProtocolError)이 동시 6개로 돌 때 자주 나서
    # 한 번 실패로 이용분석 단계 전체가 멈췄다(11-27 대량 보충 4바퀴 모두). 3번까지 다시 해 본다.
    # 기록은 됐는데 응답만 끊긴 경우 두 번 셀 수 있지만, 더 세는 쪽이라 한도는 안전하다.
    r, err = None, None
    for wait in (0, 0.5, 2):
        if wait:
            time.sleep(wait)
        try:
            r = _sb.rpc("add_batch_calls", {"n": 1}).execute().data or {}
            break
        except Exception as e:
            err = e
    if r is None:  # 그래도 안 되면 안전하게 멈춘다
        raise BudgetExceeded(f"호출 수 기록 실패: {type(err).__name__}")
    batch, total = r.get("batch"), r.get("total")
    if isinstance(total, int):
        _last_total = total
    # 중계 서버(등록 IP)를 쓰는 동안은 하루 30,000건 안에서 넉넉히 쓴다 (2026-11-26 정보나루에 IP 등록)
    b_lim, t_lim = (PROXY_BATCH_LIMIT, PROXY_TOTAL_LIMIT) if proxy_on() else (BATCH_LIMIT, TOTAL_LIMIT)
    if isinstance(batch, int) and batch > b_lim:
        raise BudgetExceeded(f"오늘 정보나루 호출이 수집 한도 {b_lim}회에 닿음")
    if isinstance(total, int) and total > t_lim:
        raise BudgetExceeded(f"오늘 정보나루 호출이 하루 전체 한도 {t_lim}회에 닿음")


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
        err = None
        # 잠깐 막히는 경우가 있어(11-27 대량 보충 2바퀴) 한 번 실패로 포기하지 않고 2번 더 해 본다
        for wait in (0, 2, 5):
            if wait:
                time.sleep(wait)
            try:
                res = requests.get(url, proxies={"http": _proxy_url, "https": _proxy_url}, **kwargs)
                if res.status_code == 407 or (res.status_code >= 400 and "tinyproxy" in (res.headers.get("Server") or "").lower()):
                    # 407 비밀번호 틀림, tinyproxy가 직접 낸 오류(필터 403·연결 실패 500/502 등): 정보나루까지 안 간 것
                    raise requests.exceptions.ProxyError(f"중계 서버 응답 {res.status_code}")
                return res
            except (requests.exceptions.ProxyError, requests.exceptions.ConnectTimeout) as e:
                err = e
                if not proxy_on():  # 다른 작업이 이미 포기함
                    break
        # 오늘 이미 500건 가까이 썼으면 바로 부르기는 '1일 500건 이상 IP 등록 필요'로 막히니 멈춘다
        if _last_total > TOTAL_LIMIT:
            raise BudgetExceeded(f"중계 서버를 쓸 수 없고 오늘 이미 {_last_total}건이라 바로 부를 수 없음 ({type(err).__name__})")
        _proxy_down = True
        print(f"  [중계 서버] 쓸 수 없어 이번 실행은 바로 부름: {type(err).__name__}")
    return requests.get(url, **kwargs)
