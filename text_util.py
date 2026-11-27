"""
책콕: 정보나루 책 소개 등에서 HTML 태그만 걷어낸다.

(2026-11-27) 책 소개는 작품 제목을 '&lt;복자에게&gt;'처럼 꺾쇠로 적는다. 예전에는 엔티티를 풀고 나서
'<...>'를 모두 태그로 보고 지워서 제목이 사라졌다
(예: "<복자에게>로 큰 사랑을 받으며…" → "로 큰 사랑을 받으며…"). 이제 진짜 HTML 태그 이름만 지운다.
"""
import html
import re

# 정보나루·국립중앙도서관 응답에 실제로 섞여 오는 태그 정도만. 한글 제목(<복자에게>)·영문 제목(<Harry Potter>)은 남는다.
TAG_RE = re.compile(
    r"</?(?:a|b|i|u|s|em|strong|p|br|span|div|font|img|sup|sub|small|big|strike|center|hr|"
    r"ul|ol|li|dl|dt|dd|table|tr|td|th|tbody|thead|h[1-6]|blockquote|pre|code|mark|ins|del)\b[^<>]*/?>",
    re.I,
)
BR_RE = re.compile(r"<br\s*/?>", re.I)


def strip_tags(t, keep_lines=False):
    """태그를 지우고 엔티티를 푼다. 엔티티를 푼 뒤 생긴 '<b>' 같은 진짜 태그도 한 번 더 지운다."""
    t = t or ""
    t = BR_RE.sub("\n" if keep_lines else " ", t)
    t = TAG_RE.sub(" ", t)
    t = html.unescape(t)
    t = BR_RE.sub("\n" if keep_lines else " ", t)
    t = TAG_RE.sub(" ", t)
    return t
