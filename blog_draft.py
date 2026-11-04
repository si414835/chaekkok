"""
책콕: 매일 아침 네이버 블로그 글 초안 만들기 (단계 계산이 끝난 뒤 실행)

네이버 블로그 글쓰기 API는 2020년에 종료돼서 자동으로 올리지는 않는다.
초안을 blog_drafts 표에 저장하면, 책콕의 /draft 화면에서 제목·본문·태그를 복사해 붙여 넣는다.

양식(고정)
  제목  [책콕] M월 D일, 도서관에서 뜨기 시작한 책 N권 — 첫 책 · 둘째 책
  본문  인사 → 책 2~3권(왜 뜨나요 · 누가 많이 빌렸나요 · 함께 나온 키워드 · 책콕 링크) → 책콕 소개 → 데이터 출처
  태그  고정 태그 + 분야 + 책 제목

책 고르는 기준
  · 오늘 포착·떠오름·확산 단계이고 어린이 책이 아닌 책, 상세 데이터(키워드·연령)가 있는 책
  · 신뢰도 높음 > 보통 > 낮음, 같은 신뢰도면 모멘텀 순
  · 최근 14일 안에 블로그에 소개한 책은 빼고, 가능하면 분야가 겹치지 않게
  · 신뢰도 보통 이상이 3권이면 3권, 아니면 2권

정보나루는 부르지 않는다 (DB에 있는 데이터만 씀).
  python blog_draft.py            # 오늘 초안 만들기(이미 있으면 다시 만듦)
  python blog_draft.py --print    # 저장하지 않고 출력만
"""

import os
import sys
from datetime import datetime, timedelta, timezone

from supabase import create_client

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
SITE = "https://chaekkok.vercel.app"
KST = timezone(timedelta(hours=9))
CAT = ["총류", "철학", "종교", "사회과학", "자연과학", "기술과학", "예술", "언어", "문학", "역사"]
CONF_ORDER = {"높음": 0, "보통": 1, "낮음": 2}
NUM = ["1", "2", "3"]

# 같은 글이 매일 똑같아 보이지 않게 인사말만 날짜에 따라 돌려 쓴다 (양식은 그대로)
INTROS = [
    "오늘 아침 전국 공공도서관 대출 데이터를 살펴보니, 요즘 순위가 오르기 시작한 책이 눈에 띄었어요.",
    "서점 베스트셀러가 아니라, 사람들이 실제로 도서관에서 빌려 읽는 책 중에 요즘 뜨기 시작한 책을 골라 봤어요.",
    "아직 베스트셀러 목록에는 잘 안 보이지만, 도서관에서는 조용히 대출이 늘고 있는 책들이에요.",
    "오늘도 전국 도서관 대출 순위를 비교해서, 일주일 사이 눈에 띄게 오른 책을 모아 왔어요.",
    "다음에 읽을 책 고민 중이라면, 요즘 도서관에서 먼저 반응이 오는 책부터 살펴보세요.",
]


def short_title(t):
    return (t or "").split(":")[0].split("=")[0].strip()


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


def keywords(kw, title, author):
    skip = set((title or "").replace(":", " ").split()) | set((author or "").split())
    out = []
    for k in kw or []:
        w = (k.get("word") or "").strip()
        if not w or w in skip or any(w in t for t in (title or "", author or "")) or len(w) < 2:
            continue
        out.append("#" + w.replace(" ", ""))
        if len(out) == 3:
            break
    return out


def pick_books(day):
    since = (day - timedelta(days=14)).isoformat()
    recent = supabase.table("blog_drafts").select("isbns").gte("day", since).lt("day", day.isoformat()).execute().data or []
    used = {i for r in recent for i in (r.get("isbns") or [])}
    latest = supabase.table("book_state").select("snapshot_date").order("snapshot_date", desc=True).limit(1).execute().data
    d = latest[0]["snapshot_date"]
    rows = (supabase.table("v_book_state_latest").select("*").in_("stage", ["확산", "떠오름", "포착"])
            .not_.is_("confidence", "null").limit(1000).execute().data or [])
    ids = [r["isbn13"] for r in rows]
    books, usage = {}, {}
    for i in range(0, len(ids), 150):
        for b in supabase.table("books").select("isbn13,title,author,publisher,class_no,addition_symbol,cover_url").in_("isbn13", ids[i:i + 150]).execute().data or []:
            books[b["isbn13"]] = b
        for u in supabase.table("book_usage").select("isbn13,keywords,loan_grps").in_("isbn13", ids[i:i + 150]).execute().data or []:
            usage[u["isbn13"]] = u
    cands = []
    for r in rows:
        b, u = books.get(r["isbn13"]), usage.get(r["isbn13"])
        if not b or not u or (b.get("addition_symbol") or "").startswith("7") or r["isbn13"] in used:
            continue
        if not evidence(r):
            continue
        cands.append((CONF_ORDER.get(r["confidence"], 3), -float(r.get("momentum") or 0), r, b, u))
    cands.sort(key=lambda x: (x[0], x[1]))
    good = [c for c in cands if c[0] <= 1]
    want = 3 if len(good) >= 3 else 2
    picked, cats = [], set()
    for c in cands:  # 분야가 겹치지 않게 먼저 고르고
        cat = (c[3].get("class_no") or " ")[:1]
        if cat not in cats:
            picked.append(c)
            cats.add(cat)
        if len(picked) == want:
            break
    for c in cands:  # 모자라면 분야가 겹쳐도 채운다
        if len(picked) == want:
            break
        if c not in picked:
            picked.append(c)
    return d, picked


