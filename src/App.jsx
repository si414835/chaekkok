import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'

// KDC(도서관 표준분류) 10개 대분류를 기본으로 쓰되, 데이터가 적은 두 분야는
// 인접한 분야에 합쳐서 보여준다: 언어(700)->문학(800), 종교(200)->철학(100).
// 실제로 국립중앙도서관 사서추천도서도 "어문학"처럼 언어+문학을 묶어서 분류함.
const CATEGORIES = [
  '전체', '어린이', '총류', '철학', '사회과학',
  '자연과학', '기술과학', '예술', '문학', '역사',
]

const CATEGORY_MERGE = {
  언어: '문학',
  종교: '철학',
}

function isChildBook(book) {
  // addition_symbol(형식기호)이 '7'로 시작하면 아동/청소년물
  return !!(book.additionSymbol && book.additionSymbol.startsWith('7'))
}

function topLevelCategory(classNameFull) {
  if (!classNameFull) return null
  const top = classNameFull.split('>')[0].trim()
  return CATEGORY_MERGE[top] || top
}

function matchesCategory(book, category) {
  if (category === '전체') return true
  if (category === '어린이') return isChildBook(book)
  // 어린이로 분류된 책은 원래 KDC 분야 탭에는 노출하지 않고 어린이 탭으로만 뺀다
  if (isChildBook(book)) return false
  return topLevelCategory(book.classNameFull) === category
}

const TREND_TYPES = [
  { id: 'composite', label: '종합 추천' },
  { id: 'rising', label: '급상승' },
  { id: 'popular', label: '꾸준한 인기' },
  { id: 'recommended', label: '신간 화제작' },
]

const today = new Date()
const dateLabel = `${today.getMonth() + 1}월 ${today.getDate()}일 기준`

function Header() {
  return (
    <header className="header">
      <div className="header__brand">
        <div>
          <h1 className="header__title">책콕</h1>
          <p className="header__tagline">베스트셀러 되기 전에, 먼저 읽으세요</p>
        </div>
        <span className="header__date">{dateLabel}</span>
      </div>
    </header>
  )
}

