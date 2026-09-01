import { useMemo, useState } from 'react'
import { CATEGORIES, TREND_TYPES, filterBooks } from './data/mockBooks'

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

function BookRow({ rank, book, onSelect }) {
  return (
    <button className="book-row" onClick={() => onSelect(book)}>
      <span className="stamp">{rank}</span>
      <span className="cover-swatch" style={{ background: book.coverTone }} />
      <span className="book-info">
        <p className="book-title">{book.title}</p>
        <p className="book-meta">
          {book.category} · {book.author}
        </p>
      </span>
      <span className="growth">{book.growth}%</span>
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

function Home({ onSelect }) {
  const [category, setCategory] = useState('전체')
  const [trendType, setTrendType] = useState('rising')

  const books = useMemo(
    () => filterBooks({ category, trendType }),
    [category, trendType]
  )

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
        {books.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13, padding: '20px 0' }}>
            아직 이 카테고리엔 데이터가 없어요.
          </p>
        )}
        {books.map((book, i) => (
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
      <span className="detail__cover" style={{ background: book.coverTone }} />
      <h2 className="detail__title">{book.title}</h2>
      <p className="detail__meta">
        {book.author} · {book.publisher} · {book.category}
      </p>
      <div className="detail__stat-row">
        <div>
          <p className="stat__label">이번 주 상승률</p>
          <p className="stat__value stat__value--growth">+{book.growth}%</p>
        </div>
        <div>
          <p className="stat__label">누적 대출</p>
          <p className="stat__value">{book.loanCount.toLocaleString()}</p>
        </div>
      </div>
      <p className="detail__desc">{book.description}</p>
    </div>
  )
}

export default function App() {
  const [selected, setSelected] = useState(null)

  return (
    <div className="app">
      {selected ? (
        <Detail book={selected} onBack={() => setSelected(null)} />
      ) : (
        <Home onSelect={setSelected} />
      )}
    </div>
  )
}
