import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

/* ================= 설정 ================= */

// 쿠팡 파트너스 가입 후 받은 링크 형식을 넣으면 구매 버튼이 제휴 링크로 바뀌고
// 공정위 표기 문구가 자동으로 나타난다. 예: (isbn) => `https://link.coupang.com/...${isbn}`
const COUPANG_AFFILIATE = null
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
const DATE_LABEL = `${today.getMonth() + 1}월 ${today.getDate()}일 기준`

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

// 해시 주소로 화면 전환: #/  #/trend/탭  #/book/ISBN  #/keyword/단어  #/wish  #/my  #/alerts  #/hits
function parseHash() {
  const parts = (window.location.hash.replace(/^#\/?/, '') || '').split('/')
  return { name: parts[0] || 'home', param: parts[1] ? decodeURIComponent(parts[1]) : null }
}
function useRoute() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = () => {
      const next = parseHash()
      setRoute((prev) => {
        // 같은 화면 안 탭 전환이 아니면 맨 위로
        if (prev.name !== next.name || next.name === 'book' || next.name === 'keyword') window.scrollTo(0, 0)
        return next
      })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
const go = (path) => {
  window.location.hash = path
}

/* ================= 모션 도우미 ================= */

// '동작 줄이기'를 켠 기기에서는 애니메이션 없이 바로 최종 값을 보여준다
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
  home: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l8-6 8 6v10H4z" /></svg>
  ),
  trend: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2.6 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
  ),
  // 콕(은행잎): 꺼짐 = 윤곽선, 켜짐 = 노랗게 차오름
  ginkgo: (on, size = 22) => (
    <svg className={`ginkgo${on ? ' is-on' : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={on ? '#E2A400' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {on && <path className="ginkgo__fill" d={GINKGO_LEAF} fill="#FFC928" stroke="none" />}
      {on && <path className="ginkgo__veins" d="M12 14.4V7.4M12 14.2 6.6 7.6M12 14.2 17.4 7.6" stroke="#F0B400" strokeWidth=".9" />}
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

function BottomNav({ current }) {
  const items = [
    { id: 'home', label: '홈', icon: Icon.home, path: '/' },
    { id: 'trend', label: '트렌드', icon: Icon.trend, path: '/trend' },
    { id: 'wish', label: '콕', icon: Icon.ginkgo, path: '/wish' },
    { id: 'my', label: '마이', icon: Icon.user, path: '/my' },
  ]
  return (
    <nav className="tabbar" aria-label="주요 메뉴">
      {items.map((it) => {
        const on = it.id === current
        return (
          <a key={it.id} href={'#' + it.path} className={`tabbar__item${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
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
    <a className="row rise" style={delay(order, 0.05, 0.04)} href={`#/book/${encodeURIComponent(book.isbn13)}`}>
      {rank != null && <span className={`row__rank num${rank === 1 ? ' is-first' : ''}`}>{rank}</span>}
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

const keywordHref = (w) => `#/keyword/${encodeURIComponent(w)}`

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
        요즘 뜨는 책{top.books ? <b> {top.books}권</b> : ''}에서
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

function Home({ feed, keywords, loading, error, upcoming, hitStats, unread }) {
  const top5 = feed.composite.filter((b) => !isChildBook(b)).slice(0, 5)
  const rising3 = feed.rising.filter((b) => !isChildBook(b)).slice(0, 3)
  return (
    <>
      <header className="topbar">
        <span className="logo">
          책콕
          <i className="logo__dot blink" aria-hidden="true" />
        </span>
        <span className="topbar__right">
          <span className="sub num">{DATE_LABEL}</span>
          <a className={`iconbtn bellbtn${unread ? ' has-new' : ''}`} href="#/alerts" aria-label={unread ? `새 알림 ${unread}개` : '알림'}>
            {Icon.bell(unread > 0)}
          </a>
          <a className="iconbtn" href="#/search" aria-label="책 검색">
            {Icon.search()}
          </a>
        </span>
      </header>
      <div className="stack">
        <KeywordHero keywords={keywords} />
        {loading && <section className="card"><Loading /></section>}
        {error && <section className="card"><p className="state state--error">데이터를 불러오지 못했어요: {error}</p></section>}
        {!loading && !error && (
          <>
            <Carousel books={top5} />
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
              <a className="btn btn--soft btn--block" href="#/trend">
                트렌드 순위 전체 보기 {Icon.chev()}
              </a>
            </section>
            <Upcoming list={upcoming} />
            <HitTeaser stats={hitStats} />
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

function Upcoming({ list: all }) {
  // 출간일이 지난 책은 '곧 나올 책'에서 뺀다 (서버에서도 거르지만 날짜가 바뀐 직후를 대비)
  const list = (all || []).filter((b) => daysUntil(b.publish_date) != null)
  if (list.length === 0) return null
  return (
    <section className="card card--bleed rise" style={{ animationDelay: '0.8s' }}>
      <Eyebrow tone="spot">COMING SOON</Eyebrow>
      <h2 className="h2 display">곧 나올 책</h2>
      <p className="sub">요즘 뜨는 작가의 신작 · 국립중앙도서관 출간예정 정보</p>
      <div className="hscroll">
        {list.slice(0, 10).map((b) => (
          <a key={b.isbn13} className="mini" href={`#/book/${encodeURIComponent(b.isbn13)}`}>
            <span className="mini__coverwrap">
              <Cover src={b.cover_url} alt="" className="mini__cover" title={b.title} />
              <span className="mini__date num">D-{daysUntil(b.publish_date)}</span>
            </span>
            <span className="mini__title">{shortTitle(b.title)}</span>
            <span className="mini__author">
              {b.matched_author || cleanAuthor(b.author)} · {fmtDate(b.publish_date)} 출간
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
    <a className="card hitteaser rise press" style={{ animationDelay: '0.9s' }} href="#/hits">
      <div className="titlegroup">
        <Eyebrow>TRACK RECORD</Eyebrow>
        <strong className="display">책콕 적중 기록</strong>
        <span className="sub">
          먼저 포착한 책의 <b className="accent num">{stats.rose_rate}%</b>가 2주 안에 순위가 더 올랐어요
        </span>
      </div>
      <span className="hitteaser__go">{Icon.chev()}</span>
    </a>
  )
}

/* ================= 적중 기록 ================= */

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
            <div className="hitgrid">
              <div>
                <span>포착한 책</span>
                <strong className="num">
                  {s.spotted_total.toLocaleString()}
                  <small>권</small>
                </strong>
              </div>
              <div>
                <span>2주 안에 더 오름</span>
                <strong className="num accent">
                  {s.rose_rate ?? '-'}
                  <small>%</small>
                </strong>
              </div>
              <div>
                <span>분야 TOP10 진입</span>
                <strong className="num up">
                  {s.top10_hits}
                  <small>권</small>
                </strong>
              </div>
              <div>
                <span>평균 먼저 안 날</span>
                <strong className="num">
                  {s.avg_lead_days ?? '-'}
                  <small>일</small>
                </strong>
              </div>
            </div>
            <p className="sub small">
              {fmtDate(s.since)}부터 기록 · 포착 후 2주가 지난 {s.matured_total}권 기준으로 계산했어요.
            </p>
          </section>
        )}

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
              <a key={b.isbn13} className="row rise" style={delay(i, 0.2, 0.04)} href={`#/book/${encodeURIComponent(b.isbn13)}`}>
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

function Trend({ tab, feed, loading, error, prefs, interests, onOpenFilter, demo }) {
  const [cat, setCat] = useState('전체')
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

  return (
    <>
      <header className="pagehead">
        <Eyebrow>TREND</Eyebrow>
        <h1 className="h1 display">트렌드</h1>
        <span className="sub">{DATE_LABEL} · 전국 공공도서관 대출 데이터</span>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={tab === t.id} className={`tabs__item${tab === t.id ? ' is-on' : ''}`} href={`#/trend/${t.id}`}>
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
    </>
  )
}

/* ================= 연령·성별 시트 ================= */

function FilterSheet({ prefs, onApply, onClose }) {
  const [draft, setDraft] = useState(prefs)
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
            <span />
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
      const coIsbns = (usage?.co_loan || []).map((c) => c.isbn13).filter(Boolean)
      if (coIsbns.length) {
        const { data } = await supabase.from('books').select('isbn13,cover_url').in('isbn13', coIsbns)
        coCovers = Object.fromEntries((data || []).map((r) => [r.isbn13, r.cover_url]))
      }
      if (!off) setExtra({ base: bookRes.data, usage, coCovers, loading: false })
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
    })
  return { book, ...extra }
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
    { id: 'coupang', name: '쿠팡', mark: '쿠', url: COUPANG_AFFILIATE ? COUPANG_AFFILIATE(q) : `https://www.coupang.com/np/search?q=${q}` },
    { id: 'kyobo', name: '교보문고', mark: '교', url: `https://search.kyobobook.co.kr/search?keyword=${q}` },
    { id: 'yes24', name: 'YES24', mark: 'Y', url: `https://www.yes24.com/Product/Search?domain=BOOK&query=${q}` },
    { id: 'aladin', name: '알라딘', mark: '알', url: `https://www.aladin.co.kr/search/wsearchresult.aspx?SearchTarget=Book&SearchWord=${q}` },
  ]
}

function Detail({ isbn, index, wish, toggleWish, libs, onPickLibrary }) {
  const { book, usage, coCovers, loading } = useBook(isbn, index)
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
  const stats = [
    { label: '모멘텀', value: book.score != null ? (Number(book.score) * p).toFixed(1) : '-', unit: book.score != null ? '점' : '' },
    { label: '대출순위 변화', value: book.rank_diff != null ? `▲${Math.round(book.rank_diff * p)}` : '-', tone: book.rank_diff ? 'up' : '' },
    {
      label: '30일 대출',
      value: book.loan_count != null ? Math.round(book.loan_count * p).toLocaleString() : '-',
      unit: book.loan_count != null ? '회' : '',
    },
  ]
  const st = stateMap.get(book.isbn13)
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
                  <Eyebrow tone={book.rank_diff ? 'up' : undefined}>{eyebrow}</Eyebrow>
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
            </div>
          )}
          <div className="statgrid rise" style={{ animationDelay: '0.3s' }}>
            {stats.map((s) => (
              <div key={s.label}>
                <span>{s.label}</span>
                <strong className={`num ${s.tone || ''}`}>
                  {s.value}
                  {s.unit && <small>{s.unit}</small>}
                </strong>
              </div>
            ))}
          </div>
        </section>

        <LoanChart history={usage?.loan_history} motionKey={isbn + (usage ? 'u' : '')} />
        <Groups groups={usage?.loan_grps} />

        {co.length > 0 && (
          <section className="card card--bleed rise" style={{ animationDelay: '0.55s' }}>
            <Eyebrow>ALSO BORROWED</Eyebrow>
            <h2 className="h2 display">
              이 책을 빌린 사람들이
              <br />
              같이 빌린 책
            </h2>
            <p className="sub">도서관 대출 기록 기준</p>
            <div className="hscroll">
              {co.map((c) => (
                <a key={c.isbn13 || c.title} className="mini" href={`#/book/${encodeURIComponent(c.isbn13)}`}>
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
          {COUPANG_AFFILIATE && <p className="notice">{AFFILIATE_NOTICE}</p>}
          <div className="shops">
            {shopLinks(book.isbn13).map((s) => (
              <a key={s.id} className="shop" href={s.url} target="_blank" rel="noopener noreferrer sponsored">
                <span className={`shop__mark shop__mark--${s.id}`}>{s.mark}</span>
                <span className="shop__name">{s.name}</span>
                <span className="shop__go">가격 보기 {Icon.chev()}</span>
              </a>
            ))}
          </div>
        </section>
      </div>

      <div className="actionbar">
        <button className="btn btn--soft" onClick={() => setLibOpen(true)}>
          도서관에서 빌리기
        </button>
        <button className="btn btn--primary" onClick={() => buyRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          구매하기
        </button>
      </div>
      {libOpen && (
        <LibraryStatusSheet
          book={book}
          libs={libs}
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

function Search() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState({ list: [], loading: false, done: false })
  useEffect(() => {
    const term = q.replace(/[%,()*]/g, ' ').trim()
    if (term.length < 2) return setRes({ list: [], loading: false, done: false })
    let off = false
    setRes((r) => ({ ...r, loading: true }))
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('books')
        .select('isbn13,title,author,class_name,cover_url,addition_symbol')
        .or(`title.ilike.%${term}%,author.ilike.%${term}%`)
        .limit(40)
      if (off) return
      const list = (data || []).map((r) => ({
        isbn13: r.isbn13,
        title: r.title,
        author: r.author,
        classNameFull: r.class_name,
        additionSymbol: r.addition_symbol,
        categoryLabel: isChildBook({ additionSymbol: r.addition_symbol }) ? '어린이 책' : categoryLabel(r.class_name),
        cover_url: r.cover_url,
      }))
      setRes({ list, loading: false, done: true })
    }, 300)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [q])
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
        {q.trim().length < 2 && <p className="state">두 글자 이상 입력해 주세요. 책콕이 모은 책 중에서 찾아요.</p>}
        {res.loading && <Loading />}
        {!res.loading && res.done && res.list.length === 0 && <p className="state">찾는 책이 없어요. 다른 단어로 검색해 보세요.</p>}
        {!res.loading && res.list.map((b) => <BookRow key={b.isbn13} rank={null} book={b} value="" />)}
      </div>
    </>
  )
}

/* ================= 키워드 ================= */

function KeywordPage({ word, index }) {
  const [res, setRes] = useState({ loading: true, list: [], related: [], error: null })
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
              <a className="btn btn--soft" href="#/trend">트렌드 보러 가기</a>
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
  return { prefs, setPrefs, alerts, unread, markRead, clear }
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
  const TONE = { wish: 'ginkgo', keyword: 'kw', interest: 'spot' }
  return (
    <>
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        <a className="pill pill--btn alerts__set" href="#/my">알림 설정</a>
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
              <a className="btn btn--soft" href="#/my">알림 설정 보기</a>
            </div>
          )}
          {alerts.map((a, i) => (
            <a key={a.id} className={`alert rise${fresh.has(a.id) ? ' is-new' : ''}`} style={delay(i, 0.05, 0.04)} href={'#' + a.url}>
              <span className={`alert__icon alert__icon--${TONE[a.type] || 'kw'}`} aria-hidden="true">
                {a.type === 'wish' ? Icon.ginkgo(true, 20) : a.type === 'keyword' ? '#' : Icon.trend(true)}
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

function AlertSettings({ alertState, push }) {
  const { prefs, setPrefs } = alertState
  return (
    <section className="card">
      <h2 className="h3">알림</h2>
      {ALERT_TYPES.map((t) => (
        <div key={t.id} className="line line--static">
          <span className="lib__info">
            <strong className="line__label">{t.label}</strong>
            <span className="sub">{t.desc}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={prefs[t.id]}
            aria-label={t.label}
            className={`switch${prefs[t.id] ? ' is-on' : ''}`}
            onClick={() => setPrefs({ ...prefs, [t.id]: !prefs[t.id] })}
          >
            <i />
          </button>
        </div>
      ))}
      <div className="pushbox">
        <span className="lib__info">
          <strong className="line__label">휴대폰 알림</strong>
          <span className="sub">
            {push.support === 'ios-home'
              ? '아이폰은 Safari 공유 버튼 → 홈 화면에 추가한 뒤, 홈 화면의 책콕에서 켤 수 있어요.'
              : push.support === 'no'
                ? '이 브라우저는 휴대폰 알림을 지원하지 않아요. 알림은 앱 안 종 모양에서 볼 수 있어요.'
                : push.on
                  ? '켜짐 · 매일 아침 새 소식이 있을 때만 한 번 보내요'
                  : '앱을 닫아 둬도 새 소식을 알려드려요'}
          </span>
        </span>
        {push.support === 'ok' && (
          <button className={`btn ${push.on ? 'btn--soft' : 'btn--primary'} btn--sm`} disabled={push.busy} onClick={push.on ? push.disable : push.enable}>
            {push.busy ? '잠시만요' : push.on ? '끄기' : '켜기'}
          </button>
        )}
      </div>
      {push.msg && <p className="sub small pushbox__msg">{push.msg}</p>}
      <a className="line" href="#/alerts">
        <span>받은 알림 보기</span>
        <span className="line__chev">{Icon.chev()}</span>
      </a>
    </section>
  )
}

/* ================= 내 도서관 ================= */

const MAX_LIBS = 3

function Sheet({ label, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
      <button className="sheet__dim" aria-label="닫기" onClick={onClose} />
      <div className="sheet__panel">
        <span className="sheet__grip" aria-hidden="true" />
        {children}
      </div>
    </div>
  )
}

// 이 책이 내 도서관에 있는지, 지금 빌릴 수 있는지 (Edge Function book-exist -> 정보나루 bookExist)
function LibraryStatusSheet({ book, libs, onClose, onPick }) {
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

  return (
    <Sheet label="내 도서관 소장 현황" onClose={onClose}>
      <div className="sheet__head">
        <div>
          <h2 className="h2">내 도서관에 있을까요</h2>
          <p className="sub">{shortTitle(book.title)}</p>
        </div>
      </div>
      {libs.length === 0 ? (
        <div className="empty">
          <p>아직 찜한 도서관이 없어요.</p>
          <p className="sub">자주 가는 도서관을 최대 {MAX_LIBS}곳까지 찜할 수 있어요.</p>
          <button className="btn btn--primary" onClick={onPick}>도서관 찾기</button>
        </div>
      ) : (
        <div className="libs">
          {state.error && <p className="state state--error">{state.error}</p>}
          {libs.map((l) => {
            const [label, tone] = status(state.results[l.libCode])
            return (
              <div key={l.libCode} className="lib">
                <div className="lib__info">
                  <strong>{l.name}</strong>
                  <span className="sub">{l.address}</span>
                </div>
                {state.loading ? <span className="pill">확인 중…</span> : <span className={`pill pill--${tone}`}>{label}</span>}
                {l.homepage && (
                  <a className="lib__go" href={l.homepage} target="_blank" rel="noopener noreferrer" aria-label={`${l.name} 홈페이지`}>
                    {Icon.chev()}
                  </a>
                )}
              </div>
            )
          })}
          <p className="sub small">소장·대출 정보는 도서관 정보나루 기준이라 실제와 조금 다를 수 있어요.</p>
          {!state.loading && !state.error && libs.some((l) => {
            const r = state.results[l.libCode]
            return r && !r.error && (!r.hasBook || r.loanAvailable === false)
          }) && (
            <div className="alt">
              <p className="alt__title">바로 못 빌린다면</p>
              <a className="alt__item press" href="https://books.nl.go.kr" target="_blank" rel="noopener noreferrer">
                <span>
                  <b>책바다 (상호대차)</b>
                  <small>다른 지역 도서관 책을 내 도서관으로 택배 배송 · 택배비 일부 본인 부담</small>
                </span>
                {Icon.chev()}
              </a>
              {libs[0]?.homepage && (
                <a className="alt__item press" href={libs[0].homepage} target="_blank" rel="noopener noreferrer">
                  <span>
                    <b>희망도서 바로대출</b>
                    <small>도서관에 없는 신간을 동네 서점에서 바로 빌리기 · 도서관마다 운영 여부가 달라요</small>
                  </span>
                  {Icon.chev()}
                </a>
              )}
            </div>
          )}
        </div>
      )}
      <div className="sheet__actions">
        {libs.length > 0 && <button className="btn btn--soft" onClick={onPick}>도서관 관리</button>}
        {book.detail_url && (
          <a className="btn btn--soft" href={book.detail_url} target="_blank" rel="noopener noreferrer">
            다른 도서관 보기
          </a>
        )}
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

function Wish({ wish, index, toggleWish }) {
  const items = wish.map((w) => ({ ...w, live: index.get(w.isbn13) }))
  return (
    <>
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
              <span>지금 급상승</span>
              <strong className="up">{items.filter((w) => w.live?.rank_diff).length}권</strong>
            </div>
            <div>
              <span>종합 순위권</span>
              <strong className="accent">{items.filter((w) => w.live?.score != null).length}권</strong>
            </div>
          </div>
        </section>
        <section className="card card--list">
          {items.length === 0 && (
            <div className="empty">
              <p>아직 콕한 책이 없어요.</p>
              <p className="sub">책 상세에서 오른쪽 위 은행잎을 누르면 여기에 모여요.</p>
              <a className="btn btn--soft" href="#/trend">트렌드 보러 가기</a>
            </div>
          )}
          {items.map((w) => (
            <div key={w.isbn13} className="row row--wish">
              <a className="row__link" href={`#/book/${encodeURIComponent(w.isbn13)}`}>
                <Cover src={w.cover_url} alt="" className="row__cover" title={w.title} />
                <span className="row__info">
                  <span className="row__title">{shortTitle(w.title)}</span>
                  <span className="row__meta">
                    {cleanAuthor(w.author)} · {w.savedAt} 콕
                  </span>
                  <span className="row__meta">
                    {w.live?.rank_diff ? (
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
        <section className="card">
          <h2 className="h2">콕한 책 소식 받기</h2>
          <p className="sub">콕한 책이 떠오름·확산·스테디 단계로 올라가면 알림으로 알려드려요.</p>
          <a className="btn btn--soft btn--block" href="#/my">알림 설정 {Icon.chev()}</a>
        </section>
      </div>
    </>
  )
}

/* ================= 마이 ================= */

const STAGE_GUIDE = [
  {
    stage: '포착',
    title: '뜨기 전에 먼저 잡은 신호',
    body: '아직 분야 인기대출 순위가 낮거나(목록 아래쪽 절반) 순위에 없지만 신호가 먼저 보인 책이에요. 사서 추천 책이나 올해 나온 신간이면서 유튜브 언급·검색 관심이 갑자기 늘었거나 지난달 대출이 30% 이상 늘었을 때 붙어요. 요즘 뜨는 작가의 신작이 곧 나올 때도 포착이에요.',
  },
  {
    stage: '떠오름',
    title: '순위가 오르기 시작',
    body: '분야 인기대출 순위가 일주일 전보다 3계단 이상 올랐거나, 순위에 새로 들어왔거나, 최근 7일 안에 전국 대출 급상승 목록에 오른 책이에요.',
  },
  {
    stage: '확산',
    title: '여러 곳에서 함께 뜨는 중',
    body: '모멘텀 점수가 45점 이상이고, 대출 순위·사서 추천·지역 인기·유튜브·검색 중 서로 다른 신호가 2가지 이상 함께 잡힌 책이에요. 한 군데서만이 아니라 여기저기서 반응이 오는 단계예요.',
  },
  {
    stage: '스테디',
    title: '이미 자리 잡은 인기 책',
    body: '최근 3주 동안 데이터가 모두 모인 날의 90% 이상을 분야 TOP10에 머문 책이에요. 새로 뜨는 책을 먼저 보여주려고 종합 순위에서는 빼고, 꾸준한 인기 탭에서 볼 수 있어요.',
  },
]

function My({ prefs, interests, setInterests, onOpenFilter, libs, setLibs, onPickLibrary, alertState, push }) {
  const [openInfo, setOpenInfo] = useState(null)
  const toggle = (c) => setInterests(interests.includes(c) ? interests.filter((x) => x !== c) : [...interests, c])
  const infos = [
    {
      id: 'score',
      label: '모멘텀 점수와 신뢰도는 뭔가요',
      body: '모멘텀은 책이 얼마나 빠르게 뜨고 있는지를 0~100점으로 나타낸 점수예요. 분야 순위가 오른 폭이 가장 크게 반영되고, 순위 신규 진입·전국 대출 급상승·지난달 대출 증가·최근 출간·사서 추천·여러 지역 인기·유튜브 언급·검색 관심을 더해요. 이미 TOP10에 오래 머문 책은 점수를 덜 받아요. 신뢰도는 함께 잡힌 신호의 가짓수로, 1가지면 낮음, 2가지면 보통, 3가지 이상이면 높음이에요.',
    },
    {
      id: 'source',
      label: '데이터는 어디서 오나요',
      body: '도서관 정보나루(전국 공공도서관 대출 데이터), 국립중앙도서관 사서추천도서와 출간예정 도서 정보, 유튜브 언급량, 구글 검색 관심도를 매일 아침 모아서 보여줘요.',
    },
  ]
  return (
    <>
      <header className="pagehead">
        <Eyebrow>MY PAGE</Eyebrow>
        <h1 className="h1 display">마이</h1>
      </header>
      <div className="stack">
        <section className="card profile">
          <span className="profile__avatar">{Icon.user(false)}</span>
          <div>
            <strong>로그인 없이 쓰는 중</strong>
            <p className="sub">콕한 책과 취향 설정은 이 기기에 저장돼요</p>
          </div>
        </section>

        <section className="card">
          <h2 className="h3">내 도서관</h2>
          {libs.length === 0 && <p className="sub">자주 가는 도서관을 찜하면 책 상세에서 바로 소장·대출 여부를 볼 수 있어요.</p>}
          {libs.map((l) => (
            <div key={l.libCode} className="line line--static">
              <span className="lib__info">
                <strong>{l.name}</strong>
                <span className="sub">{l.address}</span>
              </span>
              <button className="pill pill--btn" onClick={() => setLibs(libs.filter((x) => x.libCode !== l.libCode))}>
                삭제
              </button>
            </div>
          ))}
          {libs.length < MAX_LIBS && (
            <button className="btn btn--soft btn--full" onClick={onPickLibrary}>
              도서관 찾아서 찜하기
            </button>
          )}
        </section>

        <section className="card">
          <h2 className="h3">내 취향</h2>
          <button className="line" onClick={onOpenFilter}>
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
          <p className="sub small">관심 분야는 트렌드 화면의 분야 버튼 앞쪽에 먼저 보여요.</p>
        </section>

        <AlertSettings alertState={alertState} push={push} />

        <section className="card">
          <h2 className="h3">트렌드 단계, 이렇게 읽어요</h2>
          <p className="sub">책이 뜨기 시작해서 자리 잡기까지를 네 단계로 나눠요.</p>
          <ol className="glossary">
            {STAGE_GUIDE.map((g) => (
              <li key={g.stage} className="glossary__item">
                <span className="glossary__head">
                  <StageBadge stage={g.stage} />
                  <strong>{g.title}</strong>
                </span>
                <p>{g.body}</p>
              </li>
            ))}
          </ol>
          <p className="sub small">
            조건이 여러 개 맞으면 스테디 → 확산 → 떠오름 → 포착 순서로 먼저 맞는 단계 하나만 붙어요. 아무 조건에도 맞지 않으면 단계 없이 보여요.
          </p>
        </section>

        <section className="card">
          <a className="line" href="#/hits">
            <span>책콕 적중 기록</span>
            <span className="line__chev">{Icon.chev()}</span>
          </a>
          {infos.map((it) => (
            <div key={it.id}>
              <button className="line" aria-expanded={openInfo === it.id} onClick={() => setOpenInfo(openInfo === it.id ? null : it.id)}>
                <span>{it.label}</span>
                <span className={`line__chev${openInfo === it.id ? ' is-open' : ''}`}>{Icon.chev()}</span>
              </button>
              {openInfo === it.id && <p className="line__body">{it.body}</p>}
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
        types.map((t) => supabase.from('v_feed').select('*').eq('trend_type', t).order('snapshot_date', { ascending: false }).limit(1000)),
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
    supabase
      .from('v_book_state_latest')
      .select('isbn13,snapshot_date,stage,reason,confidence,momentum,first_spotted')
      .limit(1000)
      .then(({ data }) => {
        if (data) setMap(new Map(data.map((r) => [r.isbn13, r])))
      })
  }, [])
  return map
}

function useHome() {
  const [d, setD] = useState({ upcoming: [], hitStats: null })
  useEffect(() => {
    Promise.all([
      supabase.from('v_upcoming').select('*').order('publish_date', { ascending: true }).limit(20),
      supabase.from('v_hit_stats').select('*').maybeSingle(),
    ]).then(([u, h]) => setD({ upcoming: u.data || [], hitStats: h.data || null }))
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
  const { feed, loading, error } = useFeed()
  const index = useIndex(feed)
  const keywords = useKeywords()
  const states = useBookStates()
  const home = useHome()
  const [prefs, setPrefs] = useStored('chaekkok.prefs', { on: false, age: '20', gender: 'all' })
  const [interests, setInterests] = useStored('chaekkok.interests', [])
  const [wish, setWish] = useStored('chaekkok.wish', [])
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
            },
            ...list,
          ],
    )
  }

  const trendTab = TABS.some((t) => t.id === route.param) ? route.param : 'composite'
  const navTab = route.name === 'book' ? null : route.name
  return (
    <StateCtx.Provider value={states}>
    <div className={`app${navTab ? '' : ' app--detail'}`}>
      <main>
        {route.name === 'home' && (
          <Home feed={feed} keywords={keywords} loading={loading} error={error} upcoming={home.upcoming} hitStats={home.hitStats} unread={alertState.unread} />
        )}
        {route.name === 'hits' && <Hits stats={home.hitStats} index={index} />}
        {route.name === 'trend' && (
          <Trend tab={trendTab} feed={feed} loading={loading} error={error} prefs={prefs} interests={interests} demo={demo} onOpenFilter={() => setSheet(true)} />
        )}
        {route.name === 'book' && route.param && <Detail isbn={route.param} index={index} wish={wish} toggleWish={toggleWish} libs={libs} onPickLibrary={() => setLibPicker(true)} />}
        {route.name === 'wish' && <Wish wish={wish} index={index} toggleWish={toggleWish} />}
        {route.name === 'search' && <Search />}
        {route.name === 'keyword' && route.param && <KeywordPage word={route.param} index={index} />}
        {route.name === 'alerts' && <Alerts alerts={alertState.alerts} markRead={alertState.markRead} clear={alertState.clear} />}
        {route.name === 'my' && <My prefs={prefs} interests={interests} setInterests={setInterests} onOpenFilter={() => setSheet(true)} libs={libs} setLibs={setLibs} onPickLibrary={() => setLibPicker(true)} alertState={alertState} push={push} />}
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
