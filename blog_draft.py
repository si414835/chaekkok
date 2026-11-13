"""
책콕: 매일 아침 네이버 블로그 글 초안 만들기 (단계 계산이 끝난 뒤 실행)

네이버 블로그 글쓰기 API는 2020년에 종료돼서 자동으로 올리지는 않는다.
초안을 blog_drafts 표에 저장하면, 책콕의 /draft 화면에서 제목·본문·태그를 복사해 붙여 넣는다.

양식(고정)
  제목  M월 D일 요즘 도서관에서 뜨는 책 N권 추천 | 『책 이름』…
  본문  이모티콘 없는 줄글 완성본(붙여 넣기만 하면 됨). 사람이 쓴 블로그처럼 읽히게 —
        같은 뜻의 문장을 여러 개 두고 날짜·순서로 돌려 쓰고, 숫자는 '네 배 가까이'처럼 말로, 같은 설명(예보 계산법·
        책 소개 출처)은 글 전체에서 한 번만, 신뢰도 같은 내부 용어는 뺀다.
        인사 → 책마다 문단 3~4개(어떤 책 · 왜 뜨는지 · 누가 무엇과 함께 읽는지 · 예보) → 책콕 소개 → 마무리 → 링크 → 출처
        (네이버가 밝힌 작성 원칙: 일관된 주제 · 읽기 쉬운 구조 · 최신성 · 과도한 홍보 피하기)
  태그  고정 태그 + 분야 + 책 제목

책 고르는 기준
  · 오늘 포착·떠오름·확산 단계이고 어린이 책이 아닌 책, 상세 데이터(키워드·연령)가 있는 책
  · 신뢰도 높음 > 보통 > 낮음, 같은 신뢰도면 모멘텀 순
  · 최근 14일 안에 블로그에 소개한 책은 빼고(권만 다른 같은 책 포함), 가능하면 분야가 겹치지 않게
  · 신뢰도 보통 이상이 3권이면 3권, 아니면 2권

정보나루는 책 소개(줄거리)에만 책 1권당 1회 부른다 (하루 2~3회, api_budget으로 같이 셈).
  python blog_draft.py            # 오늘 초안 만들기(이미 있으면 다시 만듦)
  python blog_draft.py --print    # 저장하지 않고 출력만
"""

import html
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
SITE = "https://chaekkok.vercel.app"
# 블로그에서 들어온 방문을 Vercel Analytics의 UTM Parameters에서 따로 셀 수 있게 꼬리표를 붙인다
BLOG_LINK = f"{SITE}/?utm_source=naver_blog&utm_medium=blog"
KST = timezone(timedelta(hours=9))
CAT = ["총류", "철학", "종교", "사회과학", "자연과학", "기술과학", "예술", "언어", "문학", "역사"]
CONF_ORDER = {"높음": 0, "보통": 1, "낮음": 2}
NUM = ["1", "2", "3"]

# 같은 글이 매일 똑같아 보이지 않게 인사말만 날짜에 따라 돌려 쓴다 (양식은 그대로)
INTROS = [
    "서점 베스트셀러가 아니라, 사람들이 실제로 빌려 읽는 책 기준이라 조금 다른 책을 만날 수 있어요.",
    "아직 베스트셀러 목록엔 잘 안 보이지만, 도서관에서는 조용히 대출이 늘고 있는 책들이에요.",
    "일주일 사이 도서관 대출 순위가 눈에 띄게 오른 책들이니, 하나쯤은 마음에 드실 거예요.",
    "주말에 읽을 책, 출퇴근길에 읽을 책을 찾고 계셨다면 한번 살펴보세요.",
    "남들보다 한발 먼저, 요즘 뜨기 시작한 책을 만나 보세요.",
]


def short_title(t):
    return (t or "").split(":")[0].split("=")[0].strip()


def norm_title(t):
    """'서리꽃 1', '서리꽃 2권'처럼 권만 다른 책을 같은 책으로 본다"""
    t = re.sub(r"\s+", "", short_title(t))
    return re.sub(r"(\d+|[상중하])권?$", "", t) or t


