-- 2026-11-20 '누가 빌렸나' 분야 비교용
-- 같은 대분류(class_name 첫 칸) 책들의 연령·성별 대출 비율 평균 (책마다 비율을 먼저 내고 평균 → 대형 베스트셀러 한 권이 좌우하지 않게)
-- p_child: 어린이 책(부가기호 7)끼리 / 어른 책끼리 비교
create or replace function public.field_demo(p_cat text, p_child boolean default false)
returns table (age text, gender text, share numeric, books int)
language sql stable security definer set search_path = public as $$
with src as (
  select u.isbn13, g->>'age' as age, g->>'gender' as gender, greatest((g->>'loanCnt')::numeric, 0) as n
  from book_usage u
  join books b on b.isbn13 = u.isbn13
  cross join lateral jsonb_array_elements(coalesce(u.loan_grps, '[]')) g
  where split_part(b.class_name, ' > ', 1) = p_cat
    and (coalesce(b.addition_symbol, '') like '7%') = coalesce(p_child, false)
    and coalesce(g->>'age', '') <> ''
),
tot as (select isbn13, sum(n) as t from src group by 1 having sum(n) >= 30 and count(*) >= 8) -- 정보나루는 그 책이 순위에 든 그룹만 주므로 그룹이 8개 이상인 책만,
per as (select s.age, s.gender, s.n / t.t as sh, s.isbn13 from src s join tot t using (isbn13)),
nb as (select count(*)::int as k from tot)
select p.age, p.gender, round(sum(p.sh) / (select k from nb) * 100, 1) as share, (select k from nb) as books
from per p
group by p.age, p.gender
order by share desc;
$$;
grant execute on function public.field_demo(text, boolean) to anon, authenticated;
