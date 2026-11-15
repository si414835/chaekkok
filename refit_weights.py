"""
책콕: 모멘텀 점수 가중치 다시 맞추기 (손으로 실행: .github/workflows/refit.yml)

1) eval_features()로 2주 결과가 나온 책x날짜를 모두 받는다 (y = 2주 뒤 순위 20% 이상 상승)
2) 점수 공식과 같은 모양의 특징으로 로지스틱 회귀(L2)를 맞춘다
3) 앞 기간으로 맞추고 뒤 기간(TEST_FROM 이후)으로 '지금 가중치'와 '새 가중치'를 비교한다
   - AUC: 오른 책을 안 오른 책보다 높게 매기는 비율
   - 상위 10% 적중률: 점수 상위 10% 책 중 실제로 오른 비율
4) 전체 기간으로 다시 맞춘 값을 지금 값과 반반 섞어 '조금만' 바꾼 제안을 낸다
   표본이 적은 신호(양성 30건 미만)는 지금 값을 그대로 둔다

--apply 를 주면, 새 가중치가 뒤 기간에서 지금보다 나을 때만 score_config에 저장한다.
점수 크기(가중치 합)는 지금과 같게 맞춰서 단계 문턱(45점 등)과 예보 구간이 그대로 통한다.
"""

import json
import os
import sys
from datetime import date

import numpy as np
from supabase import create_client

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
TEST_FROM = os.environ.get("TEST_FROM", "")      # 비우면 마지막 30%를 뒤 기간으로
BLEND = float(os.environ.get("BLEND", "0.5"))     # 새 값 비중 (0.5 = 지금 값과 반반)
MIN_POS = 30
MAIN = ["rank", "new", "hot", "loan", "pub", "lib", "breadth", "yt", "gt"]
COLS = MAIN + ["new_deep_x", "pub_last_x", "loan_fall_x", "steady_x"]


def num(v, d=0.0):
    try:
        return float(v) if v is not None else d
    except (TypeError, ValueError):
        return d


def features(rows, cfg):
    rc0, rc1 = cfg["rc0"], cfg["rc1"]
    X, y, days, mom = [], [], [], []
    for (d, rank, rcr, new, hot, g, pub, lib, regions, demo, yt, gt, steady, m, hit) in rows:
        rank = num(rank)
        g = num(g)
        x = {
            "rank": min(max((num(rcr) - rc0) / (rc1 - rc0), 0), 1),
            "new": float(bool(new) and rank <= 100),
            "hot": min(num(hot) / 100.0, 1),
            "loan": min(max(g, 0) / cfg["loan_cap"], 1),
            "pub": float(num(pub) == 1),
            "lib": float(bool(lib)),
            "breadth": max(min(num(regions) / 8.0, 1), min(num(demo) / 6.0, 1)),
            "yt": float(bool(yt)),
            "gt": float(bool(gt)),
            "new_deep_x": float(bool(new) and rank > 100),
            "pub_last_x": float(num(pub) == 0.5),
            "loan_fall_x": float(g <= cfg["fall_at"]),
            "steady_x": float(bool(steady)),
        }
        X.append([x[c] for c in COLS])
        y.append(int(hit))
        days.append(d)
        mom.append(num(m))
    return np.array(X), np.array(y), days, np.array(mom)


def fit_logit(X, y, lam=1.0, iters=60):
    """L2 로지스틱 회귀 (IRLS). 절편은 규제하지 않는다."""
    Xb = np.hstack([np.ones((len(X), 1)), X])
    b = np.zeros(Xb.shape[1])
    reg = lam * np.eye(Xb.shape[1])
    reg[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(Xb @ b, -30, 30)))
        W = p * (1 - p) + 1e-9
        H = Xb.T @ (Xb * W[:, None]) + reg
        step = np.linalg.solve(H, Xb.T @ (y - p) - reg @ b)
        b += step
        if np.abs(step).max() < 1e-7:
            break
    return b[1:]


def to_weights(beta, X, y, cur):
    """회귀 계수를 score_config 모양으로. 가중치 합은 지금과 같게."""
    c = dict(zip(COLS, beta))
    pos = {k: int(((X[:, COLS.index(k)] > 0) & (y == 1)).sum()) for k in COLS}
    raw = {k: max(c[k], 0) for k in MAIN}
    total_cur = sum(cur[k] for k in MAIN)
    s = sum(raw.values()) or 1
    w = {k: raw[k] / s * total_cur for k in MAIN}
    for k in MAIN:  # 표본이 적은 신호는 지금 값
        if pos[k] < MIN_POS:
            w[k] = cur[k]
    s2 = sum(w.values())
    w = {k: w[k] / s2 * total_cur for k in MAIN}
    extra = {
        "new_deep": min(max(c["new_deep_x"] / c["new"], 0), 1) if c["new"] > 0 and pos["new_deep_x"] >= MIN_POS else cur["new_deep"],
        "pub_last": min(max(c["pub_last_x"] / c["pub"], -1), 1) if c["pub"] > 0 and pos["pub_last_x"] >= MIN_POS else cur["pub_last"],
        "loan_fall": max(-c["loan_fall_x"], 0) / s * total_cur if pos["loan_fall_x"] >= MIN_POS else cur["loan_fall"],
    }
    return {**w, **extra}, c, pos


