-- 책콕: 정보나루 하루 호출 수 나누어 쓰기 (2026-11-23)
-- 정보나루는 IP 미등록 키를 하루 500건에서 막는다. 수집(Actions)과 화면(Edge Function)이 같은 키를 쓰므로
--   · 수집: batch(= calls - edge_calls)가 400을 넘거나 전체가 495를 넘으면 멈춘다 (add_batch_calls)
--   · 화면: edge_calls가 90을 넘거나 전체가 495를 넘으면 정보나루를 부르지 않는다 (spend_edge_call)
-- 한도에 막힌 요청은 세지 않는다 (예전 add_api_calls는 거절된 요청도 더해서 숫자가 부풀었다).
alter table public.api_usage add column if not exists edge_calls integer not null default 0;

create or replace function public.spend_edge_call(p_total_cap integer default 495, p_edge_cap integer default 90)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d date := (now() at time zone 'Asia/Seoul')::date;
  ok boolean;
begin
  insert into api_usage (day, calls, edge_calls) values (d, 0, 0) on conflict (day) do nothing;
  update api_usage set calls = calls + 1, edge_calls = edge_calls + 1, updated_at = now()
   where day = d and calls < p_total_cap and edge_calls < p_edge_cap
  returning true into ok;
  return coalesce(ok, false);
end;
$$;

create or replace function public.add_batch_calls(n integer default 1)
returns json
language sql
security definer
set search_path to 'public'
as $$
  insert into api_usage (day, calls) values ((now() at time zone 'Asia/Seoul')::date, n)
  on conflict (day) do update set calls = api_usage.calls + excluded.calls, updated_at = now()
  returning json_build_object('total', calls, 'batch', calls - edge_calls);
$$;

revoke all on function public.spend_edge_call(integer, integer) from public, anon, authenticated;
revoke all on function public.add_batch_calls(integer) from public, anon, authenticated;
