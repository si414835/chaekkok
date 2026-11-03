// 책콕: 내 도서관에 이 책이 있는지, 지금 빌릴 수 있는지 정보나루 bookExist로 확인한다.
// 정보나루 인증키는 브라우저에 노출하지 않도록 이 함수의 비밀값(DATA4LIBRARY_KEY)에만 둔다.
// 배포: Supabase Edge Function 'book-exist' (verify_jwt 끔, 입력값 검증으로 대신함)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const KEY = Deno.env.get("DATA4LIBRARY_KEY") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 정보나루 하루 호출 수를 수집 스크립트와 같이 센다 (IP 미등록 키는 하루 500건 넘으면 막힘)
const DAILY_LIMIT = 495;
async function spend(): Promise<boolean> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/add_api_calls`, {
      method: "POST",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ n: 1 }),
      signal: AbortSignal.timeout(4000),
    });
    const total = await res.json();
    return typeof total !== "number" || total <= DAILY_LIMIT;
  } catch (_e) {
    return true; // 세는 데 실패해도 화면 기능은 막지 않는다
  }
}

// 같은 도서관·같은 책은 30분 동안 기억해 호출을 아낀다
const cache = new Map<string, { at: number; v: unknown }>();

function pick(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const found = pick(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function check(libCode: string, isbn13: string) {
  const ck = `${libCode}:${isbn13}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.v;
  const url = `http://data4library.kr/api/bookExist?authKey=${encodeURIComponent(KEY)}&libCode=${libCode}&isbn13=${isbn13}&format=json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await spend())) return { libCode, error: true, limit: true };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      const has = pick(data, "hasBook");
      const loan = pick(data, "loanAvailable");
      if (has === undefined) throw new Error("no result");
      // 대출 가능 여부 항목이 없으면 '모름(null)'으로 돌려줘서 화면이 '대출 중'으로 잘못 표시하지 않게 한다
      const v = { libCode, hasBook: has === "Y", loanAvailable: loan === undefined ? null : loan === "Y" };
      cache.set(ck, { at: Date.now(), v });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return v;
    } catch (_e) {
      // 정보나루 서버가 가끔 연결을 끊어서 한 번 더 시도
    }
  }
  return { libCode, error: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!KEY) return json({ error: "DATA4LIBRARY_KEY 비밀값이 설정되지 않았어요" }, 500);
  let body: { isbn13?: string; libCodes?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "잘못된 요청" }, 400);
  }
  const isbn13 = String(body.isbn13 ?? "").split(/\s+/)[0];
  const libCodes = Array.isArray(body.libCodes) ? body.libCodes.map(String) : [];
  if (!/^\d{10,13}$/.test(isbn13)) return json({ error: "ISBN 형식 오류" }, 400);
  if (libCodes.length === 0 || libCodes.length > 5 || !libCodes.every((c) => /^\d{3,10}$/.test(c))) {
    return json({ error: "도서관은 1~5곳까지 조회할 수 있어요" }, 400);
  }
  const results = await Promise.all(libCodes.map((c) => check(c, isbn13)));
  return json({ results });
});
