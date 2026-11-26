-- 오후 보충 수집 시작 (2026-11-26)
-- 11/26 새벽 수집에서 정보나루가 느려 이용분석 82권·책 소개 50권을 못 받았다(시간 초과).
-- 그날 남은 정보나루 몫으로 오후에 이어 받도록 catchup.yml을 13:02 KST에 시작시킨다.
-- 토큰은 kick_collect와 같은 Vault 'gh_dispatch_token'.
create or replace function public.kick_catchup()
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
    url := 'https://api.github.com/repos/si414835/chaekkok/actions/workflows/catchup.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'chaekkok-pg-cron',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main')
  ) into req;
  return 'sent ' || req;
end;
$$;
revoke all on function public.kick_catchup() from public, anon, authenticated;

select cron.schedule('kick-catchup', '2 4 * * *', 'select public.kick_catchup()');
