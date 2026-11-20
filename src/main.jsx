import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { inject } from '@vercel/analytics'

// (2026-11-20) 단정한 서점 디자인은 1200px 본문을 실제 크기로 보여 주도록 짰으므로
// 예전의 '2300px 화면을 줄여 보기(zoom)'는 쓰지 않는다.
document.documentElement.style.zoom = ''

// Vercel Web Analytics: 방문 수·많이 본 페이지 (쿠키 없이 집계, 주소가 바뀔 때마다 자동으로 셈)
inject()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
