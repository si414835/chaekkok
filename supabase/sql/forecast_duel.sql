-- 책콕: 예보 · 적중 세부 · 역주행 · 콕 대결 (2026-11-10)
--
--  refresh_forecast()  : 과거에 같은 점수대였던 책이 2주 뒤 실제로 크게(20% 이상) 오른 비율을 구해
--                        forecast_bins(점수 구간별 비율)와 book_state.forecast(책마다 예보 %)에 넣는다.
--                        hit_breakdown에는 단계·신뢰도별 실제 비율을 넣는다. 매일 단계 계산 뒤에 부른다.
--  v_eval_rows         : 책×날짜마다 2주 뒤 순위(r2). 분석·예보 계산용 (앱에서는 읽지 않는다)
--  v_spot_result       : 포착한 책의 2주 뒤 결과 (up20 크게 오름 / up 조금 오름 / down 제자리·하락 / out 순위 밖)
--  v_comeback          : 역주행. 출간 2년이 넘었는데 지금 다시 오르는 책
--  duel_*              : 콕 대결. 기기마다 일주일에 3권까지 '2주 뒤 크게 오를 책'을 고른다

create or replace view v_eval_rows as
with cd as (select snapshot_date d from v_popular_complete_dates)
select s.snapshot_date, s.isbn13, s.rank_now, s.momentum, s.stage, s.confidence, s.sources, s.list_size,
  (select t2.rank from trend_scores t2 where t2.isbn13 = s.isbn13 and t2.trend_type = 'popular'
     and t2.snapshot_date = (select b.d from cd b where b.d between s.snapshot_date + 12 and s.snapshot_date + 16 order by abs(b.d - (s.snapshot_date + 14)) limit 1)) as r2,
  exists (select 1 from cd b where b.d between s.snapshot_date + 12 and s.snapshot_date + 16) as matured
from book_state s join books b using (isbn13)
where s.rank_now > 10 and coalesce(b.addition_symbol, '') not like '7%';
revoke all on v_eval_rows from anon, authenticated;

create table if not exists forecast_bins (
  lo numeric primary key, hi numeric, n int not null, hits int not null, rate numeric not null, updated_on date
);
create table if not exists hit_breakdown (
  kind text, label text, n int not null, rate numeric, primary key (kind, label)
);
alter table forecast_bins enable row level security;
alter table hit_breakdown enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'forecast_bins') then
    create policy "read forecast_bins" on forecast_bins for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'hit_breakdown') then
    create policy "read hit_breakdown" on hit_breakdown for select to anon, authenticated using (true);
  end if;
end $$;

create or replace function public.refresh_forecast(p_all boolean default false)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_k constant numeric := 15;   -- 표본이 적은 구간은 전체 평균 쪽으로 당긴다
  v_n int;
begin
  with ev as materialized (
    select momentum, stage, confidence, (r2 is not null and r2 <= rank_now * 0.8)::int as y
    from v_eval_rows where matured
  ),
  base as (select avg(y) as v from ev),
  b as (
    select case when momentum >= 45 then 45 when momentum >= 30 then 30 when momentum >= 15 then 15 when momentum > 0 then 0.1 else 0 end as lo,
           count(*) as n, sum(y) as hits
    from ev group by 1
  ),
  r as (select lo, n, hits, (hits + v_k * (select v from base)) / (n + v_k) as raw from b),
  m as (select lo, n, hits, max(raw) over (order by lo) as rate from r),   -- 점수가 높은 구간이 더 낮게 나오지 않도록
  ins_bins as (
    insert into forecast_bins (lo, hi, n, hits, rate, updated_on)
    select lo, case lo when 0 then 0 when 0.1 then 15 when 15 then 30 when 30 then 45 end, n, hits, round(100 * rate, 1), current_date from m
    on conflict (lo) do update set hi = excluded.hi, n = excluded.n, hits = excluded.hits, rate = excluded.rate, updated_on = excluded.updated_on
    returning 1
  ),
  bd as (
    select 'all' as kind, '전체' as label, count(*)::int as n, round(100.0 * avg(y), 1) as rate from ev
    union all
    select 'stage', coalesce(stage, '단계 없음'), count(*)::int, round(100.0 * avg(y), 1) from ev where stage is distinct from '스테디' group by 2
    union all
    select 'confidence', confidence, count(*)::int, round(100.0 * avg(y), 1) from ev
      where stage in ('포착', '떠오름', '확산') and confidence is not null group by 2
  ),
  ins_bd as (
    insert into hit_breakdown (kind, label, n, rate) select kind, label, n, rate from bd
    on conflict (kind, label) do update set n = excluded.n, rate = excluded.rate
    returning 1
  )
  select (select count(*) from ins_bins) + (select count(*) from ins_bd) into v_n;

  update book_state s
    set forecast = (select f.rate from forecast_bins f where f.lo <= s.momentum order by f.lo desc limit 1)
  from books b
  where b.isbn13 = s.isbn13 and s.rank_now > 10 and s.momentum is not null
    and coalesce(b.addition_symbol, '') not like '7%'
    and (p_all or s.snapshot_date >= (select max(snapshot_date) from book_state) - 2);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

