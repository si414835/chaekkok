-- 책콕 데이터 점검을 한 번에: select public.health_check();
-- 결과의 "warnings" 배열이 비어 있으면 정상. 수집기 전용(공개 API로는 못 부름).
create or replace function public.health_check()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  d_state date := (select max(snapshot_date) from book_state);
  d_trend date := (select max(snapshot_date) from trend_scores);
  today date := (now() at time zone 'Asia/Seoul')::date;
  r jsonb := '{}'::jsonb;
  w text[] := '{}';
  n_state int; n_prev int; n_bad int; n_draft int; n_fail int;
begin
  -- 1. 오늘 수집
  select count(*) filter (where status <> 'ok') into n_fail from collect_runs where run_date = today;
  r := r || jsonb_build_object('collect_today', jsonb_build_object(
    'runs', (select count(*) from collect_runs where run_date = today),
    'not_ok', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'part', part, 'status', status, 'error', left(error, 120)))
                        from collect_runs where run_date = today and status <> 'ok'), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('part', part, 'note', left(error, 120)))
                       from collect_runs where run_date = today and status = 'ok' and error is not null), '[]'::jsonb)));
  if (select count(*) from collect_runs where run_date = today) = 0 then w := array_append(w, '오늘 수집 기록 없음'); end if;
  if n_fail > 0 then w := array_append(w, format('오늘 수집 %s건이 ok 아님', n_fail)); end if;

  -- 2. 단계 스냅샷
  select count(*) into n_state from book_state where snapshot_date = d_state;
  select count(*) into n_prev from book_state where snapshot_date = (select max(snapshot_date) from book_state where snapshot_date < d_state);
  r := r || jsonb_build_object('book_state', jsonb_build_object(
    'date', d_state, 'books', n_state, 'prev_books', n_prev,
    'stages', (select jsonb_object_agg(coalesce(stage, '없음'), c) from (select stage, count(*) c from book_state where snapshot_date = d_state group by 1) s),
    'half_filled', (select count(*) from book_state where snapshot_date = d_state and (stage is null) <> (confidence is null))));
  if d_state < today then w := array_append(w, format('단계 스냅샷이 오늘이 아님(%s)', d_state)); end if;
  if n_prev > 0 and n_state < n_prev * 0.9 then w := array_append(w, format('단계 책 수 급감 %s→%s', n_prev, n_state)); end if;

  -- 3. 순위·점수 (popular=순위만, composite=점수만 있는 게 정상)
  r := r || jsonb_build_object('trend_scores', jsonb_build_object(
    'date', d_trend,
    'by_type', (select jsonb_object_agg(trend_type, c) from (select trend_type, count(*) c from trend_scores where snapshot_date = d_trend group by 1) s),
    'popular_without_rank', (select count(*) from trend_scores where snapshot_date = d_trend and trend_type = 'popular' and rank is null),
    'composite_without_score', (select count(*) from trend_scores where snapshot_date = d_trend and trend_type = 'composite' and score is null)));

  -- 4. 책 정보
  select count(*) into n_bad from books where isbn13 !~ '^\d{13}$';
  r := r || jsonb_build_object('books', jsonb_build_object(
    'total', (select count(*) from books),
    'bad_isbn', n_bad,
    'no_class', (select count(*) from books where coalesce(class_no, '') = ''),
    'no_cover', (select count(*) from books where coalesce(cover_url, '') = ''),
    'state_without_book', (select count(*) from book_state s where snapshot_date = d_state and not exists (select 1 from books b where b.isbn13 = s.isbn13)),
    'usage_rows', (select count(*) from book_usage),
    'usage_nodata', (select count(*) from usage_nodata)));
  if n_bad > 0 then w := array_append(w, format('ISBN 형식 이상 %s건', n_bad)); end if;

  -- 5. 블로그 초안
  select count(*) into n_draft from blog_drafts where day = today;
  r := r || jsonb_build_object('blog_draft', jsonb_build_object(
    'today', n_draft > 0,
    'books', (select array_length(isbns, 1) from blog_drafts where day = today),
    'has_poll', (select poll is not null from blog_drafts where day = today)));
  if n_draft = 0 then w := array_append(w, '오늘 블로그 초안 없음'); end if;

  -- 6. 기타
  r := r || jsonb_build_object('misc', jsonb_build_object(
    'hit_baseline_on', (select computed_on from hit_baseline limit 1),
    'push_subscriptions', (select count(*) from push_subscriptions),
    'duel_picks', (select count(*) from duel_picks)));

  return jsonb_build_object('checked_at', now(), 'kst_today', today, 'warnings', to_jsonb(w)) || r;
end $$;

revoke all on function public.health_check() from public, anon, authenticated;

-- 분류(KDC)를 정보나루에서도 못 찾은 책: 14일 동안 다시 부르지 않음 (extra_collect.collect_classes)
create table if not exists class_nodata (isbn13 text primary key, checked_at timestamptz not null default now());
alter table class_nodata enable row level security;
create table if not exists usage_nodata (isbn13 text primary key, checked_at timestamptz not null default now());
alter table usage_nodata enable row level security;
