"""
책콕: 휴대폰 알림(Web Push) 보내기 — 매일 단계 계산이 끝난 뒤 실행

구독한 기기마다 하루 한 번, 아래 소식을 한 알림으로 묶어 보낸다 (소식이 없으면 안 보냄).
  1) 콕한 책: 어제보다 단계가 올라감 (떠오름·확산·스테디)
  2) 이달의 키워드: 1위 키워드가 바뀜
  3) 관심 분야: 오늘 새로 포착된 책

비밀키(VAPID)는 Supabase Vault에 있고, 서비스 키로만 꺼낼 수 있다 (get_vapid_private_key).
구독이 만료된 기기(404·410)는 표에서 지운다.

  python send_alerts.py            # 실제 발송
  python send_alerts.py --dry-run  # 보낼 내용만 출력
"""

import json
import os
import sys
import tempfile
from supabase import create_client

DRY = "--dry-run" in sys.argv
supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
STAGE_ORDER = {"포착": 1, "떠오름": 2, "확산": 3, "스테디": 4}
APP_URL = "https://chaekkok.vercel.app"


def short(t, n=18):
    t = (t or "").split(":")[0].split("=")[0].strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def josa(word, a, b):
    """받침이 있으면 a, 없으면 b ('이'/'가', '으로'/'로')."""
    ch = (word or " ")[-1]
    if "가" <= ch <= "힣":
        jong = (ord(ch) - 0xAC00) % 28
        if a == "으로" and jong == 8:  # ㄹ 받침은 '로'
            return b
        return a if jong else b
    return b


def states_on(d, isbns=None):
    out, start = {}, 0
    while True:
        q = supabase.table("book_state").select("isbn13,stage,cat,reason").eq("snapshot_date", d)
        if isbns is not None:
            q = q.in_("isbn13", list(isbns))
        rows = q.range(start, start + 999).execute().data or []
        out.update({r["isbn13"]: r for r in rows})
        if len(rows) < 1000 or isbns is not None:
            return out
        start += 1000


