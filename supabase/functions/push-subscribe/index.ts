// 책콕: 휴대폰 알림(Web Push) 구독을 저장·갱신·해제한다.
// 로그인이 없어서, 브라우저가 만든 구독 주소(endpoint)를 그 기기의 열쇠로 쓴다.
// 표(push_subscriptions)는 브라우저에서 직접 못 건드리게 막아 두고, 이 함수만 서비스 키로 쓴다.
// 배포: Supabase Edge Function 'push-subscribe' (verify_jwt 끔, 입력값 검증으로 대신함)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const CATEGORIES = ["총류", "철학", "종교", "사회과학", "자연과학", "기술과학", "예술", "언어", "문학", "역사", "어린이"];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function validEndpoint(e: unknown): e is string {
  if (typeof e !== "string" || e.length > 1000) return false;
  try {
    const u = new URL(e);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const sub = (body.subscription ?? {}) as Record<string, unknown>;
  const endpoint = sub.endpoint;
  if (!validEndpoint(endpoint)) return json({ error: "bad endpoint" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  if (body.action === "unsubscribe") {
    const { error } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
    return error ? json({ error: "save failed" }, 500) : json({ ok: true });
  }

  const keys = (sub.keys ?? {}) as Record<string, unknown>;
  const p256dh = keys.p256dh, auth = keys.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100 || !B64URL.test(p256dh) || !B64URL.test(auth)) {
    return json({ error: "bad keys" }, 400);
  }
  const p = (body.prefs ?? {}) as Record<string, unknown>;
  const prefs = { wish: p.wish !== false, keyword: p.keyword !== false, interest: p.interest !== false };
  const wish = Array.isArray(body.wish) ? body.wish.filter((x) => typeof x === "string" && /^\d{13}$/.test(x)).slice(0, 200) : [];
  const interests = Array.isArray(body.interests) ? body.interests.filter((x) => typeof x === "string" && CATEGORIES.includes(x)) : [];

  const { error } = await db.from("push_subscriptions").upsert(
    { endpoint, p256dh, auth, prefs, wish, interests, fail_count: 0, updated_at: new Date().toISOString() },
    { onConflict: "endpoint" },
  );
  return error ? json({ error: "save failed" }, 500) : json({ ok: true });
});
