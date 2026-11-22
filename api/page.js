// 책콕: 책·키워드 페이지를 검색 로봇과 링크 미리보기가 바로 읽을 수 있게,
// 화면(index.html)의 제목·설명·공유 이미지를 그 책(또는 키워드)에 맞게 바꿔서 돌려준다.
// 화면 자체는 그대로 React가 그린다. 데이터는 공개 읽기용 키로 Supabase에서 읽는다.
//   /book/:isbn      -> /api/page?type=book&id=:isbn      (vercel.json)
//   /keyword/:word   -> /api/page?type=keyword&id=:word

const SITE = 'https://chaekkok.vercel.app'
const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY

let shellCache = null
let shellAt = 0

async function shell(host) {
  // 배포마다 index.html 안의 파일 이름이 바뀌므로 짧게만 기억한다
  if (shellCache && Date.now() - shellAt < 5 * 60 * 1000) return shellCache
  const res = await fetch(`https://${host}/index.html`)
  if (!res.ok) throw new Error('index.html ' + res.status)
  shellCache = await res.text()
  shellAt = Date.now()
  return shellCache
}

async function sb(path) {
  if (!SB_URL || !SB_KEY) return null
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    signal: AbortSignal.timeout(4000),
  })
  return res.ok ? res.json() : null
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
// 본제만: ' :부제', ' =대등표제', ' /영문 제목' 앞에서 자른다
const shortTitle = (t) => (t || '').split(/\s*:\s*|\s+=\s*|\s+\/\s*/)[0].trim() || t || ''
const cleanAuthor = (a) =>
  (a || '')
    .split(/[;,]/)[0]
    .replace(/^(지은이|글|저자|원작|지음)\s*:\s*/, '')
    .replace(/\s*(지음|저|글|동화|그림|옮김|\(지은이\))$/, '')
    .trim()
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const https = (u) => (u && u.startsWith('http://') ? 'https://' + u.slice(7) : u)

