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

// (2026-11-24) 배포가 바뀌는 순간에 들어오면 화면 꾸밈(css) 파일만 못 받아 글자만 나올 때가 있다.
// 다 받은 뒤에도 꾸밈이 안 붙어 있으면 한 번만 새로 고친다 (10분 안에 두 번은 안 함).
window.addEventListener('load', () => {
  const ok = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
  if (ok) return
  try {
    const last = Number(sessionStorage.getItem('chaekkok.cssReload') || 0)
    if (Date.now() - last < 600000) return
    sessionStorage.setItem('chaekkok.cssReload', String(Date.now()))
  } catch {
    return
  }
  location.reload()
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
