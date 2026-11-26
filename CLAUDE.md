# 책콕 작업 메모 (Claude용)

새 세션에서 같은 것을 다시 찾지 않도록 적어 둔 요약. 답변은 한국어, main에 바로 커밋.

## 위치
- 사이트: https://chaekkok.vercel.app (React+Vite, `src/App.jsx`, 서버 렌더 책 페이지 `api/page.js`)
- Vercel: project `prj_41K6zw66W2KTFveQoAHxIAaoxn9M`, team `team_NAqeSLXJYaGk5V8xxRUrWH8E`
- Supabase: project `dksazvdyezxokcbjuqvp` (SQL 원본은 `supabase/sql/`)
- 수집은 **10:30 KST 전에 끝나야 함**(승환님이 점심에 블로그 올림). GitHub 예약이 늦거나 빠져서(11/24 정오까지 안 돎)
  collect.yml에 예약 5개(04:07·05:23·06:41·07:37·08:19 KST) + pg_cron `kick_collect()`(04:12·07:02 KST, Vault 'gh_dispatch_token' 있을 때만 GitHub API로 시작).
  토큰은 2026-11-25에 넣음(fine-grained, chaekkok·Actions 쓰기, **2027-11-25 만료** → 그 전에 새로 만들어 vault.update_secret로 교체). 시험: `select public.kick_collect();` 후 net._http_response가 204면 정상.
  '오늘 수집했는지 확인' 단계가 오늘 collect_runs 기록이 있으면 자동 실행(schedule, inputs.auto=true)을 건너뜀. 손으로 돌리면 항상 실행. (`supabase/sql/collect_kick.sql`)
- 보충 수집 (2026-11-26): `catchup.yml`(extra_collect.py usage coloan details)을 pg_cron 'kick-catchup'(13:02)·'kick-catchup-eve'(20:02 KST, `kick_catchup()`)이 시작. 중계 서버가 없으면 그날 남은 수집 몫(400회 중)만 쓴다.
  extra_collect는 정보나루 시간 초과·연결 실패가 3번 연속이면 그 실행에서 정보나루를 그만 부른다(시간 초과는 재시도 안 함, timeout 30초). 11/26 새벽에 시간 초과로 이용분석 82권·소개 50권을 날리고 3시간 반 걸렸었다.
  이용분석은 아직 없는 책 먼저, 다시 받기는 30일마다(14→30).