create or replace view v_book_state_latest as
select s.isbn13, s.snapshot_date, s.stage, s.reason, s.confidence, s.momentum, s.sources, s.rank_now, s.rank_prev, s.cat,
  s.regions, s.loan_growth, s.hot_diff, s.new_entry, s.upcoming, l.first_spotted, s.rank_mid, s.rank_change_ratio,
  s.rise_steady, s.demo_groups, s.librarian, s.yt_spike, s.gt_spike, s.list_size, s.forecast
from book_state s left join spotted_log l on l.isbn13 = s.isbn13
where s.snapshot_date = (select max(snapshot_date) from book_state);

create or replace view v_spot_result as
with cd as (select snapshot_date d from v_popular_complete_dates)
select l.isbn13, l.first_spotted, l.first_stage, l.rank_at_spot, x.d2 as checked_on, t2.rank as rank_after,
  case when t2.rank is null then 'out' when t2.rank <= l.rank_at_spot * 0.8 then 'up20' when t2.rank < l.rank_at_spot then 'up' else 'down' end as outcome,
  b.title, b.author, b.cover_url, b.class_name
from spotted_log l
join lateral (select c.d as d2 from cd c where c.d between l.first_spotted + 12 and l.first_spotted + 16 order by abs(c.d - (l.first_spotted + 14)) limit 1) x on true
join books b on b.isbn13 = l.isbn13
left join trend_scores t2 on t2.isbn13 = l.isbn13 and t2.trend_type = 'popular' and t2.snapshot_date = x.d2
where l.rank_at_spot is not null and l.rank_at_spot <= 100 and coalesce(b.addition_symbol, '') not like '7%';

create or replace view v_comeback as
select s.isbn13, s.snapshot_date, s.stage, s.momentum, s.rank_now, s.rank_prev, s.new_entry, s.cat,
  b.title, b.author, b.publisher, b.pub_year, b.class_name, b.cover_url, b.detail_url, b.addition_symbol
from book_state s join books b using (isbn13)
where s.snapshot_date = (select max(snapshot_date) from book_state)
  and s.stage in ('포착', '떠오름', '확산')
  and b.pub_year ~ '^\d{4}$' and b.pub_year::int <= extract(year from s.snapshot_date)::int - 2
  and coalesce(b.addition_symbol, '') not like '7%'
  and (s.new_entry or coalesce(s.rank_change_ratio, 0) >= 0.1 or s.hot_diff > 0);

-- ---------- 콕 대결 ----------
create table if not exists duel_picks (
  id bigint generated always as identity primary key,
  device uuid not null,
  isbn13 text not null,
  picked_on date not null,          -- 고른 날의 데이터 기준일
  rank_at_pick int not null,
  forecast numeric,
  stage text,
  created_at timestamptz not null default now(),
  unique (device, isbn13, picked_on)
);
create index if not exists duel_picks_device_idx on duel_picks (device);
alter table duel_picks enable row level security;   -- 정책 없음: 아래 함수로만 읽고 쓴다

