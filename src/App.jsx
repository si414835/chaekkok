import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

/* ================= 설정 ================= */

// 쿠팡 파트너스: 최종 승인 전에는 API를 못 써서, 파트너스 화면에서 직접 만든 링크를 책별로 넣는다.
// 예: { '9791140712250': 'https://link.coupang.com/a/xxxx' }
// 여기 있는 책은 구매 버튼이 제휴 링크로 바뀌고, 공정위 표기 문구가 자동으로 나타난다.
// (최종 승인 후에는 파트너스 API로 모든 책을 자동 연결할 예정)
const COUPANG_LINKS = {}
// 쿠팡 파트너스 '배너 생성'(로켓 도서, 728x90)에서 받은 HTML 태그의 링크와 이미지
const COUPANG_BANNER = {
  href: 'https://link.coupang.com/a/indTOETos0',
  img: 'https://ads-partners.coupang.com/banners/1046134?trackingCode=AF4146233&subId=&traceId=V0-301-f5c692db558def48-I1046134&w=728&h=90',
  w: 728,
  h: 90,
  alt: '쿠팡 로켓 도서 — 한 권만 사도 무료배송',
}
const COUPANG_AFFILIATE = Object.keys(COUPANG_LINKS).length > 0 || !!COUPANG_BANNER
const AFFILIATE_NOTICE =
  '이 페이지는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.'

// 정보나루 성별 코드 -> 화면 표시 (수집 결과로 확인: 0=남성, 1=여성)
const GENDER_LABEL = { all: '전체', 1: '여성', 0: '남성' }
const AGE_OPTIONS = [
  { id: '10', label: '10대' },
  { id: '20', label: '20대' },
  { id: '30', label: '30대' },
  { id: '40', label: '40대' },
  { id: '50', label: '50대' },
  { id: '60', label: '60대 이상' },
]
const GENDER_OPTIONS = ['all', '1', '0']

const CATEGORIES = ['전체', '어린이', '총류', '철학', '사회과학', '자연과학', '기술과학', '예술', '문학', '역사']
const CATEGORY_MERGE = { 언어: '문학', 종교: '철학' }

const TABS = [
  { id: 'composite', label: '종합', desc: '여러 신호를 합친 종합 점수순이에요' },
  { id: 'popular', label: '꾸준한 인기', desc: '최근 30일 대출이 많은 순이에요' },
  { id: 'rising', label: '급상승', desc: '최근 2주 사이 대출순위가 많이 오른 책을 모두 모았어요' },
  { id: 'recommended', label: '사서 추천', desc: '국립중앙도서관 사서가 최근 6개월 동안 추천한 책이에요' },
]

const LIST_SIZE = 30
const today = new Date()
// 기기·검색 로봇의 시간대와 상관없이 한국 날짜로 표시 (데이터는 한국 시간 아침에 갱신)
const KST_NOW = new Date(Date.now() + 9 * 3600 * 1000)
const DATE_LABEL = `${KST_NOW.getUTCMonth() + 1}월 ${KST_NOW.getUTCDate()}일 기준`

/* ================= 작은 도우미 ================= */

function isChildBook(b) {
  return !!(b.additionSymbol && b.additionSymbol.startsWith('7'))
}
function topCategory(cls) {
  if (!cls) return null
  const top = cls.split('>')[0].trim()
  return CATEGORY_MERGE[top] || top
}
function categoryLabel(cls) {
  return topCategory(cls) || '미분류'
}
// 어린이 책(ISBN 부가기호 7로 시작)은 순위 노이즈가 커서 '어린이 책' 분야에서만 보여준다
function matchesCategory(b, cat) {
  if (cat === '어린이') return isChildBook(b)
  if (cat === '전체') return !isChildBook(b)
  if (isChildBook(b)) return false
  return topCategory(b.classNameFull) === cat
}
function shortTitle(t) {
  // "제목 :부제" 형태에서 부제를 뗀다
  return (t || '').split(/\s*:\s*/)[0].trim() || t
}
function cleanAuthor(a) {
  if (!a) return ''
  return a
    .split(/[;,]/)[0]
    .replace(/^(지은이|글|저자|원작|지음)\s*:\s*/, '')
    .replace(/\s*(지음|저|글|동화|그림|옮김)$/, '')
    .trim()
}
function firstIsbn(isbn) {
  return (isbn || '').split(/\s+/)[0]
}
function demoLabel(prefs) {
  const age = AGE_OPTIONS.find((a) => a.id === prefs.age)?.label ?? ''
  const g = prefs.gender === 'all' ? '' : ` ${GENDER_LABEL[prefs.gender]}`
  return age + g
}

// 로컬 저장 (사생활 모드 등에서 막혀도 앱은 동작하게)
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) : fallback
  } catch {
    return fallback
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 저장 불가 환경은 무시 */
  }
}
function useStored(key, fallback) {
  const [v, setV] = useState(() => load(key, fallback))
  useEffect(() => save(key, v), [key, v])
  return [v, setV]
}

// 화면 주소: /  /trend/탭  /book/ISBN  /keyword/단어  /wish  /my  /alerts  /hits  /search
// (책·키워드 주소는 검색 로봇이 각각 다른 페이지로 읽을 수 있게 #이 없는 진짜 주소로 쓴다)
const ROUTES = ['trend', 'book', 'keyword', 'wish', 'my', 'alerts', 'hits', 'search', 'library', 'draft']
function parsePath() {
  // 예전 주소(#/book/…)로 들어오면 새 주소로 바꿔 준다 (공유된 링크·알림 호환)
  if (window.location.hash.startsWith('#/')) {
    window.history.replaceState(null, '', window.location.hash.slice(1) || '/')
  }
  const parts = window.location.pathname.replace(/^\/+/, '').split('/')
  const name = ROUTES.includes(parts[0]) ? parts[0] : 'home'
  let param = null
  try {
    param = parts[1] ? decodeURIComponent(parts[1]) : null
  } catch (_e) {
    param = parts[1] || null
  }
  return { name, param }
}
const NAV_EVENT = 'chaekkok:nav'
const SITE_URL = 'https://chaekkok.vercel.app'
const DEFAULT_TITLE = typeof document !== 'undefined' ? document.title : '책콕'
// 화면마다 브라우저 제목과 대표 주소(canonical)를 맞춘다
function setPageMeta(title, path) {
  try {
    document.title = title || DEFAULT_TITLE
    const link = document.querySelector('link[rel="canonical"]')
    if (link) link.setAttribute('href', SITE_URL + (path || '/'))
  } catch (_e) {
    // 무시
  }
}
const go = (path) => {
  if (path === window.location.pathname + window.location.search) return
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAV_EVENT))
}
function useRoute() {
  const [route, setRoute] = useState(parsePath)
  useEffect(() => {
    const on = () => {
      const next = parsePath()
      setRoute((prev) => {
        // 같은 화면 안 탭 전환이 아니면 맨 위로
        if (prev.name !== next.name || next.name === 'book' || next.name === 'keyword') window.scrollTo(0, 0)
        return next
      })
    }
    // 앱 안 링크(<a href="/…">)는 새로고침 없이 화면만 바꾼다
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target.closest && e.target.closest('a[href]')
      if (!a || a.target || a.hasAttribute('download')) return
      const href = a.getAttribute('href')
      if (!href || !href.startsWith('/') || href.startsWith('//')) return
      e.preventDefault()
      go(href)
    }
    window.addEventListener('popstate', on)
    window.addEventListener(NAV_EVENT, on)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('popstate', on)
      window.removeEventListener(NAV_EVENT, on)
      document.removeEventListener('click', onClick)
    }
  }, [])
  return route
}

/* ================= 모션 도우미 ================= */

// '동작 줄이기'를 켠 기기에서는 애니메이션 없이 바로 최종 값을 보여준다
// PC·노트북처럼 넓은 화면인지 (이 폭부터 왼쪽 메뉴 레이아웃)
const WIDE_Q = '(min-width: 1100px)'
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE_Q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(WIDE_Q)
    if (!m) return
    const f = () => setWide(m.matches)
    f()
    m.addEventListener?.('change', f)
    return () => m.removeEventListener?.('change', f)
  }, [])
  return wide
}

const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// 숫자가 0부터 올라가는 카운트업 (key가 바뀌면 다시 시작)
function useCountUp(key, ms = 1100) {
  const [p, setP] = useState(() => (reduceMotion() ? 1 : 0))
  useEffect(() => {
    if (reduceMotion()) return setP(1)
    let raf
    let start = null
    setP(0)
    const tick = (t) => {
      if (start == null) start = t
      const k = Math.min(1, (t - start) / ms)
      setP(1 - Math.pow(1 - k, 3))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [key, ms])
  return p
}

// 애니메이션 시작 시점을 엇갈리게 (목록이 길면 앞쪽 몇 개만)
const delay = (i, base = 0, step = 0.05, max = 10) => ({ animationDelay: `${base + Math.min(i, max) * step}s` })

// 책별 최신 트렌드 단계·이유 (book_state). 목록·상세 어디서든 꺼내 쓴다.
const StateCtx = createContext(new Map())
const useBookState = (isbn) => useContext(StateCtx).get(isbn)

const STAGES = ['포착', '떠오름', '확산', '스테디']
const STAGE_TONE = { 포착: 'spot', 떠오름: 'rise', 확산: 'spread', 스테디: 'steady' }

function StageBadge({ stage }) {
  if (!stage) return null
  return <span className={`stage stage--${STAGE_TONE[stage] || 'steady'}`}>{stage}</span>
}

function fmtDate(d) {
  if (!d) return ''
  const [, m, day] = String(d).split('-')
  return `${Number(m)}월 ${Number(day)}일`
}

function Eyebrow({ children, tone }) {
  return <span className={`eyebrow${tone ? ' eyebrow--' + tone : ''}`}>{children}</span>
}

function Delta({ value }) {
  return (
    <span className="delta num">
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M5 1l4 7H1z" fill="currentColor" />
      </svg>
      {value}
    </span>
  )
}

/* ================= 아이콘 ================= */

const GINKGO_LEAF = 'M12 15.8C11 13 5.9 9.8 2.8 8C2.2 7.2 2.4 6.1 3.3 5.4C5.4 3.8 8.4 2.9 10.7 3L12 5.3L13.3 3C15.6 2.9 18.6 3.8 20.7 5.4C21.6 6.1 21.8 7.2 21.2 8C18.1 9.8 13 13 12 15.8Z'
const Icon = {
  gear: () => (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  ),
  menu: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
  ),
  home: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l8-6 8 6v10H4z" /></svg>
  ),
  trend: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2.6 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
  ),
  // 콕(은행잎): 꺼짐 = 윤곽선, 켜짐 = 노랗게 차오름
  ginkgo: (on, size = 22) => (
    <svg className={`ginkgo${on ? ' is-on' : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={on ? '#C99A1E' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {on && <path className="ginkgo__fill" d={GINKGO_LEAF} fill="#ECBE48" stroke="none" />}
      {on && <path className="ginkgo__veins" d="M12 14.4V7.4M12 14.2 6.6 7.6M12 14.2 17.4 7.6" stroke="#D9A82A" strokeWidth=".9" />}
      <path d={GINKGO_LEAF} />
      <path d="M12 15.8C12.1 17.8 11.8 19.7 11.1 21.5" />
    </svg>
  ),
  bell: (dot) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 10a6 6 0 0112 0c0 5 2 6.5 2 6.5H4S6 15 6 10z" />
      <path d="M10 20a2.2 2.2 0 004 0" />
      {dot && <circle cx="18.5" cy="5.5" r="3.2" fill="#ff4d5e" stroke="#fff" strokeWidth="1.6" />}
    </svg>
  ),
  user: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
  ),
  back: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
  ),
  chev: (dir = 'right') => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} /></svg>
  ),
  search: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
  ),
  filter: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
  ),
}

/* ================= 공통 컴포넌트 ================= */

// http 표지(국립중앙도서관 등)는 https 사이트에서 막히므로 https로 바꾸고, 실패하면 이미지 프록시로 재시도
function coverCandidates(src) {
  if (!src) return []
  if (src.startsWith('http://')) {
    const rest = src.slice(7)
    return ['https://' + rest, 'https://wsrv.nl/?url=' + encodeURIComponent(rest)]
  }
  return [src]
}
function Cover({ src, alt, className = '', title }) {
  const list = useMemo(() => coverCandidates(src), [src])
  const [i, setI] = useState(0)
  useEffect(() => setI(0), [src])
  if (i >= list.length)
    return (
      <span className={`cover cover--empty ${className}`} aria-hidden="true">
        {title && <span className="cover__title">{shortTitle(title)}</span>}
      </span>
    )
  return (
    <img
      key={list[i]}
      src={list[i]}
      alt={alt}
      className={`cover ${className}`}
      loading="lazy"
      draggable="false"
      onError={() => setI((n) => n + 1)}
    />
  )
}

const NAV_ITEMS = [
  { id: 'home', label: '홈', icon: Icon.home, path: '/' },
  { id: 'trend', label: '트렌드', icon: Icon.trend, path: '/trend' },
  { id: 'wish', label: '콕', icon: Icon.ginkgo, path: '/wish' },
  { id: 'my', label: '마이', icon: Icon.user, path: '/my' },
]

// 넓은 화면 전용 왼쪽 메뉴 (폰에서는 CSS로 숨기고 하단 탭을 쓴다)
function SideNav({ current, unread, mini, onToggle }) {
  return (
    <aside className="sidenav">
      <div className="sidenav__head">
        <a className="logo sidenav__logo" href="/" aria-label="책콕 홈">
          책콕
          <i className="logo__dot" aria-hidden="true" />
        </a>
        <button type="button" className="iconbtn sidenav__toggle" onClick={onToggle} aria-expanded={!mini} aria-label={mini ? '메뉴 펼치기' : '메뉴 접기'} title={mini ? '메뉴 펼치기' : '메뉴 접기'}>
          {Icon.menu()}
        </button>
      </div>
      {mini ? (
        <a className="sidenav__search" href="/search" title="책 검색" aria-label="책 검색">
          {Icon.search()}
        </a>
      ) : (
        <SideSearch />
      )}
      <nav className="sidenav__menu" aria-label="주요 메뉴">
        {NAV_ITEMS.map((it) => {
          const on = it.id === current
          return (
            <a key={it.id} href={it.path} className={`sidenav__item${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined} title={it.label}>
              <span className="sidenav__icon">{it.icon(on)}</span>
              <span>{it.label}</span>
            </a>
          )
        })}
      </nav>
      <div className="sidenav__foot">
        <a className={`sidenav__alert${unread ? ' has-new' : ''}${current === 'alerts' ? ' is-on' : ''}`} href="/alerts" title="알림" aria-label={unread ? `알림 ${unread}개` : '알림'}>
          {Icon.bell(unread > 0)}
          <span>알림{unread ? ` ${unread}` : ''}</span>
        </a>
        <span className="sub small">{DATE_LABEL} 데이터</span>
      </div>
    </aside>
  )
}

