import { useEffect, useMemo, useRef, useState } from 'react'
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
  { id: 'recommended', label: '신간', desc: '국립중앙도서관 사서가 추천한 새 책이에요' },
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

// 해시 주소로 화면 전환: #/  #/trend/탭  #/book/ISBN  #/wish  #/my
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
        if (prev.name !== next.name || next.name === 'book') window.scrollTo(0, 0)
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

/* ================= 아이콘 ================= */

const Icon = {
  home: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l8-6 8 6v10H4z" /></svg>
  ),
  trend: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2.6 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
  ),
  heart: (on) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z" /></svg>
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
function Cover({ src, alt, className = '' }) {
  const list = useMemo(() => coverCandidates(src), [src])
  const [i, setI] = useState(0)
  useEffect(() => setI(0), [src])
  if (i >= list.length) return <span className={`cover cover--empty ${className}`} aria-hidden="true" />
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
    { id: 'wish', label: '찜', icon: Icon.heart, path: '/wish' },
    { id: 'my', label: '마이', icon: Icon.user, path: '/my' },
  ]
  return (
    <nav className="tabbar" aria-label="주요 메뉴">
      {items.map((it) => {
        const on = it.id === current
        return (
          <a key={it.id} href={'#' + it.path} className={`tabbar__item${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
            {it.icon(on)}
            <span>{it.label}</span>
          </a>
        )
      })}
    </nav>
  )
}

function BookRow({ rank, book, value, valueTone }) {
  return (
    <a className="row" href={`#/book/${encodeURIComponent(book.isbn13)}`}>
      <span className="row__rank">{rank}</span>
      <Cover src={book.cover_url} alt="" className="row__cover" />
      <span className="row__info">
        <span className="row__title">{shortTitle(book.title)}</span>
        <span className="row__meta">
          {book.categoryLabel} · {cleanAuthor(book.author)}
        </span>
      </span>
      <span className={`row__value${valueTone ? ' row__value--' + valueTone : ''}`}>{value}</span>
    </a>
  )
}

function Loading() {
  return <p className="state">불러오는 중이에요…</p>
}

/* ================= 홈 ================= */

function KeywordHero({ keywords }) {
  if (!keywords || keywords.words.length === 0) return null
  const [top, ...rest] = keywords.words
  return (
    <section className="kw">
      <span className="kw__label">{keywords.monthLabel}의 키워드</span>
      <h2 className="kw__main">{top.word}</h2>
      <p className="kw__desc">
        요즘 뜨는 책들에서
        <br />
        가장 많이 나온 단어예요
      </p>
      <div className="kw__tags">
        {rest.slice(0, 8).map((k, i) => (
          <span key={k.word} className={`tag${i < 3 ? ' tag--strong' : ''}`}>
            #{k.word}
          </span>
        ))}
      </div>
    </section>
  )
}

function Carousel({ books }) {
  const n = books.length
  const [idx, setIdx] = useState(0)
  const start = useRef(null)
  const swiped = useRef(false)
  const move = (to) => setIdx(((to % n) + n) % n)
  if (n === 0) return null
  const cur = books[Math.min(idx, n - 1)]

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
    <section className="card">
      <div className="card__head">
        <h2 className="h2">오늘의 콕 TOP {n}</h2>
        <span className="sub">옆으로 넘겨보세요</span>
      </div>
      <div className="carousel" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (start.current = null)}>
        {books.map((b, i) => {
          let o = (i - idx + n) % n
          if (o > n / 2) o -= n
          const a = Math.abs(o)
          const scale = [1, 0.78, 0.6][Math.min(a, 2)]
          const x = [0, 96, 160][Math.min(a, 2)] * Math.sign(o)
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
              style={{ transform: `translateX(${x}px) scale(${scale})`, zIndex: 10 - a, opacity: a >= 2 ? 0.55 : 1 }}
              onClick={onClick}
              aria-label={o === 0 ? `${shortTitle(b.title)} 상세 보기` : `${i + 1}위 ${shortTitle(b.title)}`}
            >
              <Cover src={b.cover_url} alt="" className="carousel__cover" />
              <span className="carousel__rank">{i + 1}</span>
            </button>
          )
        })}
      </div>
      <div className="carousel__caption">
        <strong>{shortTitle(cur.title)}</strong>
        <span>
          {cleanAuthor(cur.author)} · <b>{cur.score ?? '-'}점</b>
        </span>
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

function Home({ feed, keywords, loading, error }) {
  const top5 = feed.composite.filter((b) => !isChildBook(b)).slice(0, 5)
  const rising3 = feed.rising.filter((b) => !isChildBook(b)).slice(0, 3)
  return (
    <>
      <header className="topbar">
        <span className="logo">책콕</span>
        <span className="sub">{DATE_LABEL}</span>
      </header>
      <div className="stack">
        <KeywordHero keywords={keywords} />
        {loading && <section className="card"><Loading /></section>}
        {error && <section className="card"><p className="state state--error">데이터를 불러오지 못했어요: {error}</p></section>}
        {!loading && !error && (
          <>
            <Carousel books={top5} />
            <section className="card card--list">
              <div className="card__head">
                <h2 className="h2">지금 뜨는 책</h2>
                <span className="sub">대출순위 급상승</span>
              </div>
              {rising3.map((b, i) => (
                <BookRow key={b.isbn13} rank={i + 1} book={b} value={`▲${b.rank_diff ?? 0}`} valueTone="up" />
              ))}
              <a className="btn btn--soft btn--block" href="#/trend">
                트렌드 순위 전체 보기 {Icon.chev()}
              </a>
            </section>
          </>
        )}
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
    return ['사서 PICK', 'accent']
  }
  const desc = demoActive ? `${demoLabel(prefs)}이 최근 30일 많이 빌린 순이에요` : TABS.find((t) => t.id === tab).desc
  const waiting = loading || (demoActive && demo.loading)

  return (
    <>
      <header className="pagehead">
        <h1 className="h1">트렌드</h1>
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
            return <BookRow key={b.isbn13 + i} rank={i + 1} book={b} value={v} valueTone={tone} />
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

function LoanChart({ history }) {
  const rows = (history || []).filter((h) => h.loanCnt != null).slice(-12)
  if (rows.length < 2) return null
  const max = Math.max(...rows.map((r) => r.loanCnt), 1)
  const last = rows[rows.length - 1]
  const prev = rows[rows.length - 2]
  const diff = last.loanCnt - prev.loanCnt
  return (
    <section className="card">
      <h2 className="h2">월별 대출 추이</h2>
      <p className="sub">최근 {rows.length}개월 · 정보나루 참여 공공도서관</p>
      <div className="bigstat">
        <strong>{last.loanCnt.toLocaleString()}회</strong>
        <span className={diff >= 0 ? 'up' : 'down'}>
          지난달보다 {diff >= 0 ? '+' : ''}
          {diff.toLocaleString()}회
        </span>
      </div>
      <div className="bars" role="img" aria-label={`최근 ${rows.length}개월 대출 건수 막대그래프`}>
        {rows.map((r, i) => (
          <div key={r.month} className="bars__col">
            <div className={`bars__bar${i === rows.length - 1 ? ' is-last' : ''}`} style={{ height: `${Math.round((r.loanCnt / max) * 120)}px` }} title={`${r.month} ${r.loanCnt}회`} />
            <span>{Number((r.month.match(/(\d+)월/) || [])[1])}월</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Groups({ groups }) {
  const top = [...(groups || [])].filter((g) => g.loanCnt).sort((a, b) => b.loanCnt - a.loanCnt).slice(0, 3)
  if (top.length === 0) return null
  const max = top[0].loanCnt
  return (
    <section className="card">
      <h2 className="h2">누가 많이 빌렸을까요</h2>
      <div className="hbars">
        {top.map((g, i) => (
          <div key={g.age + g.gender} className="hbars__row">
            <span className="hbars__label">
              {g.age} {g.gender}
            </span>
            <span className="hbars__track">
              <span className={`hbars__fill${i === 0 ? ' is-top' : ''}`} style={{ width: `${Math.round((g.loanCnt / max) * 100)}%` }} />
            </span>
            <span className="hbars__num">{g.loanCnt.toLocaleString()}회</span>
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
    { label: '종합 점수', value: book.score != null ? `${book.score}` : '-' },
    { label: '대출순위 변화', value: book.rank_diff != null ? `▲${book.rank_diff}` : '-', tone: book.rank_diff ? 'up' : '' },
    { label: '30일 대출', value: book.loan_count != null ? `${book.loan_count.toLocaleString()}회` : '-' },
  ]

  return (
    <div className="detail">
      <header className="detail__bar">
        <button className="iconbtn" onClick={back} aria-label="뒤로">{Icon.back()}</button>
        <button className={`iconbtn${saved ? ' is-saved' : ''}`} onClick={() => toggleWish(book)} aria-pressed={saved} aria-label={saved ? '찜 해제' : '찜하기'}>
          {Icon.heart(saved)}
        </button>
      </header>
      <div className="stack">
        <section className="card hero">
          <div className="hero__top">
            <Cover src={book.cover_url} alt={shortTitle(book.title)} className="hero__cover" />
            <div className="hero__text">
              {book.trendType === 'recommended' && <span className="badge badge--accent">사서 추천</span>}
              <h1 className="hero__title">{shortTitle(book.title)}</h1>
              <span className="sub">
                {cleanAuthor(book.author)}
                {book.classNameFull ? ` · ${book.classNameFull.split('>').slice(0, 2).join(' > ')}` : ''}
              </span>
              {keywords.length > 0 && (
                <div className="hero__tags">
                  {keywords.slice(0, 6).map((k, i) => (
                    <span key={k.word} className={`tag tag--sm${i < 2 ? ' tag--accent' : ''}`}>#{k.word}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="statgrid">
            {stats.map((s) => (
              <div key={s.label}>
                <span>{s.label}</span>
                <strong className={s.tone || ''}>{s.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <LoanChart history={usage?.loan_history} />
        <Groups groups={usage?.loan_grps} />

        {co.length > 0 && (
          <section className="card card--bleed">
            <h2 className="h2">
              이 책을 빌린 사람들이
              <br />
              같이 빌린 책
            </h2>
            <p className="sub">도서관 대출 기록 기준</p>
            <div className="hscroll">
              {co.map((c) => (
                <a key={c.isbn13 || c.title} className="mini" href={`#/book/${encodeURIComponent(c.isbn13)}`}>
                  <Cover src={coCovers[c.isbn13] || index.get(c.isbn13)?.cover_url} alt="" className="mini__cover" />
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
          <h2 className="h2">어디서 살까요</h2>
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

/* ================= 찜 ================= */

function Wish({ wish, index, toggleWish }) {
  const items = wish.map((w) => ({ ...w, live: index.get(w.isbn13) }))
  return (
    <>
      <header className="pagehead">
        <h1 className="h1">찜한 책</h1>
        <span className="sub">이 기기에 저장돼요</span>
      </header>
      <div className="stack">
        <section className="card">
          <div className="statgrid">
            <div>
              <span>찜한 책</span>
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
              <p>아직 찜한 책이 없어요.</p>
              <p className="sub">책 상세에서 ♡를 누르면 여기에 모여요.</p>
              <a className="btn btn--soft" href="#/trend">트렌드 보러 가기</a>
            </div>
          )}
          {items.map((w) => (
            <div key={w.isbn13} className="row row--wish">
              <a className="row__link" href={`#/book/${encodeURIComponent(w.isbn13)}`}>
                <Cover src={w.cover_url} alt="" className="row__cover" />
                <span className="row__info">
                  <span className="row__title">{shortTitle(w.title)}</span>
                  <span className="row__meta">
                    {cleanAuthor(w.author)} · {w.savedAt} 찜
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
              <button className="iconbtn is-saved" onClick={() => toggleWish(w)} aria-label={`${shortTitle(w.title)} 찜 해제`}>
                {Icon.heart(true)}
              </button>
            </div>
          ))}
        </section>
        <section className="card">
          <h2 className="h2">알림은 준비 중이에요</h2>
          <p className="sub">찜한 책이 급상승하거나 단계가 바뀌면 알려드리는 기능을 만들고 있어요.</p>
        </section>
      </div>
    </>
  )
}

/* ================= 마이 ================= */

function My({ prefs, interests, setInterests, onOpenFilter, libs, setLibs, onPickLibrary }) {
  const [openInfo, setOpenInfo] = useState(null)
  const toggle = (c) => setInterests(interests.includes(c) ? interests.filter((x) => x !== c) : [...interests, c])
  const infos = [
    {
      id: 'score',
      label: '책콕 점수는 어떻게 계산하나요',
      body: '도서관 대출 급상승, 꾸준한 대출량, 유튜브 언급, 구글 검색 관심도를 합쳐 0~100점으로 계산해요. 뉴스·블로그 같은 신호는 연결되는 대로 더해질 예정이에요.',
    },
    {
      id: 'source',
      label: '데이터는 어디서 오나요',
      body: '도서관 정보나루(전국 공공도서관 대출 데이터)와 국립중앙도서관 사서추천도서를 매일 아침 모아서 보여줘요.',
    },
  ]
  return (
    <>
      <header className="pagehead">
        <h1 className="h1">마이</h1>
      </header>
      <div className="stack">
        <section className="card profile">
          <span className="profile__avatar">{Icon.user(false)}</span>
          <div>
            <strong>로그인 없이 쓰는 중</strong>
            <p className="sub">찜과 취향 설정은 이 기기에 저장돼요</p>
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
                {c}
              </button>
            ))}
          </div>
          <p className="sub small">관심 분야는 트렌드 화면의 분야 버튼 앞쪽에 먼저 보여요.</p>
        </section>

        <section className="card">
          <h2 className="h3">알림</h2>
          {['찜한 책 트렌드 알림', '이달의 키워드 알림', '관심 분야 신간 알림'].map((t) => (
            <div key={t} className="line line--static">
              <span>{t}</span>
              <span className="badge">준비 중</span>
            </div>
          ))}
        </section>

        <section className="card">
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
          데이터 출처: 도서관 정보나루, 국립중앙도서관 사서추천도서
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
  const [prefs, setPrefs] = useStored('chaekkok.prefs', { on: false, age: '20', gender: 'all' })
  const [interests, setInterests] = useStored('chaekkok.interests', [])
  const [wish, setWish] = useStored('chaekkok.wish', [])
  const [sheet, setSheet] = useState(false)
  const [libs, setLibs] = useStored('chaekkok.libs', [])
  const [libPicker, setLibPicker] = useState(false)
  const demo = useDemo(prefs)

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
    <div className={`app${navTab ? '' : ' app--detail'}`}>
      <main>
        {route.name === 'home' && <Home feed={feed} keywords={keywords} loading={loading} error={error} />}
        {route.name === 'trend' && (
          <Trend tab={trendTab} feed={feed} loading={loading} error={error} prefs={prefs} interests={interests} demo={demo} onOpenFilter={() => setSheet(true)} />
        )}
        {route.name === 'book' && route.param && <Detail isbn={route.param} index={index} wish={wish} toggleWish={toggleWish} libs={libs} onPickLibrary={() => setLibPicker(true)} />}
        {route.name === 'wish' && <Wish wish={wish} index={index} toggleWish={toggleWish} />}
        {route.name === 'my' && <My prefs={prefs} interests={interests} setInterests={setInterests} onOpenFilter={() => setSheet(true)} libs={libs} setLibs={setLibs} onPickLibrary={() => setLibPicker(true)} />}
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
  )
}
