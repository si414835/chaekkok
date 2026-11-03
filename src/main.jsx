import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { inject } from '@vercel/analytics'

// Vercel Web Analytics: 방문 수·많이 본 페이지 (쿠키 없이 집계, 주소가 바뀔 때마다 자동으로 셈)
inject()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
