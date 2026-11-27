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

// (2026-11-24, 11-27 보강) 배포가 바뀌는 순간에 들어오거나 css 요청이 한 번 끊기면 화면 꾸밈(css) 파일만 못 받아
// 글자만 나올 때가 있다. 예전에는 'load' 뒤 10분에 한 번만 새로 고쳐서, 그 안에 또 나면 글자 화면이 그대로 남았다(11-27).
// 이제는 꾸밈이 없으면 그 자리에서 ① css를 캐시 없이 다시 붙이고 ② 그래도 안 되면 최신 index.html에서
// 새 css 이름을 찾아 붙인다. 둘 다 안 되면 그때만 새로 고친다.
const cssOk = () => !!getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
const addCss = (href) =>
  new Promise((resolve) => {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = href
    l.onload = () => resolve(cssOk())
    l.onerror = () => resolve(false)
    document.head.appendChild(l)
  })
async function repairCss() {
  if (cssOk()) return
  const bust = `r=${Date.now()}`
  const olds = [...document.querySelectorAll('link[rel="stylesheet"][href*="/assets/"]')].map((l) => l.getAttribute('href'))
  for (const h of olds) {
    if (await addCss(`${h}${h.includes('?') ? '&' : '?'}${bust}`)) return
  }
  try {
    const html = await (await fetch(`/?${bust}`, { cache: 'no-store' })).text()
    const fresh = [...html.matchAll(/href="(\/assets\/[^"]+\.css)"/g)].map((m) => m[1])
    for (const h of fresh) {
      if (await addCss(h)) return
    }
  } catch {
    /* 아래에서 새로 고침 */
  }
  try {
    const last = Number(sessionStorage.getItem('chaekkok.cssReload') || 0)
    if (Date.now() - last < 60000) return
    sessionStorage.setItem('chaekkok.cssReload', String(Date.now()))
  } catch {
    return
  }
  location.reload()
}
// 모듈 스크립트는 앞의 css를 다 받거나(실패하거나) 나서 실행되므로 지금 바로 확인할 수 있다.
repairCss()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
