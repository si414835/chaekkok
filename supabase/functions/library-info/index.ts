// 책콕: 도서관 기능 (정보나루 키는 이 함수 비밀값 DATA4LIBRARY_KEY에만 둔다)
//   action 'nearby'  : 이 책을 가진 도서관을 지역에서 찾고, 가까운 몇 곳은 지금 대출 가능한지 확인
//   action 'library' : 도서관 한 곳의 운영 정보, 시간대·요일별 대출 비율, 최근 인기대출, 신착도서
//   action 'books'   : 책콕에 없는 책의 기본 정보·표지 (정보나루 도서 상세)
// 정보나루가 끊기거나 비어 있으면 '모름'으로 돌려줘서 화면이 잘못된 값을 보여주지 않게 한다.
// 배포: Supabase Edge Function 'library-info' (verify_jwt 끔, 입력값 검증으로 대신함)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const KEY = Deno.env.get("DATA4LIBRARY_KEY") ?? "";
const BASE = "http://data4library.kr/api/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 같은 요청은 잠시 기억해 정보나루 호출을 줄인다 (함수 인스턴스가 살아 있는 동안만)
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  if (v !== null && v !== undefined) cache.set(key, { at: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return v;
}

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

// deno-lint-ignore no-explicit-any
async function api(path: string, params: Record<string, string | number>): Promise<any | null> {
  const q = new URLSearchParams({ authKey: KEY, format: "json", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await spend())) return null; // 오늘 한도에 닿으면 '모름'으로
    try {
      const res = await fetch(`${BASE}${path}?${q}`, { signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      if (data?.response?.error) return null;
      return data;
    } catch (_e) {
      // 정보나루 서버가 가끔 연결을 끊어서 한 번 더
    }
  }
  return null;
}

const REGIONS: [RegExp, string][] = [
  [/^서울/, "11"], [/^부산/, "21"], [/^대구/, "22"], [/^인천/, "23"], [/^광주/, "24"], [/^대전/, "25"], [/^울산/, "26"], [/^세종/, "29"],
  [/^경기/, "31"], [/^강원/, "32"], [/^(충북|충청북)/, "33"], [/^(충남|충청남)/, "34"], [/^(전북|전라북)/, "35"], [/^(전남|전라남)/, "36"],
  [/^(경북|경상북)/, "37"], [/^(경남|경상남)/, "38"], [/^제주/, "39"],
];
const regionOf = (addr: string) => REGIONS.find(([re]) => re.test((addr || "").trim()))?.[1] ?? null;
const cityOf = (addr: string) => (addr || "").trim().split(/\s+/)[1] ?? "";

function km(a: [number, number], b: [number, number]) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 휴관일 문구에서 '매주 ○요일'만 읽어 오늘 휴관인지 판단 (그 외 공휴일·격주 등은 원문만 보여준다)
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
function closedToday(closed: string): boolean | null {
  if (!closed) return null;
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = DAYS[kst.getUTCDay()];
  const weekly = [...closed.matchAll(/매주\s*([월화수목금토일](?:\s*[,·ㆍ/]\s*[월화수목금토일])*)\s*요일/g)].flatMap((m) => m[1].split(/[\s,·ㆍ/]+/));
  if (!weekly.length) return null;
  return weekly.includes(today) ? true : null; // 안 걸리면 '휴관 아님'이 아니라 '모름' (공휴일 등)
}

function libOut(l: Record<string, string>) {
  const lat = Number(l.latitude), lng = Number(l.longitude);
  return {
    libCode: String(l.libCode ?? ""),
    name: l.libName ?? "",
    address: l.address ?? "",
    tel: l.tel ?? "",
    homepage: l.homepage ?? "",
    lat: Number.isFinite(lat) && lat ? lat : null,
    lng: Number.isFinite(lng) && lng ? lng : null,
    operatingTime: l.operatingTime ?? "",
    closed: l.closed ?? "",
    closedToday: closedToday(l.closed ?? ""),
  };
}

async function exist(libCode: string, isbn: string) {
  return cached(`ex:${libCode}:${isbn}`, 30 * 60 * 1000, async () => {
    const d = await api("bookExist", { libCode, isbn13: isbn });
    const r = d?.response?.result;
    if (!r || r.hasBook === undefined) return { hasBook: null, loanAvailable: null };
    return { hasBook: r.hasBook === "Y", loanAvailable: r.loanAvailable === undefined ? null : r.loanAvailable === "Y" };
  });
}

let libsTable: { lib_code: string; address: string; latitude: number; longitude: number }[] | null = null;
async function nearestRegion(lat: number, lng: number) {
  if (!libsTable) {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data } = await db.from("libraries").select("lib_code,address,latitude,longitude").limit(5000);
    libsTable = (data || []).filter((r) => r.latitude && r.longitude);
  }
  let best: { d: number; addr: string } | null = null;
  for (const r of libsTable) {
    const d = km([lat, lng], [Number(r.latitude), Number(r.longitude)]);
    if (!best || d < best.d) best = { d, addr: r.address };
  }
  return best ? regionOf(best.addr) : null;
}

async function nearby(body: Record<string, unknown>) {
  const isbn = String(body.isbn ?? "");
  if (!/^\d{13}$/.test(isbn)) return json({ error: "bad isbn" }, 400);
  const lat = Number(body.lat), lng = Number(body.lng);
  const hasPos = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && lat !== 0;
  let region = typeof body.region === "string" && /^\d{2}$/.test(body.region) ? body.region : null;
  if (hasPos && !body.region) region = await nearestRegion(lat, lng);
  if (!region) return json({ error: "need region" }, 400);
  const prefer = Array.isArray(body.prefer) ? body.prefer.filter((x) => typeof x === "string").slice(0, 3) as string[] : [];
  const preferCities = Array.isArray(body.preferCities) ? (body.preferCities as unknown[]).filter((x) => typeof x === "string").slice(0, 3) as string[] : [];

  const all = await cached(`by:${isbn}:${region}`, 60 * 60 * 1000, async () => {
    const out: ReturnType<typeof libOut>[] = [];
    let total = 0;
    for (let page = 1; page <= 3; page++) {
      const d = await api("libSrchByBook", { isbn, region, pageNo: page, pageSize: 100 });
      if (!d) return page === 1 ? null : { libs: out, total };
      total = Number(d.response?.numFound ?? 0);
      // deno-lint-ignore no-explicit-any
      const libs = (d.response?.libs ?? []).map((x: any) => libOut(x.lib));
      out.push(...libs);
      if (out.length >= total || libs.length < 100) break;
    }
    return { libs: out, total };
  });
  if (!all) return json({ error: "정보나루 응답 없음", libs: [], total: 0, region }, 200);

  let libs = all.libs.map((l) => ({ ...l, distanceKm: hasPos && l.lat && l.lng ? Math.round(km([lat, lng], [l.lat, l.lng]) * 10) / 10 : null }));
  if (hasPos) libs.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
  else {
    const score = (l: typeof libs[number]) => (prefer.includes(l.libCode) ? 0 : preferCities.includes(cityOf(l.address)) ? 1 : 2);
    libs.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, "ko"));
  }
  const top = libs.slice(0, 8);
  const status = await Promise.all(top.map((l) => exist(l.libCode, isbn)));
  libs = libs.slice(0, 30).map((l, i) => (i < top.length ? { ...l, ...status[i] } : { ...l, hasBook: true, loanAvailable: null }));
  const kst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return json({ region, total: all.total, sortedBy: hasPos ? "distance" : preferCities.length || prefer.length ? "city" : "name", checked: top.length, libs, checkedAt: kst });
}