def clean_author(a):
    a = (a or "").split(";")[0].split(",")[0]
    for p in ("지은이:", "글:", "저자:", "지음:", "원작:"):
        a = a.replace(p, "")
    for s in ("(지은이)", " 지음", " 저", " 글", " 옮김"):
        a = a.replace(s, "")
    return a.strip()


def evidence(s):
    """책 상세 '왜 뜨나요'와 같은 기준 (최대 3개만)"""
    cat = s.get("cat") or "분야"
    out = []
    rcr = float(s.get("rank_change_ratio") or 0)
    if rcr >= 0.2 and s.get("rank_prev") and s.get("rank_now"):
        out.append(f"{cat} 인기대출 {s['rank_prev']}위 → {s['rank_now']}위 (일주일 동안 {round(rcr * 100)}% 상승)")
    elif s.get("rank_prev") and s.get("rank_now") and s["rank_prev"] > s["rank_now"]:
        out.append(f"{cat} 인기대출 {s['rank_prev']}위 → {s['rank_now']}위 (일주일)")
    if s.get("new_entry"):
        out.append(f"지난주엔 {cat} 인기대출 목록에 없다가 {s['rank_now']}위로 진입")
    if (s.get("hot_diff") or 0) > 0:
        out.append(f"전국 도서관 대출 급상승 목록 ▲{s['hot_diff']}")
    if s.get("rise_steady"):
        if s["rank_mid"] == s["rank_now"]:
            out.append(f"{s['rank_prev']}위 → {s['rank_mid']}위로 오른 뒤 그 자리를 지키는 중")
        else:
            out.append(f"{s['rank_prev']}위 → {s['rank_mid']}위 → {s['rank_now']}위, 일주일 내내 상승")
    if float(s.get("loan_growth") or 0) >= 0.2:
        out.append(f"지난달 대출이 그 전 석 달 평균보다 {round(float(s['loan_growth']) * 100)}% 증가")
    if (s.get("regions") or 0) >= 3:
        out.append(f"전국 {s['regions']}개 지역 도서관에서 함께 인기")
    elif (s.get("demo_groups") or 0) >= 3:
        out.append(f"{s['demo_groups']}개 연령·성별 인기 목록에 함께 오름")
    if s.get("librarian"):
        out.append("국립중앙도서관 사서 추천 도서")
    return out[:3]


def top_reader(grps):
    g = [x for x in (grps or []) if x.get("loanCnt")]
    if not g:
        return None
    b = max(g, key=lambda x: x["loanCnt"])
    return f"{b.get('age', '')} {b.get('gender', '')}".strip()


# 어느 책에나 나오는 너무 흔한 말은 키워드에서 뺀다 (DB의 keyword_stopwords와 함께 씀)
GENERIC = {"세계", "문제", "최초", "인간", "사람", "독자", "이야기", "작가", "소설", "한국", "시간", "생각", "삶",
           "책", "출간", "작품", "저자", "세상", "우리", "자신", "마음", "순간", "장편소설", "에세이", "산문", "부록"}


def stopwords():
    try:
        return {r["word"] for r in supabase.table("keyword_stopwords").select("word").execute().data or []}
    except Exception:
        return set()


STOP = None


def keywords(kw, title, author):
    global STOP
    if STOP is None:
        STOP = stopwords() | GENERIC
    skip = set((title or "").replace(":", " ").split()) | set((author or "").split())
    out = []
    for k in kw or []:
        w = (k.get("word") or "").strip()
        if not w or w in skip or w in STOP or w.lower() in STOP or any(w in t for t in (title or "", author or "")) or len(w) < 2:
            continue
        out.append("#" + w.replace(" ", ""))
        if len(out) == 3:
            break
    return out


