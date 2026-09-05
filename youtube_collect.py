"""
책콕: 유튜브 언급량 수집 스크립트 (v2)

오늘의 급상승(rising) + 인기대출(popular) 도서 중 최대 50권만 골라
유튜브에서 "책 관련" 언급이 얼마나 되는지 확인해서 book_signals 테이블에 저장합니다.

v2 개선사항:
- 같은 제목(시리즈)은 한 번만 검색하고 결과를 재사용 (할당량 절약)
- totalResults(전체 검색결과 수) 대신, 상위 10개 영상의 제목/설명에
  "책", "서평", "북리뷰" 등 책 관련 키워드가 실제로 있는지 확인해서 카운트
  -> "흔한남매"처럼 유튜버/브랜드명과 겹치는 제목이 실제 콘텐츠와 무관하게
     부풀려지는 문제를 방지
"""

import os
import re
from datetime import datetime, timedelta, timezone
import requests
from supabase import create_client

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"

MAX_BOOKS_PER_RUN = 50  # 하루 쿼터 안전 마진 (중복 제거 후 기준, 50건 x
