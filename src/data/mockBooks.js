// 정보나루 API 연동 전, 화면 개발용 목업 데이터입니다.
// 실제 연동 시 이 파일 대신 Supabase에서 가져온 데이터를 씁니다.

export const CATEGORIES = ['전체', '소설', '에세이', '자기계발', '경제경영', '인문학']

export const TREND_TYPES = [
  { id: 'rising', label: '급상승' },
  { id: 'popular', label: '꾸준한 인기' },
  { id: 'new', label: '신간 화제작' },
]

export const MOCK_BOOKS = [
  {
    isbn13: '9791190090018',
    title: '달러구트 꿈 백화점',
    author: '이미예',
    publisher: '팩토리나인',
    category: '소설',
    coverTone: '#8B6F9E',
    growth: 42,
    loanCount: 1284,
    trendType: 'rising',
    description:
      '잠들어야만 입장할 수 있는 꿈 백화점에서 벌어지는 이야기. 매일 밤 수많은 손님이 꿈을 사러 온다.',
  },
  {
    isbn13: '9791190182397',
    title: '불편한 편의점',
    author: '김호연',
    publisher: '나무옆의자',
    category: '소설',
    coverTone: '#4F7942',
    growth: 31,
    loanCount: 967,
    trendType: 'rising',
    description:
      '서울역 노숙자에서 하루아침에 편의점 야간 아르바이트생이 된 독고 씨. 그가 만든 특별한 도시락과 사람들의 이야기.',
  },
  {
    isbn13: '9788936434267',
    title: '아몬드',
    author: '손원평',
    publisher: '창비',
    category: '소설',
    coverTone: '#C1432A',
    growth: 19,
    loanCount: 845,
    trendType: 'rising',
    description: '감정을 느끼지 못하는 소년 윤재가 세상과 부딪히며 성장해가는 이야기.',
  },
  {
    isbn13: '9791165341909',
    title: '나는 나로 살기로 했다',
    author: '김수현',
    publisher: '마음의숲',
    category: '에세이',
    coverTone: '#B08D57',
    growth: 12,
    loanCount: 612,
    trendType: 'popular',
    description: '타인의 시선에서 벗어나 온전한 나로 살아가기 위한 마음가짐에 대한 에세이.',
  },
  {
    isbn13: '9791190182298',
    title: '아주 작은 습관의 힘',
    author: '제임스 클리어',
    publisher: '비즈니스북스',
    category: '자기계발',
    coverTone: '#2B2620',
    growth: 8,
    loanCount: 1502,
    trendType: 'popular',
    description: '작은 습관이 만드는 인생의 놀라운 변화를 다루는 자기계발 스테디셀러.',
  },
  {
    isbn13: '9791162543764',
    title: '돈의 심리학',
    author: '모건 하우절',
    publisher: '인플루엔셜',
    category: '경제경영',
    coverTone: '#566246',
    growth: 27,
    loanCount: 733,
    trendType: 'new',
    description: '돈에 대한 사람들의 행동이 왜 이성보다 심리에 좌우되는지 풀어낸 책.',
  },
]

export function filterBooks({ category, trendType }) {
  return MOCK_BOOKS.filter((b) => {
    const categoryMatch = category === '전체' || b.category === category
    const trendMatch = !trendType || b.trendType === trendType
    return categoryMatch && trendMatch
  }).sort((a, b) => b.growth - a.growth)
}