def pick_books(day):
    since = (day - timedelta(days=14)).isoformat()
    recent = (supabase.table("blog_drafts").select("isbns,book_titles").gte("day", since).lt("day", day.isoformat())
              .execute().data or [])
    used = {i for r in recent for i in (r.get("isbns") or [])}
    used_titles = {norm_title(t) for r in recent for t in (r.get("book_titles") or [])}
    latest = supabase.table("book_state").select("snapshot_date").order("snapshot_date", desc=True).limit(1).execute().data
    d = latest[0]["snapshot_date"]
    rows = (supabase.table("v_book_state_latest").select("*").in_("stage", ["확산", "떠오름", "포착"])
            .not_.is_("confidence", "null").limit(1000).execute().data or [])
    ids = [r["isbn13"] for r in rows]
    books, usage = {}, {}
    for i in range(0, len(ids), 150):
        for b in supabase.table("books").select("isbn13,title,author,publisher,class_no,addition_symbol,cover_url").in_("isbn13", ids[i:i + 150]).execute().data or []:
            books[b["isbn13"]] = b
        for u in supabase.table("book_usage").select("isbn13,keywords,loan_grps,loan_history,co_loan").in_("isbn13", ids[i:i + 150]).execute().data or []:
            usage[u["isbn13"]] = u
    cands = []
    for r in rows:
        b, u = books.get(r["isbn13"]), usage.get(r["isbn13"])
        if not b or not u or (b.get("addition_symbol") or "").startswith("7") or r["isbn13"] in used:
            continue
        if norm_title(b.get("title")) in used_titles:
            continue
        if not evidence(r):
            continue
        cands.append((CONF_ORDER.get(r["confidence"], 3), -float(r.get("momentum") or 0), r, b, u))
    cands.sort(key=lambda x: (x[0], x[1]))
    good = [c for c in cands if c[0] <= 1]
    want = 3 if len(good) >= 3 else 2
    picked, cats, names = [], set(), set()
    for c in cands:  # 분야가 겹치지 않게 먼저 고르고
        cat = (c[3].get("class_no") or " ")[:1]
        nm = norm_title(c[3].get("title"))
        if cat not in cats and nm not in names:
            picked.append(c)
            cats.add(cat)
            names.add(nm)
        if len(picked) == want:
            break
    for c in cands:  # 모자라면 분야가 겹쳐도 채운다
        if len(picked) == want:
            break
        nm = norm_title(c[3].get("title"))
        if c not in picked and nm not in names:
            picked.append(c)
            names.add(nm)
    return d, picked


def book_intro(isbn):
    """줄거리: 정보나루 도서 상세의 책 소개 앞부분 1~2문장 (출처 표시). 없으면 None. 책 1권에 정보나루 1회."""
    key = os.environ.get("DATA4LIBRARY_KEY")
    if not key:
        return None
    try:
        import api_budget
        api_budget.init(supabase)
        api_budget.spend()
        res = requests.get("http://data4library.kr/api/srchDtlList",
                           params={"authKey": key, "isbn13": isbn, "loaninfoYN": "N", "format": "json"}, timeout=30)
        detail = (res.json().get("response") or {}).get("detail") or []
        desc = ((detail[0] or {}).get("book") or {}).get("description") if detail else None
    except Exception as e:
        print(f"  [책 소개 {isbn}] {type(e).__name__}")
        return None
    if not desc:
        return None
    text = re.sub(r"<[^>]+>", " ", html.unescape(desc))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"([!?])(?=[^\s!?”\"'’)])", r"\1 ", text)  # '신화!오직'처럼 붙은 문장 띄우기
    text = re.sub(r"[★☆◆◇■□●○▶▷※]+[^★☆◆◇■□●○▶▷※]{0,80}?[★☆◆◇■□●○▶▷※]+", " ", text)  # '★★ 수상! ★★' 같은 광고 문구 빼기
    text = re.sub(r"[★☆◆◇■□●○▶▷※]+", " ", text)
    text = re.sub(r"([,.])(?=[가-힣A-Za-z“\"])", r"\1 ", text)  # '진행되지만,건강하고' 띄우기
    text = re.sub(r"([!?.])(?=[“\"]?[가-힣])", r"\1 ", text)  # '연가!"영원' 띄우기
    text = re.sub(r"”(?=[가-힣])", "” ", text)  # '.”노화' 띄우기
    text = re.sub(r"\s+", " ", text).strip()
    # 문장 단위로 잘라 150자 안쪽까지만 (너무 길게 옮기지 않는다)
    sents = re.split(r"(?<=[.!?。])\s+", text)
    out = ""
    for st in [x.strip() for x in sents if x and x.strip()]:
        if len(out) + len(st) > 150:
            break
        out = (out + " " + st).strip()
        if out.count(".") >= 2:
            break
    if not out:
        out = text[:120].rstrip() + "…"
    return out