create or replace view v_duel_results as
with cd as (select snapshot_date d from v_popular_complete_dates),
latest as (select max(d) d from cd)
select k.id, k.device, k.isbn13, k.picked_on, k.rank_at_pick, k.forecast, k.stage, b.title, b.author, b.cover_url,
  tl.rank as rank_latest, ta.rank as rank_after,
  case when x.d2 is null then 'pending' when ta.rank is not null and ta.rank <= k.rank_at_pick * 0.8 then 'hit' else 'miss' end as status
from duel_picks k
join books b on b.isbn13 = k.isbn13
left join lateral (select c.d as d2 from cd c where c.d between k.picked_on + 12 and k.picked_on + 16 order by abs(c.d - (k.picked_on + 14)) limit 1) x on true
left join trend_scores tl on tl.isbn13 = k.isbn13 and tl.trend_type = 'popular' and tl.snapshot_date = (select d from latest)
left join trend_scores ta on ta.isbn13 = k.isbn13 and ta.trend_type = 'popular' and ta.snapshot_date = x.d2;
revoke all on v_duel_results from anon, authenticated;

create or replace function public.duel_pick(p_device uuid, p_isbn text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_d date;
  s record;
  v_week int;
begin
  select max(snapshot_date) into v_d from book_state;
  select st.rank_now, st.forecast, st.stage, b.addition_symbol into s
  from book_state st join books b using (isbn13)
  where st.snapshot_date = v_d and st.isbn13 = p_isbn;
  if not found or s.rank_now is null or s.rank_now <= 10 or coalesce(s.addition_symbol, '') like '7%' then
    return jsonb_build_object('ok', false, 'why', 'not_eligible');
  end if;
  if exists (select 1 from duel_picks where device = p_device and isbn13 = p_isbn and picked_on > v_d - 14) then
    return jsonb_build_object('ok', false, 'why', 'dup');
  end if;
  select count(*) into v_week from duel_picks where device = p_device and picked_on > v_d - 7;
  if v_week >= 3 then
    return jsonb_build_object('ok', false, 'why', 'limit');
  end if;
  if (select count(*) from duel_picks where created_at > now() - interval '1 day') > 3000 then
    return jsonb_build_object('ok', false, 'why', 'busy');
  end if;
  insert into duel_picks (device, isbn13, picked_on, rank_at_pick, forecast, stage)
  values (p_device, p_isbn, v_d, s.rank_now, s.forecast, s.stage);
  return jsonb_build_object('ok', true, 'picked_on', v_d, 'week_left', 2 - v_week);
end;
$function$;

-- 책 상세용: 내가 골랐는지, 이번 주 남은 횟수, 최근 2주 동안 이 책을 고른 사람 수
create or replace function public.duel_book(p_device uuid, p_isbn text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with d as (select max(snapshot_date) d from book_state)
  select jsonb_build_object(
    'picked', exists (select 1 from duel_picks, d where device = p_device and isbn13 = p_isbn and picked_on > d.d - 14),
    'week_left', 3 - (select count(*) from duel_picks, d where device = p_device and picked_on > d.d - 7),
    'pickers', (select count(distinct device) from duel_picks, d where isbn13 = p_isbn and picked_on > d.d - 14)
  );
$function$;

create or replace function public.duel_my(p_device uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with d as (select max(snapshot_date) d from book_state)
  select jsonb_build_object(
    'week_left', 3 - (select count(*) from duel_picks, d where device = p_device and picked_on > d.d - 7),
    'picks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'isbn13', r.isbn13, 'title', r.title, 'author', r.author, 'cover_url', r.cover_url,
        'picked_on', r.picked_on, 'due', r.picked_on + 14, 'rank_at_pick', r.rank_at_pick, 'forecast', r.forecast, 'stage', r.stage,
        'rank_latest', r.rank_latest, 'rank_after', r.rank_after, 'status', r.status) order by r.picked_on desc, r.id desc)
      from (select * from v_duel_results where device = p_device order by picked_on desc, id desc limit 60) r), '[]'::jsonb),
    'everyone', (select jsonb_build_object('n', count(*), 'hits', count(*) filter (where status = 'hit'), 'players', count(distinct device))
                 from v_duel_results where status <> 'pending')
  );
$function$;
