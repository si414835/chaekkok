-- 책콕: 트렌드 단계·모멘텀·신뢰도·예보 계산 (v3, 2026-11-10)
--
-- 바뀐 점 (v2 -> v3)
--  * 대출 증가는 '그 날짜에 이미 끝난 달'까지만 본다. (v2는 과거 날짜를 다시 계산할 때
--    나중에 받은 대출 이력을 그대로 써서, 9월 판정에 10월 대출량이 섞였다)
--  * 대출 증가는 '관찰 중인 책 전체의 중앙값'을 뺀 값(loan_growth_rel)으로 본다.
--    방학·시험 기간처럼 대출이 한꺼번에 늘고 주는 달의 효과를 뺀다.
--  * 가중치와 문턱값은 score_config 표에서 읽는다 (지금 값은 v2와 같다. 과거 적중 분석 뒤 표만 고친다).
--
-- 바뀐 점 (v1 -> v2)
--  * 분야 인기대출을 200위까지 받으면서, 순위 변화는 '목록 길이로 나눈 값' 대신
--    '이전 순위 대비 몇 % 올랐나'로 본다 (목록 깊이가 달라도 같은 기준).
--  * 신규 진입은 '지난주 목록 길이 안쪽'에 들어왔을 때만 인정한다.
--    (목록이 30위 -> 200위로 길어진 날, 150위 책이 '새로 진입'으로 잘못 잡히던 문제)
--  * 신뢰도 = 서로 다른 근거가 몇 개 겹치나. 근거 7가지:
--      ① 순위 20% 이상 상승  ② 지난주 목록에 없다가 새로 진입  ③ 전국 대출 급상승
--      ④ 꾸준한 상승(7일 전 > 3~4일 전 >= 오늘 순위)  ⑤ 지난달 대출 20% 이상 증가
--      ⑥ 여러 곳에서 동시에 인기(지역 3곳 이상 또는 연령·성별 목록 3개 이상)
--      ⑦ 바깥 신호(사서 추천 / 유튜브 급증 / 검색 급증)
--    3개 이상 높음 · 2개 보통 · 1개 낮음. 스테디는 관찰 10일 이상이면 높음, 7일 이상 보통.
--  * 단계 (위에서부터 먼저 맞는 것)
--      스테디 : 최근 21일 중 90% 이상 분야 TOP10
--      확산   : 오르는 중 + 여러 곳에서 동시에 인기 + 분야 상위 25% 안
--               (또는 모멘텀 45점 이상 + 근거 2개 이상)
--      떠오름 : 오르는 중 + 분야 상위 절반 안 (또는 순위 밖 전국 급상승)
--      포착   : 오르는 중이지만 아직 분야 하위 절반 / 출간 예정 신작 /
--               지난달 대출 30% 이상 증가 / 사서추천·신간 + 바깥 신호
--    '오르는 중' = 3계단 이상 + 10% 이상 상승, 또는 새로 진입, 또는 전국 급상승

alter table book_state add column if not exists rank_mid int;
alter table book_state add column if not exists demo_groups int;
alter table book_state add column if not exists rise_steady boolean;
alter table book_state add column if not exists loan_growth_rel numeric;
alter table book_state add column if not exists forecast numeric;

create table if not exists score_config (
  id int primary key default 1 check (id = 1),
  w jsonb not null,
  note text,
  updated_on date default current_date
);
alter table score_config enable row level security;
insert into score_config (id, w, note) values (1,
  '{"rank":0.35,"rc0":0,"rc1":0.3,"new":0.15,"hot":0.10,"loan":0.10,"loan_cap":0.5,"pub":0.10,"pub_last":0.5,"lib":0.05,"breadth":0.05,"yt":0.05,"gt":0.05,"loan_fall":0,"fall_at":-0.1,"use_rel":0,"steady_evid":1}',
  'v2 가중치 그대로') on conflict (id) do nothing;

create or replace function public.refresh_book_state(p_date date)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_prev date;
  v_mid date;
  v_recent boolean := p_date >= current_date - 3;
  v_n int;
  cfg jsonb;
  v_month date := date_trunc('month', p_date)::date;
