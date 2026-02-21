"""Infer SemanticType from an HTML form field descriptor."""

import re

from pydantic import BaseModel

from .taxonomy import SemanticType

# ── Step 1: HTML input type → SemanticType (high confidence) ─────────────────

_HTML_TYPE_MAP: dict[str, SemanticType] = {
    "email": SemanticType.EMAIL,
    "tel": SemanticType.PHONE,
    "date": SemanticType.DATE,
    "datetime-local": SemanticType.DATE,
    "month": SemanticType.DATE,
    "week": SemanticType.DATE,
    "time": SemanticType.DATE,
    "number": SemanticType.NUMBER,
    "url": SemanticType.URL,
    "checkbox": SemanticType.BOOLEAN,
}

# ── Step 2: Label/name/placeholder patterns (medium confidence) ──────────────

_LABEL_PATTERNS: list[tuple[SemanticType, re.Pattern]] = [
    (SemanticType.EMAIL, re.compile(r"e[-_\s]?mail", re.IGNORECASE)),
    (SemanticType.PHONE, re.compile(
        r"phone|tel(?:ephone)?|mobile|cell|fax", re.IGNORECASE
    )),
    (SemanticType.DATE, re.compile(
        r"date|dob|birth|expir", re.IGNORECASE
    )),
    (SemanticType.SSN, re.compile(r"ssn|social.?sec", re.IGNORECASE)),
    (SemanticType.NAME_FIRST, re.compile(
        r"first.?name|given.?name|fname", re.IGNORECASE
    )),
    (SemanticType.NAME_MIDDLE, re.compile(
        r"middle.?name|middle.?initial|mname|mi$", re.IGNORECASE
    )),
    (SemanticType.NAME_LAST, re.compile(
        r"last.?name|surname|family.?name|lname", re.IGNORECASE
    )),
    (SemanticType.NAME_FULL, re.compile(
        r"full.?name|card.?holder|account.?holder", re.IGNORECASE
    )),
    (SemanticType.GENDER, re.compile(r"gender|sex$", re.IGNORECASE)),
    (SemanticType.ADDRESS_LINE, re.compile(
        r"address|street|addr|line[_\s]?[12]", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_CITY, re.compile(r"city|town", re.IGNORECASE)),
    (SemanticType.ADDRESS_STATE, re.compile(
        r"state|province|region", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_ZIP, re.compile(
        r"zip|postal|post.?code", re.IGNORECASE
    )),
    (SemanticType.ADDRESS_COUNTRY, re.compile(r"country|nation", re.IGNORECASE)),
    (SemanticType.COMPANY_NAME, re.compile(
        r"company|employer|organization|business", re.IGNORECASE
    )),
    (SemanticType.JOB_TITLE, re.compile(
        r"job.?title|position|occupation", re.IGNORECASE
    )),
    (SemanticType.ACCOUNT_NUMBER, re.compile(
        r"account.?(?:no|num|number|#)|acct", re.IGNORECASE
    )),
    (SemanticType.CURRENCY, re.compile(
        r"amount|price|cost|fee|balance|total|premium|salary|income|payment",
        re.IGNORECASE,
    )),
    (SemanticType.PERCENTAGE, re.compile(
        r"rate|percent|pct|ratio|markup|discount", re.IGNORECASE
    )),
    (SemanticType.URL, re.compile(r"url|website|link", re.IGNORECASE)),
    (SemanticType.BOOLEAN, re.compile(
        r"is[_\s]|has[_\s]|enabled|active|flag|agree|accept|consent",
        re.IGNORECASE,
    )),
]


class TypedField(BaseModel):
    """Result of type inference on a form field."""
    selector: str
    semantic_type: SemanticType
    confidence: float


class FieldDescriptor(BaseModel):
    """Mirrors the Chrome extension's FieldDescriptor interface."""
    id: str = ""
    name: str = ""
    label: str = ""
    placeholder: str = ""
    type: str = ""
    context: str = ""
    selector: str
    options: list[str] | None = None


def infer_field_type(field: FieldDescriptor) -> TypedField:
    """Infer the semantic type of a form field from its HTML attributes."""
    # Step 1: HTML type attribute (high confidence)
    html_type = field.type.lower().strip()
    if html_type in _HTML_TYPE_MAP:
        return TypedField(
            selector=field.selector,
            semantic_type=_HTML_TYPE_MAP[html_type],
            confidence=0.9,
        )

    # Radio with options → ENUM_SELECT
    if html_type == "radio":
        return TypedField(
            selector=field.selector,
            semantic_type=SemanticType.ENUM_SELECT,
            confidence=0.85,
        )

    # Select with options → ENUM_SELECT
    if html_type == "select" or html_type == "select-one":
        return TypedField(
            selector=field.selector,
            semantic_type=SemanticType.ENUM_SELECT,
            confidence=0.85,
        )

    # Step 2: Label/name/placeholder pattern matching
    context = " ".join(
        filter(None, [field.label, field.name, field.placeholder, field.id])
    )
    for stype, pattern in _LABEL_PATTERNS:
        if pattern.search(context):
            return TypedField(
                selector=field.selector,
                semantic_type=stype,
                confidence=0.80,
            )

    return TypedField(
        selector=field.selector,
        semantic_type=SemanticType.TEXT,
        confidence=0.3,
    )