async function library(body: Record<string, unknown>) {
  const libCode = String(body.libCode ?? "");
  if (!/^\d{5,7}$/.test(libCode)) return json({ error: "bad libCode" }, 400);
  const out = await cached(`lib:${libCode}`, 6 * 60 * 60 * 1000, async () => {
    const ext = await api("extends/libSrch", { libCode });
    const lib = ext?.response?.libs?.[0]?.lib;
    if (!lib?.libInfo) return null;
    // deno-lint-ignore no-explicit-any
    const hours = (lib.loanByhours ?? []).map((x: any) => ({ hour: Number(x.result?.hour), loan: Number(x.result?.loan) || 0 })).filter((h: { hour: number }) => Number.isFinite(h.hour));
    // deno-lint-ignore no-explicit-any
    const days = (lib.loanByDayofWeek ?? []).map((x: any) => ({ day: String(x.result?.dayOfWeek ?? ""), loan: Number(x.result?.loan) || 0 }));
    // 신착도서: 책(ISBN 978/979)만, 영상·음반 등은 뺀다
    // deno-lint-ignore no-explicit-any
    const newBooks = (lib.newBooks ?? []).map((x: any) => x.book).filter((b: any) => b && /^97[89]\d{10}$/.test(String(b.isbn13 ?? "")) && !/^\s*\[/.test(b.bookname ?? ""))
      // deno-lint-ignore no-explicit-any
      .map((b: any) => ({ isbn13: b.isbn13, title: b.bookname, author: b.authors, cover: b.bookImageURL || null, regDate: b.reg_date || null, kids: String(b.addition_symbol || "").startsWith("7"), url: b.bookDtlUrl || null }));

    // 최근 인기대출: 30일 → 비어 있으면 90일 → 1년 (어느 기간인지 함께 돌려준다)
    const end = new Date(Date.now() + 9 * 3600 * 1000 - 86400000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    let popular: unknown[] = [];
    let periodDays = 0;
    for (const span of [30, 90, 365]) {
      const start = new Date(end.getTime() - span * 86400000);
      const d = await api("loanItemSrchByLib", { libCode, startDt: ymd(start), endDt: ymd(end), pageSize: 30 });
      // deno-lint-ignore no-explicit-any
      const docs = (d?.response?.docs ?? []).map((x: any) => x.doc).filter(Boolean);
      if (docs.length >= 5) {
        // deno-lint-ignore no-explicit-any
        popular = docs.map((b: any) => ({ rank: Number(b.ranking), isbn13: b.isbn13, title: b.bookname, author: b.authors, cover: b.bookImageURL || null, kids: String(b.addition_symbol || "").startsWith("7"), url: b.bookDtlUrl || null }));
        periodDays = span;
        break;
      }
    }
    const sumH = hours.reduce((s: number, h: { loan: number }) => s + h.loan, 0);
    return {
      info: libOut({ ...lib.libInfo }),
      bookCount: /^\d+$/.test(String(lib.libInfo.BookCount ?? "")) ? Number(lib.libInfo.BookCount) : null,
      hours: sumH > 0 ? hours : [],
      days: days.reduce((s: number, d: { loan: number }) => s + d.loan, 0) > 0 ? days : [],
      newBooks,
      popular,
      periodDays,
      fresh: periodDays === 30 && sumH > 0,
      checkedAt: ymd(new Date(Date.now() + 9 * 3600 * 1000)),
    };
  });
  if (!out) return json({ error: "정보나루 응답 없음" }, 200);
  return json(out);
}

// 책콕에 아직 없는 책(같이 빌린 책 등)의 기본 정보와 표지: 정보나루 도서 상세
async function books(body: Record<string, unknown>) {
  const isbns = Array.isArray(body.isbns) ? (body.isbns as unknown[]).map(String).filter((x) => /^\d{13}$/.test(x)).slice(0, 12) : [];
  if (!isbns.length) return json({ error: "bad isbns" }, 400);
  const out = await Promise.all(isbns.map((isbn) => cached(`bk:${isbn}`, 24 * 60 * 60 * 1000, async () => {
    const d = await api("srchDtlList", { isbn13: isbn, loaninfoYN: "N" });
    if (!d) return null; // 정보나루가 끊긴 경우는 기억하지 않고 다음에 다시 묻는다
    // 응답 모양이 바뀌어도 찾을 수 있게, 'bookname'을 가진 첫 객체를 찾는다
    // deno-lint-ignore no-explicit-any
    const find = (o: any): any => {
      if (!o || typeof o !== "object") return null;
      if (!Array.isArray(o) && "bookname" in o) return o;
      for (const v of Object.values(o)) {
        const r = find(v);
        if (r) return r;
      }
      return null;
    };
    const b = d?.response?.detail?.[0]?.book ?? find(d?.response);
    if (!b) return { isbn13: isbn, found: false };
    const https = (u: string) => (u && u.startsWith("http://") ? "https://" + u.slice(7) : u || null);
    return {
      isbn13: isbn,
      found: true,
      title: b.bookname ?? "",
      author: b.authors ?? "",
      publisher: b.publisher ?? "",
      pubYear: b.publication_year ?? "",
      className: b.class_nm ?? "",
      classNo: b.class_no ?? "",
      additionSymbol: b.addition_symbol ?? "",
      cover: https(b.bookImageURL ?? ""),
      description: b.description ?? "",
    };
  })));
  return json({ books: out.map((b, i) => b ?? { isbn13: isbns[i], found: false }) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!KEY) return json({ error: "server key missing" }, 500);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (body.action === "nearby") return nearby(body);
  if (body.action === "library") return library(body);
  if (body.action === "books") return books(body);
  return json({ error: "unknown action" }, 400);
});