def main():
    subs = supabase.table("push_subscriptions").select("*").execute().data or []
    if not subs:
        print("[알림] 구독한 기기가 없어 건너뜀")
        return
    dates = (supabase.table("book_state").select("snapshot_date").order("snapshot_date", desc=True)
             .limit(1).execute().data or [])
    if not dates:
        return
    d = dates[0]["snapshot_date"]
    prev_rows = (supabase.table("book_state").select("snapshot_date").lt("snapshot_date", d)
                 .order("snapshot_date", desc=True).limit(1).execute().data or [])
    prev = prev_rows[0]["snapshot_date"] if prev_rows else None

    wish_all = {i for s in subs for i in (s.get("wish") or [])}
    today = states_on(d, wish_all) if wish_all else {}
    before = states_on(prev, wish_all) if (wish_all and prev) else {}
    titles = {}
    if wish_all:
        ids = list(wish_all)
        for i in range(0, len(ids), 100):
            for b in supabase.table("books").select("isbn13,title").in_("isbn13", ids[i:i + 100]).execute().data or []:
                titles[b["isbn13"]] = b["title"]

    kw = supabase.table("v_home_keywords").select("word").order("rank").limit(1).execute().data or []
    top_kw = kw[0]["word"] if kw else None

    # 오늘 새로 포착된 책 (관심 분야용)
    fresh = supabase.table("spotted_log").select("isbn13").eq("first_spotted", d).execute().data or []
    fresh_ids = [r["isbn13"] for r in fresh]
    fresh_books = []
    if fresh_ids:
        st = states_on(d, fresh_ids)
        info = {}
        for i in range(0, len(fresh_ids), 100):
            for b in supabase.table("books").select("isbn13,title,addition_symbol").in_("isbn13", fresh_ids[i:i + 100]).execute().data or []:
                info[b["isbn13"]] = b
        for i in fresh_ids:
            b, s = info.get(i), st.get(i)
            if not b or not s or not s.get("stage"):
                continue
            kids = str(b.get("addition_symbol") or "").startswith("7")
            fresh_books.append({"isbn13": i, "title": b["title"], "cat": "어린이" if kids else s.get("cat"), "kids": kids})

    key_path = None
    if not DRY:
        pem = supabase.rpc("get_vapid_private_key", {}).execute().data
        if not pem:
            print("::warning::VAPID 비밀키가 없어 알림을 보내지 않음")
            return
        f = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False)
        f.write(pem)
        f.close()
        key_path = f.name
        from pywebpush import webpush, WebPushException

    sent = gone = 0
    try:
        for s in subs:
            prefs = s.get("prefs") or {}
            events = []
            if prefs.get("wish", True):
                for i in s.get("wish") or []:
                    cur = (today.get(i) or {}).get("stage")
                    pv = (before.get(i) or {}).get("stage")
                    if cur in ("떠오름", "확산", "스테디") and STAGE_ORDER[cur] > STAGE_ORDER.get(pv, 0):
                        t = short(titles.get(i))
                        events.append({"text": f"『{t}』{josa(t, '이', '가')} {cur} 단계가 됐어요", "url": f"/#/book/{i}"})
            if prefs.get("keyword", True) and top_kw and s.get("last_keyword") and top_kw != s["last_keyword"]:
                events.append({"text": f"이달의 키워드가 #{top_kw}{josa(top_kw, '으로', '로')} 바뀌었어요", "url": f"/#/keyword/{top_kw}"})
            if prefs.get("interest", True) and s.get("interests"):
                picks = [b for b in fresh_books if b["cat"] in s["interests"]]
                if picks:
                    cats = sorted({b["cat"] for b in picks})
                    events.append({"text": f"관심 분야({', '.join(cats[:2])})에서 새로 포착된 책 {len(picks)}권: 『{short(picks[0]['title'])}』", "url": f"/#/book/{picks[0]['isbn13']}"})

            update = {"last_keyword": top_kw}
            if events and s.get("last_sent_on") != d:
                body = events[0]["text"] + (f" 외 {len(events) - 1}건" if len(events) > 1 else "")
                payload = {"title": "책콕 새 소식", "body": body, "url": events[0]["url"] if len(events) == 1 else "/#/alerts", "tag": f"chaekkok-{d}"}
                if DRY:
                    print(f"  [보낼 알림] {s['endpoint'][:40]}… {payload}")
                else:
                    try:
                        webpush(
                            subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                            data=json.dumps(payload, ensure_ascii=False),
                            vapid_private_key=key_path,
                            vapid_claims={"sub": APP_URL},
                            ttl=60 * 60 * 12,
                        )
                        sent += 1
                        update.update(last_sent_on=d, fail_count=0)
                    except WebPushException as e:
                        code = getattr(e.response, "status_code", None)
                        if code in (404, 410):
                            supabase.table("push_subscriptions").delete().eq("endpoint", s["endpoint"]).execute()
                            gone += 1
                            continue
                        update["fail_count"] = (s.get("fail_count") or 0) + 1
                        print(f"  [발송 실패] 상태 {code}")
                    except Exception as e:  # 네트워크 오류 등: 다음 날 다시 시도
                        update["fail_count"] = (s.get("fail_count") or 0) + 1
                        print(f"  [발송 실패] {type(e).__name__}")
            if not DRY:
                if update.get("fail_count", 0) >= 30:
                    supabase.table("push_subscriptions").delete().eq("endpoint", s["endpoint"]).execute()
                    gone += 1
                    continue
                supabase.table("push_subscriptions").update(update).eq("endpoint", s["endpoint"]).execute()
    finally:
        if key_path:
            os.unlink(key_path)
    print(f"[알림] {d}: 구독 {len(subs)}곳 · 보냄 {sent} · 만료 정리 {gone}")


if __name__ == "__main__":
    main()