def score(X, w):
    c = {k: X[:, COLS.index(k)] for k in COLS}
    s = sum(w[k] * c[k] for k in MAIN if k != "new")
    s += w["new"] * (c["new"] + w["new_deep"] * c["new_deep_x"])
    s += w["pub"] * w["pub_last"] * c["pub_last_x"]
    s -= w["loan_fall"] * c["loan_fall_x"]
    return 100 * s


def auc(s, y):
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):  # 같은 점수는 평균 순위
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    n1, n0 = y.sum(), len(y) - y.sum()
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0) if n1 and n0 else float("nan")


def top_rate(s, y, frac=0.1):
    k = max(int(len(s) * frac), 1)
    return y[np.argsort(-s)[:k]].mean()


def blend(cur, new, a):
    return {k: round((1 - a) * cur[k] + a * new[k], 3) for k in new}


def main():
    apply = "--apply" in sys.argv
    cfg_row = supabase.table("score_config").select("w").eq("id", 1).execute().data[0]
    cur = {k: float(v) for k, v in cfg_row["w"].items()}
    rows = supabase.rpc("eval_features", {}).execute().data or []
    X, y, days, _ = features(rows, cur)
    print(f"[데이터] {len(y)}건, 적중 {y.sum()}건 ({100 * y.mean():.1f}%), {min(days)} ~ {max(days)}")

    cut = TEST_FROM or sorted(days)[int(len(days) * 0.7)]
    tr = np.array([d < cut for d in days])
    te = ~tr
    print(f"[나눔] 앞 기간 {tr.sum()}건 / 뒤 기간(평가) {te.sum()}건, 기준일 {cut}")

    beta_tr = fit_logit(X[tr], y[tr])
    w_fit_tr, _, _ = to_weights(beta_tr, X[tr], y[tr], cur)
    w_blend_tr = blend(cur, w_fit_tr, BLEND)
    res = {}
    for name, w in [("지금", cur), ("새로 맞춤", w_fit_tr), (f"섞음({BLEND:.0%})", w_blend_tr)]:
        s = score(X[te], w)
        res[name] = (auc(s, y[te]), top_rate(s, y[te]))
        print(f"  {name:10s} AUC {res[name][0]:.3f} · 상위10% 적중률 {100 * res[name][1]:.1f}%")

    beta = fit_logit(X, y)
    w_fit, coef, pos = to_weights(beta, X, y, cur)
    w_new = blend(cur, w_fit, BLEND)
    print("\n[신호별] 계수(전체 기간) · 양성 적중 건수 · 지금 → 제안")
    for k in COLS:
        key = {"new_deep_x": "new_deep", "pub_last_x": "pub_last", "loan_fall_x": "loan_fall"}.get(k, k)
        cur_v = cur.get(key, "-")
        new_v = w_new.get(key, "-")
        print(f"  {k:12s} {coef[k]:+.2f} · {pos[k]:4d}건 · {cur_v} → {new_v}")

    better = res[f"섞음({BLEND:.0%})"][0] >= res["지금"][0] and res[f"섞음({BLEND:.0%})"][1] >= res["지금"][1]
    final = {**cur, **w_new}
    print("\n[제안 score_config.w]")
    print(json.dumps(final, ensure_ascii=False))
    print(f"\n[판정] 뒤 기간에서 섞은 값이 지금보다 {'낫거나 같음' if better else '나쁨'}")

    if apply:
        if not better:
            print("::warning::새 가중치가 지금보다 낫지 않아 저장하지 않음")
            return
        note = (f"{date.today()}: {min(days)}~{max(days)} {len(y)}건으로 다시 맞춤(지금 값과 {BLEND:.0%} 섞음). "
                f"뒤 기간 AUC {res['지금'][0]:.3f}→{res[f'섞음({BLEND:.0%})'][0]:.3f}, "
                f"상위10% 적중률 {100 * res['지금'][1]:.1f}%→{100 * res[f'섞음({BLEND:.0%})'][1]:.1f}%")
        supabase.table("score_config").update({"w": final, "note": note, "updated_on": str(date.today())}).eq("id", 1).execute()
        print(f"[저장] {note}")


if __name__ == "__main__":
    main()
