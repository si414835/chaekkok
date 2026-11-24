-- 책 상세의 '이 책을 이야기한 영상' (2026-11-24)
-- 채우는 곳: youtube_collect.py — 원래 하던 유튜브 검색(언급량) 결과에서 그 책을 다룬 영상만 골라 저장한다 (추가 검색 없음).
-- 유튜브 개발자 정책 III.E.4.c: API로 받은 정보는 30일 안에 새로 받거나 지운다 → 매일 30일 지난 행을 지운다.
-- 화면은 썸네일 주소만 쓰고 파일은 내려받지 않는다. 누르면 유튜브 플레이어(youtube-nocookie)로 재생.
create table if not exists public.book_videos (
  isbn13 text not null references public.books(isbn13) on delete cascade,
  video_id text not null,
  rank smallint not null,
  title text,
  channel text,
  thumb text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (isbn13, video_id)
);
create index if not exists book_videos_fetched on public.book_videos (fetched_at);
alter table public.book_videos enable row level security;
create policy book_videos_read on public.book_videos for select to anon, authenticated using (true);

select cron.schedule('purge-book-videos', '33 18 * * *', $$delete from public.book_videos where fetched_at < now() - interval '30 days'$$);