function BottomNav({ current }) {
  const items = NAV_ITEMS
  return (
    <nav className="tabbar" aria-label="주요 메뉴">
      {items.map((it) => {
        const on = it.id === current
        return (
          <a key={it.id} href={it.path} className={`tabbar__item${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
            <span className={`tabbar__icon${on ? ' hop' : ''}`}>{it.icon(on)}</span>
            <span>{it.label}</span>
          </a>
        )
      })}
    </nav>
  )
}

function BookRow({ rank, book, value, valueTone, order = 0 }) {
  const st = useBookState(book.isbn13)
  return (
    <a className="row rise" style={delay(order, 0.05, 0.04)} href={`/book/${encodeURIComponent(book.isbn13)}`}>
      {rank != null && <span className={`row__rank num${rank === 1 ? ' is-first' : ''}${rank <= 3 ? ' is-top' : ''}`}>{rank}</span>}
      <Cover src={book.cover_url} alt="" className="row__cover" title={book.title} />
      <span className="row__info">
        <span className="row__title">{shortTitle(book.title)}</span>
        <span className="row__meta">
          {book.categoryLabel} · {cleanAuthor(book.author)}
        </span>
        {st?.reason && (
          <span className="row__reason">
            <StageBadge stage={st.stage} />
            <span>{st.reason}</span>
          </span>
        )}
      </span>
      {valueTone === 'up' ? (
        <Delta value={String(value).replace('▲', '')} />
      ) : (
        <span className={`row__value num${valueTone ? ' row__value--' + valueTone : ''}`}>{value}</span>
      )}
    </a>
  )
}

function Loading() {
  return <p className="state">불러오는 중이에요…</p>
}

/* ================= 홈 ================= */

const keywordHref = (w) => `/keyword/${encodeURIComponent(w)}`

function KeywordHero({ keywords }) {
  const [wiggle, setWiggle] = useState(null)
  if (!keywords || keywords.words.length === 0) return null
  const [top, ...rest] = keywords.words
  const letters = [...top.word]
  const after = 0.25 + letters.length * 0.12
  // 살짝 흔들고 나서 키워드 페이지로
  const open = (e, w) => {
    e.preventDefault()
    setWiggle(w)
    setTimeout(() => go(`/keyword/${encodeURIComponent(w)}`), 220)
  }
  return (
    <section className="kw">
      <span className="kw__label pop" style={{ animationDelay: '0.05s' }}>
        <i aria-hidden="true" />
        {keywords.monthLabel}의 키워드
      </span>
      <h2 className="kw__heading">
      <a className={`kw__main${wiggle === top.word ? ' jelly' : ''}`} href={keywordHref(top.word)} onClick={(e) => open(e, top.word)} aria-label={`${top.word} 관련 책 보기`}>
        <span className="kw__mark grow" style={{ animationDelay: `${after}s` }} aria-hidden="true" />
        {letters.map((ch, i) => (
          <span key={i} className="drop" style={{ animationDelay: `${0.15 + i * 0.12}s` }} aria-hidden="true">
            {ch}
          </span>
        ))}
      </a>
      </h2>
      <p className="kw__desc rise" style={{ animationDelay: `${after + 0.1}s` }}>
        요즘 뜨는 책{top.books ? <> <b className="hl">{top.books}권</b></> : ''}에서
        <br />
        가장 많이 나온 단어예요 · 누르면 관련 책을 보여줘요
      </p>
      <div className="kw__tags">
        {rest.slice(0, 8).map((k, i) => (
          <a
            key={k.word}
            href={keywordHref(k.word)}
            className={`tag tag--btn pop${i < 3 ? ' tag--strong' : ''}`}
            style={delay(i, after + 0.15, 0.06)}
            onClick={(e) => open(e, k.word)}
          >
            <span className={wiggle === k.word ? 'jelly' : ''}>
              <span className="tag__hash">#</span>
              {k.word}
            </span>
          </a>
        ))}
      </div>
    </section>
  )
}

function Carousel({ books }) {
  const stateMap = useContext(StateCtx)
  const n = books.length
  const [idx, setIdx] = useState(0)
  const start = useRef(null)
  const swiped = useRef(false)
  const move = (to) => setIdx(((to % n) + n) % n)
  if (n === 0) return null
  const cur = books[Math.min(idx, n - 1)]
  const curState = stateMap.get(cur?.isbn13)

  const onDown = (e) => {
    start.current = e.clientX
    swiped.current = false
  }
  const onUp = (e) => {
    if (start.current == null) return
    const dx = e.clientX - start.current
    start.current = null
    if (Math.abs(dx) > 30) {
      swiped.current = true
      move(dx < 0 ? idx + 1 : idx - 1)
    }
  }

  return (
    <section className="card rise" style={{ animationDelay: '0.5s' }}>
      <div className="card__head">
        <div className="titlegroup">
          <Eyebrow>TODAY&apos;S KOK</Eyebrow>
          <h2 className="h2 display">
            오늘의 콕 <em>TOP {n}</em>
          </h2>
        </div>
        <span className="sub">밀어서 넘기기 →</span>
      </div>
      <div className="carousel" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (start.current = null)}>
        {books.map((b, i) => {
          let o = (i - idx + n) % n
          if (o > n / 2) o -= n
          const a = Math.abs(o)
          const scale = [1, 0.78, 0.6][Math.min(a, 2)]
          const x = [0, 98, 162][Math.min(a, 2)] * Math.sign(o)
          const rot = [0, 7, 11][Math.min(a, 2)] * Math.sign(o)
          const onClick = () => {
            if (swiped.current) {
              swiped.current = false
              return
            }
            if (o === 0) go(`/book/${encodeURIComponent(b.isbn13)}`)
            else move(i)
          }
          return (
            <button
              key={b.isbn13}
              className={`carousel__card${o === 0 ? ' is-center' : ''}`}
              style={{ transform: `translateX(${x}px) scale(${scale}) rotate(${rot}deg)`, zIndex: 10 - a, opacity: a >= 2 ? 0.5 : 1 }}
              onClick={onClick}
              aria-label={o === 0 ? `${shortTitle(b.title)} 상세 보기` : `${i + 1}위 ${shortTitle(b.title)}`}
            >
              <span className={`carousel__inner${o === 0 ? ' bob' : ''}`}>
                <Cover src={b.cover_url} alt="" className="carousel__cover" title={b.title} />
                <span className="spine" aria-hidden="true" />
                {o === 0 && <span className="carousel__rank pop num">{i + 1}</span>}
              </span>
            </button>
          )
        })}
      </div>
      <div className="carousel__caption pop" key={idx}>
        <strong>{shortTitle(cur.title)}</strong>
        <span>
          {cleanAuthor(cur.author)} · <b className="num">{cur.score ?? '-'}</b>
          <small>점</small>
        </span>
        {curState?.reason && (
          <span className="carousel__reason">
            <StageBadge stage={curState.stage} />
            {curState.reason}
          </span>
        )}
      </div>
      <div className="carousel__nav">
        <button className="round" onClick={() => move(idx - 1)} aria-label="이전 책">{Icon.chev('left')}</button>
        <div className="dots">
          {books.map((b, i) => (
            <span key={b.isbn13} className={`dot${i === idx ? ' is-on' : ''}`} />
          ))}
        </div>
        <button className="round" onClick={() => move(idx + 1)} aria-label="다음 책">{Icon.chev('right')}</button>
      </div>
    </section>
  )
}

function TopGrid({ books }) {
  if (!books.length) return null
  return (
    <section className="card topgrid">
      <div className="card__head">
        <div className="titlegroup">
          <Eyebrow>TODAY&apos;S KOK</Eyebrow>
          <h2 className="h2 display">
            오늘의 콕 <em>TOP {books.length}</em>
          </h2>
          <span className="sub">여러 신호를 합쳐 지금 가장 빠르게 뜨는 책이에요</span>
        </div>
        <a className="sub" href="/trend">
          트렌드 전체 보기 →
        </a>
      </div>
      <div className="topgrid__list">
        {books.map((b, i) => (
          <GalleryItem key={b.isbn13} book={b} rank={i + 1} value={[b.score != null ? `${b.score}점` : '']} />
        ))}
      </div>
    </section>
  )
}

function Home({ feed, keywords, loading, error, upcoming, hitStats, unread, libs }) {
  const wide = useWide()
  const top5 = feed.composite.filter((b) => !isChildBook(b)).slice(0, 5)
  // 넓은 화면은 옆 칸(우리 동네)과 높이를 맞추려고 5권, 폰은 3권
  const rising3 = feed.rising.filter((b) => !isChildBook(b)).slice(0, wide ? 5 : 3)
  return (
    <>
      <header className="topbar">
        <span className="logo">
          책콕
          <i className="logo__dot blink" aria-hidden="true" />
        </span>
        <span className="topbar__right">
          <span className="sub num">{DATE_LABEL}</span>
          <a className={`iconbtn bellbtn${unread ? ' has-new' : ''}`} href="/alerts" aria-label={unread ? `새 알림 ${unread}개` : '알림'}>
            {Icon.bell(unread > 0)}
          </a>
          <a className="iconbtn" href="/search" aria-label="책 검색">
            {Icon.search()}
          </a>
        </span>
      </header>
      <div className="stack home">
        <div className="kwgroup">
          <KeywordHero keywords={keywords} />
          <HitTeaser stats={hitStats} />
        </div>
        {loading && <section className="card"><Loading /></section>}
        {error && <section className="card"><p className="state state--error">데이터를 불러오지 못했어요: {error}</p></section>}
        {!loading && !error && (
          <>
            {wide ? <TopGrid books={top5} /> : <Carousel books={top5} />}
            <div className="home__pair">
            <section className="card card--list rise" style={{ animationDelay: '0.65s' }}>
              <div className="card__head">
                <div className="titlegroup">
                  <Eyebrow tone="up">RISING NOW</Eyebrow>
                  <h2 className="h2 display">지금 뜨는 책</h2>
                </div>
                <span className="sub">대출순위 급상승</span>
              </div>
              {rising3.map((b, i) => (
                <BookRow key={b.isbn13} rank={i + 1} order={i + 14} book={b} value={`▲${b.rank_diff ?? 0}`} valueTone="up" />
              ))}
              <a className="btn btn--soft btn--block" href="/trend">
                트렌드 순위 전체 보기 {Icon.chev()}
              </a>
            </section>
            <LocalRising libs={libs || []} />
            </div>
            <Upcoming list={upcoming} />
          </>
        )}
      </div>
    </>
  )
}

// 오늘(한국 시간) 기준 남은 날짜. 이미 나온 책은 null
function daysUntil(ymd) {
  if (!ymd) return null
  const now = new Date(Date.now() + 9 * 3600 * 1000)
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const [y, m, d] = ymd.split('-').map(Number)
  const diff = Math.round((Date.UTC(y, m - 1, d) - todayUtc) / 86400000)
  return diff > 0 ? diff : null
}

// 우리 동네에서 뜨는 책: 시·도별 인기대출(전 분야 100위)의 순위 변화
function LocalRising({ libs }) {
  const [region, setRegion] = useStored('chaekkok.region', regionOfAddr(libs[0]?.address))
  const [rows, setRows] = useState(null)
  useEffect(() => {
    if (!region) return setRows(null)
    let off = false
    setRows(null)
    supabase
      .from('v_region_books')
      .select('isbn13,rank,prev_rank,rank_diff,new_entry,region_count,region_total,snapshot_date,prev_date,title,author,cover_url,class_name,addition_symbol')
      .eq('region', region)
      .limit(100)
      .then(({ data }) => !off && setRows(data || []))
    return () => {
      off = true
    }
  }, [region])
  const name = REGION_LIST.find(([c]) => c === region)?.[1]
  const adult = (rows || []).filter((b) => !(b.addition_symbol || '').startsWith('7'))
  const picks = adult
    .filter((b) => b.rank_diff > 0 || b.new_entry)
    .sort((a, b) => (b.new_entry ? 100 - b.rank : b.rank_diff) - (a.new_entry ? 100 - a.rank : a.rank_diff))
    .slice(0, 5)
  const first = rows?.[0]
  const gap = first?.prev_date ? Math.round((Date.parse(first.snapshot_date) - Date.parse(first.prev_date)) / 86400000) : null
  return (
    <section className="card card--list rise local" style={{ animationDelay: '0.7s' }}>
      <div className="card__head">
        <div className="titlegroup">
          <Eyebrow tone="up">NEAR ME</Eyebrow>
          <h2 className="h2 display">{name ? `${name}에서 뜨는 책` : '우리 동네에서 뜨는 책'}</h2>
        </div>
        <label className="local__region">
          <span className="sr-only">지역</span>
          <select value={region || ''} onChange={(e) => setRegion(e.target.value || null)}>
            <option value="">지역 선택</option>
            {REGION_LIST.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!region && <p className="sub local__lead">지역을 고르면 그 지역 공공도서관에서 요즘 순위가 오르는 책을 보여드려요.</p>}
      {region && rows === null && <Loading />}
      {region && rows && (
        <>
          <p className="sub local__lead">
            {name} 공공도서관 인기대출 100위 · {gap ? `${gap}일 전보다 순위가 오른 책` : '순위가 오른 책'}
          </p>
          {picks.length === 0 && <p className="state">아직 비교할 기록이 부족해요. 며칠 뒤에 다시 보여드릴게요.</p>}
          {picks.map((b, i) => (
            <a key={b.isbn13} className="row rise" style={delay(i, 0.05, 0.04)} href={`/book/${encodeURIComponent(b.isbn13)}`}>
              <span className={`row__rank num${i === 0 ? ' is-first' : ''}${i < 3 ? ' is-top' : ''}`}>{i + 1}</span>
              <Cover src={b.cover_url} alt="" className="row__cover" title={b.title} />
              <span className="row__info">
                <span className="row__title">{shortTitle(b.title)}</span>
                <span className="row__meta">
                  {b.new_entry ? `${name} ${b.rank}위로 새로 진입` : `${name} ${b.prev_rank}위 → ${b.rank}위`}
                </span>
                {b.region_count != null && b.region_count <= 3 && (
                  <span className="row__reason">
                    <span className="local__only">이 지역에서 특히</span>
                    <span>
                      {b.region_total}곳 중 {b.region_count}곳만
                    </span>
                  </span>
                )}
              </span>
              {b.new_entry ? <span className="row__value num row__value--accent">NEW</span> : <Delta value={String(b.rank_diff)} />}
            </a>
          ))}
          {gap != null && gap < 7 && <p className="sub small local__note">지역 기록을 모은 지 얼마 안 돼서 {gap}일 전과 비교했어요. 일주일이 지나면 7일 전과 비교해요.</p>}
        </>
      )}
    </section>
  )
}

function Upcoming({ list: all }) {
  // 출간일이 지난 책은 '곧 나올 책'에서 뺀다 (서버에서도 거르지만 날짜가 바뀐 직후를 대비)
  const list = (all || []).filter((b) => daysUntil(b.publish_date) != null)
  // 3권보다 적으면 칸만 덩그러니 남아서 숨긴다
  if (list.length < 3) return null
  return (
    <section className="card card--bleed rise upcoming" style={{ animationDelay: '0.8s' }}>
      <div className="upcoming__head">
        <Eyebrow tone="spot">COMING SOON</Eyebrow>
        <h2 className="h2 display">곧 나올 책</h2>
        <p className="sub">요즘 뜨는 작가의 신작 · 출간 전 예약 판매도 해요</p>
      </div>
      <div className="hscroll">
        {list.slice(0, 10).map((b) => (
          <a key={b.isbn13} className="mini" href={`/book/${encodeURIComponent(b.isbn13)}`}>
            <span className="mini__coverwrap">
              <Cover src={b.cover_url} alt="" className="mini__cover" title={b.title} />
              <span className="mini__date num">D-{daysUntil(b.publish_date)}</span>
            </span>
            <span className="mini__text">
              <span className="mini__title">{shortTitle(b.title)}</span>
              <span className="mini__author">
                {b.matched_author || cleanAuthor(b.author)} · {fmtDate(b.publish_date)} 출간 예정
              </span>
            </span>
          </a>
        ))}
      </div>
    </section>
  )
}

function HitTeaser({ stats }) {
  if (!stats || !stats.matured_total) return null
  return (
    <a className="card hitteaser rise press" style={{ animationDelay: '0.5s' }} href="/hits">
      <div className="titlegroup">
        <Eyebrow>TRACK RECORD</Eyebrow>
        <strong className="display">책콕 적중 기록</strong>
        <span className="sub">
          {stats.base?.spot_up20 != null ? (
            <>
              포착한 책이 2주 뒤 크게 오른 비율 <b className="hl num">{Math.round(stats.base.spot_up20)}%</b> · 전체 평균 {Math.round(stats.base.base_up20)}%
            </>
          ) : (
            <>
              책콕이 먼저 알아본 책 <b className="hl num">{stats.top10_hits}권</b>이 분야 TOP10에 들었어요
            </>
          )}
        </span>
      </div>
      <span className="hitteaser__go">{Icon.chev()}</span>
    </a>
  )
}

/* ================= 적중 기록 ================= */

// 책콕이 포착한 책 vs 아무 책(같은 기간 분야 100위 안): 2주 뒤 순위를 비교
function HitCompare({ b }) {
  const rows = [
    { label: '2주 뒤 순위가 더 높음', spot: b.spot_up, base: b.base_up },
    { label: '2주 뒤 20% 넘게 오름', spot: b.spot_up20, base: b.base_up20 },
  ]
  const times = b.base_up20 > 0 ? Math.round((b.spot_up20 / b.base_up20) * 10) / 10 : null
  return (
    <section className="card rise compare" style={{ animationDelay: '0.1s' }}>
      <Eyebrow>VS AVERAGE</Eyebrow>
      <h2 className="h2 display">아무 책이나 고를 때보다 나을까요?</h2>
      <p className="sub">
        같은 기간 분야 100위 안의 모든 책과, 책콕이 포착한 책의 2주 뒤 순위를 비교했어요.
        {times && times > 1 && (
          <>
            {' '}크게 오른 비율이 <b className="hl">약 {times}배</b>예요.
          </>
        )}
      </p>
      {rows.map((r) => (
        <div key={r.label} className="compare__row">
          <span className="compare__label">{r.label}</span>
          <div className="compare__bars">
            <div className="compare__bar">
              <span className="compare__who">책콕</span>
              <span className="compare__track">
                <i className="is-spot" style={{ width: `${Math.min(100, r.spot)}%` }} />
              </span>
              <b className="num">{Math.round(r.spot)}%</b>
            </div>
            <div className="compare__bar">
              <span className="compare__who">전체</span>
              <span className="compare__track">
                <i style={{ width: `${Math.min(100, r.base)}%` }} />
              </span>
              <b className="num">{Math.round(r.base)}%</b>
            </div>
          </div>
        </div>
      ))}
      <p className="sub small">
        책콕 {b.spot_n.toLocaleString()}권 · 전체 {b.base_n.toLocaleString()}건(책×날짜) 기준 · 매일 다시 계산해요. 책콕이 고른 책은 2주 뒤 순위 밖으로 밀려난 비율도 {Math.round(b.spot_drop)}%(전체 {Math.round(b.base_drop)}%)로 더 높아서, 변동이 큰 책이 많아요.
      </p>
    </section>
  )
}

function Hits({ stats, index }) {
  const [books, setBooks] = useState(null)
  useEffect(() => {
    supabase
      .from('v_hit_books')
      .select('*')
      .order('top10_date', { ascending: false })
      .limit(30)
      .then(({ data }) => setBooks((data || []).filter((b) => !(b.addition_symbol || '').startsWith('7'))))
  }, [])
  const s = stats
  return (
    <>
      <header className="pagehead">
        <Eyebrow>TRACK RECORD</Eyebrow>
        <h1 className="h1 display">책콕 적중 기록</h1>
        <span className="sub">책콕이 먼저 알아본 책은 실제로 떴을까요?</span>
      </header>
      <div className="stack">
        {!s && <section className="card"><Loading /></section>}
        {s && (
          <section className="card rise">
            <div className="hitgrid hitgrid--3">
              <div>
                <span>포착한 책</span>
                <strong className="num">
                  {s.spotted_total.toLocaleString()}
                  <small>권</small>
                </strong>
              </div>
              <div>
                <span>TOP10 진입</span>
                <strong className="num up">
                  {s.top10_hits}
                  <small>권</small>
                </strong>
              </div>
              <div>
                <span>먼저 안 날</span>
                <strong className="num">
                  {s.avg_lead_days ?? '-'}
                  <small>일</small>
                </strong>
              </div>
            </div>
            <p className="sub small">
              {fmtDate(s.since)}부터 기록 · TOP10 진입은 포착 당시 분야 10위 밖이던 책 기준이에요.
            </p>
          </section>
        )}
        {s?.base?.spot_n > 0 && <HitCompare b={s.base} />}

        <section className="card card--list rise" style={{ animationDelay: '0.15s' }}>
          <div className="card__head">
            <div className="titlegroup">
              <Eyebrow tone="up">HITS</Eyebrow>
              <h2 className="h2 display">먼저 알아본 책</h2>
            </div>
            <span className="sub">포착 → 분야 TOP10</span>
          </div>
          {books === null && <Loading />}
          {books && books.length === 0 && <p className="state">아직 기록이 없어요. 매일 쌓이고 있어요.</p>}
          {books &&
            books.map((b, i) => (
              <a key={b.isbn13} className="row rise" style={delay(i, 0.2, 0.04)} href={`/book/${encodeURIComponent(b.isbn13)}`}>
                <Cover src={b.cover_url || index.get(b.isbn13)?.cover_url} alt="" className="row__cover" title={b.title} />
                <span className="row__info">
                  <span className="row__title">{shortTitle(b.title)}</span>
                  <span className="row__meta row__meta--wrap">
                    {fmtDate(b.first_spotted)} {b.first_stage}({b.rank_at_spot ? `${b.rank_at_spot}위` : '순위 밖'}) → {fmtDate(b.top10_date)} TOP10
                  </span>
                </span>
                <span className="lead num">
                  <b>{b.lead_days}일</b>
                  <small>먼저 포착</small>
                </span>
              </a>
            ))}
        </section>

        <section className="card rise" style={{ animationDelay: '0.25s' }}>
          <h2 className="h3">어떻게 계산하나요</h2>
          <ul className="howto">
            <li>
              <b>포착</b>은 책이 처음으로 포착·떠오름·확산 단계가 된 날이에요.
            </li>
            <li>
              <b>더 오름</b>은 포착 뒤 2주 안에 분야 순위가 포착 때보다 올라간 경우예요.
            </li>
            <li>
              <b>TOP10 진입</b>은 포착 당시 분야 10위 밖이던 책이 그 뒤 10위 안에 든 경우예요.
            </li>
            <li>기록을 시작하기 전 기간은 같은 기준을 과거 대출 데이터에 적용해 계산했어요.</li>
          </ul>
          <p className="sub small">데이터 출처: 도서관 정보나루 인기대출·대출 급상승</p>
        </section>
      </div>
    </>
  )
}

/* ================= 트렌드 ================= */

function PrefsSheet({ prefs, interests, setInterests, onOpenFilter, onClose }) {
  const toggle = (c) => setInterests(interests.includes(c) ? interests.filter((x) => x !== c) : [...interests, c])
  return (
    <Sheet label="내 취향" onClose={onClose}>
      <div className="sheet__head">
        <div>
          <h2 className="h2">내 취향</h2>
          <p className="sub">트렌드 순위를 나에게 맞게 볼 수 있어요</p>
        </div>
      </div>
      <button
        className="line"
        onClick={() => {
          onClose()
          onOpenFilter()
        }}
      >
        <span>연령대·성별</span>
        <span className="line__value">
          {prefs.on ? demoLabel(prefs) : '설정 안 함'} {Icon.chev()}
        </span>
      </button>
      <p className="label">관심 분야</p>
      <div className="chips chips--wrap">
        {CATEGORIES.filter((c) => c !== '전체').map((c) => (
          <button key={c} className={`chip${interests.includes(c) ? ' is-picked' : ''}`} aria-pressed={interests.includes(c)} onClick={() => toggle(c)}>
            {c === '어린이' ? '어린이 책' : c}
          </button>
        ))}
      </div>
      <p className="sub small">관심 분야는 분야 버튼 앞쪽에 먼저 보이고, 새로 포착된 책 알림에도 쓰여요.</p>
      <button className="btn btn--primary btn--full" onClick={onClose}>
        완료
      </button>
    </Sheet>
  )
}

// 넓은 화면 트렌드: 갤러리형 (순위는 표지 왼쪽, 표지는 그림자만)
function GalleryItem({ book, rank, value }) {
  const st = useBookState(book.isbn13)
  const m = /(\d+)위 → (\d+)위/.exec(st?.reason || '')
  const from = m ? Number(m[1]) : null
  const to = m ? Number(m[2]) : null
  const up = from != null ? from - to : book.rank_diff || null
  return (
    <a className="gitem rise" style={delay(rank, 0.03, 0)} href={`/book/${encodeURIComponent(book.isbn13)}`}>
      <span className={`gitem__rank${rank <= 3 ? ' is-top' : ''}`}>
        <b className="num">{rank}</b>
        <i aria-hidden="true" />
        {up > 0 && <span className="num">▲{up}</span>}
      </span>
      <span className="gitem__body">
        <Cover src={book.cover_url} alt="" className="gitem__cover" title={book.title} />
        <span className="gitem__title">{shortTitle(book.title)}</span>
        <span className="gitem__meta">
          {book.categoryLabel} · {cleanAuthor(book.author)}
        </span>
        {from != null && (
          <span className="gitem__move">
            <s>{from}위</s>
            <span aria-hidden="true">→</span>
            <b className="num">{to}위</b>
          </span>
        )}
        <span className={`gitem__stage gitem__stage--${STAGE_TONE[st?.stage] || 'none'}`}>
          {st?.stage ? `${st.stage} · ` : ''}
          {value[0]}
        </span>
      </span>
    </a>
  )
}

function Trend({ tab, feed, loading, error, prefs, interests, setInterests, onOpenFilter, demo }) {
  const wide = useWide()
  const [cat, setCat] = useState('전체')
  const [more, setMore] = useState(false)
  useEffect(() => setMore(false), [tab, cat])
  const [menu, setMenu] = useState(false)
  const demoActive = tab === 'popular' && prefs.on

  const cats = useMemo(() => {
    const fav = CATEGORIES.filter((c) => interests.includes(c))
    return ['전체', ...fav, ...CATEGORIES.filter((c) => c !== '전체' && !fav.includes(c))]
  }, [interests])

  const list = useMemo(() => {
    let src = demoActive ? demo.list : feed[tab]
    // 급상승은 책 수가 적어 분야 구분 없이 모아서 보여준다 (어린이 책만 제외)
    if (tab === 'rising') src = src.filter((b) => !isChildBook(b))
    else if (tab !== 'recommended') src = src.filter((b) => matchesCategory(b, cat))
    return src.slice(0, LIST_SIZE)
  }, [feed, tab, cat, demoActive, demo.list])

  const value = (b) => {
    if (tab === 'composite') return [`${b.score ?? 0}점`]
    if (tab === 'rising') return [`▲${b.rank_diff ?? 0}`, 'up']
    if (tab === 'popular') return [`${(b.loan_count ?? 0).toLocaleString()}회`]
    return [b.snapshotDate ? `${Number(b.snapshotDate.slice(5, 7))}월 추천` : '사서 추천', 'accent']
  }
  const desc = demoActive ? `${demoLabel(prefs)}이 최근 30일 많이 빌린 순이에요` : TABS.find((t) => t.id === tab).desc
  const waiting = loading || (demoActive && demo.loading)

  if (wide) {
    const shown = list.slice(0, more ? LIST_SIZE : 12)
    return (
      <section className="card gal">
        <i className="gal__line" aria-hidden="true" />
        <div className="gal__bar">
          <div>
            <h1 className="gal__title">요즘 뜨는 책</h1>
            <p className="sub gal__desc">
              {DATE_LABEL} · {desc}
            </p>
          </div>
          <div className="gal__tabs" role="tablist">
            {TABS.map((t) => (
              <a key={t.id} role="tab" aria-selected={tab === t.id} className={`gal__tab${tab === t.id ? ' is-on' : ''}`} href={`/trend/${t.id}`}>
                {t.label}
              </a>
            ))}
          </div>
        </div>
        <div className="gal__cats">
          {tab !== 'recommended' && tab !== 'rising' && (
            <>
              {tab === 'popular' && (
                <button className={`gal__cat${prefs.on ? ' is-on' : ''}`} onClick={onOpenFilter}>
                  {prefs.on ? demoLabel(prefs) : '연령·성별'}
                </button>
              )}
              {cats.map((c) => (
                <button key={c} className={`gal__cat${cat === c ? ' is-on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
                  {c === '전체' ? '전체 분야' : c === '어린이' ? '어린이 책' : c}
                </button>
              ))}
            </>
          )}
          <button className={`gal__prefs${prefs.on || interests.length ? ' has-set' : ''}`} onClick={() => setMenu(true)}>
            내 취향 설정
          </button>
        </div>
        {menu && <PrefsSheet prefs={prefs} interests={interests} setInterests={setInterests} onOpenFilter={onOpenFilter} onClose={() => setMenu(false)} />}
        {waiting && <Loading />}
        {error && <p className="state state--error">데이터를 불러오지 못했어요: {error}</p>}
        {!waiting && !error && list.length === 0 && (
          <p className="state">{demoActive ? '이 조건의 데이터가 아직 없어요. 다음 수집 후 채워져요.' : '이 분야는 아직 데이터가 없어요.'}</p>
        )}
        {!waiting && !error && list.length > 0 && (
          <div className="gal__grid">
            {shown.map((b, i) => (
              <GalleryItem key={tab + cat + b.isbn13} book={b} rank={i + 1} value={value(b)} />
            ))}
          </div>
        )}
        {!waiting && !error && !more && list.length > 12 && (
          <button className="gal__more" onClick={() => setMore(true)}>
            More +
          </button>
        )}
      </section>
    )
  }

  return (
    <div className="split">
      <div className="split__main">
      <header className="pagehead pagehead--withmenu">
        <Eyebrow>TREND</Eyebrow>
        <h1 className="h1 display">트렌드</h1>
        <span className="sub">{DATE_LABEL} · 전국 공공도서관 대출 데이터</span>
        <button className={`iconbtn menubtn${prefs.on || interests.length ? ' has-set' : ''}`} onClick={() => setMenu(true)} aria-label="내 취향 설정">
          {Icon.menu()}
        </button>
      </header>
      {menu && <PrefsSheet prefs={prefs} interests={interests} setInterests={setInterests} onOpenFilter={onOpenFilter} onClose={() => setMenu(false)} />}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={tab === t.id} className={`tabs__item${tab === t.id ? ' is-on' : ''}`} href={`/trend/${t.id}`}>
            {t.label}
          </a>
        ))}
      </div>
      {tab !== 'recommended' && tab !== 'rising' && (
        <div className="chips">
          {tab === 'popular' && (
            <button className={`chip chip--filter${prefs.on ? ' is-on' : ''}`} onClick={onOpenFilter}>
              {Icon.filter()} {prefs.on ? demoLabel(prefs) : '연령·성별'}
            </button>
          )}
          {cats.map((c) => (
            <button key={c} className={`chip${cat === c ? ' is-on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c === '전체' ? '전체 분야' : c === '어린이' ? '어린이 책' : c}
            </button>
          ))}
        </div>
      )}
      <p className="listdesc">{desc}</p>
      <div className="list">
        {waiting && <Loading />}
        {error && <p className="state state--error">데이터를 불러오지 못했어요: {error}</p>}
        {!waiting && !error && list.length === 0 && (
          <p className="state">{demoActive ? '이 조건의 데이터가 아직 없어요. 다음 수집 후 채워져요.' : '이 분야는 아직 데이터가 없어요.'}</p>
        )}
        {!waiting &&
          list.map((b, i) => {
            const [v, tone] = value(b)
            return <BookRow key={tab + cat + b.isbn13 + i} rank={i + 1} order={i} book={b} value={v} valueTone={tone} />
          })}
      </div>
      </div>
    </div>
  )
}

/* ================= 연령·성별 시트 ================= */

function FilterSheet({ prefs, onApply, onClose }) {
  const [draft, setDraft] = useState(prefs)
  useLockBody()
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="연령·성별로 보기">
      <button className="sheet__dim" aria-label="닫기" onClick={onClose} />
      <div className="sheet__panel">
        <span className="sheet__grip" aria-hidden="true" />
        <div className="sheet__head">
          <div>
            <h2 className="h2">연령·성별로 보기</h2>
            <p className="sub">이 사람들이 많이 빌린 책 순서로 보여줘요</p>
          </div>
          <button
            className={`switch${draft.on ? ' is-on' : ''}`}
            role="switch"
            aria-checked={draft.on}
            aria-label="연령·성별 필터"
            onClick={() => setDraft({ ...draft, on: !draft.on })}
          >
            <i />
          </button>
        </div>
        <div className={`sheet__body${draft.on ? '' : ' is-off'}`}>
          <p className="label">연령대</p>
          <div className="grid3">
            {AGE_OPTIONS.map((a) => (
              <button key={a.id} className={`opt${draft.on && draft.age === a.id ? ' is-on' : ''}`} onClick={() => setDraft({ ...draft, on: true, age: a.id })}>
                {a.label}
              </button>
            ))}
          </div>
          <p className="label">성별</p>
          <div className="seg">
            {GENDER_OPTIONS.map((g) => (
              <button key={g} className={`seg__item${draft.on && draft.gender === g ? ' is-on' : ''}`} onClick={() => setDraft({ ...draft, on: true, gender: g })}>
                {GENDER_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
        <div className="sheet__actions">
          <button className="btn btn--soft" onClick={() => setDraft({ on: false, age: '20', gender: 'all' })}>초기화</button>
          <button className="btn btn--primary" onClick={() => onApply(draft)}>
            {draft.on ? `${demoLabel(draft)} 순위 보기` : '전체 순위 보기'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ================= 책 상세 ================= */

function useBook(isbn, index) {
  const [extra, setExtra] = useState({ base: null, usage: null, coCovers: {}, loading: true })
  const known = index.get(isbn)
  useEffect(() => {
    let off = false
    async function run() {
      setExtra({ base: null, usage: null, coCovers: {}, loading: true })
      const [bookRes, usageRes] = await Promise.all([
        supabase.from('books').select('*').eq('isbn13', isbn).maybeSingle(),
        supabase.from('book_usage').select('*').eq('isbn13', isbn).maybeSingle(),
      ])
      const usage = usageRes.data
      let coCovers = {}
      const coIsbns = (usage?.co_loan || []).map((c) => c.isbn13).filter(Boolean).slice(0, 10)
      if (coIsbns.length) {
        const { data } = await supabase.from('books').select('isbn13,cover_url').in('isbn13', coIsbns)
        coCovers = Object.fromEntries((data || []).filter((r) => r.cover_url).map((r) => [r.isbn13, r.cover_url]))
      }
      // 책콕에 없는 책(같이 빌린 책 등)이나 표지가 없는 책은 정보나루 도서 상세에서 보강
      let base = bookRes.data
      const need = [...(base || index.get(isbn) ? [] : [isbn]), ...coIsbns.filter((i) => !coCovers[i] && !index.get(i)?.cover_url)]
      if (need.length) {
        const { data } = await supabase.functions.invoke('library-info', { body: { action: 'books', isbns: need.slice(0, 12) } })
        for (const b of data?.books || []) {
          if (!b.found) continue
          if (b.cover) coCovers[b.isbn13] = b.cover
          if (b.isbn13 === isbn && !base) {
            base = {
              isbn13: b.isbn13,
              title: b.title,
              author: b.author,
              publisher: b.publisher,
              class_name: b.className,
              cover_url: b.cover,
              addition_symbol: b.additionSymbol,
              description: b.description,
              external: true,
            }
          }
        }
      }
      if (!off) setExtra({ base, usage, coCovers, loading: false })
    }
    run()
    return () => {
      off = true
    }
  }, [isbn])
  const base = extra.base
  const book =
    known ||
    (base && {
      isbn13: base.isbn13,
      title: base.title,
      author: base.author,
      classNameFull: base.class_name,
      categoryLabel: categoryLabel(base.class_name),
      cover_url: base.cover_url,
      detail_url: base.detail_url,
      additionSymbol: base.addition_symbol,
      description: base.description,
      external: !!base.external,
    })
  return { book, ...extra }
}

/* ================= 순위 기록 · 콕 적중 ================= */

const DAY_MS = 86400000
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS)
const STAGE_COLOR = { 포착: '#c99a1e', 떠오름: '#007a56', 확산: '#3d48c8', 스테디: '#4e5968' }

// 콕한 날 (예전 기록은 'M/D'만 있어서 올해 날짜로 바꾼다)
function savedOnOf(w) {
  if (!w) return null
  if (w.savedOn) return w.savedOn
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(w.savedAt || '')
  if (!m) return null
  const today = kstToday()
  let y = Number(today.slice(0, 4))
  const iso = (yy) => `${yy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  if (iso(y) > today) y -= 1
  return iso(y)
}

// 적중: 콕할 때 분야 10위 밖(또는 순위 밖)이던 책이, 콕한 뒤 분야 TOP10에 들어간 경우
function evalHit(rows, savedOn) {
  if (!savedOn) return null
  const before = rows.filter((r) => r.snapshot_date <= savedOn && dayDiff(r.snapshot_date, savedOn) <= 7)
  const atSave = before.length ? before[before.length - 1].rank_now : null
  const after = rows.filter((r) => r.snapshot_date > savedOn && r.rank_now != null)
  const top = after.find((r) => r.rank_now <= 10)
  const hit = !!top && (atSave == null || atSave > 10)
  const best = after.reduce((m, r) => (m == null || r.rank_now < m ? r.rank_now : m), null)
  return {
    savedOn,
    atSave,
    best,
    hit,
    top10Date: hit ? top.snapshot_date : null,
    leadDays: hit ? dayDiff(savedOn, top.snapshot_date) : null,
    rose: atSave != null && best != null && best < atSave ? atSave - best : null,
  }
}

// 콕한 책들의 순위 기록을 한 번에 받아 적중 여부를 계산
function useWishHits(wish) {
  const [map, setMap] = useState(new Map())
  const key = wish.map((w) => w.isbn13 + '@' + (savedOnOf(w) || '')).join(',')
  useEffect(() => {
    const list = wish.map((w) => ({ isbn: w.isbn13, on: savedOnOf(w) })).filter((x) => x.on)
    if (!list.length) {
      setMap(new Map())
      return
    }
    let off = false
    const minOn = list.reduce((m, x) => (x.on < m ? x.on : m), list[0].on)
    const from = new Date(Date.parse(minOn) - 8 * DAY_MS).toISOString().slice(0, 10)
    ;(async () => {
      const ids = list.map((x) => x.isbn)
      const rows = []
      for (let i = 0; i < ids.length; i += 100) {
        for (let start = 0; start < 10000; start += 1000) {
          const { data, error } = await supabase
            .from('book_state')
            .select('isbn13,snapshot_date,rank_now')
            .in('isbn13', ids.slice(i, i + 100))
            .gte('snapshot_date', from)
            .order('snapshot_date', { ascending: true })
            .range(start, start + 999)
          if (error || !data) break
          rows.push(...data)
          if (data.length < 1000) break
        }
      }
      if (off) return
      const by = new Map()
      rows.forEach((r) => {
        if (!by.has(r.isbn13)) by.set(r.isbn13, [])
        by.get(r.isbn13).push(r)
      })
      const out = new Map()
      list.forEach((x) => out.set(x.isbn, evalHit(by.get(x.isbn) || [], x.on)))
      setMap(out)
    })()
    return () => {
      off = true
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return map
}

function useRankHistory(isbn) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    let off = false
    setRows(null)
    supabase
      .from('book_state')
      .select('snapshot_date,rank_now,stage,list_size,cat')
      .eq('isbn13', isbn)
      .order('snapshot_date', { ascending: false })
      .limit(45)
      .then(({ data }) => {
        if (!off) setRows((data || []).reverse())
      })
    return () => {
      off = true
    }
  }, [isbn])
  return rows
}

// 분야 순위 그래프: 위로 갈수록 높은 순위. TOP10 구간을 띠로 표시하고, 단계가 바뀐 날을 점으로 찍는다
function RankChart({ isbn, firstSpotted, hit, embedded }) {
  const rows = useRankHistory(isbn)
  if (!rows) return null
  const ranked = rows.filter((r) => r.rank_now != null)
  if (ranked.length < 2) return null
  const minR = Math.min(...ranked.map((r) => r.rank_now))
  const maxR = Math.max(...ranked.map((r) => r.rank_now))
  const flat = maxR - minR <= 3 // 거의 그대로면 그래프를 작게
  const W = 320
  const H = flat ? 86 : 150
  const L = 30
  const R = 14
  const T = 12
  const B = 24
  // 축: 실제 순위 범위에 맞추되, 상위권(15위 안)에 닿으면 1위부터 보여 TOP10 띠가 의미 있게
  const lo = minR <= 15 ? 1 : Math.max(1, minR - Math.max(3, Math.round((maxR - minR) * 0.3)))
  const hiRaw = maxR + Math.max(2, Math.round((maxR - minR) * 0.2))
  const top = Math.max(lo + 4, Math.ceil(hiRaw / 5) * 5)
  const showBand = lo <= 10
  const x = (i) => L + (rows.length === 1 ? 0 : (i * (W - L - R)) / (rows.length - 1))
  const y = (rank) => T + ((rank - lo) * (H - T - B)) / Math.max(top - lo, 1)
  // 순위 밖인 날은 선을 끊는다
  const segs = []
  let cur = []
  rows.forEach((r, i) => {
    if (r.rank_now == null) {
      if (cur.length) segs.push(cur)
      cur = []
    } else cur.push([x(i), y(r.rank_now)])
  })
  if (cur.length) segs.push(cur)
  // 단계가 바뀐 날 (순위 밖이던 날은 건너뛰고 직전 단계와 비교)
  const changes = []
  let prevStage = null
  rows.forEach((r, i) => {
    if (r.rank_now == null || !r.stage) return
    if (r.stage !== prevStage) changes.push({ ...r, i })
    prevStage = r.stage
  })
  const first = ranked[0]
  const last = ranked[ranked.length - 1]
  const lastIdx = rows.indexOf(last)
  const top10 = rows.find((r) => r.rank_now != null && r.rank_now <= 10 && (!firstSpotted || r.snapshot_date >= firstSpotted))
  const savedIdx = hit?.savedOn ? rows.findIndex((r) => r.snapshot_date >= hit.savedOn) : -1
  const cat = last.cat || first.cat || '분야'
  const diff = first.rank_now - last.rank_now
  const Wrap = embedded ? 'div' : 'section'
  return (
    <Wrap className={`${embedded ? 'rankcard rankcard--embedded' : 'card rankcard'} rise`} style={{ animationDelay: '0.34s' }}>
      <h2 className="h3 rankcard__title">순위 흐름</h2>
      <p className="sub">
        {cat} 인기대출 · {fmtDate(first.snapshot_date)} <b className="num">{first.rank_now}위</b> → {fmtDate(last.snapshot_date)}{' '}
        <b className={`num${diff > 0 ? ' up' : ''}`}>{last.rank_now}위</b>
        {diff > 0 ? ` (▲${diff})` : diff < 0 ? ` (▼${-diff})` : ' · 순위 그대로'}
      </p>
      {hit?.hit && (
        <p className="hitline">
          {Icon.ginkgo(true, 18)}
          <span>
            내가 <b>{fmtDate(hit.savedOn)}</b>에 콕한 책이 <b>{hit.leadDays}일 뒤</b> TOP10에 들었어요
          </span>
        </p>
      )}
      <svg className="rankchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${cat} 순위 ${first.rank_now}위에서 ${last.rank_now}위로`}>
        {showBand && (
          <>
            <rect x={L} y={y(1) - 4} width={W - L - R} height={y(10) - y(1) + 8} rx="6" className="rankchart__band" />
            <text x={W - R - 4} y={y(10) - 6} textAnchor="end" className="rankchart__bandlabel">TOP10</text>
          </>
        )}
        {[...new Set(showBand ? [1, 10, top] : [lo, top])].map((v) => (
          <text key={v} x={L - 8} y={y(v) + 4} textAnchor="end" className="rankchart__tick num">
            {v}
          </text>
        ))}
        {savedIdx >= 0 && (
          <g>
            <line x1={x(savedIdx)} x2={x(savedIdx)} y1={T - 4} y2={H - B + 2} className="rankchart__saved" />
            <text x={x(savedIdx) + 4} y={H - B - 4} className="rankchart__savedlabel">내가 콕</text>
          </g>
        )}
        {segs.map((pts, k) => (
          <polyline key={k} points={pts.map((p) => p.join(',')).join(' ')} className="rankchart__line" pathLength="1" />
        ))}
        {changes.map((c) => (
          <circle key={c.snapshot_date} cx={x(c.i)} cy={y(c.rank_now)} r="4.5" fill={STAGE_COLOR[c.stage] || '#4e5968'} className="rankchart__dot" />
        ))}
        {top10 && <circle cx={x(rows.indexOf(top10))} cy={y(top10.rank_now)} r="4.5" fill="#ecbe48" className="rankchart__dot" />}
        <circle cx={x(lastIdx)} cy={y(last.rank_now)} r="6" className="rankchart__now" />
        <text x={L} y={H - 6} className="rankchart__date">{fmtDate(rows[0].snapshot_date)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="rankchart__date">{fmtDate(rows[rows.length - 1].snapshot_date)}</text>
      </svg>
      <div className="rankchart__legend">
        {[
          ...changes.map((c) => ({ d: c.snapshot_date, label: c.stage, color: STAGE_COLOR[c.stage] })),
          ...(top10 ? [{ d: top10.snapshot_date, label: 'TOP10 진입', top: true }] : []),
        ]
          .sort((a, b) => a.d.localeCompare(b.d))
          .map((m) => (
            <span key={m.label + m.d} className="rankchart__mile">
              <i className={m.top ? 'is-top' : ''} style={m.top ? undefined : { background: m.color }} aria-hidden="true" />
              {m.label} <b className="num">{fmtDate(m.d)}</b>
            </span>
          ))}
      </div>
      {!flat && <p className="sub small">점은 트렌드 단계가 바뀐 날이에요. 선이 끊긴 곳은 그날 분야 순위 목록에 없던 날이에요.</p>}
    </Wrap>
  )
}

function LoanChart({ history, motionKey }) {
  const p = useCountUp(motionKey)
  const rows = (history || []).filter((h) => h.loanCnt != null).slice(-12)
  if (rows.length < 2) return null
  const max = Math.max(...rows.map((r) => r.loanCnt), 1)
  const last = rows[rows.length - 1]
  const prev = rows[rows.length - 2]
  const diff = last.loanCnt - prev.loanCnt
  return (
    <section className="card rise" style={{ animationDelay: '0.35s' }}>
      <Eyebrow>LOAN TREND</Eyebrow>
      <h2 className="h2 display">월별 대출 추이</h2>
      <p className="sub">최근 {rows.length}개월 · 정보나루 참여 공공도서관</p>
      <div className="bigstat">
        <strong className="num">
          {Math.round(last.loanCnt * p).toLocaleString()}
          <small>회</small>
        </strong>
        <span className={`chip-stat num ${diff >= 0 ? 'up' : 'down'}`}>
          지난달보다 {diff >= 0 ? '+' : ''}
          {diff.toLocaleString()}회
        </span>
      </div>
      <div className="bars" role="img" aria-label={`최근 ${rows.length}개월 대출 건수 막대그래프`}>
        {rows.map((r, i) => (
          <div key={r.month} className="bars__col">
            <div
              className={`bars__bar barup${i === rows.length - 1 ? ' is-last' : ''}`}
              style={{ height: `${Math.round((r.loanCnt / max) * 120)}px`, ...delay(i, 0.45, 0.04, 12) }}
              title={`${r.month} ${r.loanCnt}회`}
            />
            <span className={i === rows.length - 1 ? 'is-last' : ''}>{Number((r.month.match(/(\d+)월/) || [])[1])}월</span>
          </div>
        ))}
      </div>
    </section>
  )
}

const MIN_GROUP_LOANS = 50

// 대출 '횟수'로 줄 세우면 도서관 이용이 가장 많은 40대 여성이 거의 모든 책에서 1위가 된다.
// 그래서 '각 연령·성별 그룹 안에서 이 책이 몇 위인지'로 이 책을 특히 좋아하는 그룹을 고른다.
function Groups({ groups }) {
  const top = [...(groups || [])]
    // 이용자가 적은 그룹은 몇 번만 빌려도 순위가 튀어서, 대출 50회 이상인 그룹만 본다
    .filter((g) => g.ranking && g.age && g.age.trim() && (g.loanCnt ?? 0) >= MIN_GROUP_LOANS)
    .sort((a, b) => a.ranking - b.ranking)
    .slice(0, 3)
  if (top.length === 0) return null
  const best = top[0].ranking
  return (
    <section className="card rise" style={{ animationDelay: '0.45s' }}>
      <Eyebrow>WHO READS</Eyebrow>
      <h2 className="h2 display">누가 특히 많이 빌렸을까요</h2>
      <p className="sub">그 그룹이 빌린 책 중에서 이 책이 몇 위인지 비교했어요 (대출 {MIN_GROUP_LOANS}회 이상 그룹)</p>
      <p className="groups__lead">
        <b>
          {top[0].age} {top[0].gender}
        </b>
        이 빌린 책 중 <b>{top[0].ranking.toLocaleString()}위</b>예요
      </p>
      <div className="hbars">
        {top.map((g, i) => (
          <div
            key={g.age + g.gender}
            className="hbars__row"
            aria-label={`${g.age} ${g.gender}이 빌린 책 중 ${g.ranking}위, ${g.loanCnt}회 대출`}
          >
            <span className="hbars__label">
              {g.age} {g.gender}
            </span>
            <span className="hbars__track">
              <span
                className={`hbars__fill barx${i === 0 ? ' is-top' : ''}`}
                style={{ width: `${Math.max(12, Math.round((best / g.ranking) * 100))}%`, ...delay(i, 0.6, 0.08) }}
              />
            </span>
            <span className="hbars__num">
              <b className="num">
                {g.ranking.toLocaleString()}
                <i>위</i>
              </b>
              <small className="num">{g.loanCnt.toLocaleString()}회 대출</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function shopLinks(isbn) {
  const q = encodeURIComponent(firstIsbn(isbn))
  return [
    {
      id: 'coupang', name: '쿠팡', mark: '쿠', domain: 'coupang.com', sub: '로켓배송 도서', direct: !!(COUPANG_LINKS[isbn] || COUPANG_LINKS[firstIsbn(isbn)]),
      url: COUPANG_LINKS[isbn] || COUPANG_LINKS[firstIsbn(isbn)] || `https://www.coupang.com/np/search?q=${q}`,
    },
    // 교보문고·알라딘은 ISBN 주소가 그 책 상품 페이지로 바로 연결된다 (2026-11-03 확인)
    { id: 'kyobo', name: '교보문고', mark: '교', domain: 'kyobobook.co.kr', sub: '이 책 상품 페이지로 바로', direct: true, url: `http://www.kyobobook.co.kr/product/detailViewKor.laf?mallGb=KOR&ejkGb=KOR&barcode=${q}` },
    { id: 'aladin', name: '알라딘', mark: '알', domain: 'aladin.co.kr', sub: '이 책 상품 페이지로 바로', direct: true, url: `https://www.aladin.co.kr/shop/wproduct.aspx?ISBN=${q}` },
    // YES24·네이버는 ISBN으로 바로 가는 공개 주소가 없어 ISBN 검색 결과(보통 그 책 1권)로 연결한다
    { id: 'yes24', name: 'YES24', mark: 'Y', domain: 'yes24.com', sub: 'ISBN으로 정확히 검색', direct: false, url: `https://www.yes24.com/Product/Search?domain=BOOK&query=${q}` },
    { id: 'naver', name: '네이버 도서', mark: 'N', domain: 'naver.com', sub: '여러 판매처 가격 비교', direct: false, url: `https://search.shopping.naver.com/book/search?query=${q}` },
  ]
}

// 서점 로고: 각 사이트가 직접 쓰는 아이콘(파비콘)을 불러온다. 못 불러오면 글자 아이콘으로.
function ShopLogo({ shop }) {
  const [fail, setFail] = useState(false)
  if (fail || !shop.domain) return <span className={`shop__mark shop__mark--${shop.id}`}>{shop.mark}</span>
  return (
    <span className="shop__logo">
      <img src={`https://www.google.com/s2/favicons?domain=${shop.domain}&sz=128`} alt="" width="32" height="32" loading="lazy" onError={() => setFail(true)} />
    </span>
  )
}

// 블로그 초안 (/draft): 매일 아침 자동으로 만든 네이버 블로그 글. 검색에는 안 나오게 한다.
function CopyBtn({ text, label }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1600)
    } catch (_e) {
      // 복사가 막힌 브라우저: 길게 눌러 직접 복사
    }
  }
  return (
    <button type="button" className={`btn ${done ? 'btn--primary' : 'btn--soft'} draft__copy`} onClick={copy} aria-live="polite">
      {done ? '복사했어요 ✓' : label}
    </button>
  )
}

function Drafts() {
  const [list, setList] = useState(null)
  const [i, setI] = useState(0)
  useEffect(() => {
    setPageMeta('블로그 초안 | 책콕', '/draft')
    const m = document.createElement('meta')
    m.name = 'robots'
    m.content = 'noindex, nofollow'
    document.head.appendChild(m)
    supabase
      .from('blog_drafts')
      .select('*')
      .order('day', { ascending: false })
      .limit(14)
      .then(({ data }) => setList(data || []))
    return () => m.remove()
  }, [])
  const d = list?.[i]
  return (
    <>
      <header className="pagehead">
        <Eyebrow>BLOG DRAFT</Eyebrow>
        <h1 className="h1 display">블로그 초안</h1>
        <span className="sub">매일 아침 데이터가 들어오면 자동으로 만들어져요. 복사해서 네이버 블로그에 붙여 넣으세요.</span>
      </header>
      <div className="stack">
        {!list && <section className="card"><Loading /></section>}
        {list && list.length === 0 && <section className="card"><p className="state">아직 만들어진 초안이 없어요.</p></section>}
        {list && list.length > 0 && (
          <section className="card draft">
            <div className="draft__days">
              {list.map((x, n) => (
                <button key={x.day} type="button" className={`pill pill--btn${n === i ? ' is-on' : ''}`} onClick={() => setI(n)}>
                  {fmtDate(x.day)}
                </button>
              ))}
            </div>
            <p className="label">1. 제목</p>
            <p className="draft__title">{d.title}</p>
            <CopyBtn text={d.title} label="제목 복사" />
            {d.book_titles?.length > 0 && (
              <>
                <p className="label">책 첨부할 때 검색어 (글감 → 책)</p>
                <div className="draft__books">
                  {d.book_titles.map((t) => (
                    <CopyBtn key={t} text={t} label={`『${t}』 복사`} />
                  ))}
                </div>
                <p className="sub small">본문의 📌 줄 자리에 책을 첨부하고, 📌 줄은 지워 주세요.</p>
              </>
            )}
            <p className="label">2. 본문</p>
            <pre className="draft__body">{d.body}</pre>
            <CopyBtn text={d.body} label="본문 복사" />
            <p className="label">3. 태그</p>
            <p className="draft__tags">{d.tags}</p>
            <CopyBtn text={d.tags} label="태그 복사" />
            <p className="sub small">책 표지 사진은 저작권 문제가 생길 수 있어서 넣지 않았어요. 사진이 필요하면 책콕 화면을 캡처해서 넣어 주세요.</p>
          </section>
        )}
      </div>
    </>
  )
}

function CopyIsbn({ isbn }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(isbn)
      setDone(true)
      setTimeout(() => setDone(false), 1600)
    } catch (_e) {
      // 복사가 막힌 브라우저
    }
  }
  return (
    <button type="button" className={`pill pill--btn isbncopy${done ? ' is-on' : ''}`} onClick={copy} aria-live="polite">
      {done ? '복사했어요' : 'ISBN 복사'}
    </button>
  )
}

// 왜 뜨는지: 신뢰도를 정하는 7가지 근거 중 이 책에 해당하는 것만 보여준다
function useEvidence(isbn) {
  const [ev, setEv] = useState(null)
  useEffect(() => {
    let off = false
    supabase
      .from('v_book_state_latest')
      .select('rank_now,rank_prev,rank_mid,rank_change_ratio,new_entry,hot_diff,rise_steady,loan_growth,regions,demo_groups,librarian,yt_spike,gt_spike,cat,sources')
      .eq('isbn13', isbn)
      .maybeSingle()
      .then(({ data }) => !off && setEv(data || null))
    return () => {
      off = true
    }
  }, [isbn])
  return ev
}

function evidenceOf(e) {
  if (!e) return []
  const cat = e.cat || '분야'
  const out = []
  const rcr = Number(e.rank_change_ratio)
  if (rcr >= 0.2 && e.rank_prev && e.rank_now)
    out.push({ title: `순위 ${Math.round(rcr * 100)}% 상승`, desc: `${cat} ${e.rank_prev}위 → ${e.rank_now}위, 일주일 동안` })
  if (e.new_entry) out.push({ title: '새로 진입', desc: `지난주엔 ${cat} 인기대출 목록에 없다가 ${e.rank_now}위로 들어왔어요` })
  if (e.hot_diff > 0) out.push({ title: '전국 대출 급상승', desc: `전국 공공도서관 대출 급상승 목록 ▲${e.hot_diff}` })
  if (e.rise_steady)
    out.push({
      title: '꾸준히 상승',
      desc: e.rank_mid === e.rank_now ? `${e.rank_prev}위 → ${e.rank_mid}위로 오른 뒤 그 자리를 지키는 중이에요` : `${e.rank_prev}위 → ${e.rank_mid}위 → ${e.rank_now}위, 일주일 내내 올랐어요`,
    })
  if (Number(e.loan_growth) >= 0.2) out.push({ title: '지난달 대출 증가', desc: `지난달 대출이 그 전 석 달 평균보다 ${Math.round(e.loan_growth * 100)}% 늘었어요` })
  if (e.regions >= 3 || e.demo_groups >= 3) {
    const parts = [e.regions >= 3 && `${e.regions}개 지역`, e.demo_groups >= 3 && `${e.demo_groups}개 연령·성별 목록`].filter(Boolean)
    out.push({ title: '여러 곳에서 인기', desc: `${parts.join(' · ')}에서 인기대출 순위에 올랐어요` })
  }
  const ext = [e.librarian && '국립중앙도서관 사서 추천', e.yt_spike && '유튜브 언급 급증', e.gt_spike && '검색 관심 급증'].filter(Boolean)
  if (ext.length) out.push({ title: '도서관 밖 신호', desc: ext.join(' · ') })
  return out
}

function WhyRising({ isbn }) {
  const ev = useEvidence(isbn)
  const list = evidenceOf(ev)
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [isbn])
  if (!list.length) return null
  const peek = list.slice(0, 2).map((x) => x.title).join(' · ') + (list.length > 2 ? ` 외 ${list.length - 2}개` : '')
  return (
    <div className={`why${open ? ' is-open' : ''}`}>
      <button type="button" className="why__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="why__text">
          <span className="why__title">
            왜 뜨나요 <span>근거 {list.length}개</span>
          </span>
          {!open && <span className="why__peek">{peek}</span>}
        </span>
        <span className="why__chev" aria-hidden="true">{Icon.chev()}</span>
      </button>
      {open && <ul className="why__list">
        {list.map((x) => (
          <li key={x.title}>
            <span className="why__check" aria-hidden="true">✓</span>
            <span>
              <b>{x.title}</b>
              <small>{x.desc}</small>
            </span>
          </li>
        ))}
      </ul>}
    </div>
  )
}

function Detail({ isbn, index, wish, toggleWish, libs, setLibs, onPickLibrary, hits }) {
  const { book, usage, coCovers, loading } = useBook(isbn, index)
  useEffect(() => {
    if (book) setPageMeta(`${shortTitle(book.title)}${cleanAuthor(book.author) ? ' — ' + cleanAuthor(book.author) : ''} | 책콕`, `/book/${book.isbn13}`)
  }, [book])
  const buyRef = useRef(null)
  const [libOpen, setLibOpen] = useState(false)
  const [heartKey, setHeartKey] = useState(0)
  const p = useCountUp(isbn)
  const stateMap = useContext(StateCtx)
  const back = () => (window.history.length > 1 ? window.history.back() : go('/'))
  if (!book) {
    return (
      <div className="detail">
        <header className="detail__bar">
          <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        </header>
        {loading ? <Loading /> : <p className="state">책 정보를 찾지 못했어요.</p>}
      </div>
    )
  }
  const saved = wish.some((w) => w.isbn13 === book.isbn13)
  const keywords = (usage?.keywords || []).slice(0, 8)
  const co = (usage?.co_loan || []).slice(0, 10)
  const st = stateMap.get(book.isbn13)
  const stats = [
    { label: '모멘텀', value: book.score != null ? (Number(book.score) * p).toFixed(1) : '-', unit: book.score != null ? '점' : '' },
    st?.rank_now != null
      ? { label: `${st.cat || '분야'} 순위`, value: st.rank_now, unit: '위', tone: st.rank_now <= 10 ? 'hl' : '' }
      : { label: '분야 순위', value: '순위 밖', unit: '', small: true },
    {
      label: '30일 대출',
      value: book.loan_count != null ? Math.round(book.loan_count * p).toLocaleString() : '-',
      unit: book.loan_count != null ? '회' : '',
    },
  ]
  const eyebrow = st?.stage ? `STAGE · ${st.stage}` : book.rank_diff ? `RISING · ▲${book.rank_diff}` : book.trendType === 'recommended' ? 'LIBRARIAN PICK' : book.score != null ? "TODAY'S KOK" : null
  const onHeart = () => {
    toggleWish(book)
    setHeartKey((k) => k + 1)
  }

  return (
    <div className="detail">
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        <button className={`iconbtn heartbtn${saved ? ' is-saved' : ''}`} onClick={onHeart} aria-pressed={saved} aria-label={saved ? '콕 해제' : '콕하기'}>
          {saved && heartKey > 0 && (
            <span className="sparks" key={'s' + heartKey} aria-hidden="true">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <i key={i} style={{ '--a': `${i * 45}deg` }} />
              ))}
            </span>
          )}
          <span key={heartKey} className={heartKey ? 'heartpop' : ''}>
            {Icon.ginkgo(saved, 26)}
          </span>
        </button>
      </header>
      <div className="stack">
        <section className="card hero">
          <div className="hero__top">
            <span className="hero__coverwrap tilt" key={'c' + isbn}>
              <Cover src={book.cover_url} alt={shortTitle(book.title)} className="hero__cover" title={book.title} />
              <span className="spine" aria-hidden="true" />
            </span>
            <div className="hero__text">
              {eyebrow && (
                <span className="rise" style={{ animationDelay: '0.12s' }}>
                  <Eyebrow tone={st?.stage ? { 포착: 'spot', 떠오름: 'up' }[st.stage] : book.rank_diff ? 'up' : undefined}>{eyebrow}</Eyebrow>
                </span>
              )}
              <h1 className="hero__title display rise" style={{ animationDelay: '0.18s' }}>
                {shortTitle(book.title)}
              </h1>
              <span className="sub rise" style={{ animationDelay: '0.24s' }}>
                <b className="hero__author">{cleanAuthor(book.author)}</b>
                {book.classNameFull ? ` · ${book.classNameFull.split('>').slice(0, 2).join(' > ')}` : ''}
              </span>
              {keywords.length > 0 && (
                <div className="hero__tags">
                  {keywords.slice(0, 6).map((k, i) => (
                    <a key={k.word} href={keywordHref(k.word)} className={`tag tag--sm tag--btn pop${i < 2 ? ' tag--accent' : ''}`} style={delay(i, 0.3, 0.06)}>
                      <span className="tag__hash">#</span>
                      {k.word}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
          {book.external && (
            <p className="notice notice--box hero__ext">아직 책콕 순위 기록이 없는 책이에요. 기본 정보와 표지는 도서관 정보나루 도서 정보예요.</p>
          )}
          {st?.stage && (
            <div className="stagebar rise" style={{ animationDelay: '0.28s' }}>
              <div className="stagebar__steps" role="img" aria-label={`트렌드 단계: ${st.stage}`}>
                {STAGES.map((s) => (
                  <span key={s} data-tone={STAGE_TONE[s]} className={`stagebar__step${s === st.stage ? ' is-on' : ''}`}>
                    {s}
                  </span>
                ))}
              </div>
              {st.reason && <p className="stagebar__reason">{st.reason}</p>}
              <p className="stagebar__meta">
                {st.confidence && (
                  <span>
                    신뢰도 <b>{st.confidence}</b>
                  </span>
                )}
                {st.first_spotted && st.stage !== '스테디' && (
                  <span>
                    책콕이 <b>{fmtDate(st.first_spotted)}</b> 처음 포착
                  </span>
                )}
              </p>
              {st.stage !== '스테디' && <WhyRising isbn={book.isbn13} />}
            </div>
          )}
          <div className="statgrid rise" style={{ animationDelay: '0.3s' }}>
            {stats.map((s) => (
              <div key={s.label}>
                <span>{s.label}</span>
                <strong className={`num${s.small ? ' is-small' : ''}`}>
                  {s.tone === 'hl' ? <span className="hl">{s.value}</span> : s.value}
                  {s.unit && <small>{s.unit}</small>}
                </strong>
              </div>
            ))}
          </div>
          <RankChart isbn={book.isbn13} firstSpotted={st?.first_spotted} hit={hits?.get(book.isbn13)} embedded />
        </section>

        <LoanChart history={usage?.loan_history} motionKey={isbn + (usage ? 'u' : '')} />
        <Groups groups={usage?.loan_grps} />

        {co.length > 0 && (
          <section className="card card--bleed rise" style={{ animationDelay: '0.55s' }}>
            <Eyebrow>ALSO BORROWED</Eyebrow>
            <h2 className="h2 display">함께 빌린 책</h2>
            <p className="sub">이 책을 빌린 사람들이 같이 빌린 책 · 도서관 대출 기록 기준</p>
            <div className="hscroll">
              {co.map((c) => (
                <a key={c.isbn13 || c.title} className="mini" href={`/book/${encodeURIComponent(c.isbn13)}`}>
                  <Cover src={coCovers[c.isbn13] || index.get(c.isbn13)?.cover_url} alt="" className="mini__cover" title={c.title} />
                  <span className="mini__title">{shortTitle(c.title)}</span>
                  <span className="mini__author">{cleanAuthor(c.author)}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {!loading && !usage && (
          <section className="card">
            <p className="sub">대출 추이와 같이 빌린 책은 상위권 책부터 매일 채워지고 있어요.</p>
          </section>
        )}

        <section className="card" id="buy" ref={buyRef}>
          <Eyebrow>WHERE TO BUY</Eyebrow>
          <h2 className="h2 display">어디서 살까요</h2>
          <p className="sub buy__lead">새 책은 도서정가제로 서점마다 가격이 거의 같아요. 배송·적립 혜택을 비교해 보세요.</p>
          <div className="buy__book">
            <Cover src={book.cover_url} alt="" className="buy__cover" title={book.title} />
            <span className="buy__info">
              <strong>{shortTitle(book.title)}</strong>
              <span className="num">ISBN {firstIsbn(book.isbn13)}</span>
            </span>
            <CopyIsbn isbn={firstIsbn(book.isbn13)} />
          </div>
          <div className="shops">
            {shopLinks(book.isbn13).map((s, i) => (
              <a key={s.id} className="shop rise" style={delay(i, 0.05, 0.04)} href={s.url} target="_blank" rel="noopener noreferrer sponsored">
                <ShopLogo shop={s} />
                <span className="shop__text">
                  <span className="shop__name">{s.name}</span>
                </span>
                <span className={`shop__tag${s.direct ? ' is-direct' : ''}`}>{s.direct ? '바로가기' : '검색'}</span>
                <span className="shop__chev">{Icon.chev()}</span>
              </a>
            ))}
          </div>
          {COUPANG_BANNER && (
            <a className="adbanner" href={COUPANG_BANNER.href} target="_blank" rel="noopener sponsored" referrerPolicy="unsafe-url">
              <img src={COUPANG_BANNER.img} alt={COUPANG_BANNER.alt} width={COUPANG_BANNER.w} height={COUPANG_BANNER.h} loading="lazy" />
            </a>
          )}
          {COUPANG_AFFILIATE && <p className="notice notice--below">{AFFILIATE_NOTICE}</p>}
        </section>
      </div>

      <div className="actionbar">
        <button className="btn btn--soft" onClick={() => buyRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          구매하기
        </button>
        <button className="btn btn--primary" onClick={() => setLibOpen(true)}>
          도서관에서 빌리기
        </button>
      </div>
      {libOpen && (
        <LibraryStatusSheet
          book={book}
          libs={libs}
          setLibs={setLibs}
          onClose={() => setLibOpen(false)}
          onPick={() => {
            setLibOpen(false)
            onPickLibrary()
          }}
        />
      )}
    </div>
  )
}

/* ================= 검색 ================= */

// 책콕이 모은 책에서 제목·저자로 찾기 (검색 화면과 PC 사이드바 검색칸이 같이 쓴다)
function useBookSearch(q, { min = 2, limit = 40, wait = 300 } = {}) {
  const [res, setRes] = useState({ list: [], loading: false, done: false })
  useEffect(() => {
    const term = q.replace(/[%,()*]/g, ' ').trim()
    if (term.length < min) return setRes({ list: [], loading: false, done: false })
    let off = false
    setRes((r) => ({ ...r, loading: true }))
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('books')
        .select('isbn13,title,author,class_name,cover_url,addition_symbol')
        .or(`title.ilike.%${term}%,author.ilike.%${term}%`)
        .limit(limit)
      if (off) return
      const low = term.toLowerCase()
      const list = (data || [])
        .map((r) => ({
          isbn13: r.isbn13,
          title: r.title,
          author: r.author,
          classNameFull: r.class_name,
          additionSymbol: r.addition_symbol,
          categoryLabel: isChildBook({ additionSymbol: r.addition_symbol }) ? '어린이 책' : categoryLabel(r.class_name),
          cover_url: r.cover_url,
        }))
        // 제목이 검색어로 시작하는 책 → 제목에 들어간 책 → 저자만 맞는 책 순서
        .map((b, i) => {
          const t = shortTitle(b.title).toLowerCase()
          return { b, k: t.startsWith(low) ? 0 : t.includes(low) ? 1 : 2, i }
        })
        .sort((a, b) => a.k - b.k || a.i - b.i)
        .map((x) => x.b)
      setRes({ list, loading: false, done: true })
    }, wait)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [q, min, limit, wait])
  return res
}

// 검색어와 같은 부분을 형광펜으로
function Mark({ text, term }) {
  const t = term.trim()
  const i = t ? text.toLowerCase().indexOf(t.toLowerCase()) : -1
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="hlmark">{text.slice(i, i + t.length)}</mark>
      {text.slice(i + t.length)}
    </>
  )
}

// PC 사이드바 검색칸: 누르면 바로 입력, 쓰는 동안 아래에 관련 책을 띄운다
function SideSearch() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(-1)
  const res = useBookSearch(q, { min: 1, limit: 30, wait: 180 })
  const items = res.list.slice(0, 7)
  const term = q.trim()
  const showAll = term.length >= 1
  const total = items.length + (showAll ? 1 : 0)
  useEffect(() => setSel(-1), [q])
  const pick = (i) => {
    if (i >= 0 && i < items.length) go(`/book/${encodeURIComponent(items[i].isbn13)}`)
    else if (term) go(`/search?q=${encodeURIComponent(term)}`)
    else return
    setOpen(false)
    setQ('')
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setSel((v) => (total ? (v + 1) % total : -1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((v) => (total ? (v - 1 + total) % total : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(sel >= 0 ? sel : items.length)
    } else if (e.key === 'Escape') {
      setOpen(false)
      e.currentTarget.blur()
    }
  }
  const shown = open && term.length >= 1
  return (
    <div className="sidesearch">
      <label className="sidenav__search">
        {Icon.search()}
        <span className="sr-only">책 제목, 작가 검색</span>
        <input
          type="search"
          value={q}
          placeholder="책 제목, 작가 검색"
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={shown}
          aria-controls="sidesearch-list"
          aria-autocomplete="list"
          aria-activedescendant={sel >= 0 ? `sidesearch-${sel}` : undefined}
        />
      </label>
      {shown && (
        <div className="sidesearch__pop" id="sidesearch-list" role="listbox">
          {res.loading && items.length === 0 && <p className="sidesearch__state">찾는 중이에요…</p>}
          {!res.loading && res.done && items.length === 0 && <p className="sidesearch__state">책콕에 없는 책이에요. 다른 단어로 찾아보세요.</p>}
          {items.map((b, i) => (
            <button
              key={b.isbn13}
              id={`sidesearch-${i}`}
              type="button"
              role="option"
              aria-selected={sel === i}
              className={`sidesearch__item${sel === i ? ' is-sel' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <Cover src={b.cover_url} alt="" className="sidesearch__cover" title={b.title} />
              <span className="sidesearch__text">
                <span className="sidesearch__title">
                  <Mark text={shortTitle(b.title)} term={term} />
                </span>
                <span className="sidesearch__meta">
                  <Mark text={cleanAuthor(b.author)} term={term} /> · {b.categoryLabel}
                </span>
              </span>
            </button>
          ))}
          {showAll && (
            <button
              type="button"
              id={`sidesearch-${items.length}`}
              role="option"
              aria-selected={sel === items.length}
              className={`sidesearch__all${sel === items.length ? ' is-sel' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSel(items.length)}
              onClick={() => pick(items.length)}
            >
              ‘{term}’ 검색 결과 모두 보기 {Icon.chev()}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Search() {
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') || '')
  const res = useBookSearch(q, { min: 1 })
  return (
    <>
      <header className="searchbar">
        <button className="iconbtn" onClick={() => (window.history.length > 1 ? window.history.back() : go('/'))} aria-label="뒤로">
          {Icon.back()}
        </button>
        <label className="search search--bar">
          <span className="sr-only">책 제목이나 저자</span>
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="책 제목이나 저자" />
        </label>
      </header>
      <div className="list">
        {q.trim().length < 1 && <p className="state">책 제목이나 저자를 입력해 주세요. 책콕이 모은 책 중에서 찾아요.</p>}
        {res.loading && <Loading />}
        {!res.loading && res.done && res.list.length === 0 && <p className="state">찾는 책이 없어요. 다른 단어로 검색해 보세요.</p>}
        {!res.loading && res.list.map((b) => <BookRow key={b.isbn13} rank={null} book={b} value="" />)}
      </div>
    </>
  )
}

/* ================= 키워드 ================= */

function KeywordPage({ word, index }) {
  const wide = useWide()
  const [kwMore, setKwMore] = useState(false)
  const [res, setRes] = useState({ loading: true, list: [], related: [], error: null })
  useEffect(() => setPageMeta(`#${word} 관련 요즘 책 | 책콕`, `/keyword/${encodeURIComponent(word)}`), [word])
  const ready = index.size > 0
  useEffect(() => {
    let off = false
    setRes({ loading: true, list: [], related: [], error: null })
    async function run() {
      const { data, error } = await supabase
        .from('v_keyword_books')
        .select('isbn13,weight,title,author,class_name,cover_url,addition_symbol,momentum')
        .eq('word', word)
        .limit(80)
      if (off) return
      if (error) return setRes({ loading: false, list: [], related: [], error: error.message })
      const seen = new Set()
      const list = []
      for (const r of data || []) {
        if (seen.has(r.isbn13)) continue
        seen.add(r.isbn13)
        const live = index.get(r.isbn13)
        list.push({
          ...(live || {}),
          isbn13: r.isbn13,
          title: r.title,
          author: r.author,
          classNameFull: r.class_name,
          additionSymbol: r.addition_symbol,
          categoryLabel: categoryLabel(r.class_name),
          cover_url: r.cover_url,
          momentum: r.momentum != null ? Number(r.momentum) : null,
          weight: Number(r.weight) || 0,
        })
      }
      // 키워드 데이터가 아직 없는 요즘 책 중 제목에 이 단어가 들어간 책도 함께
      for (const b of index.values()) {
        if (list.length >= 40) break
        if (seen.has(b.isbn13) || isChildBook(b) || !(b.title || '').includes(word)) continue
        seen.add(b.isbn13)
        list.push({ ...b, momentum: b.score != null ? Number(b.score) : null, weight: 0, byTitle: true })
      }
      list.sort((a, b) => (b.momentum ?? -1) - (a.momentum ?? -1) || b.weight - a.weight)

      // 이 책들에 함께 나온 다른 키워드
      let related = []
      const ids = (data || []).map((r) => r.isbn13).slice(0, 40)
      if (ids.length > 1) {
        const rel = await supabase.from('v_keyword_books').select('word,isbn13').in('isbn13', ids).neq('word', word).limit(1000)
        if (off) return
        const cnt = new Map()
        const pairs = new Set()
        for (const r of rel.data || []) {
          const k = r.word + '|' + r.isbn13
          if (pairs.has(k)) continue
          pairs.add(k)
          cnt.set(r.word, (cnt.get(r.word) || 0) + 1)
        }
        related = [...cnt.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w)
      }
      setRes({ loading: false, list, related, error: null })
    }
    run()
    return () => {
      off = true
    }
    // 피드가 늦게 오면 한 번 더 (제목 일치 책과 순위 정보를 붙이려고)
  }, [word, ready]) // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => (window.history.length > 1 ? window.history.back() : go('/'))
  const tagged = res.list.filter((b) => !b.byTitle).length
  // 넓은 화면: 트렌드와 같은 갤러리형
  if (wide) {
    const n = res.list.length
    return (
      <section className="card gal kwgal">
        <button className="iconbtn kwgal__back" onClick={back} aria-label="뒤로">
          {Icon.back()}
        </button>
        <i className="gal__line" aria-hidden="true" />
        <div className="gal__bar">
          <div>
            <p className="kwgal__label">이 단어가 들어간 요즘 책</p>
            <h1 className="gal__title kwgal__title">
              <span className="kwgal__hash">#</span>
              <span className="kwgal__word">{word}</span>
            </h1>
            <p className="sub gal__desc">{res.loading ? '관련 책을 모으는 중이에요' : n ? `관련 책 ${n}권 · 요즘 뜨는 순서` : '아직 관련 책이 없어요'}</p>
          </div>
        </div>
        {res.related.length > 0 && (
          <div className="gal__cats kwgal__related">
            <span className="kwgal__rlabel">함께 나온 키워드</span>
            {res.related.map((w) => (
              <a key={w} className="gal__cat" href={keywordHref(w)}>
                #{w}
              </a>
            ))}
          </div>
        )}
        {res.loading && <Loading />}
        {res.error && <p className="state state--error">책을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.</p>}
        {!res.loading && !res.error && n === 0 && (
          <div className="empty">
            <p>이 키워드로 모인 책이 아직 없어요.</p>
            <p className="sub">키워드는 매일 아침 새 데이터로 다시 모여요.</p>
            <a className="btn btn--soft" href="/trend">트렌드 보러 가기</a>
          </div>
        )}
        {!res.loading && n > 0 && (
          <div className="gal__grid">
            {res.list.slice(0, kwMore ? n : 15).map((b, i) => (
              <GalleryItem key={b.isbn13} book={b} rank={i + 1} value={[b.momentum != null ? `${Math.round(b.momentum)}점` : '']} />
            ))}
          </div>
        )}
        {!res.loading && !kwMore && n > 15 && (
          <button className="gal__more" onClick={() => setKwMore(true)}>
            More +
          </button>
        )}
      </section>
    )
  }
  return (
    <>
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
      </header>
      <header className="pagehead pagehead--tight">
        <Eyebrow>KEYWORD</Eyebrow>
        <h1 className="h1 display kwpage__title">
          <span className="tag__hash">#</span>
          {word}
        </h1>
        <span className="sub">
          {res.loading ? '관련 책을 모으는 중이에요' : res.list.length ? `관련 책 ${res.list.length}권 · 요즘 뜨는 순서` : '아직 관련 책이 없어요'}
        </span>
      </header>
      <div className="stack">
        {res.related.length > 0 && (
          <section className="card">
            <p className="label">함께 나온 키워드</p>
            <div className="chips chips--wrap">
              {res.related.map((w, i) => (
                <a key={w} className="tag tag--sm tag--btn pop" style={delay(i, 0.05, 0.04)} href={keywordHref(w)}>
                  <span className="tag__hash">#</span>
                  {w}
                </a>
              ))}
            </div>
          </section>
        )}
        <section className="card card--list">
          {res.loading && <Loading />}
          {res.error && <p className="state state--error">책을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.</p>}
          {!res.loading && !res.error && res.list.length === 0 && (
            <div className="empty">
              <p>이 키워드로 모인 책이 아직 없어요.</p>
              <p className="sub">키워드는 매일 아침 새 데이터로 다시 모여요.</p>
              <a className="btn btn--soft" href="/trend">트렌드 보러 가기</a>
            </div>
          )}
          {!res.loading &&
            res.list.map((b, i) => (
              <BookRow key={b.isbn13} rank={i + 1} order={i} book={b} value={b.momentum != null ? `${Math.round(b.momentum)}점` : ''} />
            ))}
        </section>
        {!res.loading && res.list.length > 0 && (
          <p className="foot">
            도서관 정보나루가 책마다 뽑은 핵심 키워드 기준이에요{tagged < res.list.length ? '. 제목에 이 단어가 들어간 요즘 책도 함께 보여줘요' : ''}. 점수는 모멘텀이에요.
          </p>
        )}
      </div>
    </>
  )
}

/* ================= 알림 ================= */

// 휴대폰 알림(Web Push) 공개키. 비밀키는 Supabase Vault에만 있다.
const PUSH_PUBLIC_KEY = 'BEGvGNmo3Wtc3LsB6VeR1lR9KV-xpAztk1HQVxVRblmJaOupnaCZKDpj1nF-XxK2vLQ8oaau2Sixkj5hPtQZ4sk'
const ALERT_TYPES = [
  { id: 'wish', label: '콕한 책 트렌드 알림', desc: '콕한 책이 떠오름·확산·스테디 단계로 올라가면' },
  { id: 'keyword', label: '이달의 키워드 알림', desc: '홈의 1위 키워드가 바뀌면' },
  { id: 'interest', label: '관심 분야 새 책 알림', desc: '관심 분야에서 새로 포착된 책이 생기면' },
]
const STAGE_RANK = { 포착: 1, 떠오름: 2, 확산: 3, 스테디: 4 }
// 받침에 맞는 조사: josa('사랑', '이', '가') -> '이'
function josa(word, withFinal, without) {
  const ch = String(word || '').trim().slice(-1)
  const code = ch.charCodeAt(0) - 0xac00
  if (code < 0 || code > 11171) return without
  const fin = code % 28
  if (withFinal === '으로' && fin === 8) return without // ㄹ 받침은 '로'
  return fin ? withFinal : without
}
const MAX_ALERTS = 50

function pushSupport() {
  try {
    const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true
    if (ios && !standalone) return 'ios-home'
    return ok ? 'ok' : 'no'
  } catch (_e) {
    return 'no'
  }
}
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  return reg ? reg.pushManager.getSubscription() : null
}
async function savePush(sub, extra) {
  const { error } = await supabase.functions.invoke('push-subscribe', { body: { subscription: sub.toJSON(), ...extra } })
  if (error) throw error
}

// 앱을 열 때마다, 지난번에 본 상태와 비교해 새 소식을 만든다 (이 기기에만 저장)
function useAlerts({ states, statesDate, keywords, wish, interests, index, feedReady }) {
  const [prefs, setPrefs] = useStored('chaekkok.alertPrefs', { wish: true, keyword: true, interest: true })
  const [alerts, setAlerts] = useStored('chaekkok.alerts', [])
  const [base, setBase] = useStored('chaekkok.alertBase', null)
  const topKw = keywords?.words?.[0]?.word || null

  useEffect(() => {
    if (!statesDate || !feedReady) return
    const stageOf = (i) => states.get(i)?.stage || ''
    if (!base) {
      setBase({ date: statesDate, keyword: topKw, stages: Object.fromEntries(wish.map((w) => [w.isbn13, stageOf(w.isbn13)])) })
      return
    }
    if (base.date === statesDate) {
      // 오늘 새로 콕한 책은 기준만 기록해 둔다 (소식 없음)
      const missing = wish.filter((w) => !(w.isbn13 in (base.stages || {})))
      if (missing.length || (!base.keyword && topKw)) {
        setBase({
          ...base,
          keyword: base.keyword || topKw,
          stages: { ...(base.stages || {}), ...Object.fromEntries(missing.map((w) => [w.isbn13, stageOf(w.isbn13)])) },
        })
      }
      return
    }
    if (base.date > statesDate) return
    const fresh = []
    const at = statesDate
    if (prefs.wish) {
      for (const w of wish) {
        if (!(w.isbn13 in (base.stages || {}))) continue
        const cur = stageOf(w.isbn13)
        const prev = base.stages[w.isbn13]
        if (['떠오름', '확산', '스테디'].includes(cur) && STAGE_RANK[cur] > (STAGE_RANK[prev] || 0)) {
          const st = states.get(w.isbn13)
          fresh.push({
            id: `${at}:wish:${w.isbn13}:${cur}`,
            type: 'wish',
            date: at,
            stage: cur,
            text: `『${shortTitle(w.title)}』${josa(shortTitle(w.title), '이', '가')} ${cur} 단계가 됐어요`,
            sub: st?.reason || '',
            url: `/book/${w.isbn13}`,
          })
        }
      }
    }
    if (prefs.keyword && topKw && base.keyword && topKw !== base.keyword) {
      fresh.push({
        id: `${at}:keyword:${topKw}`,
        type: 'keyword',
        date: at,
        text: `이달의 키워드가 #${topKw}${josa(topKw, '으로', '로')} 바뀌었어요`,
        sub: `지난번엔 #${base.keyword}${josa(base.keyword, '이었어요', '였어요')}`,
        url: `/keyword/${encodeURIComponent(topKw)}`,
      })
    }
    if (prefs.interest && interests.length) {
      const picks = []
      for (const [isbn, st] of states) {
        if (!st.stage || !st.first_spotted || st.first_spotted <= base.date || st.first_spotted > at) continue
        const b = index.get(isbn)
        if (!b) continue
        const cat = isChildBook(b) ? '어린이' : b.categoryLabel
        if (interests.includes(cat)) picks.push({ isbn13: isbn, title: b.title, cover_url: b.cover_url, cat })
      }
      if (picks.length) {
        const cats = [...new Set(picks.map((p) => p.cat))]
        fresh.push({
          id: `${at}:interest:${cats.join(',')}`,
          type: 'interest',
          date: at,
          text: `관심 분야에서 새로 포착된 책 ${picks.length}권`,
          sub: cats.join(' · '),
          books: picks.slice(0, 5),
          url: `/book/${picks[0].isbn13}`,
        })
      }
    }
    if (fresh.length) {
      setAlerts((list) => {
        const ids = new Set(list.map((a) => a.id))
        return [...fresh.filter((a) => !ids.has(a.id)).map((a) => ({ ...a, read: false })), ...list].slice(0, MAX_ALERTS)
      })
    }
    setBase({ date: statesDate, keyword: topKw || base.keyword, stages: Object.fromEntries(wish.map((w) => [w.isbn13, stageOf(w.isbn13)])) })
  }, [statesDate, feedReady, topKw, wish, interests, prefs, base]) // eslint-disable-line react-hooks/exhaustive-deps

  const unread = alerts.filter((a) => !a.read).length
  const markRead = () => setAlerts((list) => (list.some((a) => !a.read) ? list.map((a) => ({ ...a, read: true })) : list))
  const clear = () => setAlerts([])
  // 다른 곳(적중 계산 등)에서 만든 소식을 한 번만 넣는다
  const addAlerts = (items) =>
    setAlerts((list) => {
      const ids = new Set(list.map((a) => a.id))
      const fresh = items.filter((a) => !ids.has(a.id)).map((a) => ({ ...a, read: false }))
      return fresh.length ? [...fresh, ...list].slice(0, MAX_ALERTS) : list
    })
  return { prefs, setPrefs, alerts, unread, markRead, clear, addAlerts }
}

// 휴대폰 알림 켜기·끄기, 콕한 책·관심 분야가 바뀌면 서버의 구독 정보도 맞춰 둔다
function usePush({ prefs, wish, interests }) {
  const [on, setOn] = useStored('chaekkok.push', false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const support = useMemo(pushSupport, [])
  const payload = { prefs, wish: wish.map((w) => w.isbn13), interests }
  const key = JSON.stringify(payload)

  useEffect(() => {
    if (!on || support !== 'ok') return
    const t = setTimeout(async () => {
      try {
        const sub = await currentSubscription()
        if (!sub) return setOn(false) // 브라우저에서 알림 권한을 끈 경우
        await savePush(sub, payload)
      } catch (_e) {
        // 다음에 다시 맞춘다
      }
    }, 1500)
    return () => clearTimeout(t)
  }, [on, key]) // eslint-disable-line react-hooks/exhaustive-deps

  const enable = async () => {
    setBusy(true)
    setMsg('')
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setMsg('알림 권한이 꺼져 있어요. 브라우저 설정에서 책콕 알림을 허용해 주세요.')
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      await navigator.serviceWorker.ready
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(PUSH_PUBLIC_KEY) }))
      await savePush(sub, payload)
      setOn(true)
      setMsg('휴대폰 알림을 켰어요. 매일 아침 새 소식이 있을 때만 보내요.')
    } catch (_e) {
      setMsg('알림을 켜지 못했어요. 잠시 뒤 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }
  const disable = async () => {
    setBusy(true)
    setMsg('')
    try {
      const sub = await currentSubscription()
      if (sub) {
        await supabase.functions.invoke('push-subscribe', { body: { action: 'unsubscribe', subscription: { endpoint: sub.endpoint } } })
        await sub.unsubscribe()
      }
    } catch (_e) {
      // 이미 해제된 경우
    } finally {
      setOn(false)
      setBusy(false)
      setMsg('휴대폰 알림을 껐어요.')
    }
  }
  return { on, busy, msg, support, enable, disable }
}

function Alerts({ alerts, markRead, clear }) {
  // 들어와서 보면 읽음 처리 (화면에는 이번에 새로 온 표시를 남겨 둠)
  const [fresh] = useState(() => new Set(alerts.filter((a) => !a.read).map((a) => a.id)))
  useEffect(() => {
    markRead()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => (window.history.length > 1 ? window.history.back() : go('/'))
  const TONE = { wish: 'ginkgo', hit: 'ginkgo', keyword: 'kw', interest: 'spot' }
  return (
    <>
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        <a className="pill pill--btn alerts__set" href="/my">알림 설정</a>
      </header>
      <header className="pagehead pagehead--tight">
        <Eyebrow>NOTIFICATIONS</Eyebrow>
        <h1 className="h1 display">알림</h1>
        <span className="sub">앱을 열 때마다 지난번과 비교해서 새 소식을 모아요</span>
      </header>
      <div className="stack">
        <section className="card card--list">
          {alerts.length === 0 && (
            <div className="empty">
              <p>아직 새 소식이 없어요.</p>
              <p className="sub">책을 콕하거나 관심 분야를 고르면, 단계가 오르거나 새 책이 포착될 때 여기로 알려드려요.</p>
              <a className="btn btn--soft" href="/my">알림 설정 보기</a>
            </div>
          )}
          {alerts.map((a, i) => (
            <a key={a.id} className={`alert rise${fresh.has(a.id) ? ' is-new' : ''}`} style={delay(i, 0.05, 0.04)} href={a.url}>
              <span className={`alert__icon alert__icon--${TONE[a.type] || 'kw'}`} aria-hidden="true">
                {a.type === 'wish' || a.type === 'hit' ? Icon.ginkgo(true, 20) : a.type === 'keyword' ? '#' : Icon.trend(true)}
              </span>
              <span className="alert__body">
                <span className="alert__text">{a.text}</span>
                {a.sub && <span className="alert__sub">{a.stage && <StageBadge stage={a.stage} />}{a.sub}</span>}
                {a.books?.length > 0 && (
                  <span className="alert__books">
                    {a.books.slice(0, 3).map((b) => shortTitle(b.title)).join(' · ')}
                    {a.books.length > 3 ? ` 외 ${a.books.length - 3}권` : ''}
                  </span>
                )}
                <span className="alert__date">{fmtDate(a.date)} 데이터 기준</span>
              </span>
              {fresh.has(a.id) && <i className="alert__dot" aria-label="새 소식" />}
            </a>
          ))}
        </section>
        {alerts.length > 0 && (
          <button className="btn btn--soft btn--full alerts__clear" onClick={clear}>
            알림 모두 지우기
          </button>
        )}
      </div>
    </>
  )
}

// 알림 설정: 마이 탭 오른쪽 위 톱니바퀴 → 항목 목록 → 항목을 누르면 설명과 켜기/끄기
function AlertSettingsSheet({ alertState, push, onClose }) {
  return (
    <Sheet label="알림 설정" onClose={onClose}>
      <div className="sheet__head">
        <div>
          <h2 className="h2">알림 설정</h2>
          <p className="sub">스위치를 밀어 켜고 끌 수 있어요</p>
        </div>
      </div>
      <AlertToggles alertState={alertState} push={push} />
    </Sheet>
  )
}

// 알림 스위치 목록 (시트와 넓은 화면 옆 칸에서 같이 쓴다)
function AlertToggles({ alertState, push }) {
  const { prefs, setPrefs } = alertState
  const pushDesc =
    push.support === 'ios-home'
      ? '아이폰은 Safari 공유 버튼 → 홈 화면에 추가한 뒤, 홈 화면의 책콕에서 켤 수 있어요.'
      : push.support === 'no'
        ? '이 브라우저는 휴대폰 알림을 지원하지 않아요. 알림은 앱 안 종 모양에서 볼 수 있어요.'
        : '매일 아침 새 소식이 있을 때만 한 번 보내요. 앱을 닫아 둬도 받을 수 있어요.'
  const items = [
    ...ALERT_TYPES.map((t) => ({ id: t.id, label: t.label, desc: t.desc + ' 알려드려요.', on: !!prefs[t.id], toggle: () => setPrefs({ ...prefs, [t.id]: !prefs[t.id] }), disabled: false, busy: false })),
    { id: 'push', label: '휴대폰 알림', desc: pushDesc, on: push.on, toggle: push.on ? push.disable : push.enable, disabled: push.support !== 'ok' || push.busy, busy: push.busy },
  ]
  return (
    <>
      <div className="setlist">
        {items.map((it) => (
          <div key={it.id} className="setrow">
            <div className="setrow__text">
              <span className="line__label">{it.label}</span>
              <span className="sub small">{it.busy ? '설정 중…' : it.desc}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={it.on}
              aria-label={it.label}
              aria-busy={it.busy}
              disabled={it.disabled}
              className={`switch${it.on ? ' is-on' : ''}${it.busy ? ' is-busy' : ''}`}
              onClick={it.toggle}
            >
              <i />
            </button>
          </div>
        ))}
      </div>
      {push.msg && <p className="sub small pushbox__msg">{push.msg}</p>}
    </>
  )
}

// 마이 ⚙: 오른쪽에서 밀려 들어오는 설정 화면
function SettingsPanel({ alertState, push, onClose }) {
  useLockBody()
  const [shown, setShown] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const close = () => {
    setShown(false)
    setTimeout(onClose, 280)
  }
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !alertsOpen && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const onCount = ALERT_TYPES.filter((t) => alertState.prefs[t.id]).length + (push.on ? 1 : 0)
  return (
    <div className={`settings${shown ? ' is-shown' : ''}`} role="dialog" aria-modal="true" aria-label="설정">
      <header className="settings__bar">
        <button className="iconbtn" onClick={close} aria-label="뒤로">{Icon.back()}</button>
        <h2 className="settings__title">설정</h2>
        <span className="settings__spacer" />
      </header>
      <div className="settings__body">
        <p className="label settings__group">알림</p>
        <div className="settings__card">
          <button type="button" className="line" onClick={() => setAlertsOpen(true)}>
            <span className="line__label">알림 설정</span>
            <span className="line__value">
              <span className="sub small">{onCount}개 켜짐</span>
              <span className="line__chev">{Icon.chev()}</span>
            </span>
          </button>
          <a className="line" href="/alerts" onClick={onClose}>
            <span className="line__label">받은 알림 보기</span>
            <span className="line__chev">{Icon.chev()}</span>
          </a>
        </div>
        <p className="label settings__group">저장</p>
        <div className="settings__card settings__note">
          <p className="sub small">콕한 책, 취향, 내 도서관은 로그인 없이 이 기기(브라우저)에만 저장돼요. 브라우저 기록을 지우면 함께 지워져요.</p>
        </div>
      </div>
      {alertsOpen && <AlertSettingsSheet alertState={alertState} push={push} onClose={() => setAlertsOpen(false)} />}
    </div>
  )
}

/* ================= 내 도서관 ================= */

const MAX_LIBS = 3

// 시트가 열려 있는 동안 뒤 화면이 같이 움직이지 않게 막는다
function useLockBody() {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])
}

function Sheet({ label, onClose, children, className = '' }) {
  useLockBody()
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
      <button className="sheet__dim" aria-label="닫기" onClick={onClose} />
      <div className={`sheet__panel ${className}`}>
        <span className="sheet__grip" aria-hidden="true" />
        {children}
      </div>
    </div>
  )
}

/* ================= 도서관 (근처 도서관 · 도서관 페이지) ================= */

const REGION_LIST = [
  ['11', '서울'], ['31', '경기'], ['23', '인천'], ['21', '부산'], ['22', '대구'], ['24', '광주'], ['25', '대전'], ['26', '울산'], ['29', '세종'],
  ['32', '강원'], ['33', '충북'], ['34', '충남'], ['35', '전북'], ['36', '전남'], ['37', '경북'], ['38', '경남'], ['39', '제주'],
]
const REGION_RE = [
  [/^서울/, '11'], [/^부산/, '21'], [/^대구/, '22'], [/^인천/, '23'], [/^광주/, '24'], [/^대전/, '25'], [/^울산/, '26'], [/^세종/, '29'],
  [/^경기/, '31'], [/^강원/, '32'], [/^(충북|충청북)/, '33'], [/^(충남|충청남)/, '34'], [/^(전북|전라북)/, '35'], [/^(전남|전라남)/, '36'],
  [/^(경북|경상북)/, '37'], [/^(경남|경상남)/, '38'], [/^제주/, '39'],
]
const regionOfAddr = (a) => REGION_RE.find(([re]) => re.test((a || '').trim()))?.[1] || null
const cityOfAddr = (a) => (a || '').trim().split(/\s+/)[1] || ''
const mapLink = (l) => (l.lat && l.lng ? `https://map.kakao.com/link/map/${encodeURIComponent(l.name)},${l.lat},${l.lng}` : `https://map.kakao.com/link/search/${encodeURIComponent(l.name)}`)
const DAY_KO = { Sunday: '일', Monday: '월', Tuesday: '화', Wednesday: '수', Thursday: '목', Friday: '금', Saturday: '토' }
const hourLabel = (h) => (h === 0 ? '자정' : h < 12 ? `오전 ${h}시` : h === 12 ? '낮 12시' : `오후 ${h - 12}시`)

function libStatus(l) {
  if (l.hasBook === false) return ['확인 안 됨', 'muted']
  if (l.loanAvailable === true) return ['대출 가능', 'up']
  if (l.loanAvailable === false) return ['대출 중', 'warn']
  return ['소장', 'muted'] // 소장 목록에는 있지만 지금 대출 가능한지는 확인 안 한 곳
}

// 한 줄 제목을 누르면 아래 내용이 펼쳐지는 칸
function Fold({ title, hint, open, onToggle, children }) {
  return (
    <div className={`fold${open ? ' is-open' : ''}`}>
      <button type="button" className="fold__head" onClick={onToggle} aria-expanded={open}>
        <span className="fold__text">
          <span className="fold__title">{title}</span>
          {hint && !open && <span className="fold__hint">{hint}</span>}
        </span>
        <span className="fold__chev" aria-hidden="true">{Icon.chev()}</span>
      </button>
      {open && <div className="fold__body">{children}</div>}
    </div>
  )
}

function NearbyLibraries({ book, libs, setLibs }) {
  const [region, setRegion] = useStored('chaekkok.region', regionOfAddr(libs[0]?.address))
  const [pos, setPos] = useState(null)
  const [locMsg, setLocMsg] = useState('')
  const [res, setRes] = useState({ loading: false, data: null, error: null })
  const [more, setMore] = useState(false)
  // 근처 도서관은 눌렀을 때만 펼치고 불러온다
  const [open, setOpen] = useState(false)
  const isbn = firstIsbn(book.isbn13)

  useEffect(() => {
    if (!open || (!pos && !region)) return
    let off = false
    setRes({ loading: true, data: null, error: null })
    supabase.functions
      .invoke('library-info', {
        body: pos
          ? { action: 'nearby', isbn, lat: pos.lat, lng: pos.lng }
          : { action: 'nearby', isbn, region, prefer: libs.map((l) => l.libCode), preferCities: [...new Set(libs.map((l) => cityOfAddr(l.address)).filter(Boolean))] },
      })
      .then(({ data, error }) => {
        if (off) return
        if (error || !data || data.error) return setRes({ loading: false, data: null, error: '지금은 도서관 정보를 불러올 수 없어요. 잠시 뒤 다시 시도해 주세요.' })
        if (pos && data.region && data.region !== region) setRegion(data.region)
        setRes({ loading: false, data, error: null })
      })
    return () => {
      off = true
    }
  }, [isbn, region, pos, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const locate = () => {
    if (!navigator.geolocation) return setLocMsg('이 기기에서는 위치를 쓸 수 없어요. 지역을 골라 주세요.')
    setLocMsg('위치를 확인하는 중이에요…')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocMsg('')
        setPos({ lat: Math.round(p.coords.latitude * 1e4) / 1e4, lng: Math.round(p.coords.longitude * 1e4) / 1e4 })
      },
      () => setLocMsg('위치 권한이 꺼져 있어요. 지역을 골라 주시면 그 지역에서 찾아볼게요.'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
    )
  }
  const toggleSave = (l) =>
    setLibs((cur) =>
      cur.some((x) => x.libCode === l.libCode)
        ? cur.filter((x) => x.libCode !== l.libCode)
        : cur.length >= MAX_LIBS
          ? cur
          : [...cur, { libCode: l.libCode, name: l.name, address: l.address, homepage: l.homepage }],
    )
  const d = res.data
  const list = d?.libs || []
  const FIRST = 5
  const shown = more ? list : list.slice(0, FIRST)
  const regionName = REGION_LIST.find(([c]) => c === (d?.region || region))?.[1]
  const sortLabel = d?.sortedBy === 'distance' ? '가까운 순' : d?.sortedBy === 'city' ? '내 도서관 근처 먼저' : '이름순'
  return (
    <Fold title="근처 도서관 찾기" hint="이 책이 있는 도서관과 대출 가능 여부" open={open} onToggle={() => setOpen(!open)}>
      <div className="nearby__controls">
        <button className={`pill pill--btn${pos ? ' is-on' : ''}`} onClick={locate}>
          내 위치로 찾기
        </button>
        <label className="nearby__region">
          <span className="sr-only">지역</span>
          <select
            value={pos ? '' : region || ''}
            onChange={(e) => {
              setPos(null)
              setRegion(e.target.value || null)
            }}
          >
            <option value="">{pos ? '내 위치 기준' : '지역 선택'}</option>
            {REGION_LIST.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {locMsg && <p className="nearby__note">{locMsg}</p>}
      {!pos && !region && <p className="nearby__note">내 위치를 켜거나 지역을 골라 주세요.</p>}
      {res.loading && <p className="state">찾는 중이에요…</p>}
      {res.error && <p className="state state--error">{res.error}</p>}
      {d && !res.loading && d.total === 0 && <p className="nearby__note">{regionName}에는 이 책을 가진 도서관이 없어요. 다른 지역을 골라 보세요.</p>}
      {d && !res.loading && d.total > 0 && (
        <>
          <p className="nearby__note">
            {regionName} <b>{d.total.toLocaleString()}곳</b> 소장 · {sortLabel}
          </p>
          <div className="libs">
            {shown.map((l) => {
              const [label, tone] = libStatus(l)
              const saved = libs.some((x) => x.libCode === l.libCode)
              return (
                <div key={l.libCode} className="lib lib--near">
                  <a className="lib__info" href={`/library/${l.libCode}`}>
                    <strong title={l.name}>{l.name}</strong>
                    <span className="sub">
                      {l.distanceKm != null ? `${l.distanceKm}km · ` : ''}
                      {l.closedToday ? '오늘 휴관 · ' : ''}
                      {l.address}
                    </span>
                  </a>
                  <span className="lib__acts">
                    <span className={`pill pill--${tone} lib__state`}>{label}</span>
                    <a className="pill pill--btn" href={mapLink(l)} target="_blank" rel="noopener noreferrer">지도</a>
                    <button className={`pill pill--btn${saved ? ' is-on' : ''}`} onClick={() => toggleSave(l)} disabled={!saved && libs.length >= MAX_LIBS} aria-pressed={saved}>
                      {saved ? '찜함' : '찜'}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
          {list.length > FIRST && !more && (
            <button className="btn btn--soft btn--full" onClick={() => setMore(true)}>
              {list.length - FIRST}곳 더 보기
            </button>
          )}
          <p className="nearby__note">대출 상태는 하루 한 번 바뀌어요. 가기 전에 전화로 확인해 보세요.</p>
        </>
      )}
    </Fold>
  )
}

function useLibraryInfo(libCode) {
  const [res, setRes] = useState({ loading: true, data: null, error: null })
  useEffect(() => {
    let off = false
    setRes({ loading: true, data: null, error: null })
    supabase.functions.invoke('library-info', { body: { action: 'library', libCode } }).then(({ data, error }) => {
      if (off) return
      if (error || !data || data.error) return setRes({ loading: false, data: null, error: '도서관 정보를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })
      setRes({ loading: false, data, error: null })
    })
    return () => {
      off = true
    }
  }, [libCode])
  return res
}

// 우리 DB에 있는 책은 책콕 상세로, 없는 책은 정보나루 상세로
function useKnownIsbns(isbns) {
  const [known, setKnown] = useState(new Set())
  const key = isbns.join(',')
  useEffect(() => {
    if (!isbns.length) return
    let off = false
    supabase
      .from('books')
      .select('isbn13')
      .in('isbn13', isbns.slice(0, 100))
      .then(({ data }) => {
        if (!off) setKnown(new Set((data || []).map((r) => r.isbn13)))
      })
    return () => {
      off = true
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return known
}

function BarRow({ items, labelOf, unit = '%' }) {
  const max = Math.max(...items.map((x) => x.loan), 1)
  const top = items.reduce((a, b) => (b.loan > a.loan ? b : a), items[0])
  return (
    <div className="bars" role="img" aria-label={`가장 많이 빌리는 때: ${labelOf(top)}`}>
      {items.map((x, i) => (
        <span key={i} className={`bars__col${x === top ? ' is-top' : ''}`}>
          <span className="bars__val num">{x.loan ? `${x.loan}${unit}` : ''}</span>
          <span className="bars__bar barup" style={{ height: `${Math.max(4, (x.loan / max) * 72)}px`, animationDelay: `${0.2 + i * 0.03}s` }} />
          <span className="bars__label">{labelOf(x, true)}</span>
        </span>
      ))}
    </div>
  )
}

// 접혀 있을 때는 첫 줄만 흐리게 살짝 보이고, 누르면 아래로 펼쳐진다
function Accordion({ open, children }) {
  const ref = useRef(null)
  const [h, setH] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setH(el.scrollHeight)
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  return (
    <div className={`accordion${open ? ' is-open' : ''}`} style={{ maxHeight: open ? h || 'none' : 56 }}>
      <div ref={ref} aria-hidden={!open} onClickCapture={(e) => !open && e.preventDefault()}>
        {children}
      </div>
    </div>
  )
}

function LibraryPage({ libCode, libs, setLibs }) {
  const { loading, data, error } = useLibraryInfo(libCode)
  const [noKids, setNoKids] = useState(true)
  const [more, setMore] = useState(false)
  const pop = (data?.popular || []).filter((b) => !noKids || !b.kids)
  const news = (data?.newBooks || []).filter((b) => !noKids || !b.kids)
  const known = useKnownIsbns([...pop.slice(0, 30), ...news.slice(0, 10)].map((b) => b.isbn13).filter(Boolean))
  const saved = libs.some((x) => x.libCode === libCode)
  const info = data?.info
  useEffect(() => {
    if (info?.name) setPageMeta(`${info.name} | 책콕`, `/library/${libCode}`)
  }, [info?.name, libCode])
  const back = () => (window.history.length > 1 ? window.history.back() : go('/my'))
  const toggleSave = () =>
    setLibs((cur) =>
      cur.some((x) => x.libCode === libCode)
        ? cur.filter((x) => x.libCode !== libCode)
        : cur.length >= MAX_LIBS
          ? cur
          : [...cur, { libCode, name: info.name, address: info.address, homepage: info.homepage }],
    )
  const hours = (data?.hours || []).filter((h) => h.hour >= 6 && h.hour <= 23)
  const days = data?.days || []
  const topHour = hours.length ? hours.reduce((a, b) => (b.loan > a.loan ? b : a)) : null
  const topDay = days.length ? days.reduce((a, b) => (b.loan > a.loan ? b : a)) : null
  const period = data?.periodDays === 30 ? '최근 30일' : data?.periodDays === 90 ? '최근 3개월' : data?.periodDays === 365 ? '최근 1년' : ''
  const bookLink = (b) => (known.has(b.isbn13) ? { href: `/book/${b.isbn13}` } : b.url ? { href: b.url, target: '_blank', rel: 'noopener noreferrer' } : null)
  const BookLine = ({ b, i, meta }) => {
    const link = bookLink(b)
    const inner = (
      <>
        {i != null && <span className={`row__rank num${i === 0 ? ' is-first' : ''}`}>{i + 1}</span>}
        <Cover src={b.cover} alt="" className="row__cover" title={b.title} />
        <span className="row__info">
          <span className="row__title">{shortTitle(b.title)}</span>
          <span className="row__meta">{[cleanAuthor(b.author), meta].filter(Boolean).join(' · ')}</span>
        </span>
      </>
    )
    return link ? (
      <a className="row" {...link}>
        {inner}
      </a>
    ) : (
      <div className="row">{inner}</div>
    )
  }
  return (
    <>
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        {info && (
          <button className={`pill pill--btn libpage__save${saved ? ' is-on' : ''}`} onClick={toggleSave} disabled={!saved && libs.length >= MAX_LIBS} aria-pressed={saved}>
            {saved ? '내 도서관 ✓' : '도서관 찜하기'}
          </button>
        )}
      </header>
      {loading && <section className="card"><Loading /></section>}
      {error && <section className="card"><p className="state state--error">{error}</p></section>}
      {info && (
        <>
          <header className="pagehead pagehead--tight">
            <Eyebrow>LIBRARY</Eyebrow>
            <h1 className="h1 display libpage__title">{info.name}</h1>
            <span className="sub">{info.address}</span>
            <span className="lib__badges">
              {info.closedToday && <span className="pill pill--warn">오늘 휴관</span>}
              {data.fresh && <span className="pill pill--up">최근 데이터 있음</span>}
            </span>
          </header>
          <div className="stack libpage__stack">
            <section className="card rise">
              <div className="libpage__acts">
                <a className="btn btn--soft" href={mapLink(info)} target="_blank" rel="noopener noreferrer">지도 보기</a>
                {info.tel && <a className="btn btn--soft" href={`tel:${info.tel.replace(/[^\d-]/g, '')}`}>전화하기</a>}
                {info.homepage && <a className="btn btn--soft" href={info.homepage} target="_blank" rel="noopener noreferrer">홈페이지</a>}
              </div>
              {info.operatingTime && (
                <div className="libpage__row">
                  <span className="label">운영시간</span>
                  <p>{info.operatingTime}</p>
                </div>
              )}
              {info.closed && (
                <div className="libpage__row">
                  <span className="label">휴관일</span>
                  <p>{info.closed}</p>
                </div>
              )}
              {data.bookCount != null && (
                <div className="libpage__row">
                  <span className="label">장서</span>
                  <p className="num">{data.bookCount.toLocaleString()}권</p>
                </div>
              )}
              <p className="sub small">운영 정보는 정보나루에 등록된 내용이에요. 공휴일·임시 휴관은 도서관 홈페이지에서 확인해 주세요.</p>
            </section>

            {!data.fresh && (
              <section className="card">
                <p className="notice notice--box">이 도서관은 최근 대출 기록이 정보나루에 충분히 올라오지 않았어요. 아래 인기 책은 기간을 넓혀({period}) 보여드려요.</p>
              </section>
            )}

            {(hours.length > 0 || days.length > 0) && (
              <section className="card rise" style={{ animationDelay: '0.1s' }}>
                <Eyebrow>BUSY TIME</Eyebrow>
                <h2 className="h2 display">언제 많이 빌릴까요</h2>
                {topHour && (
                  <p className="sub">
                    {topDay && (
                      <>
                        요일은 <b>{DAY_KO[topDay.day] || topDay.day}요일</b>,{' '}
                      </>
                    )}
                    시간은 <b>{hourLabel(topHour.hour)}</b> 무렵에 대출이 가장 많아요. 한산할 때 가고 싶다면 이때를 피해 보세요.
                  </p>
                )}
                {hours.length > 0 && (
                  <>
                    <p className="label">시간대별</p>
                    <BarRow items={hours} labelOf={(x, short) => (short ? `${x.hour}` : hourLabel(x.hour))} />
                  </>
                )}
                {days.length > 0 && (
                  <>
                    <p className="label">요일별</p>
                    <BarRow items={days} labelOf={(x) => DAY_KO[x.day] || x.day} />
                  </>
                )}
                <p className="sub small">정보나루가 집계한 이 도서관의 전체 대출 중 시간대·요일별 비율(%)이에요.</p>
              </section>
            )}

            {data.popular?.length > 0 && (
              <section className="card card--list rise" style={{ animationDelay: '0.15s' }}>
                <div className="card__head">
                  <div className="titlegroup">
                    <Eyebrow tone="up">POPULAR HERE</Eyebrow>
                    <h2 className="h2 display">이 도서관 인기 책</h2>
                  </div>
                  <label className="kidsswitch">
                    <span>어린이 책 제외</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={noKids}
                      aria-label="어린이 책 제외"
                      className={`switch${noKids ? ' is-on' : ''}`}
                      onClick={() => setNoKids(!noKids)}
                    >
                      <i />
                    </button>
                  </label>
                </div>
                <p className="sub libpage__lead">{period} 대출 순위예요 · 어린이 책 {noKids ? '빼고' : '포함해서'} 보는 중</p>
                {pop.slice(0, 5).map((b, i) => (
                  <BookLine key={b.isbn13 + i} b={b} i={i} />
                ))}
                {pop.length > 5 && (
                  <Accordion open={more}>
                    {pop.slice(5).map((b, i) => (
                      <BookLine key={b.isbn13 + i} b={b} i={i + 5} />
                    ))}
                  </Accordion>
                )}
                {pop.length > 5 && (
                  <button type="button" className="morebtn" onClick={() => setMore(!more)} aria-expanded={more}>
                    {more ? '접기' : `${pop.length - 5}권 더 보기`}
                    <span className={`morebtn__chev${more ? ' is-open' : ''}`} aria-hidden="true">⌄</span>
                  </button>
                )}
                {pop.length === 0 && <p className="state">어린이 책을 빼면 남는 책이 없어요. 스위치를 꺼서 어린이 책도 보세요.</p>}
              </section>
            )}

            {news.length > 0 && (
              <section className="card card--list rise" style={{ animationDelay: '0.2s' }}>
                <div className="card__head">
                  <div className="titlegroup">
                    <Eyebrow tone="spot">NEW ARRIVALS</Eyebrow>
                    <h2 className="h2 display">새로 들어온 책</h2>
                  </div>
                </div>
                {news.slice(0, 10).map((b, i) => (
                  <BookLine key={b.isbn13 + i} b={b} meta={b.regDate ? `${fmtDate(b.regDate)} 등록` : ''} />
                ))}
              </section>
            )}
            <p className="foot">데이터 출처: 도서관 정보나루 · {fmtDate(data.checkedAt)} 확인</p>
          </div>
        </>
      )}
    </>
  )
}

// 이 책이 내 도서관에 있는지, 지금 빌릴 수 있는지 (Edge Function book-exist -> 정보나루 bookExist)
function LibraryStatusSheet({ book, libs, setLibs, onClose, onPick }) {
  const [state, setState] = useState({ loading: libs.length > 0, results: {}, error: null })
  useEffect(() => {
    if (libs.length === 0) return
    let off = false
    supabase.functions
      .invoke('book-exist', { body: { isbn13: firstIsbn(book.isbn13), libCodes: libs.map((l) => l.libCode) } })
      .then(({ data, error }) => {
        if (off) return
        if (error || !data?.results) return setState({ loading: false, results: {}, error: '지금은 확인할 수 없어요. 잠시 후 다시 시도해 주세요.' })
        setState({ loading: false, results: Object.fromEntries(data.results.map((r) => [r.libCode, r])), error: null })
      })
    return () => {
      off = true
    }
  }, [book.isbn13, libs])

  const status = (r) => {
    if (!r || r.error) return ['확인 실패', 'muted']
    if (!r.hasBook) return ['소장 안 함', 'muted']
    if (r.loanAvailable == null) return ['소장 중', 'up']
    return r.loanAvailable ? ['대출 가능', 'up'] : ['대출 중', 'warn']
  }

  const [altOpen, setAltOpen] = useState(false)
  return (
    <Sheet label="어디서 빌릴까요" onClose={onClose} className="wsheet">
      <div className="wsheet__head">
        <h2 className="wsheet__title">어디서 빌릴까요?</h2>
        <p className="wsheet__book">
          <span className="hl">{shortTitle(book.title)}</span>
        </p>
      </div>
      {libs.length === 0 ? (
        <p className="wsheet__empty">찜한 도서관이 없어요. 아래에서 근처 도서관을 찾아보세요.</p>
      ) : (
        <div className="libs wsheet__mine">
          <p className="wsheet__label">내 도서관</p>
          {state.error && <p className="state state--error">{state.error}</p>}
          {libs.map((l) => {
            const [label, tone] = status(state.results[l.libCode])
            return (
              <div key={l.libCode} className="lib">
                <a className="lib__info" href={`/library/${l.libCode}`}>
                  <strong>{l.name}</strong>
                  <span className="sub">{l.address}</span>
                </a>
                {state.loading ? <span className="pill">확인 중…</span> : <span className={`pill pill--${tone}`}>{label}</span>}
                <a className="lib__go" href={`/library/${l.libCode}`} aria-label={`${l.name} 도서관 정보`}>
                  {Icon.chev()}
                </a>
              </div>
            )
          })}
        </div>
      )}
      <NearbyLibraries book={book} libs={libs} setLibs={setLibs} />
      <Fold title="바로 못 빌린다면?" hint="책바다 · 희망도서 바로대출" open={altOpen} onToggle={() => setAltOpen(!altOpen)}>
        <div className="alt">
          <a className="alt__item press" href="https://books.nl.go.kr" target="_blank" rel="noopener noreferrer">
            <span>
              <b>책바다 (상호대차)</b>
              <small>다른 지역 책을 내 도서관으로 택배 배송</small>
            </span>
            {Icon.chev()}
          </a>
          {libs[0]?.homepage && (
            <a className="alt__item press" href={libs[0].homepage} target="_blank" rel="noopener noreferrer">
              <span>
                <b>희망도서 바로대출</b>
                <small>없는 신간을 동네 서점에서 바로 빌리기</small>
              </span>
              {Icon.chev()}
            </a>
          )}
        </div>
      </Fold>
      <p className="wsheet__foot">소장·대출 정보는 도서관 정보나루 기준이에요.</p>
      <div className="sheet__actions">
        <button className="btn btn--soft" onClick={onPick}>{libs.length > 0 ? '내 도서관 관리' : '도서관 이름으로 찾기'}</button>
      </div>
    </Sheet>
  )
}

function LibraryPicker({ libs, setLibs, onClose }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState({ list: [], loading: false, empty: false })
  useEffect(() => {
    const term = q.replace(/[%,()*]/g, ' ').trim()
    if (term.length < 2) return setFound({ list: [], loading: false, empty: false })
    let off = false
    setFound((f) => ({ ...f, loading: true }))
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('libraries')
        .select('lib_code,name,address,homepage')
        .or(`name.ilike.%${term}%,address.ilike.%${term}%`)
        .order('name')
        .limit(30)
      if (!off) setFound({ list: data || [], loading: false, empty: (data || []).length === 0 })
    }, 300)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [q])
  const has = (code) => libs.some((l) => l.libCode === code)
  const toggle = (r) =>
    setLibs((cur) =>
      cur.some((l) => l.libCode === r.lib_code)
        ? cur.filter((l) => l.libCode !== r.lib_code)
        : cur.length >= MAX_LIBS
          ? cur
          : [...cur, { libCode: r.lib_code, name: r.name, address: r.address, homepage: r.homepage }],
    )
  return (
    <Sheet label="도서관 찾기" onClose={onClose}>
      <div className="sheet__head">
        <div>
          <h2 className="h2">내 도서관 찜하기</h2>
          <p className="sub">
            최대 {MAX_LIBS}곳 · 지금 {libs.length}곳 찜함
          </p>
        </div>
      </div>
      <label className="search">
        <span className="sr-only">도서관 이름이나 지역</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="도서관 이름이나 지역 (예: 수원, 선경)" />
      </label>
      <div className="libs libs--scroll">
        {found.loading && <p className="state">찾는 중…</p>}
        {found.empty && <p className="state">찾는 도서관이 없어요. 다른 이름으로 검색해 보세요.</p>}
        {!found.loading &&
          found.list.map((r) => {
            const on = has(r.lib_code)
            return (
              <div key={r.lib_code} className="lib">
                <div className="lib__info">
                  <strong>{r.name}</strong>
                  <span className="sub">{r.address}</span>
                </div>
                <button
                  className={`pill pill--btn${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={!on && libs.length >= MAX_LIBS}
                  onClick={() => toggle(r)}
                >
                  {on ? '찜함' : '찜하기'}
                </button>
              </div>
            )
          })}
      </div>
      <div className="sheet__actions">
        <button className="btn btn--primary" onClick={onClose}>완료</button>
      </div>
    </Sheet>
  )
}

/* ================= 콕한 책 ================= */

function Wish({ wish, index, toggleWish, hits, alertState, push }) {
  const wide = useWide()
  const items = wish.map((w) => ({ ...w, live: index.get(w.isbn13), hit: hits.get(w.isbn13) }))
  return (
    <div className="split">
      <div className="split__main">
      <header className="pagehead">
        <Eyebrow>MY BOOKS</Eyebrow>
        <h1 className="h1 display">콕한 책</h1>
        <span className="sub">이 기기에 저장돼요</span>
      </header>
      <div className="stack">
        <section className="card">
          <div className="statgrid">
            <div>
              <span>콕한 책</span>
              <strong>{items.length}권</strong>
            </div>
            <div>
              <span>콕 적중</span>
              <strong className="hl">{items.filter((w) => w.hit?.hit).length}권</strong>
            </div>
            <div>
              <span>콕한 뒤 오름</span>
              <strong className="up">{items.filter((w) => w.hit?.rose).length}권</strong>
            </div>
          </div>
        </section>
        <section className="card card--list wishlist">
          {items.length === 0 && (
            <div className="empty">
              <p>아직 콕한 책이 없어요.</p>
              <p className="sub">책 상세에서 오른쪽 위 은행잎을 누르면 여기에 모여요.</p>
              <a className="btn btn--soft" href="/trend">트렌드 보러 가기</a>
            </div>
          )}
          {items.map((w) => (
            <div key={w.isbn13} className="row row--wish">
              <a className="row__link" href={`/book/${encodeURIComponent(w.isbn13)}`}>
                <Cover src={w.cover_url} alt="" className="row__cover" title={w.title} />
                <span className="row__info">
                  <span className="row__title">{shortTitle(w.title)}</span>
                  <span className="row__meta">
                    {cleanAuthor(w.author)} · {w.savedAt} 콕
                  </span>
                  <span className="row__meta">
                    {w.hit?.hit ? (
                      <span className="hitbadge">
                        {Icon.ginkgo(true, 14)}
                        적중 · 콕하고 {w.hit.leadDays}일 뒤 TOP10
                      </span>
                    ) : w.hit?.rose ? (
                      <b className="up">콕한 뒤 순위 ▲{w.hit.rose}</b>
                    ) : w.live?.rank_diff ? (
                      <b className="up">대출순위 ▲{w.live.rank_diff}</b>
                    ) : w.live?.score != null ? (
                      <b>종합 {w.live.score}점</b>
                    ) : (
                      '오늘 순위권 밖'
                    )}
                  </span>
                </span>
              </a>
              <button className="iconbtn is-saved" onClick={() => toggleWish(w)} aria-label={`${shortTitle(w.title)} 콕 해제`}>
                {Icon.ginkgo(true)}
              </button>
            </div>
          ))}
        </section>
        {!wide && (
          <section className="card">
            <h2 className="h2">콕한 책 소식 받기</h2>
            <p className="sub">콕한 책이 떠오름·확산·스테디 단계로 올라가면 알림으로 알려드려요.</p>
            <a className="btn btn--soft btn--block" href="/my">알림 설정 {Icon.chev()}</a>
          </section>
        )}
      </div>
      </div>
      {wide && (
        <aside className="side">
          <section className="card">
            <h2 className="h3">콕한 책 소식 받기</h2>
            <p className="sub">콕한 책이 떠오름·확산·스테디 단계로 올라가면 알려드려요.</p>
            <AlertToggles alertState={alertState} push={push} />
          </section>
          <section className="card">
            <h2 className="h3">적중은 어떻게 세나요</h2>
            <p className="sub">콕할 때 분야 10위 밖이던 책이 그 뒤 분야 TOP10에 들면 적중이에요. 콕한 날 이후 기록만 세요.</p>
          </section>
        </aside>
      )}
    </div>
  )
}

/* ================= 마이 ================= */

const STAGE_GUIDE = [
  {
    stage: '포착',
    title: '뜨기 전에 먼저 잡은 신호',
    body: '분야 인기대출 200위 안에서 순위가 오르기 시작했지만 아직 아래쪽 절반(100위 밖)에 있는 책이에요. 지난달 대출이 30% 이상 늘었거나, 요즘 뜨는 작가의 신작이 곧 나올 때도 포착이에요.',
  },
  {
    stage: '떠오름',
    title: '순위가 오르기 시작',
    body: '분야 인기대출 위쪽 절반(100위 안)에서 순위가 오르는 책이에요. 일주일 전보다 3계단 이상이면서 10% 이상 올랐거나, 지난주 목록에 없다가 새로 들어왔거나, 최근 7일 안에 전국 대출 급상승 목록에 오르면 붙어요.',
  },
  {
    stage: '확산',
    title: '여러 곳에서 함께 뜨는 중',
    body: '순위가 오르는 중이면서 분야 상위 25%(50위 안)에 있고, 3개 이상 지역이나 3개 이상 연령·성별 인기 목록에 함께 오른 책이에요. 한 군데서만이 아니라 여기저기서 반응이 오는 단계예요.',
  },
  {
    stage: '스테디',
    title: '이미 자리 잡은 인기 책',
    body: '최근 3주 동안 데이터가 모두 모인 날의 90% 이상을 분야 TOP10에 머문 책이에요. 새로 뜨는 책을 먼저 보여주려고 종합 순위에서는 빼고, 꾸준한 인기 탭에서 볼 수 있어요.',
  },
]

function MyHits({ wish, hits }) {
  const list = wish.map((w) => ({ ...w, hit: hits.get(w.isbn13) }))
  const got = list.filter((w) => w.hit?.hit)
  const rose = list.filter((w) => w.hit?.rose)
  const avg = got.length ? Math.round(got.reduce((s, w) => s + w.hit.leadDays, 0) / got.length) : null
  const fastest = got.slice().sort((a, b) => a.hit.leadDays - b.hit.leadDays)[0]
  return (
    <section className="card myhits">
      <h2 className="h3">내 콕 적중 기록</h2>
      {wish.length === 0 && <p className="sub">요즘 뜰 것 같은 책을 콕해 두세요. 나중에 분야 TOP10에 들면 '적중'으로 기록돼요.</p>}
      {(
        <>
          <div className="hitgrid hitgrid--3">
            <div>
              <span>적중</span>
              <strong className="num">
                {got.length}
                <small>권</small>
              </strong>
            </div>
            <div>
              <span>평균 앞선 날</span>
              <strong className="num">
                {avg ?? '-'}
                {avg != null && <small>일</small>}
              </strong>
            </div>
            <div>
              <span>콕한 뒤 오름</span>
              <strong className="num up">
                {rose.length}
                <small>권</small>
              </strong>
            </div>
          </div>
          {wish.length === 0 ? null : fastest ? (
            <p className="hitline">
              {Icon.ginkgo(true, 18)}
              <span>
                가장 빨리 알아본 책: <b>{shortTitle(fastest.title)}</b> · 콕하고 {fastest.hit.leadDays}일 뒤 TOP10
              </span>
            </p>
          ) : (
            <p className="sub small">아직 적중한 책이 없어요. 콕한 책이 분야 TOP10에 들면 여기에 기록돼요.</p>
          )}
        </>
      )}
      <a className="line" href="/wish">
        <span>콕한 책 보기</span>
        <span className="line__chev">{Icon.chev()}</span>
      </a>
      <p className="sub small">콕할 때 분야 10위 밖이던 책이 그 뒤 분야 TOP10에 들면 적중이에요. 콕한 날 이후 기록만 세요.</p>
    </section>
  )
}

function My({ prefs, interests, setInterests, onOpenFilter, libs, setLibs, onPickLibrary, alertState, push, wish, hits }) {
  const wide = useWide()
  const [openInfo, setOpenInfo] = useState(null)
  const [settings, setSettings] = useState(false)
  const infos = [
    {
      id: 'stages',
      label: '트렌드 단계, 이렇게 읽어요',
      body: (
        <>
          <span className="glossary__lead">책이 뜨기 시작해서 자리 잡기까지를 네 단계로 나눠요.</span>
          <ol className="glossary">
            {STAGE_GUIDE.map((g) => (
              <li key={g.stage} className="glossary__item">
                <span className="glossary__head">
                  <StageBadge stage={g.stage} />
                  <strong>{g.title}</strong>
                </span>
                <span className="glossary__text">{g.body}</span>
              </li>
            ))}
          </ol>
          <span className="glossary__lead">
            조건이 여러 개 맞으면 스테디 → 확산 → 떠오름 → 포착 순서로 먼저 맞는 단계 하나만 붙어요. 아무 조건에도 맞지 않으면 단계 없이 보여요.
          </span>
        </>
      ),
    },
    {
      id: 'score',
      label: '모멘텀 점수와 신뢰도는 뭔가요?',
      body: '모멘텀은 책이 얼마나 빠르게 뜨고 있는지를 0~100점으로 나타낸 점수예요. 분야 순위가 오른 비율이 가장 크게 반영되고, 신규 진입·전국 대출 급상승·지난달 대출 증가·최근 출간·사서 추천·여러 지역·연령 인기·유튜브 언급·검색 관심을 더해요. 이미 TOP10에 오래 머문 책은 점수를 덜 받아요. 신뢰도는 서로 다른 근거가 몇 개 겹치는지예요. 근거는 ① 순위 20% 이상 상승 ② 새로 진입 ③ 전국 급상승 ④ 일주일 내내 꾸준히 상승 ⑤ 지난달 대출 20% 이상 증가 ⑥ 3곳 이상 지역 또는 3개 이상 연령·성별 목록 ⑦ 사서 추천·유튜브·검색 급증, 7가지예요. 1개면 낮음, 2개면 보통, 3개 이상이면 높음이에요. 스테디는 10일 넘게 지켜본 책이면 높음이에요.',
    },
    {
      id: 'source',
      label: '데이터는 어디서 오나요?',
      body: '도서관 정보나루(전국 공공도서관 대출 데이터), 국립중앙도서관 사서추천도서와 출간예정 도서 정보, 유튜브 언급량, 구글 검색 관심도를 매일 아침 모아서 보여줘요.',
    },
  ]
  return (
    <>
      <header className="pagehead pagehead--withmenu">
        <Eyebrow>MY PAGE</Eyebrow>
        <h1 className="h1 display">마이</h1>
        <button className="iconbtn menubtn" onClick={() => setSettings(true)} aria-label="설정">
          {Icon.gear()}
        </button>
      </header>
      {settings && !wide && <SettingsPanel alertState={alertState} push={push} onClose={() => setSettings(false)} />}
      <div className="split">
      <div className="stack my split__main">
        <section className="card profile">
          <span className="profile__avatar">{Icon.user(false)}</span>
          <div>
            <strong>로그인 없이 쓰는 중</strong>
            <p className="sub">콕한 책과 취향 설정은 이 기기에 저장돼요</p>
          </div>
        </section>

        <MyHits wish={wish} hits={hits} />

        <section className="card">
          <h2 className="h3">내 도서관</h2>
          {libs.length === 0 && <p className="sub">자주 가는 도서관을 찜하면 책 상세에서 바로 소장·대출 여부를 볼 수 있어요.</p>}
          {libs.map((l) => (
            <div key={l.libCode} className="line line--static">
              <a className="lib__info" href={`/library/${l.libCode}`}>
                <strong>{l.name}</strong>
                <span className="sub">{l.address} · 운영시간·인기 책 보기</span>
              </a>
              <button className="pill pill--btn" onClick={() => setLibs(libs.filter((x) => x.libCode !== l.libCode))}>
                삭제
              </button>
            </div>
          ))}
          {libs.length < MAX_LIBS && (
            <button className="btn btn--primary btn--full" onClick={onPickLibrary}>
              도서관 찜하기
            </button>
          )}
        </section>

        <section className="card">
          <a className="line" href="/hits">
            <span>책콕 적중 기록</span>
            <span className="line__chev">{Icon.chev()}</span>
          </a>
          {infos.map((it) => (
            <div key={it.id}>
              <button className="line" aria-expanded={openInfo === it.id} onClick={() => setOpenInfo(openInfo === it.id ? null : it.id)}>
                <span>{it.label}</span>
                <span className={`line__chev${openInfo === it.id ? ' is-open' : ''}`}>{Icon.chev()}</span>
              </button>
              {openInfo === it.id && <div className="line__body">{it.body}</div>}
            </div>
          ))}
        </section>
        <p className="foot">
          데이터 출처: 도서관 정보나루, 국립중앙도서관(사서추천·출간예정), 유튜브, 구글 트렌드
          {COUPANG_AFFILIATE && (
            <>
              <br />
              {AFFILIATE_NOTICE}
            </>
          )}
        </p>
      </div>
      {wide && (
        <aside className="side">
          <section className="card">
            <h2 className="h3">알림</h2>
            <AlertToggles alertState={alertState} push={push} />
            <a className="line" href="/alerts">
              <span className="line__label">받은 알림 보기</span>
              <span className="line__chev">{Icon.chev()}</span>
            </a>
          </section>
          <section className="card">
            <h2 className="h3">저장</h2>
            <p className="sub">콕한 책, 취향, 내 도서관은 로그인 없이 이 기기(브라우저)에만 저장돼요. 브라우저 기록을 지우면 함께 지워져요.</p>
          </section>
        </aside>
      )}
      </div>
    </>
  )
}

/* ================= 데이터 ================= */

function mapRow(r) {
  return {
    isbn13: r.isbn13,
    title: r.title,
    author: r.author,
    publisher: r.publisher,
    classNameFull: r.class_name,
    additionSymbol: r.addition_symbol,
    categoryLabel: categoryLabel(r.class_name),
    cover_url: r.cover_url,
    detail_url: r.detail_url,
    rank_diff: r.rank_diff,
    loan_count: r.loan_count,
    rank: r.rank,
    score: r.score,
    snapshotDate: r.snapshot_date,
    trendType: r.trend_type,
  }
}

function useFeed() {
  const [state, setState] = useState({
    feed: { composite: [], rising: [], popular: [], recommended: [] },
    loading: true,
    error: null,
  })
  useEffect(() => {
    let off = false
    async function run() {
      // v_feed는 탭마다 '올바른 날짜'의 데이터만 준다. 한 번에 최대 1,000건이라 탭별로 나눠 받는다.
      const types = ['composite', 'rising', 'popular', 'recommended']
      const res = await Promise.all(
        types.map((t) => {
          let q = supabase.from('v_feed').select('*').eq('trend_type', t)
          // 분야별 인기대출은 200위까지 모으지만 화면에는 분야마다 60위까지만 받는다 (한 번에 1,000건 제한)
          if (t === 'popular') q = q.lte('rank', 60).order('rank')
          else if (t === 'composite') q = q.order('score', { ascending: false })
          else q = q.order('snapshot_date', { ascending: false })
          return q.limit(1000)
        }),
      )
      if (off) return
      const bad = res.find((r) => r.error)
      if (bad) return setState((s) => ({ ...s, loading: false, error: bad.error.message }))
      const feed = {}
      types.forEach((t, i) => {
        let rows = (res[i].data || []).map(mapRow)
        if (t === 'rising') {
          // 3일치라 같은 책이 겹칠 수 있음 -> 상승폭이 가장 큰 기록만
          const best = new Map()
          rows.forEach((b) => {
            const p = best.get(b.isbn13)
            if (!p || (b.rank_diff ?? 0) > (p.rank_diff ?? 0)) best.set(b.isbn13, b)
          })
          rows = [...best.values()].sort((a, b) => (b.rank_diff ?? 0) - (a.rank_diff ?? 0))
        } else if (t === 'composite') rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        else if (t === 'popular') rows.sort((a, b) => (b.loan_count ?? 0) - (a.loan_count ?? 0))
        else rows.sort((a, b) => (b.snapshotDate ?? '').localeCompare(a.snapshotDate ?? ''))
        feed[t] = rows
      })
      setState({ feed, loading: false, error: null })
    }
    run()
    return () => {
      off = true
    }
  }, [])
  return state
}

// 같은 책의 여러 탭 기록을 하나로 합친 색인 (상세·찜에서 사용)
function useIndex(feed) {
  return useMemo(() => {
    const m = new Map()
    for (const t of ['recommended', 'popular', 'rising', 'composite']) {
      for (const b of feed[t]) {
        const prev = m.get(b.isbn13) || {}
        m.set(b.isbn13, {
          ...prev,
          ...b,
          score: b.score ?? prev.score,
          rank_diff: b.rank_diff ?? prev.rank_diff,
          loan_count: b.loan_count ?? prev.loan_count,
          trendType: prev.trendType === 'recommended' ? 'recommended' : b.trendType,
        })
      }
    }
    return m
  }, [feed])
}

// 홈 키워드: 정보나루 '이달의 키워드'에는 어린이 책이 섞여 있어서,
// 어린이 책을 뺀 요즘 뜨는 책들의 키워드를 모은 v_home_keywords를 쓴다
// 최신 트렌드 단계·이유 (작은 표라 한 번에 받음)
function useBookStates() {
  const [map, setMap] = useState(new Map())
  useEffect(() => {
    // 분야별 200위까지 모으면서 후보가 2천 권을 넘어, 1,000건씩 나눠 받는다
    let off = false
    ;(async () => {
      const all = []
      for (let from = 0; from < 5000; from += 1000) {
        const { data, error } = await supabase
          .from('v_book_state_latest')
          .select('isbn13,snapshot_date,stage,reason,confidence,momentum,first_spotted,rank_now,cat')
          .order('isbn13')
          .range(from, from + 999)
        if (error || !data) break
        all.push(...data)
        if (data.length < 1000) break
      }
      if (!off && all.length) setMap(new Map(all.map((r) => [r.isbn13, r])))
    })()
    return () => {
      off = true
    }
  }, [])
  return map
}

function useHome() {
  const [d, setD] = useState({ upcoming: [], hitStats: null })
  useEffect(() => {
    Promise.all([
      supabase.from('v_upcoming').select('*').order('publish_date', { ascending: true }).limit(20),
      supabase.from('v_hit_stats').select('*').maybeSingle(),
      supabase.from('hit_baseline').select('*').maybeSingle(),
    ]).then(([u, h, b]) => setD({ upcoming: u.data || [], hitStats: h.data ? { ...h.data, base: b.data || null } : null }))
  }, [])
  return d
}

function useKeywords() {
  const [kw, setKw] = useState(null)
  useEffect(() => {
    supabase
      .from('v_home_keywords')
      .select('word,books,rank')
      .order('rank', { ascending: true })
      .limit(10)
      .then(({ data }) => {
        if (!data || data.length === 0) return
        setKw({ monthLabel: `${today.getMonth() + 1}월`, words: data })
      })
  }, [])
  return kw
}

function useDemo(prefs) {
  const [demo, setDemo] = useState({ list: [], loading: false })
  useEffect(() => {
    if (!prefs.on) return
    let off = false
    setDemo({ list: [], loading: true })
    supabase
      .from('v_demo_feed')
      .select('*')
      .eq('age_group', prefs.age)
      .eq('gender', prefs.gender)
      .order('rank', { ascending: true })
      .limit(100)
      .then(({ data }) => {
        if (!off) setDemo({ list: (data || []).map((r) => ({ ...mapRow(r), trendType: 'popular' })), loading: false })
      })
    return () => {
      off = true
    }
  }, [prefs.on, prefs.age, prefs.gender])
  return demo
}

/* ================= 앱 ================= */

export default function App() {
  const route = useRoute()
  useEffect(() => {
    if (route.name === 'book' || route.name === 'keyword') return // 각 화면에서 정함
    const names = { trend: '트렌드 순위', wish: '콕한 책', my: '마이', alerts: '알림', hits: '적중 기록', search: '검색' }
    setPageMeta(names[route.name] ? `${names[route.name]} | 책콕` : DEFAULT_TITLE, window.location.pathname)
  }, [route.name, route.param])
  const { feed, loading, error } = useFeed()
  const index = useIndex(feed)
  const keywords = useKeywords()
  const states = useBookStates()
  const home = useHome()
  const [prefs, setPrefs] = useStored('chaekkok.prefs', { on: false, age: '20', gender: 'all' })
  const [interests, setInterests] = useStored('chaekkok.interests', [])
  const [wish, setWish] = useStored('chaekkok.wish', [])
  const [navMini, setNavMini] = useStored('chaekkok.navMini', false)
  const [sheet, setSheet] = useState(false)
  const [libs, setLibs] = useStored('chaekkok.libs', [])
  const [libPicker, setLibPicker] = useState(false)
  const demo = useDemo(prefs)
  const statesDate = useMemo(() => {
    let d = null
    for (const r of states.values()) if (!d || r.snapshot_date > d) d = r.snapshot_date
    return d
  }, [states])
  const alertState = useAlerts({ states, statesDate, keywords, wish, interests, index, feedReady: !loading && !error })
  const push = usePush({ prefs: alertState.prefs, wish, interests })
  const hits = useWishHits(wish)
  // 콕한 책이 적중하면 알림함에 한 번 알려준다
  useEffect(() => {
    if (!alertState.prefs.wish || hits.size === 0) return
    const items = []
    for (const w of wish) {
      const h = hits.get(w.isbn13)
      if (!h?.hit) continue
      const t = shortTitle(w.title)
      items.push({
        id: `hit:${w.isbn13}`,
        type: 'hit',
        date: h.top10Date,
        text: `적중! 『${t}』${josa(t, '이', '가')} 콕하고 ${h.leadDays}일 만에 TOP10에 들었어요`,
        sub: `${fmtDate(h.savedOn)}에 콕 · 그때 ${h.atSave ? h.atSave + '위' : '순위 밖'}`,
        url: `/book/${w.isbn13}`,
      })
    }
    if (items.length) alertState.addAlerts(items)
  }, [hits]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleWish = (b) => {
    setWish((list) =>
      list.some((w) => w.isbn13 === b.isbn13)
        ? list.filter((w) => w.isbn13 !== b.isbn13)
        : [
            {
              isbn13: b.isbn13,
              title: b.title,
              author: b.author,
              cover_url: b.cover_url,
              savedAt: `${today.getMonth() + 1}/${today.getDate()}`,
              savedOn: kstToday(),
            },
            ...list,
          ],
    )
  }

  const trendTab = TABS.some((t) => t.id === route.param) ? route.param : 'composite'
  const navTab = route.name === 'book' ? null : route.name
  return (
    <StateCtx.Provider value={states}>
    <div className={`app${navTab ? '' : ' app--detail'}${navMini ? ' nav-mini' : ''}`}>
      <SideNav current={navTab} unread={alertState.unread} mini={navMini} onToggle={() => setNavMini(!navMini)} />
      <main className={`page page--${route.name}`}>
        {route.name === 'home' && (
          <Home feed={feed} keywords={keywords} loading={loading} error={error} upcoming={home.upcoming} hitStats={home.hitStats} unread={alertState.unread} libs={libs} />
        )}
        {route.name === 'hits' && <Hits stats={home.hitStats} index={index} />}
        {route.name === 'draft' && <Drafts />}
        {route.name === 'trend' && (
          <Trend tab={trendTab} feed={feed} loading={loading} error={error} prefs={prefs} interests={interests} setInterests={setInterests} demo={demo} onOpenFilter={() => setSheet(true)} />
        )}
        {route.name === 'book' && route.param && <Detail isbn={route.param} index={index} wish={wish} toggleWish={toggleWish} libs={libs} setLibs={setLibs} onPickLibrary={() => setLibPicker(true)} hits={hits} />}
        {route.name === 'library' && route.param && <LibraryPage libCode={route.param} libs={libs} setLibs={setLibs} />}
        {route.name === 'wish' && <Wish wish={wish} index={index} toggleWish={toggleWish} hits={hits} alertState={alertState} push={push} />}
        {route.name === 'search' && <Search key={window.location.search} />}
        {route.name === 'keyword' && route.param && <KeywordPage word={route.param} index={index} />}
        {route.name === 'alerts' && <Alerts alerts={alertState.alerts} markRead={alertState.markRead} clear={alertState.clear} />}
        {route.name === 'my' && <My prefs={prefs} interests={interests} setInterests={setInterests} onOpenFilter={() => setSheet(true)} libs={libs} setLibs={setLibs} onPickLibrary={() => setLibPicker(true)} alertState={alertState} push={push} wish={wish} hits={hits} />}
      </main>
      {navTab && <BottomNav current={navTab} />}
      {libPicker && <LibraryPicker libs={libs} setLibs={setLibs} onClose={() => setLibPicker(false)} />}
      {sheet && (
        <FilterSheet
          prefs={prefs}
          onClose={() => setSheet(false)}
          onApply={(next) => {
            setPrefs(next)
            setSheet(false)
            // 연령·성별 순위는 '꾸준한 인기' 탭에서 보여준다
            if (next.on && route.name !== 'my') go('/trend/popular')
          }}
        />
      )}
    </div>
    </StateCtx.Provider>
  )
}
