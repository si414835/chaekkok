import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[책콕] Supabase 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정 > Environment Variables에서 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY를 등록해주세요.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