begin
  select w into cfg from score_config where id = 1;
  if not exists (select 1 from v_popular_complete_dates where snapshot_date = p_date) then
    raise exception 'not a complete date: %', p_date;
  end if;
  select max(snapshot_date) into v_prev from v_popular_complete_dates
  where snapshot_date between p_date - 12 and p_date - 7;
  select max(snapshot_date) into v_mid from v_popular_complete_dates
  where snapshot_date between p_date - 5 and p_date - 3;

  with
  complete21 as (select snapshot_date from v_popular_complete_dates where snapshot_date between p_date - 20 and p_date),
  pop_now as (select isbn13, rank from trend_scores where trend_type = 'popular' and snapshot_date = p_date),
  pop_prev as (select isbn13, rank from trend_scores where trend_type = 'popular' and snapshot_date = v_prev),
  pop_mid as (select isbn13, rank from trend_scores where trend_type = 'popular' and snapshot_date = v_mid),
  list_size as (
    select left(b.class_no, 1) as kdc, count(*) as n
    from trend_scores t join books b using (isbn13)
    where t.trend_type = 'popular' and t.snapshot_date = p_date group by 1
  ),
  prev_size as (
    select left(b.class_no, 1) as kdc, count(*) as n
    from trend_scores t join books b using (isbn13)
    where t.trend_type = 'popular' and t.snapshot_date = v_prev group by 1
  ),
  rising7 as (
    select isbn13, max(rank_diff) as diff from trend_scores
    where trend_type = 'rising' and snapshot_date between p_date - 6 and p_date group by isbn13
  ),
  librarian as (
    select distinct isbn13 from trend_scores
    where trend_type = 'recommended' and snapshot_date between p_date - 180 and p_date
  ),
  upcoming as (
    select isbn13, publish_date, matched_author from upcoming_books
    where v_recent and publish_date between current_date - 30 and current_date + 60
  ),
  cand as (
    select isbn13 from pop_now union select isbn13 from rising7
    union select isbn13 from librarian union select isbn13 from upcoming
  ),
  top10 as (
    select t.isbn13, count(distinct t.snapshot_date) as days
    from trend_scores t join complete21 c on c.snapshot_date = t.snapshot_date
    where t.trend_type = 'popular' and t.rank <= 10 group by t.isbn13
  ),
  hist as (
    select u.isbn13, (x->>'loanCnt')::numeric as cnt, ord
    from book_usage u, jsonb_array_elements(coalesce(u.loan_history, '[]'::jsonb)) with ordinality as e(x, ord)
    where x->>'loanCnt' is not null
      and x->>'month' ~ '^\d{4}년 \d{1,2}월$'
      and to_date(x->>'month', 'YYYY"년" MM"월"') < v_month   -- 그 날짜에 이미 끝난 달만
  ),
  hist_ranked as (
    select isbn13, cnt, row_number() over (partition by isbn13 order by ord desc) as rn,
           count(*) over (partition by isbn13) as total
    from hist
  ),
  growth as (
    select isbn13,
           max(cnt) filter (where rn = 1) / nullif(avg(cnt) filter (where rn between 2 and 4), 0) - 1 as g
    from hist_ranked where total >= 4 group by isbn13
  ),
  market as (select percentile_cont(0.5) within group (order by g) as med from growth where g is not null),
  regions as (
    select isbn13, count(distinct region) as n from region_popular
    where snapshot_date = (select max(snapshot_date) from region_popular where snapshot_date between p_date - 2 and p_date)
    group by isbn13
  ),
  demo as (
    select isbn13, count(distinct (age_group, gender)) as n from demo_popular
    where snapshot_date = (select max(snapshot_date) from demo_popular where snapshot_date between p_date - 2 and p_date)
    group by isbn13
  ),
  sig as (
    select isbn13, source,
           max(mention_count) filter (where signal_date between p_date - 1 and p_date) as today,
           percentile_cont(0.5) within group (order by mention_count) filter (where signal_date between p_date - 15 and p_date - 2) as med
    from book_signals
    where signal_date between p_date - 15 and p_date and source in ('youtube', 'google_trends') and signal_date >= date '2026-09-07'
    group by isbn13, source
  ),
  spikes as (
    select isbn13,
      bool_or(source = 'youtube' and today >= greatest(2 * coalesce(med, 0), 1)) as yt,
      bool_or(source = 'google_trends' and today >= 20 and today >= 2 * coalesce(med, 0)) as gt
    from sig group by isbn13
  ),
  feat as (
    select c.isbn13, left(b.class_no, 1) as kdc,
      (array['총류','철학','종교','사회과학','자연과학','기술과학','예술','언어','문학','역사'])[left(b.class_no, 1)::int + 1] as cat,
      pn.rank as rank_now, pp.rank as rank_prev, pm.rank as rank_mid, ls.n as list_size,
      case when pn.rank is not null and pp.rank is not null and pp.rank > 0 then (pp.rank - pn.rank)::numeric / pp.rank end as rcr,
      (pn.rank is not null and v_prev is not null and pp.rank is null and pn.rank <= coalesce(ps.n, 0)) as new_entry,
      coalesce(t10.days, 0) as top10_days,
      (select count(*) from complete21)::int as complete_days,
      coalesce(r7.diff, 0) as hot_diff,
      g.g as loan_growth,
      g.g - coalesce((select med from market), 0) as loan_growth_rel,
      coalesce(rg.n, 0)::int as regions,
      coalesce(dm.n, 0)::int as demo_groups,
      case when b.pub_year ~ '^\d{4}$' and b.pub_year::int = extract(year from p_date)::int then 1
           when b.pub_year ~ '^\d{4}$' and b.pub_year::int = extract(year from p_date)::int - 1 then 0.5
           else 0 end::numeric as recent_pub,
      (lb.isbn13 is not null) as librarian,
      (up.isbn13 is not null) as upcoming,
      up.publish_date as up_date, up.matched_author as up_author,
      coalesce(sp.yt, false) as yt_spike, coalesce(sp.gt, false) as gt_spike
    from cand c
    join books b on b.isbn13 = c.isbn13
    left join pop_now pn on pn.isbn13 = c.isbn13
    left join pop_prev pp on pp.isbn13 = c.isbn13
    left join pop_mid pm on pm.isbn13 = c.isbn13
    left join list_size ls on ls.kdc = left(b.class_no, 1)
    left join prev_size ps on ps.kdc = left(b.class_no, 1)
    left join top10 t10 on t10.isbn13 = c.isbn13
    left join rising7 r7 on r7.isbn13 = c.isbn13
    left join growth g on g.isbn13 = c.isbn13
    left join regions rg on rg.isbn13 = c.isbn13
    left join demo dm on dm.isbn13 = c.isbn13
    left join librarian lb on lb.isbn13 = c.isbn13
    left join upcoming up on up.isbn13 = c.isbn13
    left join spikes sp on sp.isbn13 = c.isbn13
  ),
  scored as (
    select f.*,
      (f.rank_prev is not null and f.rank_now is not null and f.rank_prev - f.rank_now >= 3 and coalesce(f.rcr, 0) >= 0.1) as rank_up,
      (f.rank_prev is not null and f.rank_mid is not null and f.rank_now is not null
        and f.rank_prev > f.rank_mid and f.rank_mid >= f.rank_now) as rise_steady,
      (f.regions >= 3 or f.demo_groups >= 3) as breadth,
      (f.complete_days >= 7 and f.top10_days >= 0.9 * f.complete_days) as steady,
      (f.complete_days >= 7 and f.top10_days >= f.complete_days * 2.0 / 3) as near_steady,
      100 * ((cfg->>'rank')::numeric * least(greatest((coalesce(f.rcr, 0) - (cfg->>'rc0')::numeric) / ((cfg->>'rc1')::numeric - (cfg->>'rc0')::numeric), 0), 1)
           + (cfg->>'new')::numeric * (f.new_entry)::int
           + (cfg->>'hot')::numeric * least(f.hot_diff / 100.0, 1)
           + (cfg->>'loan')::numeric * least(greatest(coalesce(f.g_use, 0), 0) / (cfg->>'loan_cap')::numeric, 1)
           + (cfg->>'pub')::numeric * case when f.recent_pub = 1 then 1 when f.recent_pub = 0.5 then (cfg->>'pub_last')::numeric else 0 end
           + (cfg->>'lib')::numeric * (f.librarian)::int
           + (cfg->>'breadth')::numeric * greatest(least(f.regions / 8.0, 1), least(f.demo_groups / 6.0, 1))
           + (cfg->>'yt')::numeric * (f.yt_spike)::int
           + (cfg->>'gt')::numeric * (f.gt_spike)::int
           - (cfg->>'loan_fall')::numeric * (coalesce(f.g_use, 0) <= (cfg->>'fall_at')::numeric)::int) as raw_score
    from (select *, case when (cfg->>'use_rel')::int = 1 then loan_growth_rel else loan_growth end as g_use from feat) f
  ),
  evid as (
    select s.*,
      ((coalesce(s.rcr, 0) >= 0.2)::int + (s.new_entry)::int + (s.hot_diff > 0)::int
       + (s.rise_steady and (cfg->>'steady_evid')::int = 1)::int
       + (coalesce(s.g_use, 0) >= 0.2)::int + (s.breadth)::int
       + (s.librarian or s.yt_spike or s.gt_spike)::int) as sources,
      (s.rank_up or s.new_entry or s.hot_diff > 0) as rising
    from scored s
  ),
  staged as (
    select e.*,
      greatest(0, round((greatest(e.raw_score, 0) - case when e.near_steady and not e.steady then 15 else 0 end)::numeric, 1)) as momentum_v,
      case
        when e.steady then '스테디'
        when e.rising and e.breadth and e.rank_now is not null and e.rank_now <= greatest(e.list_size, 1) * 0.25 then '확산'
        when e.raw_score >= 45 and e.sources >= 2 then '확산'
        when e.rising and (e.rank_now is null or e.rank_now <= greatest(e.list_size, 1) * 0.5) then '떠오름'
        when e.rising then '포착'
        when e.upcoming then '포착'
        when e.rank_now is not null and coalesce(e.g_use, 0) >= 0.3 then '포착'
        when (e.rank_now is null or e.rank_now > coalesce(e.list_size, 0) / 2.0)
             and (e.librarian or e.recent_pub = 1)
             and (e.yt_spike or e.gt_spike or coalesce(e.g_use, 0) >= 0.3) then '포착'
      end as stage_v
    from evid e
  )
  insert into book_state (snapshot_date, isbn13, kdc, cat, rank_now, rank_prev, rank_mid, list_size, rank_change_ratio, new_entry,
    top10_days, complete_days, hot_diff, loan_growth, loan_growth_rel, regions, demo_groups, rise_steady, recent_pub, librarian, upcoming,
    yt_spike, gt_spike, momentum, sources, confidence, stage, reason)
  select p_date, isbn13, kdc, cat, rank_now, rank_prev, rank_mid, list_size, round(rcr, 4), new_entry,
    top10_days, complete_days, hot_diff, round(loan_growth, 3), round(loan_growth_rel, 3), regions, demo_groups, rise_steady, recent_pub, librarian, upcoming,
    yt_spike, gt_spike, momentum_v, sources,
    case
      when stage_v is null then null
      when stage_v = '스테디' then case when complete_days >= 10 then '높음' else '보통' end
      when sources >= 3 then '높음' when sources = 2 then '보통' else '낮음'
    end,
    stage_v,
    case
      when steady then coalesce(cat, '분야') || ' TOP10에 ' || top10_days || '일째'
      when new_entry then coalesce(cat, '분야') || ' 인기대출 ' || rank_now || '위로 새로 진입'
      when rank_up then coalesce(cat, '분야') || ' ' || rank_prev || '위 → ' || rank_now || '위, 7일간'
      when hot_diff > 0 then '전국 대출 급상승 ▲' || hot_diff
      when coalesce(loan_growth, 0) >= 0.2 then '지난달 대출 ' || round(loan_growth * 100) || '% 증가'
      when regions >= 3 then regions || '개 지역에서 인기대출 순위권'
      when upcoming then coalesce(up_author || ' 작가 신작 · ', '') || to_char(up_date, 'FMMM"월" FMDD"일"') || ' 출간'
      when librarian then '국립중앙도서관 사서 추천'
      when yt_spike then '유튜브 언급 급증'
      when gt_spike then '검색 관심 급증'
      when recent_pub = 1 then extract(year from p_date)::int || '년 신간'
    end
  from staged
  on conflict (snapshot_date, isbn13) do update set
    kdc = excluded.kdc, cat = excluded.cat, rank_now = excluded.rank_now, rank_prev = excluded.rank_prev,
    rank_mid = excluded.rank_mid, list_size = excluded.list_size, rank_change_ratio = excluded.rank_change_ratio,
    new_entry = excluded.new_entry, top10_days = excluded.top10_days, complete_days = excluded.complete_days,
    hot_diff = excluded.hot_diff, loan_growth = excluded.loan_growth, loan_growth_rel = excluded.loan_growth_rel, regions = excluded.regions,
    demo_groups = excluded.demo_groups, rise_steady = excluded.rise_steady, recent_pub = excluded.recent_pub,
    librarian = excluded.librarian, upcoming = excluded.upcoming, yt_spike = excluded.yt_spike,
    gt_spike = excluded.gt_spike, momentum = excluded.momentum, sources = excluded.sources,
    confidence = excluded.confidence, stage = excluded.stage, reason = excluded.reason;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
