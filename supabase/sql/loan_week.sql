-- 최근 7일 대출 순위 (분야별 100위). 30일 순위보다 새 책이 1~3주 빨리 보이게 하려고 따로 모은다 (2026-11-23)
-- trend_scores와 섞지 않는다: 단계 판정·피드가 30일 순위(popular)를 기준으로 짜여 있어서.
-- 채우는 곳: collect.py collect_loan_week() (하루 정보나루 7회). 쓰는 곳: extra_collect.py pick_usage_targets()
create table if not exists public.loan_week (
  isbn13 text not null references public.books(isbn13),
  snapshot_date date not null,
  kdc text not null,
  rank integer,
  loan_count integer,
  primary key (snapshot_date, kdc, isbn13)
);
create index if not exists loan_week_isbn on public.loan_week (isbn13);
alter table public.loan_week enable row level security;
create policy loan_week_read on public.loan_week for select to anon, authenticated using (true);
