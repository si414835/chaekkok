-- 지역별 뜨는 책 화면용 (2026-11-26 갱신)
-- 지역 순위를 200위까지 받기 시작했지만, 예전 날짜(100위까지)와 비교가 맞도록 화면은 100위까지만 본다.
create or replace view public.v_region_books as
 WITH latest AS (SELECT max(region_popular.snapshot_date) AS d FROM region_popular),
 prev AS (
   SELECT COALESCE((SELECT max(region_popular.snapshot_date) FROM region_popular WHERE region_popular.snapshot_date <= ((SELECT latest.d FROM latest) - 7)),
                   (SELECT min(region_popular.snapshot_date) FROM region_popular WHERE region_popular.snapshot_date < (SELECT latest.d FROM latest))) AS d),
 cur AS (SELECT r.region, r.isbn13, r.rank FROM region_popular r WHERE r.snapshot_date = (SELECT latest.d FROM latest) AND r.rank <= 100),
 old AS (SELECT r.region, r.isbn13, r.rank FROM region_popular r WHERE r.snapshot_date = (SELECT prev.d FROM prev) AND r.rank <= 100),
 spread AS (SELECT cur.isbn13, count(DISTINCT cur.region) AS n FROM cur GROUP BY cur.isbn13)
 SELECT c.region, c.isbn13, c.rank, o.rank AS prev_rank, (o.rank - c.rank) AS rank_diff,
    ((o.rank IS NULL) AND ((SELECT prev.d FROM prev) IS NOT NULL)) AS new_entry,
    sp.n AS region_count,
    (SELECT count(DISTINCT cur.region) FROM cur) AS region_total,
    (SELECT latest.d FROM latest) AS snapshot_date,
    (SELECT prev.d FROM prev) AS prev_date,
    b.title, b.author, b.cover_url, b.class_name, b.addition_symbol, s.stage
   FROM cur c
     JOIN books b ON b.isbn13 = c.isbn13
     LEFT JOIN old o ON o.region = c.region AND o.isbn13 = c.isbn13
     LEFT JOIN spread sp ON sp.isbn13 = c.isbn13
     LEFT JOIN v_book_state_latest s ON s.isbn13 = c.isbn13;