function setMeta(html, { title, description, url, image, jsonld, body }) {
  const rep = (re, val) => (html = html.replace(re, val))
  rep(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  rep(/(<meta name="description" content=")[^"]*(")/, `$1${esc(description)}$2`)
  rep(/(<link rel="canonical" href=")[^"]*(")/, `$1${esc(url)}$2`)
  rep(/(<meta property="og:url" content=")[^"]*(")/, `$1${esc(url)}$2`)
  rep(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
  rep(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(description)}$2`)
  rep(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
  rep(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(description)}$2`)
  if (image) {
    rep(/(<meta property="og:image" content=")[^"]*(")/, `$1${esc(image)}$2`)
    rep(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${esc(image)}$2`)
    // 책 표지는 크기가 제각각이라 1200x630 표시를 뺀다
    rep(/\s*<meta property="og:image:(width|height)" content="[^"]*" \/>/g, '')
    rep(/(<meta property="og:image:alt" content=")[^"]*(")/, `$1${esc(title)}$2`)
  }
  if (jsonld) {
    rep(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>`)
  }
  // 자바스크립트를 실행하지 않는 로봇도 읽을 수 있게 첫 화면에 요약을 넣어 둔다 (React가 뜨면 바로 바뀜)
  if (body) rep('<div id="root"></div>', `<div id="root">${body}</div>`)
  return html
}

// 화면(App.jsx cleanKeywords)과 같은 기준 + 뜻이 흐린 일반 낱말
const TAG_SKIP = new Set(['올해', '수천', '과정', '방법', '시대', '오늘', '지금', '하나', '정도', '부분', '경우', '내용', '모든', '이번', '이유', '사실', '자신', '우리', '저자', '작가', '출간', '책', '시간', '하루', '생각', '마음'])

async function bookPage(isbn) {
  const [books, states, usages] = await Promise.all([
    sb(`books?isbn13=eq.${isbn}&select=title,author,publisher,class_name,cover_url,pub_year,addition_symbol,vol,description&limit=1`),
    sb(`v_book_state_latest?isbn13=eq.${isbn}&select=stage,reason,rank_now,rank_prev,cat&limit=1`),
    sb(`book_usage?isbn13=eq.${isbn}&select=keywords,co_loan,loan_grps,mania_rec&limit=1`),
  ])
  const b = books?.[0]
  if (!b) return null
  const st = states?.[0]
  const u = usages?.[0] || {}
  const vol = (b.vol || '').trim()
  const t = shortTitle(b.title) + (vol ? (/^\d+$/.test(vol) ? ` ${vol}권` : ` ${vol}`) : '') // 서리꽃 1권·2권 구분
  const author = cleanAuthor(b.author)
  const cat = (b.class_name || '').split('>').slice(0, 2).map((s) => s.trim()).filter(Boolean).join(' > ')
  const title = `${t}${author ? ` — ${author}` : ''} | 책콕`
  const why = st?.reason ? `${st.stage ? st.stage + ' · ' : ''}${st.reason}. ` : ''
  const intro = (b.description || '').replace(/\s+/g, ' ').trim()

  // 이 책만의 정보로 본문을 만든다 (같은 틀 문장만 있는 얇은 페이지가 되지 않게)
  const grp = (u.loan_grps || []).slice().sort((x, y) => (y.loanCnt || 0) - (x.loanCnt || 0))[0]
  const topGroup = grp?.age ? `${grp.age}${grp.gender ? ' ' + grp.gender : ''}` : ''
  const words = [...new Set((u.keywords || []).map((k) => String(k.word || '').trim()))].filter((w) => w.length > 1 && w.length <= 12 && !TAG_SKIP.has(w) && w !== shortTitle(b.title)).slice(0, 8)
  const seen = new Set([shortTitle(b.title)])
  const pickBooks = (list, n) =>
    (list || []).filter((c) => c?.isbn13 && c.isbn13 !== isbn && c.title && !seen.has(shortTitle(c.title)) && seen.add(shortTitle(c.title))).slice(0, n)
  const co = pickBooks(u.co_loan, 8)
  const mania = pickBooks(u.mania_rec, 5)
  const rankLine =
    st?.rank_now != null
      ? `${st.cat ? st.cat + ' ' : ''}대출 순위 ${st.rank_now}위` + (st.rank_prev != null && st.rank_prev !== st.rank_now ? ` (지난번 ${st.rank_prev}위)` : '')
      : ''

  const descParts = [
    why.trim().replace(/\.$/, ''),
    rankLine,
    topGroup ? `${topGroup}이 가장 많이 빌림` : '',
    co.length ? `같이 빌린 책: ${co.slice(0, 2).map((c) => shortTitle(c.title)).join(', ')}` : '',
  ].filter(Boolean)
  const description = clip(
    descParts.length ? `『${t}』 ${descParts.join(' · ')}` : intro ? `『${t}』 ${intro}` : `『${t}』 대출 추이, 많이 빌린 연령대, 같이 빌린 책, 내 도서관 소장 여부를 책콕에서 확인하세요.`,
    110,
  )
  const url = `${SITE}/book/${isbn}`
  const image = https(b.cover_url) || `${SITE}/og.png?v=20261122c`
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: t,
    ...(author ? { author: { '@type': 'Person', name: author } } : {}),
    isbn,
    ...(b.publisher ? { publisher: { '@type': 'Organization', name: b.publisher } } : {}),
    ...(/^\d{4}$/.test(b.pub_year || '') ? { datePublished: b.pub_year } : {}),
    ...(b.cover_url ? { image } : {}),
    ...(intro ? { description: clip(intro, 300) } : {}),
    ...(words.length ? { keywords: words.join(', ') } : {}),
    url,
    inLanguage: 'ko',
  }
  const li = (c) => `<li><a href="/book/${esc(c.isbn13)}">${esc(shortTitle(c.title))}</a>${c.author ? ' · ' + esc(cleanAuthor(c.author)) : ''}</li>`
  const sec = (h, inner) => `<section style="margin-top:18px"><h2 style="font-size:17px;margin:0 0 6px">${h}</h2>${inner}</section>`
  const body =
    `<article style="padding:24px 20px;font-family:'Noto Sans KR',sans-serif;line-height:1.6">` +
    `<h1 style="font-size:24px;margin:0 0 8px">${esc(t)}</h1>` +
    `<p style="margin:0;color:#6b7684">${esc([author, b.publisher, b.pub_year, cat].filter(Boolean).join(' · '))}</p>` +
    (why || rankLine ? `<p style="margin:12px 0 0">${esc([why.trim(), rankLine].filter(Boolean).join(' '))}</p>` : '') +
    (intro ? sec('책 소개', `<p style="margin:0">${esc(clip(intro, 400))}</p>`) : '') +
    (topGroup ? sec('누가 빌렸나', `<p style="margin:0">도서관 대출 기록 기준 ${esc(topGroup)}이 가장 많이 빌렸어요.</p>`) : '') +
    (words.length ? sec('이 책의 키워드', `<p style="margin:0">${words.map((w) => `<a href="/keyword/${encodeURIComponent(w)}">#${esc(w)}</a>`).join(' ')}</p>`) : '') +
    (co.length ? sec('이 책을 빌린 사람들이 같이 빌린 책', `<ul style="margin:0;padding-left:18px">${co.map(li).join('')}</ul>`) : '') +
    (mania.length ? sec('마니아 독자가 함께 고른 책', `<ul style="margin:0;padding-left:18px">${mania.map(li).join('')}</ul>`) : '') +
    `<p style="margin:18px 0 0;color:#6b7684;font-size:13px">자료: 도서관 정보나루 대출 데이터 · <a href="/">책콕 홈</a> · <a href="/trend">요즘 뜨는 책</a></p>` +
    `</article>`
  return { title, description, url, image, jsonld, body }
}

async function keywordPage(word) {
  const rows = await sb(`v_keyword_books?word=eq.${encodeURIComponent(word)}&select=title&limit=6`)
  const titles = [...new Set((rows || []).map((r) => shortTitle(r.title)))].slice(0, 3)
  const title = `#${word} 관련 요즘 책 | 책콕`
  const description = clip(
    titles.length ? `'${word}' 키워드가 많이 나온 요즘 뜨는 책: ${titles.join(', ')} 등. 책콕에서 순위와 이유를 확인하세요.` : `'${word}' 키워드와 관련된 요즘 뜨는 책을 책콕에서 확인하세요.`,
    80,
  )
  const url = `${SITE}/keyword/${encodeURIComponent(word)}`
  const body = `<article style="padding:24px 20px;font-family:'Noto Sans KR',sans-serif"><h1 style="font-size:24px;margin:0 0 8px">#${esc(word)}</h1><p style="margin:0;color:#6b7684">${esc(description)}</p></article>`
  return { title, description, url, image: null, jsonld: null, body }
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host
  let html
  try {
    html = await shell(host)
  } catch (_e) {
    res.statusCode = 302
    res.setHeader('Location', '/')
    return res.end()
  }
  const type = String(req.query.type || '')
  const id = String(req.query.id || '').trim()
  let meta = null
  try {
    if (type === 'book' && /^\d{10,13}$/.test(id)) meta = await bookPage(id)
    else if (type === 'keyword' && id.length > 0 && id.length <= 30) meta = await keywordPage(id)
  } catch (_e) {
    meta = null // 데이터를 못 읽어도 화면은 그대로 뜨게
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400')
  res.statusCode = 200
  res.end(meta ? setMeta(html, meta) : html)
}
