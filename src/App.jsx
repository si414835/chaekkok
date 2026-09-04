import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'

const CATEGORIES = ['전체', '소설', '에세이', '자기계발', '경제경영', '인문학']

const TREND_TYPES = [
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
      <span className="growth">{book.rank_diff}계단</span>
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
  const [trendType, setTrendType] = useState('rising')

  const filtered = useMemo(() => {
    return books
      .filter((b) => b.trendType === trendType)
      .filter((b) => category === '전체' || (b.classNameFull && b.classNameFull.includes(category)))
      .sort((a, b) => (b.rank_diff ?? 0) - (a.rank_diff ?? 0))
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
            <BookRow key={book.isbn13} rank={i + 1} book={book}