def build(day):
    d, picked = pick_books(day)
    if not picked:
        return None
    base = supabase.table("hit_baseline").select("*").limit(1).execute().data
    base = base[0] if base else None
    md = f"{day.month}월 {day.day}일"
    names = [short_title(c[3]["title"]) for c in picked]
    title = f"[책콕] {md}, 도서관에서 뜨기 시작한 책 {len(picked)}권 — {' · '.join(names[:2])}{' 외' if len(names) > 2 else ''}"

    lines = [
        "안녕하세요, 책콕이에요 🍂",
        INTROS[day.toordinal() % len(INTROS)],
        "서점 판매량이 아니라 '도서관 대출' 기준이라, 베스트셀러와는 조금 다른 책을 만날 수 있어요.",
        "",
    ]
    tag_titles, tag_cats = [], []
    for n, (_, _, s, b, u) in enumerate(picked):
        cat_no = (b.get("class_no") or "")[:1]
        cat = CAT[int(cat_no)] if cat_no.isdigit() else (s.get("cat") or "")
        author = clean_author(b.get("author"))
        meta = " · ".join(x for x in [author, (b.get("publisher") or "").strip(), cat] if x)
        lines += [
            "━━━━━━━━━━━━━━",
            f"📚 {NUM[n]}. 『{short_title(b['title'])}』",
            meta,
            f"지금 단계: {s['stage']} (신뢰도 {s['confidence']})",
            "━━━━━━━━━━━━━━",
            "",
            "📈 왜 뜨나요",
        ]
        lines += [f"· {e}" for e in evidence(s)]
        reader = top_reader(u.get("loan_grps"))
        if reader:
            lines += ["", "👀 누가 많이 빌렸나요", f"{reader} 독자가 가장 많이 빌렸어요"]
        kws = keywords(u.get("keywords"), b.get("title"), author)
        if kws:
            lines += ["", "🔖 함께 나온 키워드", " ".join(kws)]
        lines += [
            "",
            "👉 내 동네 도서관에 있는지, 순위가 어떻게 움직였는지 보기",
            f"{SITE}/book/{s['isbn13']}",
            "",
        ]
        tag_titles.append("#" + short_title(b["title"]).replace(" ", ""))
        if cat:
            tag_cats.append(f"#{cat}책")

    lines += [
        "━━━━━━━━━━━━━━",
        "🍂 책콕은 이런 곳이에요",
        "━━━━━━━━━━━━━━",
        "책콕은 전국 공공도서관 대출 데이터로 '뜨기 시작한 책'을 먼저 알려 주는 무료 웹사이트예요.",
        "· 포착 → 떠오름 → 확산 → 스테디, 책의 트렌드 단계를 매일 아침 업데이트해요",
    ]
    if base and base.get("spot_up20") and base.get("base_up20") and float(base["spot_up20"]) > float(base["base_up20"]):
        times = round(float(base["spot_up20"]) / float(base["base_up20"]), 1)
        lines.append(
            f"· 책콕이 포착한 책은 2주 뒤 순위가 20% 넘게 오른 비율이 {round(float(base['spot_up20']))}%로, "
            f"전체 평균({round(float(base['base_up20']))}%)의 약 {times}배였어요"
        )
    lines += [
        "· 우리 동네 도서관에 그 책이 있는지, 지금 빌릴 수 있는지도 바로 확인할 수 있어요",
        f"로그인 없이 바로 둘러보세요 👉 {SITE}",
        "",
        f"※ 데이터 출처: 도서관 정보나루(전국 공공도서관 대출 데이터) · {int(d[5:7])}월 {int(d[8:10])}일 기준",
    ]
    tags = ["#책추천", "#요즘읽을책", "#도서관추천도서", "#책콕", "#베스트셀러"] + list(dict.fromkeys(tag_cats)) + tag_titles
    return {
        "day": day.isoformat(),
        "title": title,
        "body": "\n".join(lines),
        "tags": " ".join(tags),
        "isbns": [c[2]["isbn13"] for c in picked],
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