def top_readers(grps, n=3):
    """많이 빌린 연령·성별 상위 n개 ('40대 여성' 형태)"""
    g = sorted([x for x in (grps or []) if x.get("loanCnt")], key=lambda x: -x["loanCnt"])
    out = []
    for x in g:
        lab = f"{x.get('age', '')} {x.get('gender', '')}".strip()
        if lab and lab not in out:
            out.append(lab)
        if len(out) == n:
            break
    return out


def loan_flow(hist):
    """최근 3개월 대출 건수 ('9월 1,067건 → 10월 1,160건 → 11월 1,383건')"""
    rows = []
    for x in hist or []:
        m = re.match(r"(\d{4})년 (\d{1,2})월", x.get("month") or "")
        if m and x.get("loanCnt") is not None:
            rows.append((int(m.group(1)), int(m.group(2)), int(x["loanCnt"])))
    rows.sort()
    rows = rows[-3:]
    if len(rows) < 2:
        return None
    flow = " → ".join(f"{mo}월 {c:,}건" for _, mo, c in rows)
    first, last = rows[0][2], rows[-1][2]
    trend = " (대출 건수는 줄었지만 순위는 오르는 중이에요)" if first > 0 and (last - first) / first <= -0.1 else ""
    return flow + trend


def co_loans(co, own_title, n=2):
    """이 책과 함께 많이 빌린 책 (권만 다른 같은 책은 하나로)"""
    out, seen = [], {norm_title(own_title)}
    for x in co or []:
        nm = short_title(x.get("title"))
        key = norm_title(nm)
        if not nm or key in seen:
            continue
        seen.add(key)
        out.append(f"『{nm}』")
        if len(out) == n:
            break
    return out


def _jong(word):
    """마지막 글자에 받침이 있으면 True, 없으면 False, 한글이 아니면 None"""
    ch = (word or " ").rstrip("』」'\" ")[-1:]
    if "가" <= ch <= "힣":
        return (ord(ch) - 0xAC00) % 28 != 0
    if ch.isdigit():
        return ch in "013678"  # 영·일·삼·육·칠·팔 → 받침 있음
    return None


def josa(word, with_jong, without_jong):
    j = _jong(word)
    return word + (with_jong if j else without_jong if j is False else f"{with_jong}({without_jong})")


def pick(options, seed):
    """같은 문장이 매일·매 책마다 반복되지 않게 날짜와 순서로 골라 쓴다"""
    return options[seed % len(options)]