function Filters({ category, setCategory, trendType, setTrendType }) {
  return (
    <div className="filters">
      <div className="filters__row">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className="chip"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="trend-tabs">
        {TREND_TYPES.map((t) => (
          <button
            key={t.id}
            className="trend-tab"
            aria-pressed={trendType === t.id}
            onClick={() => setTrendType(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function BookCover({ src, alt, size = 'row' }) {
  const [failed, setFailed] = useState(false)
  const className = size === 'detail' ? 'cover-swatch detail__cover' : 'cover-swatch'
  if (!src || failed) {
    return <span className={className + ' cover-swatch--empty'} aria-hidden="true" />
  }
  return (
    <img src={src} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />
  )
}

function formatMetric(book) {
  if (book.trendType === 'recommended') {
    return '사서 PICK'
  }
  if (book.trendType === 'composite') {
    return `${book.score ?? 0}점`
  }
  if (book.trendType === 'popular') {
    return `${book.loan_count ?? 0}회 대출`
  }
  return `${book.rank_diff ?? 0}계단`
}

function BookRow({ rank, book, onSelect }) {
  return (
    <button className="book-row" onClick={() => onSelect(book)}>
      <span className="stamp">{rank}</span>
      <BookCover src={book.cover_url} alt={book.title} />
      <span className="book-info">
        <p className="book-title">{book.title}</p>
        <p className="book-meta">
          {book.categoryLabel} · {book.author}
        </p>
      </span>
      <span className={`growth${book.trendType !== 'rising' ? ' growth--plain' : ''}`}>
        {formatMetric(book)}
      </span>
    </button>
  )
}

function AdBanner() {
  return (
    <div className="ad-banner">
      <span className="ad-label">광고</span>
      <span className="ad-cover" />
      <span className="ad-info">
        <p className="ad-title">내가 쓴 책 제목</p>
        <p className="ad-desc">저자 이름 · 신간 소개</p>
      </span>
      <button className="ad-cta">구매하기</button>
    </div>
  )
}

function EmptyState({ trendType }) {
  const label = TREND_TYPES.find((t) => t.id === trendType)?.label ?? ''
  return (
    <p style={{ color: 'var(--ink-soft)', fontSize: 13, padding: '20px 0' }}>
      아직 '{label}' 데이터가 없어요. 곧 채워질 예정이에요.
    </p>
  )
}

function HeroRow({ books, onSelect }) {
  const top3 = books.slice(0, 3)
  if (top3.length === 0) return null

  return (
    <div className="hero-section">
      <p className="hero-section__title">오늘의 콕</p>
      <div className="hero-row">
        {top3.map((book, i) => (
          <button key={book.isbn13} className="hero-card" onClick={() => onSelect(book)}>
            <img
              src={book.cover_url}
              alt={book.title}
              className="hero-card__cover"
              loading="lazy"
              onError={(e) => {
                e.target.style.background = 'var(--rule)'
                e.target.src = ''
              }}
            />
            <p className="hero-card__rank">{i + 1}</p>
            <p className="hero-card__title">{book.title}</p>
            <p className="hero-card__metric">{formatMetric(book)}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function Home({ books, loading, error, onSelect }) {
  const [category, setCategory] = useState('전체')
  const [trendType, setTrendType] = useState('composite')

  const MAX_BOOKS_PER_VIEW = 20

  const filtered = useMemo(() => {
    const list = books
      .filter((b) => b.trendType === trendType)
      .filter((b) => matchesCategory(b, category))

    let sorted
    if (trendType === 'recommended') {
      sorted = [...list].sort((a, b) => (b.snapshotDate ?? '').localeCompare(a.snapshotDate ?? ''))
    } else if (trendType === 'composite') {
      sorted = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    } else if (trendType === 'popular') {
      sorted = [...list].sort((a, b) => (b.loan_count ?? 0) - (a.loan_count ?? 0))
    } else {
      sorted = [...list].sort((a, b) => (b.rank_diff ?? 0) - (a.rank_diff ?? 0))
    }
    return sorted.slice(0, MAX_BOOKS_PER_VIEW)
  }, [books, category, trendType])

  const heroBooks = useMemo(() => {
    return books
      .filter((b) => b.trendType === 'composite')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
  }, [books])

  return (
    <>
      <Header />
      {!loading && !error && <HeroRow books={heroBooks} onSelect={onSelect} />}
      <Filters
        category={category}
        setCategory={setCategory}
        trendType={trendType}
        setTrendType={setTrendType}
      />
      <div className="card-list">
        {loading && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13, padding: '20px 0' }}>
            불러오는 중...
          </p>
        )}
        {!loading && error && (
          <p style={{ color: 'var(--stamp-red)', fontSize: 13, padding: '20px 0' }}>
            데이터를 불러오지 못했어요: {error}
          </p>
        )}
        {!loading && !error && filtered.length === 0 && <EmptyState trendType={trendType} />}
        {!loading &&
          !error &&
          filtered.map((book, i) => (
            <BookRow key={book.isbn13} rank={i + 1} book={book} onSelect={onSelect} />
          ))}
      </div>
      <AdBanner />
    </>
  )
}

function Detail({ book, onBack }) {
  return (
    <div className="detail">
      <button className="back-link" onClick={onBack}>
        ← 목록으로
      </button>
      <BookCover src={book.cover_url} alt={book.title} size="detail" />
      <h2 className="detail__title">{book.title}</h2>
      <p className="detail__meta">
        {book.author} · {book.publisher} · {book.categoryLabel}
      </p>
      <div className="detail__stat-row">
        {book.trendType === 'recommended' ? (
          <div>
            <p className="stat__label">국립중앙도서관 사서 추천</p>
            <p className="stat__value stat__value--growth">{book.snapshotDate ?? '-'}</p>
          </div>
        ) : book.trendType === 'composite' ? (
          <div>
            <p className="stat__label">종합 트렌드 점수</p>
            <p className="stat__value stat__value--growth">{book.score ?? '-'}점</p>
          </div>
        ) : book.trendType === 'popular' ? (
          <>
            <div>
              <p className="stat__label">최근 30일 대출</p>
              <p className="stat__value stat__value--growth">{book.loan_count ?? '-'}회</p>
            </div>
            <div>
              <p className="stat__label">인기 순위</p>
              <p className="stat__value">{book.rank ?? '-'}위</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="stat__label">지난주 대비</p>
              <p className="stat__value stat__value--growth">+{book.rank_diff}계단</p>
            </div>
            <div>
              <p className="stat__label">이번 주 순위</p>
              <p className="stat__value">{book.base_week_rank ?? '-'}위</p>
            </div>
            <div>
              <p className="stat__label">지난 주 순위</p>
              <p className="stat__value">{book.past_week_rank ?? '-'}위</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function extractCategoryLabel(classNameFull) {
  if (!classNameFull) return '미분류'
  const parts = classNameFull.split('>').map((s) => s.trim())
  return parts[parts.length - 1] || '미분류'
}

export default function App() {
  const [selected, setSelected] = useState(null)
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      // v_feed 뷰는 탭(trend_type)마다 '올바른 날짜'의 데이터만 돌려준다.
      // - 인기대출/종합점수: 10개 분야가 끝까지 수집된 가장 최근 날짜
      // - 급상승: 최근 3일치
      // Supabase는 한 번에 최대 1,000건만 주므로 탭별로 나눠서 받는다.
      const TYPES = ['composite', 'rising', 'popular', 'recommended']
      const results = await Promise.all(
        TYPES.map((t) =>
          supabase
            .from('v_feed')
            .select('*')
            .eq('trend_type', t)
            .order('snapshot_date', { ascending: false })
            .limit(1000)
        )
      )

      if (cancelled) return

      const failed = results.find((r) => r.error)
      if (failed) {
        setError(failed.error.message)
        setLoading(false)
        return
      }

      const rows = results.flatMap((r) => r.data ?? [])

      let mapped = rows.map((r) => ({
        isbn13: r.isbn13,
        title: r.title,
        author: r.author,
        publisher: r.publisher,
        classNameFull: r.class_name,
        additionSymbol: r.addition_symbol,
        categoryLabel: extractCategoryLabel(r.class_name),
        cover_url: r.cover_url,
        detail_url: r.detail_url,
        rank_diff: r.rank_diff,
        base_week_rank: r.base_week_rank,
        past_week_rank: r.past_week_rank,
        loan_count: r.loan_count,
        rank: r.rank,
        score: r.score,
        snapshotDate: r.snapshot_date,
        trendType: r.trend_type,
      }))

      // 급상승은 3일치라 같은 책이 겹칠 수 있음 -> 상승폭이 가장 큰 기록 하나만 남김
      const bestRising = new Map()
      for (const b of mapped) {
        if (b.trendType !== 'rising') continue
        const prev = bestRising.get(b.isbn13)
        if (!prev || (b.rank_diff ?? 0) > (prev.rank_diff ?? 0)) bestRising.set(b.isbn13, b)
      }
      mapped = mapped.filter((b) => b.trendType !== 'rising').concat([...bestRising.values()])

      setBooks(mapped)
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      {selected ? (
        <Detail book={selected} onBack={() => setSelected(null)} />
      ) : (
        <Home books={books} loading={loading} error={error} onSelect={setSelected} />
      )}
    </div>
  )
}
