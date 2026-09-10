import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'

// KDC(도서관 표준분류) 10개 대분류를 그대로 사용. 정보나루 class_name의
// 맨 앞 단어가 이미 이 이름 그대로 오기 때문에(예: "문학 > 한국문학 > 소설"),
// 키워드를 추측해서 매칭하는 대신 첫 단어를 그대로 비교하면 훨씬 안정적이다.
const CATEGORIES = [
  '전체', '어린이', '총류', '철학', '종교', '사회과학',
  '자연과학', '기술과학', '예술', '언어', '문학', '역사',
]

function isChildBook(book) {
  // addition_symbol(형식기호)이 '7'로 시작하면 아동/청소년물
  return !!(book.additionSymbol && book.additionSymbol.startsWith('7'))
}

function topLevelCategory(classNameFull) {
  if (!classNameFull) return null
  return classNameFull.split('>')[0].trim()
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

      const { data, error: fetchError } = await supabase
        .from('trend_scores')
        .select(
          'rank_diff, base_week_rank, past_week_rank, loan_count, rank, score, snapshot_date, trend_type, books ( isbn13, title, author, publisher, class_name, cover_url, detail_url, addition_symbol )'
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
        .filter(
          (r) =>
            r.books &&
            (r.trend_type === 'recommended' || r.snapshot_date === latestDateByType[r.trend_type])
        )
        .map((r) => ({
          isbn13: r.books.isbn13,
          title: r.books.title,
          author: r.books.author,
          publisher: r.books.publisher,
          classNameFull: r.books.class_name,
          additionSymbol: r.books.addition_symbol,
          categoryLabel: extractCategoryLabel(r.books.class_name),
          cover_url: r.books.cover_url,
          detail_url: r.books.detail_url,
          rank_diff: r.rank_diff,
          base_week_rank: r.base_week_rank,
          past_week_rank: r.past_week_rank,
          loan_count: r.loan_count,
          rank: r.rank,
          score: r.score,
          snapshotDate: r.snapshot_date,
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