def times_text(ratio):
    """1 + 증가율 → '두 배쯤', '네 배 가까이' 같은 말"""
    words = {2: "두", 3: "세", 4: "네", 5: "다섯", 6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉", 10: "열"}
    if ratio < 1.5:
        return f"{round((ratio - 1) * 100)}% 정도 더"
    n = round(ratio)
    if n > 10:
        return "열 배 넘게"
    if ratio < n - 0.1:
        return f"{words.get(n, n)} 배 가까이"
    return f"{words.get(n, n)} 배쯤"


def why_sentences(s, cat, seed):
    """순위·대출 근거를 사람이 쓰는 말투로 (책상세 '왜 뜨나요'와 같은 기준)"""
    out = []
    prev, now = s.get("rank_prev"), s.get("rank_now")
    if prev and now and prev > now:
        out.append(pick([
            f"일주일 전만 해도 {cat} 인기대출 {prev}위였는데 지금은 {now}위예요.",
            f"{cat} 인기대출 순위가 일주일 만에 {prev}위에서 {now}위로 올라왔어요.",
            f"일주일 사이 {cat} 순위가 {prev}위에서 {now}위가 됐어요.",
        ], seed))
    if s.get("new_entry") and now:
        out.append(pick([
            f"지난주엔 {cat} 인기대출 목록에 아예 없던 책인데, 이번 주에 {now}위로 들어왔어요.",
            f"{cat} 인기대출 목록에 이번 주 처음 이름을 올렸어요. 바로 {now}위예요.",
            f"일주일 전엔 순위 밖이었는데, 이번 주 {cat} 인기대출 {now}위에 들어왔어요.",
        ], seed))
    if (s.get("hot_diff") or 0) > 0:
        out.append(f"전국 도서관 대출 급상승 목록에서도 {s['hot_diff']}계단 올랐고요.")
    if s.get("rise_steady") and s.get("rank_mid") and prev and now:
        if s["rank_mid"] == now:
            out.append(f"중간에 {s['rank_mid']}위까지 오른 뒤로는 그 자리를 지키고 있어요.")
        else:
            out.append(f"{prev}위, {s['rank_mid']}위, {now}위로 한 주 내내 쉬지 않고 올랐어요.")
    if float(s.get("loan_growth") or 0) >= 0.2:
        out.append(pick([
            f"지난달엔 그 전 석 달 평균보다 {times_text(1 + float(s['loan_growth']))} 빌려 갔어요.",
            f"대출 건수로 보면 지난달이 그 전 석 달 평균보다 {times_text(1 + float(s['loan_growth']))} 많았어요.",
        ], seed))
    if (s.get("regions") or 0) >= 3:
        out.append(f"한 지역만의 유행도 아니에요. 전국 {s['regions']}개 지역 도서관에서 같이 인기예요.")
    elif (s.get("demo_groups") or 0) >= 3:
        out.append(f"연령·성별로 나눈 인기 목록 {s['demo_groups']}곳에 함께 올라 있어요.")
    if s.get("librarian"):
        out.append("국립중앙도서관 사서들이 고른 추천 도서이기도 해요.")
    return out[:3]


STAGE_SAY = {
    "포착": ["아직 순위는 낮지만, 오를 낌새가 보이는 책이에요.", "지금은 눈에 덜 띄어도 슬슬 신호가 오는 책이에요."],
    "떠오름": ["이제 막 순위가 오르기 시작한 책이에요.", "막 뜨기 시작한 단계예요."],
    "확산": ["여러 곳에서 동시에 읽히기 시작한, 한창 퍼지는 중인 책이에요.", "이미 여기저기서 같이 읽히고 있어요."],
    "스테디": ["오래 꾸준히 읽히는 책이에요.", "유행을 타기보다는 꾸준히 찾는 사람이 많은 책이에요."],
}


def build(day):
    d, picked = pick_books(day)
    if not picked:
        return None
    base = supabase.table("hit_baseline").select("*").limit(1).execute().data
    base = base[0] if base else None
    md = f"{day.month}월 {day.day}일"
    seed0 = day.toordinal()

    items = []
    for _, _, s, b, u in picked:
        cat_no = (b.get("class_no") or "")[:1]
        cat = CAT[int(cat_no)] if cat_no.isdigit() else (s.get("cat") or "")
        author = clean_author(b.get("author"))
        pub = re.sub(r"\(.*?\)", "", (b.get("publisher") or "")).strip() or (b.get("publisher") or "").strip()
        items.append({
            "s": s, "cat": cat, "author": author, "pub": pub, "name": short_title(b["title"]),
            "readers": [r.replace("이상", " 이상") for r in top_readers(u.get("loan_grps"))],
            "flow": loan_flow(u.get("loan_history")),
            "co": co_loans(u.get("co_loan"), b.get("title")),
            "kws": keywords(u.get("keywords"), b.get("title"), author),
            "intro": book_intro(s["isbn13"]),
        })
    names = [it["name"] for it in items]
    title = f"{md} 요즘 도서관에서 뜨는 책 {len(items)}권 추천 | " + " · ".join(f"『{n}』" for n in names)
    if len(title) > 60:
        title = f"{md} 요즘 도서관에서 뜨는 책 {len(items)}권 추천 | 『{names[0]}』 외"

    opening = pick([
        f"오늘도 도서관에서 요즘 부쩍 많이 빌려 가는 책 {len(items)}권을 골라 왔어요.",
        f"요즘 도서관에서 대출이 눈에 띄게 늘고 있는 책 {len(items)}권을 모아 봤어요.",
        f"이번에도 도서관 대출 순위가 쑥 오른 책 {len(items)}권을 가져왔어요.",
    ], seed0)
    paras = [
        "안녕하세요. " + opening + " " + INTROS[seed0 % len(INTROS)],
    ]

    forecast_explained = False
    tag_titles, tag_cats, tag_kws = [], [], []
    for n, it in enumerate(items):
        s, seed = it["s"], seed0 + n
        name_q = f"『{it['name']}』"
        block = [f"{NUM[n]}. {name_q}" + (f" — {it['author']}" if it["author"] else "")]

        # 어떤 책인지: 짧게, 매번 다른 문장으로
        who = it["author"]
        if who and it["pub"]:
            first = pick([
                f"{who}의 {it['cat']} 책으로, {it['pub']}에서 나왔어요.",
                f"{it['pub']}에서 나온 {who}의 책이에요.",
                f"{it['cat']} 분야에서 요즘 눈에 띄는 {who}의 책이에요.",
            ], seed)
        else:
            first = f"요즘 {it['cat']} 분야에서 눈에 띄는 책이에요."
        p1 = first
        if it["intro"]:
            p1 += " " + pick(["책 소개를 보면 이런 내용이에요.", "어떤 책인지는 소개 글이 잘 말해 줘요.", "출판사 소개는 이렇게 시작해요."], seed) + "\n" + it["intro"]
        block.append(p1)

        # 왜 요즘 뜨는지
        p2 = why_sentences(s, it["cat"] or "분야", seed)
        if it["flow"]:
            flow = it["flow"].split(" (")[0].replace(" → ", ", ")
            if "줄었지만" in it["flow"]:
                p2.append(f"월별 대출은 {flow}으로 오히려 줄었는데, 순위는 오르고 있다는 게 재밌어요.")
            else:
                p2.append(pick([f"월별로 보면 {flow}이에요.", f"월별 대출도 {flow}으로 계속 늘고 있어요."], seed))
        stage_line = pick(STAGE_SAY.get(s["stage"], [""]), seed)
        if stage_line:
            p2.append(f"책콕 단계로는 '{s['stage']}'. {stage_line}")
        block.append(" ".join(p2))

        # 누가 무엇과 함께 읽는지
        p3 = []
        rd = it["readers"]
        if len(rd) >= 2:
            p3.append(pick([
                f"주로 {rd[0]} 독자가 많이 빌렸고, {josa(rd[1], '이', '가')} 그다음이에요.",
                f"빌려 간 사람을 보면 {josa(rd[0], '이', '가')} 가장 많고 {josa(rd[1], '이', '가')} 뒤를 이어요.",
            ], seed))
        elif rd:
            p3.append(f"{rd[0]} 독자가 가장 많이 빌렸어요.")
        if it["co"]:
            co = f"{josa(it['co'][0], '과', '와')} {it['co'][1]}" if len(it["co"]) > 1 else it["co"][0]
            p3.append(pick([
                f"이 책을 빌린 분들은 {co}도 같이 빌려 갔어요. 그런 책을 좋아하셨다면 한번 펼쳐 볼 만해요.",
                f"같이 빌려 간 책으로는 {josa(co, '이', '가')} 많았어요. 결이 비슷한 책을 찾으신다면 참고하세요.",
            ], seed))
        elif len(it["kws"]) >= 2:
            words = ", ".join(k.lstrip("#") for k in it["kws"][:2])
            p3.append(f"소개 글에 {words} 같은 말이 자주 나와요. 이런 주제가 궁금하셨다면 잘 맞을 거예요.")
        if p3:
            block.append(" ".join(p3))

        # 책콕 예보: 설명은 처음 한 번만
        fc = s.get("forecast")
        if fc is not None and (s.get("rank_now") or 0) > 10:
            target = int(s["rank_now"] * 0.8)
            if not forecast_explained:
                block.append(
                    f"책콕은 이 책이 2주 뒤 {it['cat']} {target}위 안에 들 확률을 {round(float(fc))}%로 보고 있어요. "
                    "예전에 비슷한 점수였던 책들이 실제로 얼마나 올랐는지를 보고 낸 숫자예요."
                )
                forecast_explained = True
            else:
                block.append(f"2주 뒤 {target}위 안에 들 확률은 {round(float(fc))}%예요.")

        paras.append("\n\n".join(block))
        tag_titles.append("#" + it["name"].replace(" ", ""))
        if it["cat"]:
            tag_cats.append(f"#{it['cat']}책")
        tag_kws += it["kws"][:1]

    about = (
        "오늘 책들은 '책콕'에서 골랐어요. 전국 공공도서관 대출 데이터로 막 뜨기 시작한 책을 먼저 찾아 주는 "
        "무료 사이트인데, 우리 동네 도서관에 그 책이 있는지, 지금 빌릴 수 있는지도 같이 볼 수 있어요."
    )
    if base and base.get("spot_up20") and base.get("base_up20") and float(base["spot_up20"]) > float(base["base_up20"]):
        about += (
            f" 지금까지 책콕이 미리 짚은 책은 2주 뒤 순위가 20% 넘게 오른 경우가 {round(float(base['spot_up20']))}%였어요. "
            f"아무 책이나 골랐을 때({round(float(base['base_up20']))}%)보다 두 배 넘게 잘 맞힌 셈이에요."
            if float(base["spot_up20"]) / float(base["base_up20"]) >= 2 else
            f" 지금까지 책콕이 미리 짚은 책은 2주 뒤 순위가 20% 넘게 오른 경우가 {round(float(base['spot_up20']))}%로, "
            f"전체 평균({round(float(base['base_up20']))}%)보다 높았어요."
        )
    paras += [
        about,
        pick([
            "순위는 서점 판매량이 아니라 도서관 분야별 인기 대출 순위고, 일주일 전과 비교했어요. 마음에 드는 책이 있었다면 가까운 도서관에서 빌려 보세요.",
            "참고로 여기 나온 순위는 서점이 아니라 도서관 대출 기준이에요. 일주일 전과 비교한 거고요. 읽고 싶은 책이 생겼다면 동네 도서관부터 찾아보세요.",
        ], seed0),
        "책콕 바로가기\n" + BLOG_LINK,  # 따로 한 줄에 두면 네이버가 링크 카드로 바꿔 준다
        f"데이터 출처: 도서관 정보나루(전국 공공도서관 대출 데이터), {int(d[5:7])}월 {int(d[8:10])}일 기준. 책 소개 글도 도서관 정보나루에서 옮겼어요.",
    ]
    tags = ["#책추천", "#오늘의책", "#요즘읽을만한책", "#도서관", "#도서관추천도서", "#책콕", "#읽을만한책"]
    tags += list(dict.fromkeys(tag_cats)) + tag_titles + list(dict.fromkeys(tag_kws))
    return {
        "day": day.isoformat(),
        "title": title,
        "body": "\n\n\n".join(paras),
        "tags": " ".join(dict.fromkeys(tags)),
        "isbns": [it["s"]["isbn13"] for it in items],
        "book_titles": names,
    }


def main():
    day = datetime.now(KST).date()
    draft = build(day)
    if not draft:
        print("::warning::블로그 초안: 고를 책이 없어 건너뜀")
        return
    if "--print" in sys.argv:
        print(draft["title"], "\n\n", draft["body"], "\n\n", draft["tags"])
        return
    supabase.table("blog_drafts").upsert(draft, on_conflict="day").execute()
    print(f"[블로그 초안] {draft['day']}: {draft['title']}")


if __name__ == "__main__":
    main()
