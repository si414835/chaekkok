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
  const url = `http://data4library.kr/api/bookExist?authKey=${encodeURIComponent(KEY)}&libCode=${libCode}&isbn13=${isbn13}&format=json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      const has = pick(data, "hasBook");
      const loan = pick(data, "loanAvailable");
      if (has === undefined) throw new Error("no result");
      // 대출 가능 여부 항목이 없으면 '모름(null)'으로 돌려줘서 화면이 '대출 중'으로 잘못 표시하지 않게 한다
      return { libCode, hasBook: has === "Y", loanAvailable: loan === undefined ? null : loan === "Y" };
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
