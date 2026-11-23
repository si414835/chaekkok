import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 자주 안 바뀌는 라이브러리(React·Supabase)를 따로 묶어, 화면 코드를 고쳐 배포해도
        // 재방문자는 라이브러리 파일을 브라우저에 남아 있는 것으로 다시 쓴다 (/assets는 1년 캐시)
        manualChunks(id) {
          if (id.includes('node_modules/@supabase')) return 'supabase'
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
})