- 정보나루 고정 IP 중계 서버 (2026-11-26): 오라클 무료 VM(춘천, VM.Standard.E2.1.Micro, Ubuntu 22.04) 공인 IP **168.107.1.200**, tinyproxy :8888
  (BasicAuth 사용자 chaekkok, 필터로 data4library.kr만 통과). GitHub Secret `D4L_PROXY`=http://chaekkok:<비번>@168.107.1.200:8888.
  수집 스크립트는 `api_budget.d4l_get()`으로 부르며, 중계 서버가 안 되면 그 실행은 바로 부른다. 점검: Actions '중계 서버 점검 (수동)'(proxytest.yml, 정보나루 API 안 씀).
  정보나루 마이페이지에 서버 IP 등록함(11-26). 확인 결과: 등록 IP로는 하루 500건을 넘어도 정상, 등록 안 한 IP는 하루 합계 500건이 넘으면 '1일 500건 이상 요청 시 IP 등록이 필요합니다'로 막힘.
  그래서 Edge Function(book-exist·library-info)도 `Deno.createHttpClient({proxy})`로 중계 서버를 거친다(Supabase 함수 비밀값 `D4L_PROXY`, 없으면 바로 부름).
  한도: 중계 서버를 쓰면 수집 20,000·전체 29,000·화면 3,000(spend_edge_call 인자), 안 쓰면 예전 400·495·90.
  수집량(11-26 재구성, 중계 서버일 때 / 아닐 때): 7일 인기 10개 분야×200위 / 6개 분야 / · 연령·성별 순위 100위 / 50위 ·
  이용분석 새벽 500·보충 1500권 / 160권(뜨거운 책=7일 인기·단계 붙은 책은 7일마다, 나머지 30일마다 다시) · 상세 300·1500 / 50 · 함께 빌린 책 등록 200·500 / 30(소개도 함께 저장).
  보충 수집은 13:02·20:02 KST(pg_cron kick-catchup, kick-catchup-eve). 수량은 환경변수 USAGE_LIMIT·DETAIL_LIMIT·COLOAN_LIMIT로 바꾼다.
  대상 수만 보기: Actions '수집 대상 미리 보기 (수동)'(dryrun.yml, 정보나루 안 부름). PostgREST는 한 번에 1000행까지라 큰 조회는 range로 나눠 읽는다.
  확인 워크플로: '정보나루 IP 등록 확인 (수동)'(d4ltest.yml, inputs.n = 등록 IP로 부를 횟수, libSrch 1건씩).
  서버 들어가기: 오라클 Cloud Shell에 키 올리고 `ssh -i ~/ssh-key-*.key ubuntu@168.107.1.200`. 붙여넣기 앞에 `^[[200~`가 붙으니 명령 앞뒤에 `true;`.
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
- 취향 찾기(/taste): `taste_votes`(기기 번호·책마다 마지막 선택, RLS 잠김) ← `taste_vote` RPC만으로 기록. 콕 추가/해제도 source='kok'로 +1/0. 홈 '모두가 콕한 책'은 `taste_top`(최근 30일). 비어 있으면 아직 투표가 없는 것.
- '누가 빌렸나' 분야 비교는 `field_demo(대분류, 어린이여부)`: 그룹 8개 이상인 같은 분야 책들의 비율 평균. 책이 5권 미만이면 화면은 남녀 비율만 보여 준다 (loan_grps는 그 책이 순위에 든 그룹만 와서 전체 분포가 아님).
- ISBN은 `isbn_util.py`로 13자리 하나만 저장 (API가 'ISBN1 ISBN2'로 줄 때가 있음).
- 정보나루 하루 500건(IP 미등록 키) 나눠 쓰기 (`supabase/sql/api_budget.sql`, 2026-11-23): 수집은 `add_batch_calls`로 batch 400회, 화면(book-exist·library-info)은 `spend_edge_call`로 하루 90회, 전체 495회. 막힌 요청은 세지 않음. `api_usage.edge_calls`가 화면 몫.
- 검색 로봇(구글 렌더러 등)은 화면·함수 둘 다 정보나루를 안 부른다(App.jsx `IS_BOT`, 함수의 `isBot`). 11/23에 구글 로봇이 책 상세를 그리며 하루 400회를 써서 수집·소장 확인이 다 막혔었다.
- 화면용 캐시 (`supabase/sql/cache_views.sql`, 2026-11-23): `v_feed`·`v_home_keywords`·`v_hit_stats`는 `cache` 스키마의 materialized view를 읽는 뷰다(계산식은 `*_live`). 새로 고침은 수집 워크플로 '화면용 캐시 새로 고침' 단계 + pg_cron 매시 17분(`refresh_cached_views()`). 수집 스크립트는 `v_feed_live`를 읽는다. 홈 첫 로딩의 DB 시간이 v_feed 0.2~0.9초 → 2ms.
- 최근 7일 인기대출(`loan_week`, 2026-11-23): 30일 순위에 들기 전 새 책을 빨리 들이려고 문학 200위·사회과학·철학·총류·역사·기술과학 100위를 매일 받는다(collect.py `collect_loan_week`, 하루 7회). trend_scores와 섞지 않음. 이용분석은 이 목록의 '아직 이용분석 없는 책'을 하루 40권까지 먼저 받는다(USAGE_LIMIT 170→160).
- 정보나루가 막혀도 도서관 이름·주소·전화·홈페이지는 `libraries` 테이블에서 보여 준다(도서관 페이지, 소장 확인 줄의 '홈페이지').

