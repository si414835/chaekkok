import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { inject } from '@vercel/analytics'

// PC·노트북 화면: 해상도와 상관없이 '가로 2300px 화면을 줄여서 본 모습'으로 맞춘다.
// (브라우저 배율 67%에서 보던 크기를 100%에서도 그대로 보이게) 폰·태블릿 폭에서는 건드리지 않는다.
const WIDE_BASE = 2300
const wideQ = window.matchMedia('(min-width: 1100px)')
function fitWide() {
  const root = document.documentElement
  if (!wideQ.matches) {
    root.style.zoom = ''
    return
  }
  const z = Math.min(1, Math.max(0.62, window.innerWidth / WIDE_BASE))
  root.style.zoom = String(Math.round(z * 1000) / 1000)
}
fitWide()
window.addEventListener('resize', fitWide)

// Vercel Web Analytics: 방문 수·많이 본 페이지 (쿠키 없이 집계, 주소가 바뀔 때마다 자동으로 셈)
inject()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
