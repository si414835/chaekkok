// 책콕: 사이트 지도(sitemap.xml)를 매번 최신 데이터로 만든다.
// 홈·트렌드 탭 + 요즘 단계가 붙은 책 + 이달의 키워드 페이지
const SITE = 'https://chaekkok.vercel.app'
const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY

async function sb(path) {
  if (!SB_URL || !SB_KEY) return []
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      signal: AbortSignal.timeout(5000),
    })
    return res.ok ? res.json() : []
  } catch (_e) {
    return []
  }
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export default async function handler(req, res) {
  const [states, popular, keywords] = await Promise.all([
    sb('v_book_state_latest?select=isbn13,snapshot_date&limit=3000'),
    sb('v_feed?select=isbn13,snapshot_date&limit=3000'),
    sb('v_home_keywords?select=word&order=rank&limit=30'),
  ])
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const books = new Map()
  for (const r of [...(states || []), ...(popular || [])]) {
    if (!r?.isbn13 || !/^\d{10,13}$/.test(r.isbn13)) continue
    const d = r.snapshot_date || today
    if (!books.has(r.isbn13) || books.get(r.isbn13) < d) books.set(r.isbn13, d)
  }
  const urls = [
    { loc: `${SITE}/`, lastmod: today, freq: 'daily', pri: '1.0' },
    ...['composite', 'popular', 'rising', 'recommended'].map((t) => ({ loc: `${SITE}/trend/${t}`, lastmod: today, freq: 'daily', pri: '0.8' })),
    { loc: `${SITE}/hits`, lastmod: today, freq: 'weekly', pri: '0.5' },
    ...(keywords || []).map((k) => ({ loc: `${SITE}/keyword/${encodeURIComponent(k.word)}`, lastmod: today, freq: 'weekly', pri: '0.6' })),
    ...[...books.entries()].map(([isbn, d]) => ({ loc: `${SITE}/book/${isbn}`, lastmod: d, freq: 'weekly', pri: '0.7' })),
  ]
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${xml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n') +
    '\n</urlset>\n'
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400')
  res.statusCode = 200
  res.end(body)
}