## 홈 지역 지도 (2026-11-26)
- 홈 두 면 중 오른쪽(남색)은 `RegionMapPanel`: 대한민국 시·도 지도(`src/koreaMap.js`, 처음 볼 때 따로 불러옴). 마우스를 올리면 그 지역 인기 3권, 누르면 30위까지 목록. 자료는 `v_region_map`(`supabase/sql/region_map.sql`).
- 지도 원본은 MapSVG South Korea(CC BY 4.0, npm @svg-maps/south-korea) → 점 줄이고 작은 섬 뺌. 출처 표기(패널 아래 '지도: MapSVG (CC BY 4.0)')는 지우면 안 된다.
- 강원(32)·전북(35)은 정보나루 지역 인기대출이 비어 있다(51·52는 '지역코드를 확인'). 지도에서 점선·'자료 없음'.
- 예전 '곧 서점에 나올 책'(ShopPanel)은 홈에서 뺐다(출간 예정 책은 /upcoming 쪽 `Upcoming`에 그대로).

## 책냥이
- 책콕 고양이 이름은 **책냥이**. `KokCat`(삐뚤빼뚤 책 4권 위, 상세 표지 판·취향 찾기·빈 콕 화면)과 `KokCatScene`(홈 키워드 줄 오른쪽, 'TOP 5' 선 위: 노란 스탠드 불빛 가끔 깜빡, 머그잔 김, 꼬리 살랑), `CatWalk`(키워드 페이지: 걸어오다 기지개 → 스탠드 아래 책 더미에 자리 잡기, 10초 한 번). svg 바닥이 맨 아래 책 바닥이라 선 위에 bottom 0으로 놓으면 딱 붙는다.
- 링크 미리보기 public/og.png도 같은 그림. 바꾸면 index.html·api/page.js의 og.png?v= 값도 올린다.

## 주의
- 방문자 수는 날마다 초기화되는 해시라 날짜 합계는 중복 포함.
- 가중치 재조정은 Actions '점수 가중치 다시 맞추기'(refit.yml)로. 결과는 로그에서 `[데이터]`~`[판정]`만 보면 된다.
  score_config의 정수 값(use_rel·loan_evid·steady_evid)은 꼭 정수로 (1.0이면 refresh_book_state 실패).
- `_backup_book_state_1110`, `_backup_spotted_1110`은 점수 가중치 재조정(11월 말) 확인 후 삭제 예정.

## 할 일 (승환님이 하기로 정한 것)
- **책 상세 유튜브 영상** (2026-11-24 만듦, `supabase/sql/book_videos.sql`): youtube_collect.py가 원래 하던 검색(인기 책 50권, 추가 호출 없음) 결과에서
  영상 제목에 책 제목(권 표시 뗀 것)이 있고 저자나 '리뷰·서평·줄거리' 같은 말이 있는 영상을 책마다 3개까지 `book_videos`에 저장.
  30일 지난 행은 pg_cron 'purge-book-videos'가 지움(YouTube 정책 III.E.4.c). 화면은 `useBookVideos`/`BookVideo`:
  넓은 화면은 제목 오른쪽(사실 칸 위), 폰은 제목 옆 42% 칸 → 누르면 가로로 꽉 차게 youtube-nocookie로 재생. 'YouTube' 표시는 항상 보이게.
  그날 바로 채우려면 Actions '책 소개 영상 채우기 (수동)'(videos.yml). 유튜브 검색 한도를 수집과 나눠 쓰니 하루 한 번만.
  - (사업 아이디어) 북튜버 유료 노출: 검색으로 찾은 영상 목록은 손대지 않고(정책 III.C.5) 그 위에 '광고' 표시한 별도 칸 1개로.
    책 제목·저자가 영상에 있는 경우만 받는다. 페이지에 책콕 자체 내용이 있어야 광고 판매 가능(III.G.1.d).
