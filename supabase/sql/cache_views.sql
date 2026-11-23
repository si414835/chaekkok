-- 책콕: 화면이 매번 다시 계산하던 무거운 뷰를 미리 계산해 두기 (2026-11-23)
-- 재 본 값(pg_stat_statements): v_feed 한 번에 평균 0.2~0.95초, v_hit_stats 0.5초, v_home_keywords 0.23초.
-- 홈을 열 때마다 이 뷰들을 6번 계산해서 첫 화면이 느렸다. 데이터는 하루 한 번 바뀌므로 미리 계산해 둔다.
--   · cache 스키마의 materialized view에 결과를 저장하고, 화면이 쓰는 이름(v_feed 등)은 그것을 읽는 뷰로 바꾼다.
--   · 원래 계산식은 v_feed_live / v_hit_stats_live / v_home_keywords_live 로 남겨 둔다 (수집 스크립트는 _live를 읽는다).
--   · 새로 고침: 수집 워크플로 끝(복합 점수 계산 뒤)에 refresh_cached_views(), 그리고 pg_cron이 매시 17분에 한 번 더.
create schema if not exists cache;
grant usage on schema cache to anon, authenticated, service_role;

alter view public.v_feed rename to v_feed_live;
alter view public.v_hit_stats rename to v_hit_stats_live;
alter view public.v_home_keywords rename to v_home_keywords_live;

create materialized view cache.feed as select * from public.v_feed_live;
create unique index feed_key on cache.feed (trend_type, snapshot_date, isbn13);
create materialized view cache.hit_stats as select * from public.v_hit_stats_live;
create materialized view cache.home_keywords as select * from public.v_home_keywords_live;
create unique index home_keywords_key on cache.home_keywords (word);
grant select on cache.feed, cache.hit_stats, cache.home_keywords to anon, authenticated, service_role;

create view public.v_feed with (security_invoker = true) as select * from cache.feed;
create view public.v_hit_stats with (security_invoker = true) as select * from cache.hit_stats;
create view public.v_home_keywords with (security_invoker = true) as select * from cache.home_keywords;
grant select on public.v_feed, public.v_hit_stats, public.v_home_keywords to anon, authenticated, service_role;

create or replace function public.refresh_cached_views()
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  refresh materialized view concurrently cache.feed;
  refresh materialized view cache.hit_stats;
  refresh materialized view concurrently cache.home_keywords;
  return now();
end;
$$;
revoke all on function public.refresh_cached_views() from public, anon, authenticated;
grant execute on function public.refresh_cached_views() to service_role;

create extension if not exists pg_cron;
select cron.schedule('refresh-cached-views', '17 * * * *', 'select public.refresh_cached_views()');
