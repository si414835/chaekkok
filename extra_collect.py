"""
책콕: 추가 데이터 수집 (정보나루)

1) (사용 안 함) 이달의 키워드 (monthlyKeywords) -> monthly_keywords
2) 연령·성별 인기대출 (loanItemSrch)     -> demo_popular (+ books)
3) 도서별 이용분석 (usageAnalysisList)   -> book_usage
   같이 빌린 책, 키워드, 월별 대출 추이, 연령·성별 대출 그룹

정보나루 서버가 자주 연결을 끊어서, 호출마다 재시도하고
한 부분이 실패해도 나머지는 계속 진행한다.
"""

import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client

KEY = os.environ["DATA4LIBRARY_KEY"]
NL_KEY = os.environ.get("NL_API_KEY")  # 국립중앙도서관 키 (출간예정 조회용, 없으면 그 단계만 건너뜀)
SEOJI_URL = "https://www.nl.go.kr/seoji/SearchApi.do"
supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
BASE = "http://data4library.kr/api/"
KST = timezone(timedelta(hours=9))

# 연령대: (이름, from_age, to_age). 'all'은 전체 연령
AGE_GROUPS = [("all", None, None), ("10", 10, 19), ("20", 20, 29), ("30", 30, 39),
              ("40", 40, 49), ("50", 50, 59), ("60", 60, 99)]
# 성별: 정보나루 gender 코드 그대로 저장 ('all'은 전체). 화면에서 남/여로 바꿔 보여준다.
GENDERS = ["all", "0", "1"]
DEMO_PAGE_SIZE = 50
USAGE_LIMIT = 60           # 하루에 이용분석을 새로 받을 책 수
USAGE_REFRESH_DAYS = 7     # 이 기간 안에 받은 책은 건너뜀


def now_kst():
    return datetime.now(KST)


def safe_err(e):
    """오류 메시지에 인증키가 찍히지 않게 가린다."""
    msg = re.sub(r"authKey=[^&\s'\"]+", "authKey=***", str(e))
    msg = re.sub(r"cert_key=[^&\s'\"]+", "cert_key=***", msg)
    return msg[:300]


def call(api, params, retries=(5, 15, 30)):
    p = {"authKey": KEY, "format": "json", **params}
    last = None
    for attempt, wait in enumerate((0,) + tuple(retries)):
        if wait:
            time.sleep(wait)
        try:
            res = requests.get(BASE + api, params=p, timeout=60)
            res.raise_for_status()
            data = res.json()
            err = (data.get("response") or {}).get("error")
            if err:
                raise RuntimeError(f"API 오류: {err}")
            return data
        except Exception as e:  # 연결 끊김, JSON 아님, API 오류 모두 재시도
            last = e
            print(f"  [재시도 {attempt + 1}] {api}: {safe_err(e)}")
    raise RuntimeError(safe_err(last))


def log_run(part, status, rows=0, error=None):
    try:
        supabase.table("collect_runs").insert({
            "run_date": now_kst().strftime("%Y-%m-%d"),
            "source": "extra",
            "part": part,
            "status": status,
            "rows_saved": rows,
            "error": safe_err(error) if error else None,
        }).execute()
    except Exception as e:
        print(f"  [기록 실패] {safe_err(e)}")


def find_dicts_with(obj, key):
    """응답 어디에 있든 key를 가진 dict를 모두 찾는다 (응답 구조 변화 대비)."""
    out = []
    if isinstance(obj, dict):
        if key in obj:
            out.append(obj)
        for v in obj.values():
            out.extend(find_dicts_with(v, key))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(find_dicts_with(v, key))
    return out


