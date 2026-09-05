import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'

const CATEGORIES = ['전체', '소설', '에세이', '자기계발', '경제경영', '인문학']

// 우리 탭 이름과 정보나루 실제 분류명(KDC)이 표현이 달라서, 탭마다 매칭될
// 키워드를 여러 개 등록해둔다. 이 중 하나라도 class_name에 포함되면 그 탭으로 분류.
const CATEGORY_KEYWORDS = {
  소설: ['소설'],
  에세이: ['수필', '에세이'],
  자기계발: ['처세', '자기계발', '인간관계'],
  경제경영: ['경제', '경영', '금융'],
  인문학: ['철학', '역사', '인문', '언어'],
}

function matchesCategory(classNameFull, category) {
  if (category === '전체') return true
  if (!classNameFull) return false
  const keywords = CATEGORY_KEYWORDS[category] || [category]
  return keywords.some((kw) => classNameFull.includes(kw))
}

const TREND_TYPES = [
  { id: 'composite', label: '종합 추천' },
  { id: 'rising', label: '급상승' },
  { id: 'popular', label: '꾸준한 인기' },
  { id: 'new', label: '신간 화제작' },
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

function Home({ books, loading, error, onSelect }) {
  const [category, setCategory] = useState('전체')
  const [trendType, setTrendType] = useState('composite')

  const filtered = useMemo(() => {
    const list = books
      .filter((b) => b.trendType === trendType)
      .filter((b) => matchesCategory(b.classNameFull, category))

    if (trendType === 'composite') {
      return [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    }
    if (trendType === 'popular') {
      return [...list].sort((a, b) => (b.loan_count ?? 0) - (a.loan_count ?? 0))
    }
    return [...list].sort((a, b) => (b.rank_diff ?? 0) - (a.rank_diff ?? 0))
  }, [books, category, trendType])

  return (
    <>
      <Header />
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
        {book.trendType === 'composite' ? (
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

      const { data, error: fetchError } = await supabase
        .from('trend_scores')
        .select(
          'rank_diff, base_week_rank, past_week_rank, loan_count, rank, score, snapshot_date, trend_type, books ( isbn13, title, author, publisher, class_name, cover_url, detail_url )'
        )
        .order('snapshot_date', { ascending: false })

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
        setLoading(false)
        return
      }

      const rows = data ?? []

      // trend_type별로 각각의 최신 snapshot_date를 따로 계산
      // (급상승은 매일, 인기대출은 다른 주기로 갱신될 수 있어서 하나의 날짜로 묶으면 안 됨)
      const latestDateByType = {}
      for (const r of rows) {
        const t = r.trend_type
        if (!latestDateByType[t] || r.snapshot_date > latestDateByType[t]) {
          latestDateByType[t] = r.snapshot_date
        }
      }

      const mapped = rows
        .filter((r) => r.books && r.snapshot_date === latestDateByType[r.trend_type])
        .map((r) => ({
          isbn13: r.books.isbn13,
          title: r.books.title,
          author: r.books.author,
          publisher: r.books.publisher,
          classNameFull: r.books.class_name,
          categoryLabel: extractCategoryLabel(r.books.class_name),
          cover_url: r.books.cover_url,
          detail_url: r.books.detail_url,
          rank_diff: r.rank_diff,
          base_week_rank: r.base_week_rank,
          past_week_rank: r.past_week_rank,
          loan_count: r.loan_count,
          rank: r.rank,
          score: r.score,
          trendType: r.trend_type,
        }))

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
