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
- 마니아·다독자 추천(book_usage.mania_rec·reader_rec)은 이용분석 응답에 같이 오는 것을 저장(추가 호출 없음). 하루 170권씩 채워지므로 처음 2주는 빈 책이 많다.
- 흔한 책 보정: `mv_neighbor_freq`(이웃 목록 등장 수)를 extra_collect 이용분석 단계 끝에 `refresh_neighbor_freq()`로 새로 고침. `book_recs`·`taste_recs`가 ln(전체/(1+등장 수))로 순서를 낮춘다.
- 취향 찾기(/taste): `taste_votes`(기기 번호·책마다 마지막 선택, RLS 잠김) ← `taste_vote` RPC만으로 기록. 콕 추가/해제도 source='kok'로 +1/0. 홈 '책콕 사람들이 좋다고 고른 책'은 `taste_top`(최근 30일). 비어 있으면 아직 투표가 없는 것.
- '누가 빌렸나' 분야 비교는 `field_demo(대분류, 어린이여부)`: 그룹 8개 이상인 같은 분야 책들의 비율 평균. 책이 5권 미만이면 화면은 남녀 비율만 보여 준다 (loan_grps는 그 책이 순위에 든 그룹만 와서 전체 분포가 아님).
- ISBN은 `isbn_util.py`로 13자리 하나만 저장 (API가 'ISBN1 ISBN2'로 줄 때가 있음).
- 정보나루 하루 500건(IP 미등록 키) 나눠 쓰기 (`supabase/sql/api_budget.sql`, 2026-11-23): 수집은 `add_batch_calls`로 batch 400회, 화면(book-exist·library-info)은 `spend_edge_call`로 하루 90회, 전체 495회. 막힌 요청은 세지 않음. `api_usage.edge_calls`가 화면 몫.
- 검색 로봇(구글 렌더러 등)은 화면·함수 둘 다 정보나루를 안 부른다(App.jsx `IS_BOT`, 함수의 `isBot`). 11/23에 구글 로봇이 책 상세를 그리며 하루 400회를 써서 수집·소장 확인이 다 막혔었다.
- 화면용 캐시 (`supabase/sql/cache_views.sql`, 2026-11-23): `v_feed`·`v_home_keywords`·`v_hit_stats`는 `cache` 스키마의 materialized view를 읽는 뷰다(계산식은 `*_live`). 새로 고침은 수집 워크플로 '화면용 캐시 새로 고침' 단계 + pg_cron 매시 17분(`refresh_cached_views()`). 수집 스크립트는 `v_feed_live`를 읽는다. 홈 첫 로딩의 DB 시간이 v_feed 0.2~0.9초 → 2ms.
- 정보나루가 막혀도 도서관 이름·주소·전화·홈페이지는 `libraries` 테이블에서 보여 준다(도서관 페이지, 소장 확인 줄의 '홈페이지').

## 책냥이
- 책콕 고양이 이름은 **책냥이**. `KokCat`(삐뚤빼뚤 책 4권 위, 상세 표지 판·취향 찾기·빈 콕 화면)과 `KokCatScene`(홈 키워드 줄 오른쪽, 'TOP 5' 선 위: 노란 스탠드 불빛 가끔 깜빡, 머그잔 김, 꼬리 살랑), `CatWalk`(키워드 페이지: 걸어오다 기지개 → 스탠드 아래 책 더미에 자리 잡기, 10초 한 번). svg 바닥이 맨 아래 책 바닥이라 선 위에 bottom 0으로 놓으면 딱 붙는다.
- 링크 미리보기 public/og.png도 같은 그림. 바꾸면 index.html·api/page.js의 og.png?v= 값도 올린다.

## 주의
- 방문자 수는 날마다 초기화되는 해시라 날짜 합계는 중복 포함.
- 가중치 재조정은 Actions '점수 가중치 다시 맞추기'(refit.yml)로. 결과는 로그에서 `[데이터]`~`[판정]`만 보면 된다.
  score_config의 정수 값(use_rel·loan_evid·steady_evid)은 꼭 정수로 (1.0이면 refresh_book_state 실패).
- `_backup_book_state_1110`, `_backup_spotted_1110`은 점수 가중치 재조정(11월 말) 확인 후 삭제 예정.
