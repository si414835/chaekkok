-- 홈 '지역별 인기 책' 지도용 (2026-11-26): 지역마다 자기 최신 날짜(최근 7일 안)의 30위까지
create or replace view public.v_region_map as
with d as (
  select region, max(snapshot_date) as d from region_popular
  where snapshot_date > (now() at time zone 'Asia/Seoul')::date - 7
  group by region
)
select r.region, r.rank, r.isbn13, d.d as snapshot_date, b.title, b.author, b.cover_url, b.addition_symbol
from region_popular r
join d on d.region = r.region and r.snapshot_date = d.d
join books b on b.isbn13 = r.isbn13
where r.rank <= 30;
grant select on public.v_region_map to anon, authenticated;
