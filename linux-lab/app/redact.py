"""Mask secrets and personal data before output reaches the screen, the AI or the audit log."""
import re
PATTERNS = [
    (re.compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+"), r"\1=***"),
    (re.compile(r"(?i)bearer\s+[a-z0-9._\-]+"), "Bearer ***"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "<email>"),
    (re.compile(r"\b(?:\d[ -]?){13,16}\b"), "<card>"),
]
def redact(text: str) -> str:
    for p, r in PATTERNS:
        text = p.sub(r, text)
    return text