def to_int(v):
    try:
        return int(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def doc_to_book(d):
    cls = d.get("class_nm")
    return {
        "isbn13": d["isbn13"],
        "title": (d.get("bookname") or "").strip(),
        "author": d.get("authors"),
        "publisher": d.get("publisher"),
        "pub_year": d.get("publication_year"),
        "class_no": d.get("class_no") or None,
        "class_name": cls if cls and "null" not in cls else None,
        "cover_url": d.get("bookImageURL"),
        "detail_url": d.get("bookDtlUrl"),
        "addition_symbol": d.get("addition_symbol") or None,
    }


# ---------- 1. 이달의 키워드 ----------

def collect_keywords():
    today = now_kst()
    months = [today.strftime("%Y-%m"), (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")]
    total = 0
    for m in months:
        try:
            data = call("monthlyKeywords", {"month": m})
            rows, seen = [], set()
            found = find_dicts_with(data, "word")
            if found:
                print(f"  [키워드 응답 예시] {sorted(found[0].keys())}")
            for d in found:
                word = str(d.get("word") or "").strip()
                if not word or word in seen:
                    continue
                seen.add(word)
                weight = next((to_int(d.get(k)) for k in ("weight", "frequency", "score", "count") if to_int(d.get(k)) is not None), None)
                # 응답 순서가 중요도 순이라고 보고 순번을 저장 (가중치가 없을 때 정렬 기준)
                rows.append({"month": m, "word": word, "weight": weight, "rank": len(rows) + 1})
            uniq = rows
            if uniq:
                supabase.table("monthly_keywords").upsert(list(uniq), on_conflict="month,word").execute()
            total += len(uniq)
            log_run(f"keywords {m}", "ok", len(uniq))
            print(f"[키워드] {m}: {len(uniq)}개")
        except Exception as e:
            log_run(f"keywords {m}", "failed", 0, e)
            print(f"::warning::이달의 키워드 {m} 실패: {safe_err(e)}")
    return total


# ---------- 2. 연령·성별 인기대출 ----------

def collect_demographics():
    today = now_kst()
    snapshot = today.strftime("%Y-%m-%d")
    period = {
        "startDt": (today - timedelta(days=30)).strftime("%Y-%m-%d"),
        "endDt": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
        "pageNo": 1,
        "pageSize": DEMO_PAGE_SIZE,
    }
    total = 0
    for age, lo, hi in AGE_GROUPS:
        for gender in GENDERS:
            if age == "all" and gender == "all":
                continue  # 전체 인기대출은 collect.py가 이미 모음
            params = dict(period)
            if lo is not None:
                params.update({"from_age": lo, "to_age": hi})
            if gender != "all":
                params["gender"] = gender
            part = f"demo {age}/{gender}"
            try:
                data = call("loanItemSrch", params)
                docs = [d for d in find_dicts_with(data, "isbn13") if d.get("bookname")]
                books, rows = {}, {}
                for d in docs:
                    isbn = d["isbn13"]
                    books[isbn] = {
                        "isbn13": isbn,
                        "title": (d.get("bookname") or "").strip(),
                        "author": d.get("authors"),
                        "publisher": d.get("publisher"),
                        "pub_year": d.get("publication_year"),
                        "class_no": d.get("class_no") or None,
                        "class_name": d.get("class_nm") if d.get("class_nm") and "null" not in d.get("class_nm") else None,
                        "cover_url": d.get("bookImageURL"),
                        "detail_url": d.get("bookDtlUrl"),
                        "addition_symbol": d.get("addition_symbol") or None,
                    }
                    rows[isbn] = {
                        "snapshot_date": snapshot, "age_group": age, "gender": gender,
                        "isbn13": isbn, "rank": to_int(d.get("ranking")),
                        "loan_count": to_int(d.get("loan_count")),
                    }
                if books:
                    supabase.table("books").upsert(list(books.values()), on_conflict="isbn13").execute()
                    supabase.table("demo_popular").upsert(
                        list(rows.values()), on_conflict="snapshot_date,age_group,gender,isbn13").execute()
                total += len(rows)
                log_run(part, "ok", len(rows))
                print(f"[연령·성별] {age}/{gender}: {len(rows)}권")
            except Exception as e:
                log_run(part, "failed", 0, e)
                print(f"::warning::연령·성별 {part} 실패: {safe_err(e)}")
            time.sleep(1)
    return total


# ---------- 2-1. 지역별 인기대출 (확산 판단용) ----------

# 정보나루 시·도 코드. 강원·전북은 특별자치도 전환 뒤 코드가 바뀌었을 수 있어 51·52도 함께 조회 (0건이면 저장 안 함)
REGIONS = ["11", "21", "22", "23", "24", "25", "26", "29", "31", "32", "33", "34", "35", "36", "37", "38", "39", "51", "52"]


def collect_regions():
    today = now_kst()
    snapshot = today.strftime("%Y-%m-%d")
    period = {
        "startDt": (today - timedelta(days=30)).strftime("%Y-%m-%d"),
        "endDt": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
        "pageNo": 1,
        "pageSize": 100,
    }
    ok_regions, total = 0, 0
    for code in REGIONS:
        try:
            data = call("loanItemSrchByLib", {**period, "region": code})
            docs = [d for d in find_dicts_with(data, "isbn13") if d.get("bookname")]
            if not docs:
                continue
            books = {d["isbn13"]: doc_to_book(d) for d in docs}
            rows = {d["isbn13"]: {"snapshot_date": snapshot, "region": code, "isbn13": d["isbn13"],
                                  "rank": to_int(d.get("ranking"))} for d in docs}
            supabase.table("books").upsert(list(books.values()), on_conflict="isbn13").execute()
            supabase.table("region_popular").upsert(list(rows.values()),
                                                     on_conflict="snapshot_date,region,isbn13").execute()
            ok_regions += 1
            total += len(rows)
        except Exception as e:
            print(f"  [지역 {code} 실패] {safe_err(e)}")
        time.sleep(1)
    status = "ok" if ok_regions >= 12 else ("failed" if ok_regions == 0 else "partial")
    log_run("regions", status, total, None if status == "ok" else f"{ok_regions}개 지역만 성공")
    print(f"[지역별 인기대출] {ok_regions}개 지역 · {total}건")
    return total


# ---------- 2-2. 출간 예정 (요즘 뜨는 작가의 곧 나올 책) ----------

def clean_author_name(a):
    """'지은이: 황보름', '앨런 레비 지음 ;노지양 옮김' -> 첫 저자 이름만."""
    if not a:
        return None
    first = re.split(r"[;,]", a)[0]
    first = re.sub(r"^(지은이|글|저자|원작|지음|저)\s*:\s*", "", first)
    first = re.sub(r"\(.*?\)", "", first)
    first = re.sub(r"\s*(지음|저|글|동화|그림|옮김|엮음|편)$", "", first).strip()
    if len(first) < 2 or len(first) > 12 or "편집부" in first or "연구소" in first:
        return None
    return first


# 신작이 아니라 재출간·수험서 등인 경우를 거른다
UPCOMING_SKIP = re.compile(r"큰\s?글자|모의고사|문제집|기출|수험|교재|워크북|해설과 함께|세트|합본|오디오북|점자")


def content_class(add_code, class_no=None):
    """부가기호 '03810' -> 내용분류 첫 자리 '8' (없으면 KDC 첫 자리)."""
    a = str(add_code or "").strip()
    if re.fullmatch(r"\d{5}", a):
        return a[2]
    c = str(class_no or "").strip()
    return c[0] if c[:1].isdigit() else None


def author_role(author_field, name):
    """서지 AUTHOR '저자 : 메리 셸리;기획자 : 김경일;' 에서 그 이름의 역할과 전체 저자 수."""
    parts = [x.strip() for x in re.split(r"[;,]", author_field or "") if x.strip()]
    for x in parts:
        if name in x:
            return (x.split(":")[0].strip() if ":" in x else ""), len(parts)
    return None, len(parts)


def title_core(t):
    return re.sub(r"\s+", "", re.split(r"\s*[:=(]", t or "")[0])


def seoji(params, retries=(5, 15)):
    p = {"cert_key": NL_KEY, "result_style": "json", "page_no": 1, "page_size": 20, **params}
    last = None
    for wait in (0,) + tuple(retries):
        if wait:
            time.sleep(wait)
        try:
            res = requests.get(SEOJI_URL, params=p, timeout=40)
            res.raise_for_status()
            return res.json()
        except Exception as e:
            last = e
    raise RuntimeError(safe_err(last))


def collect_upcoming():
    if not NL_KEY:
        print("::warning::NL_API_KEY가 없어 출간예정 조회를 건너뜀")
        return 0
    rows = (supabase.table("v_book_state_latest").select("isbn13,momentum,stage")
            .order("momentum", desc=True).limit(200).execute().data or [])
    # 출간예정으로 들어온 책은 작가 출처에서 뺀다 (잘못 걸린 책이 다시 작가를 끌어오는 걸 막음)
    prior = {r["isbn13"] for r in (supabase.table("upcoming_books").select("isbn13").execute().data or [])}
    isbns = [r["isbn13"] for r in rows if r["isbn13"] not in prior][:150]
    authors = {}  # 작가 이름 -> 그 작가의 요즘 뜨는 책 (분야·제목으로 동명이인과 재출간을 거름)
    for i in range(0, len(isbns), 100):
        for b in (supabase.table("books").select("isbn13,author,title,class_no,addition_symbol")
                  .in_("isbn13", isbns[i:i + 100]).execute().data or []):
            if str(b.get("addition_symbol") or "").startswith("7"):
                continue  # 어린이 책 작가는 출간예정 출처에서 뺌
            name = clean_author_name(b.get("author"))
            cls = content_class(b.get("addition_symbol"), b.get("class_no"))
            if name and cls:
                a = authors.setdefault(name, {"kdc": set(), "titles": set()})
                a["kdc"].add(cls)
                a["titles"].add(title_core(b.get("title")))
    names = list(authors)[:50]
    run_started = datetime.now(timezone.utc).isoformat()
    today = now_kst()
    start = (today - timedelta(days=30)).strftime("%Y%m%d")
    end = (today + timedelta(days=60)).strftime("%Y%m%d")
    found, books, failed = {}, {}, 0
    for name in names:
        try:
            data = seoji({"author": name, "start_publish_date": start, "end_publish_date": end, "ebook_yn": "N"})
        except Exception as e:
            failed += 1
            print(f"  [출간예정 {name} 실패] {safe_err(e)}")
            continue
        docs = find_dicts_with(data, "EA_ISBN")
        if len(docs) > 8:
            continue  # 같은 이름으로 너무 많이 나오면 동명이인이 섞였다고 보고 건너뜀
        info = authors[name]
        for d in docs:
            isbn = str(d.get("EA_ISBN") or "").strip()
            date = str(d.get("PUBLISH_PREDATE") or "").strip()
            if len(isbn) != 13 or not re.fullmatch(r"\d{8}", date):
                continue
            role, n_authors = author_role(d.get("AUTHOR"), name)
            if role is None or re.search(r"기획|옮|역|번역|그림|감수|편", role) or n_authors > 5:
                continue  # 이름이 저자로 직접 올라 있지 않거나, 여러 명이 함께 쓴 보고서·교재
            add = str(d.get("EA_ADD_CODE") or "").strip()
            if not re.fullmatch(r"[012]\d{4}", add):
                continue  # 부가기호가 교양·실용·여성 독자용이 아니면 제외 (어린이·학습·전문서 등)
            pub = f"{date[:4]}-{date[4:6]}-{date[6:]}"
            title = (d.get("TITLE") or "").strip()
            if UPCOMING_SKIP.search(title) or title_core(title) in info["titles"]:
                continue  # 재출간·수험서, 또는 이미 뜨고 있는 그 책의 다른 판
            if add[2] not in info["kdc"]:
                continue  # 요즘 뜨는 그 작가의 책과 분야가 다르면 동명이인일 가능성이 큼
            found[isbn] = {"isbn13": isbn, "title": title, "author": d.get("AUTHOR"), "publisher": d.get("PUBLISHER"),
                           "publish_date": pub, "cover_url": d.get("TITLE_URL") or None, "matched_author": name}
            books[isbn] = {"isbn13": isbn, "title": title, "author": d.get("AUTHOR"), "publisher": d.get("PUBLISHER"),
                           "pub_year": date[:4], "class_no": (str(d.get("KDC")).strip() or None) if d.get("KDC") else None,
                           "cover_url": d.get("TITLE_URL") or None,
                           "addition_symbol": str(d.get("EA_ADD_CODE") or "").strip() or None}
        time.sleep(0.5)
    if books:
        # 이미 있는 책(정보나루 정보가 더 자세함)은 덮어쓰지 않고 새 책만 넣는다
        existing = set()
        keys = list(books)
        for i in range(0, len(keys), 100):
            existing |= {r["isbn13"] for r in (supabase.table("books").select("isbn13").in_("isbn13", keys[i:i + 100]).execute().data or [])}
        new_books = [b for k, b in books.items() if k not in existing]
        if new_books:
            supabase.table("books").upsert(new_books, on_conflict="isbn13").execute()
        rows = [{**r, "updated_at": run_started} for r in found.values()]
        supabase.table("upcoming_books").upsert(rows, on_conflict="isbn13").execute()
    if names and failed <= len(names) // 5:
        # 이번 기준에 맞지 않게 된 예전 결과는 지운다
        supabase.table("upcoming_books").delete().lt("updated_at", run_started).execute()
    status = "ok" if failed == 0 else ("failed" if failed == len(names) else "partial")
    log_run("upcoming", status, len(found), None if status == "ok" else f"{failed}명 조회 실패")
    print(f"[출간예정] 작가 {len(names)}명 · 책 {len(found)}권 (실패 {failed})")
    return len(found)


# ---------- 3. 정보나루 참여 도서관 목록 (주 1회) ----------

def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def collect_libraries():
    """'내 도서관' 고르기에 쓰는 도서관 목록. 자주 바뀌지 않으니 7일마다 새로 받는다."""
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    fresh = supabase.table("libraries").select("lib_code").gte("updated_at", since).limit(1).execute().data
    if fresh:
        print("[도서관 목록] 최근에 받아서 건너뜀")
        return 0
    rows, page = {}, 1
    try:
        while page <= 20:
            data = call("libSrch", {"pageNo": page, "pageSize": 500})
            libs = [d for d in find_dicts_with(data, "libCode") if d.get("libName")]
            if not libs:
                break
            for d in libs:
                code = str(d["libCode"]).strip()
                rows[code] = {
                    "lib_code": code,
                    "name": d.get("libName", "").strip(),
                    "address": d.get("address"),
                    "tel": d.get("tel"),
                    "homepage": d.get("homepage"),
                    "latitude": to_float(d.get("latitude")),
                    "longitude": to_float(d.get("longitude")),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            if len(libs) < 500:
                break
            page += 1
        items = list(rows.values())
        for i in range(0, len(items), 500):
            supabase.table("libraries").upsert(items[i:i + 500], on_conflict="lib_code").execute()
        log_run("libraries", "ok", len(items))
        print(f"[도서관 목록] {len(items)}곳")
        return len(items)
    except Exception as e:
        log_run("libraries", "failed", len(rows), e)
        print(f"::warning::도서관 목록 실패: {safe_err(e)}")
        return 0


# ---------- 4. 도서별 이용분석 ----------

def pick_usage_targets():
    """종합 상위 + 급상승 책 중, 최근에 받지 않은 책."""
    targets = []
    for ttype, order, limit in [("composite", "score", 50), ("rising", "rank_diff", 30)]:
        res = (supabase.table("v_feed").select("isbn13,addition_symbol").eq("trend_type", ttype)
               .order(order, desc=True).limit(limit * 3).execute())
        # 어린이 책은 화면 순위에서 빠지므로 이용분석도 받지 않는다
        adult = [r["isbn13"] for r in (res.data or []) if not (r.get("addition_symbol") or "").startswith("7")]
        targets += adult[:limit]
    targets = list(dict.fromkeys(targets))
    since = (datetime.now(timezone.utc) - timedelta(days=USAGE_REFRESH_DAYS)).isoformat()
    fresh = (supabase.table("book_usage").select("isbn13").gte("updated_at", since)
             .in_("isbn13", targets).execute().data or [])
    fresh = {r["isbn13"] for r in fresh}
    return [t for t in targets if t not in fresh][:USAGE_LIMIT]


def parse_usage(data):
    resp = data.get("response", {})

    def items(key, inner):
        return [x.get(inner, x) for x in (resp.get(key) or []) if isinstance(x, dict)]

    keywords = [{"word": k.get("word"), "weight": to_int(k.get("weight"))}
                for k in items("keywords", "keyword") if k.get("word")][:20]
    co_loan = [{"isbn13": b.get("isbn13"), "title": (b.get("bookname") or "").strip(),
                "author": b.get("authors"), "publisher": b.get("publisher")}
               for b in items("coLoanBooks", "book") if b.get("bookname")][:10]
    history = [{"month": h.get("month"), "loanCnt": to_int(h.get("loanCnt")),
                "ranking": to_int(h.get("ranking"))} for h in items("loanHistory", "loan")]
    groups = [{"age": g.get("age"), "gender": g.get("gender"),
               "loanCnt": to_int(g.get("loanCnt")), "ranking": to_int(g.get("ranking"))}
              for g in items("loanGrps", "loanGrp")]
    return keywords, co_loan, history, groups


def collect_usage():
    try:
        targets = pick_usage_targets()
    except Exception as e:
        log_run("usage", "failed", 0, e)
        print(f"::warning::이용분석 대상 조회 실패: {safe_err(e)}")
        return 0
    ok = 0
    for isbn in targets:
        try:
            data = call("usageAnalysisList", {"isbn13": isbn})
            keywords, co_loan, history, groups = parse_usage(data)
            supabase.table("book_usage").upsert({
                "isbn13": isbn, "keywords": keywords, "co_loan": co_loan,
                "loan_history": history, "loan_grps": groups,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="isbn13").execute()
            ok += 1
        except Exception as e:
            print(f"  [이용분석 실패] {isbn}: {safe_err(e)}")
        time.sleep(1)
    status = "ok" if ok == len(targets) else ("failed" if ok == 0 and targets else "partial")
    log_run("usage", status, ok, None if status == "ok" else f"{len(targets) - ok}권 실패")
    print(f"[이용분석] {ok}/{len(targets)}권")
    return ok


def main():
    # 정보나루 '이달의 키워드'는 어린이 책이 섞여 화면에서 쓰지 않으므로 수집하지 않는다 (홈 키워드는 v_home_keywords)
    steps = [collect_demographics, collect_regions, collect_libraries, collect_usage, collect_upcoming]
    only = sys.argv[1:]  # 예: python extra_collect.py upcoming  -> 그 단계만 실행
    if only:
        steps = [f for f in steps if f.__name__.replace("collect_", "") in only]
    for step in steps:
        try:
            step()
        except Exception as e:
            print(f"::warning::{step.__name__} 중단: {safe_err(e)}")


if __name__ == "__main__":
    main()
