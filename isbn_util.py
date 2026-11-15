"""ISBN 정리 도우미.

정보나루·국립중앙도서관은 가끔 'ISBN1 ISBN2'처럼 두 개를 붙여 보낸다.
그대로 저장하면 books의 키가 깨지므로, 저장 전에 13자리 하나만 남긴다.
"""

import re

_ISBN = re.compile(r"\d{13}")


def isbn_candidates(value):
    """문자열 안의 13자리 ISBN을 순서대로 모두 돌려준다."""
    return _ISBN.findall(str(value or ""))


def norm_isbn(value):
    """13자리 ISBN 하나(첫 번째). 없으면 None."""
    found = isbn_candidates(value)
    return found[0] if found else None


def fix_isbns(obj):
    """API 응답 안의 모든 'isbn13' 값을 제자리에서 13자리 하나로 고친다."""
    if isinstance(obj, dict):
        if isinstance(obj.get("isbn13"), str):
            obj["isbn13"] = norm_isbn(obj["isbn13"])
        for v in obj.values():
            fix_isbns(v)
    elif isinstance(obj, list):
        for v in obj:
            fix_isbns(v)
    return obj
