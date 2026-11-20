-- 2026-11-20 책결 비교 후 추가
-- ① 이용분석 응답에 이미 들어 있는 마니아·다독자 추천을 저장 (추가 API 호출 없음)
-- ② 흔한 책 보정: 여러 책의 이웃 목록에 자주 끼는 책은 점수를 낮춘다 (log(전체/(1+등장 수)))
-- ③ 표지 고르기 취향 추천 + 익명 좋아요 집계

alter table public.book_usage add column if not exists mania_rec jsonb;
alter table public.book_usage add column if not exists reader_rec jsonb;

-- 이웃 목록 등장 횟수 (흔한 책 보정용). 매번 전체를 세지 않게 머티리얼라이즈드 뷰로 두고 수집 뒤 새로 고친다
create materialized view if not exists public.mv_neighbor_freq as
select x->>'isbn13' as isbn13, count(*)::int as n
from public.book_usage u,
     jsonb_array_elements(coalesce(u.co_loan, '[]') || coalesce(u.mania_rec, '[]') || coalesce(u.reader_rec, '[]')) x
where x->>'isbn13' is not null
group by 1;
create unique index if not exists mv_neighbor_freq_isbn on public.mv_neighbor_freq (isbn13);

create or replace function public.refresh_neighbor_freq() returns void
language sql security definer set search_path = public as $$
  refresh materialized view concurrently public.mv_neighbor_freq;
$$;

-- 책 한 권의 함께 빌린 · 마니아 · 다독자 목록 (흔한 책 보정 순)
create or replace function public.book_recs(p_isbn text) returns jsonb
language sql stable security definer set search_path = public as $$
with u as (select * from book_usage where isbn13 = p_isbn),
total as (select greatest(count(*), 1)::numeric as t from book_usage),
lists as (
  select 'co' as kind, e.x, e.ord from u, jsonb_array_elements(coalesce(u.co_loan, '[]')) with ordinality as e(x, ord)
  union all
  select 'mania', e.x, e.ord from u, jsonb_array_elements(coalesce(u.mania_rec, '[]')) with ordinality as e(x, ord)
  union all
  select 'reader', e.x, e.ord from u, jsonb_array_elements(coalesce(u.reader_rec, '[]')) with ordinality as e(x, ord)
),
scored as (
  select l.kind,
         l.x || jsonb_build_object('cover_url', b.cover_url, 'common', coalesce(f.n, 0), 'ord', l.ord) as item,
         (11 - least(l.ord, 10)) * greatest(ln((select t from total) / (1 + coalesce(f.n, 0))), 0.1) as score
  from lists l
  left join mv_neighbor_freq f on f.isbn13 = l.x->>'isbn13'
  left join books b on b.isbn13 = l.x->>'isbn13'
  where coalesce(l.x->>'isbn13', '') <> p_isbn
)
select coalesce(jsonb_object_agg(kind, items), '{}'::jsonb)
from (select kind, jsonb_agg(item order by score desc) as items from scored group by kind) z;
$$;

-- 익명 좋아요 (기기 번호 단위, 책마다 마지막 선택 하나)
create table if not exists public.taste_votes (
  device text not null,
  isbn13 text not null,
  vote smallint not null check (vote in (-1, 0, 1)),
  source text not null default 'taste',
  updated_at timestamptz not null default now(),
  primary key (device, isbn13)
);
alter table public.taste_votes enable row level security;
create index if not exists taste_votes_recent on public.taste_votes (updated_at desc);

create or replace function public.taste_vote(p_device text, p_isbn text, p_vote int, p_source text default 'taste') returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_device is null or length(p_device) not between 8 and 64 or p_vote not in (-1, 0, 1) then
    return false;
  end if;
  if not exists (select 1 from books where isbn13 = p_isbn) then
    return false;
  end if;
  -- 한 기기에서 하루 300번까지
  if (select count(*) from taste_votes where device = p_device and updated_at > now() - interval '1 day') >= 300 then
    return false;
  end if;
  insert into taste_votes (device, isbn13, vote, source, updated_at)
  values (p_device, p_isbn, p_vote, coalesce(nullif(p_source, ''), 'taste'), now())
  on conflict (device, isbn13) do update set vote = excluded.vote, source = excluded.source, updated_at = now();
  return true;
