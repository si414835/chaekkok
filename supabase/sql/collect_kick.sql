-- 수집 시작을 GitHub 예약 실행에만 맡기지 않기 (2026-11-24)
-- GitHub 예약 실행은 몇 시간씩 늦거나 빠진다(11/24는 정오까지 안 돎). 수집은 10:30 KST 전에 끝나야 한다.
-- pg_cron은 제시간에 돌기 때문에, 여기서 GitHub API로 collect.yml을 직접 시작시킨다(inputs.auto=true).
-- 워크플로의 '오늘 수집했는지 확인' 단계가 이미 돈 날은 건너뛰므로 여러 번 불러도 한 번만 수집한다.
-- GitHub 토큰은 Vault의 'gh_dispatch_token'에서 읽는다. 없으면 아무것도 안 한다.
--   토큰 넣기(승환님이 Supabase SQL 편집기에서 직접): select vault.create_secret('<토큰>', 'gh_dispatch_token');
--   토큰 권한: fine-grained, 저장소 si414835/chaekkok 하나, Actions: Read and write
create extension if not exists pg_net;

create or replace function public.kick_collect()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  tok text;
  req bigint;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'gh_dispatch_token' limit 1;
  if tok is null then
    return 'no token';
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/si414835/chaekkok/actions/workflows/collect.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'chaekkok-pg-cron',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('auto', 'true'))
  ) into req;
  return 'sent ' || req;
end;
$$;
revoke all on function public.kick_collect() from public, anon, authenticated;

-- 04:12 KST에 시작, 07:02 KST에 한 번 더(앞에서 이미 돌았으면 워크플로가 건너뜀)
select cron.schedule('kick-collect-0412', '12 19 * * *', 'select public.kick_collect()');
select cron.schedule('kick-collect-0702', '2 22 * * *', 'select public.kick_collect()');
