# 책콕 작업 메모 (Claude용)

새 세션에서 같은 것을 다시 찾지 않도록 적어 둔 요약. 답변은 한국어, main에 바로 커밋.

## 위치
- 사이트: https://chaekkok.vercel.app (React+Vite, `src/App.jsx`, 서버 렌더 책 페이지 `api/page.js`)
- Vercel: project `prj_41K6zw66W2KTFveQoAHxIAaoxn9M`, team `team_NAqeSLXJYaGk5V8xxRUrWH8E`
- Supabase: project `dksazvdyezxokcbjuqvp` (SQL 원본은 `supabase/sql/`)
- 수집: `.github/workflows/collect.yml` 매일 04:07 KST → `collect.py`, `extra_collect.py`, `nl_recommend_collect.py`, `blog_draft.py`
- 워크플로 수동 실행은 GraphQL이 막혀 있어 REST로:
  `gh api -X POST repos/si414835/chaekkok/actions/workflows/<file>.yml/dispatches -f ref=main`
- 키(authKey, cert_key, VAPID 개인키 등)는 절대 출력·커밋하지 않는다.

## 점검 (사용량 아끼는 순서)
1. 데이터: `select public.health_check();` 한 번. `warnings`가 비어 있으면 정상.
   (수집 전인 0시~04:30 KST에는 '오늘 수집 기록 없음·스냅샷이 오늘이 아님·초안 없음' 3개가 뜨는 게 정상)
2. 방문: Vercel `aggregate_pageviews` — by `day`(최근 7일), 필요할 때만 `referrerHostname`/`requestPath`.
3. 경고가 있을 때만 `collect_runs`나 Actions 로그(`gh run view <id> --log | grep ...`)를 연다.

## 정상인데 이상해 보이는 것
- `trend_scores`: `popular`는 rank만, `composite`는 score만 있다 (빈 값은 설계).
- `book_state`: 단계(stage)는 매일 약 400권만 붙고 나머지는 stage·confidence 둘 다 null.
- 이용분석 "자료 없음"은 실패가 아니라 `usage_nodata`에 적고 14일 뒤 다시 확인.
- 책 소개(books.description)는 두 곳에서 채운다: 상세 화면을 열면 library-info 함수가 받아 저장, 새벽 수집 collect_details가 화면에 보이는 책부터 하루 50권(분류와 함께). desc_checked_at이 있으면 소개가 없어도 다시 부르지 않음.
- ISBN은 `isbn_util.py`로 13자리 하나만 저장 (API가 'ISBN1 ISBN2'로 줄 때가 있음).

## 주의
- 방문자 수는 날마다 초기화되는 해시라 날짜 합계는 중복 포함.
- 가중치 재조정은 Actions '점수 가중치 다시 맞추기'(refit.yml)로. 결과는 로그에서 `[데이터]`~`[판정]`만 보면 된다.
  score_config의 정수 값(use_rel·loan_evid·steady_evid)은 꼭 정수로 (1.0이면 refresh_book_state 실패).
- `_backup_book_state_1110`, `_backup_spotted_1110`은 점수 가중치 재조정(11월 말) 확인 후 삭제 예정.