end;
$$;

-- 책콕 사람들이 좋다고 고른 책 (최근 p_days일, 좋아요 많은 순)
create or replace function public.taste_top(p_days int default 30, p_limit int default 12) returns table (
  isbn13 text, likes int, dislikes int, title text, author text, cover_url text, class_name text, stage text
)
language sql stable security definer set search_path = public as $$
  select v.isbn13,
         count(*) filter (where v.vote = 1)::int as likes,
         count(*) filter (where v.vote = -1)::int as dislikes,
         b.title, b.author, b.cover_url, b.class_name, s.stage
  from taste_votes v
  join books b on b.isbn13 = v.isbn13
  left join v_book_state_latest s on s.isbn13 = v.isbn13
  where v.updated_at > now() - make_interval(days => greatest(p_days, 1))
    and coalesce(b.addition_symbol, '') not like '7%'
  group by v.isbn13, b.title, b.author, b.cover_url, b.class_name, s.stage
  having count(*) filter (where v.vote = 1) > 0
  order by likes desc, dislikes asc, max(v.updated_at) desc
  limit least(greatest(p_limit, 1), 50);
$$;

-- 표지 고르기 결과: 좋아한 책의 이웃(함께 빌린 3 · 마니아 2 · 다독자 1)을 더하고, 별로인 책의 이웃은 빼고, 흔한 책은 낮춘다
create or replace function public.taste_recs(p_like text[], p_dislike text[] default '{}', p_seen text[] default '{}', p_limit int default 30)
returns table (
  isbn13 text, score numeric, via text, title text, author text, cover_url text, class_name text,
  stage text, rank_now int, momentum numeric
)
language sql stable security definer set search_path = public as $$
with total as (select greatest(count(*), 1)::numeric as t from book_usage),
nb as (
  select u.isbn13 as src, e.x->>'isbn13' as isbn13, w.weight, 11 - least(e.ord, 10) as pos
  from book_usage u
  cross join lateral (values ('co', 3), ('mania', 2), ('reader', 1)) as w(kind, weight)
  cross join lateral jsonb_array_elements(
    case w.kind when 'co' then coalesce(u.co_loan, '[]') when 'mania' then coalesce(u.mania_rec, '[]') else coalesce(u.reader_rec, '[]') end
  ) with ordinality as e(x, ord)
  where u.isbn13 = any (coalesce(p_like, '{}') || coalesce(p_dislike, '{}'))
),
agg as (
  select nb.isbn13,
         sum(case when nb.src = any (p_like) then nb.weight * nb.pos else -nb.weight * nb.pos end)::numeric as raw,
         (array_agg(nb.src order by nb.weight * nb.pos desc) filter (where nb.src = any (p_like)))[1] as via
  from nb
  where nb.isbn13 is not null
    and not (nb.isbn13 = any (coalesce(p_like, '{}') || coalesce(p_dislike, '{}') || coalesce(p_seen, '{}')))
  group by nb.isbn13
)
select a.isbn13,
       round(a.raw * greatest(ln((select t from total) / (1 + coalesce(f.n, 0))), 0.1), 2) as score,
       a.via, b.title, b.author, b.cover_url, b.class_name, s.stage, s.rank_now::int, s.momentum::numeric
from agg a
join books b on b.isbn13 = a.isbn13
left join mv_neighbor_freq f on f.isbn13 = a.isbn13
left join v_book_state_latest s on s.isbn13 = a.isbn13
where a.raw > 0 and coalesce(b.addition_symbol, '') not like '7%'
order by score desc
limit least(greatest(p_limit, 1), 60);
$$;

grant execute on function public.book_recs(text) to anon, authenticated;
grant execute on function public.taste_vote(text, text, int, text) to anon, authenticated;
grant execute on function public.taste_top(int, int) to anon, authenticated;
grant execute on function public.taste_recs(text[], text[], text[], int) to anon, authenticated;
revoke execute on function public.refresh_neighbor_freq() from public, anon, authenticated;
