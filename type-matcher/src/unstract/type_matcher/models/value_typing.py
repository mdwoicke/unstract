"""Infer SemanticType from a JSON value (and optionally its key path)."""

import re

from pydantic import BaseModel

from .taxonomy import SemanticType

# ── Step 1: Regex patterns on the value string (high confidence: 0.9) ────────

_VALUE_PATTERNS: list[tuple[SemanticType, re.Pattern]] = [
    (SemanticType.EMAIL, re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")),
    (SemanticType.SSN, re.compile(r"^\d{3}-\d{2}-\d{4}$")),
    (SemanticType.DATE, re.compile(
        r"^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$"
    )),
    # Phone must start with + or contain area code in parens or match US digit grouping
    # Avoids matching account/ID numbers like "0012-3456-7890"
    (SemanticType.PHONE, re.compile(
        r"^(\+[\d\s\-\.\(\)]{7,19}"
        r"|\(\d{1,4}\)[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}"
        r"|\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4})$"
    )),
    (SemanticType.URL, re.compile(r"^https?://", re.IGNORECASE)),
    (SemanticType.PERCENTAGE, re.compile(r"^[\-+]?\d+\.?\d*\s*%$")),
    (SemanticType.CURRENCY, re.compile(r"^\$[\d,]+\.?\d*$")),
    (SemanticType.ADDRESS_ZIP, re.compile(r"^\d{4,5}(-\d{4})?$")),
    (SemanticType.NUMBER, re.compile(r"^[\-+]?\d[\d,]*\.?\d*$")),
    (SemanticType.BOOLEAN, re.compile(
        r"^(true|false|yes|no|on|off|1|0|checked)$", re.IGNORECASE
    )),
]

# ── Step 2: Key-name patterns (medium confidence: 0.7) ──────────────────────

_KEY_PATTERNS: list[tuple[SemanticType, re.Pattern]] = [
    (SemanticType.EMAIL, re.compile(r"e[-_]?mail", re.IGNORECASE)),
    (SemanticType.PHONE, re.compile(
        r"phone|tel(?:ephone)?|mobile(?![-_\s]*(?:app|device|platform|os|version))|cell|fax",
        re.IGNORECASE,
    )),
    (SemanticType.DATE, re.compile(
        r"date|dob|birth|expir|issued|created|updated", re.IGNORECASE
    )),
    (SemanticType.SSN, re.compile(r"ssn|social.?sec", re.IGNORECASE)),
    (SemanticType.NAME_FIRST, re.compile(
        r"first.?name|given.?name|fname", re.IGNORECASE
    )),
    (SemanticType.NAME_LAST, re.compile(
        r"last.?name|surname|family.?name|lname", re.IGNORECASE
    )),
    (SemanticType.NAME_FULL, re.compile(
        r"full.?name|card.?holder|account.?holder|name$", re.IGNORECASE
    )),
    (SemanticType.GENDER, re.compile(r"gender|sex$", re.IGNORECASE)),
    (SemanticType.ADDRESS_LINE, re.compile(
        r"address|street|addr|line[_\s]?[12]", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_CITY, re.compile(r"city|town|municipality", re.IGNORECASE)),
    (SemanticType.ADDRESS_STATE, re.compile(
        r"state|province|region", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_ZIP, re.compile(
        r"zip|postal|post.?code", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_COUNTRY, re.compile(r"country|nation", re.IGNORECASE)),
    (SemanticType.COMPANY_NAME, re.compile(
        r"company|employer|organization|corp|business", re.IGNORECASE
    )),
    (SemanticType.JOB_TITLE, re.compile(
        r"job.?title|position|occupation|role", re.IGNORECASE
    )),
    (SemanticType.ACCOUNT_NUMBER, re.compile(
        r"account.?(?:no|num|number|#)|acct", re.IGNORECASE
    )),
    (SemanticType.CURRENCY, re.compile(
        r"amount|price|cost|fee|balance|total|premium|payment|salary|income",
        re.IGNORECASE,
    )),
    (SemanticType.PERCENTAGE, re.compile(
        r"rate|percent|pct|ratio|markup|discount|interchange", re.IGNORECASE
    )),
    (SemanticType.URL, re.compile(r"url|website|link|href", re.IGNORECASE)),
    (SemanticType.BOOLEAN, re.compile(
        r"is[_\s]|has[_\s]|enabled|active|flag", re.IGNORECASE
    )),
]


class TypedValue(BaseModel):
    """Result of type inference on a JSON value."""
    key: str
    value: str | int | float | bool | None
    semantic_type: SemanticType
    confidence: float  # 0.0–1.0


def _normalize_key(key: str) -> str:
    """Extract last segment from dot-path, strip array indices."""
    if "." in key:
        key = key[key.rfind(".") + 1:]
    return re.sub(r"\[\d+\]", "", key)


def infer_value_type(key: str, value: str | int | float | bool | None) -> TypedValue:
    """Infer the semantic type of a JSON value using key + regex heuristics.

    Key-name patterns run first because key names are more reliable than
    value regex for ambiguous cases (e.g. "0012-3456-7890" could be PHONE
    or ACCOUNT_NUMBER — the key "account_number" disambiguates).
    """
    s = str(value if value is not None else "").strip()
    norm_key = _normalize_key(key)

    # Step 1: Key-name pattern matching (reliable — key names are intentional)
    key_type: SemanticType | None = None
    for stype, pattern in _KEY_PATTERNS:
        if pattern.search(norm_key):
            key_type = stype
            break

    # Step 2: Value pattern matching (regex on the actual value)
    value_type: SemanticType | None = None
    if s:
        for stype, pattern in _VALUE_PATTERNS:
            if pattern.search(s):
                value_type = stype
                break

    # Resolution: prefer key when both match and disagree
    if key_type and value_type:
        if key_type == value_type:
            # Both agree — highest confidence
            return TypedValue(key=key, value=value, semantic_type=key_type, confidence=0.95)
        else:
            # Disagree — key name is more trustworthy
            return TypedValue(key=key, value=value, semantic_type=key_type, confidence=0.85)
    elif key_type:
        return TypedValue(key=key, value=value, semantic_type=key_type, confidence=0.8)
    elif value_type:
        return TypedValue(key=key, value=value, semantic_type=value_type, confidence=0.9)

    return TypedValue(key=key, value=value, semantic_type=SemanticType.TEXT, confidence=0.3)
