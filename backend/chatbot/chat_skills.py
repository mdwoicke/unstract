"""Post-processing skill layer for chat responses.

These skills run deterministically after the LLM returns its text.
They do not make additional LLM calls.
"""

import json
import re


# Keys whose values are amounts — shown with currency hint
_CURRENCY_KEYS = {
    "amount", "fee", "price", "cost", "charge", "balance",
    "total", "subtotal", "premium", "payment", "rate",
}

# Known abbreviations to expand for readability
_ABBREV = {
    "dob": "Date of Birth",
    "ssn": "Social Security Number",
    "ein": "Employer Identification Number",
    "id": "ID",
    "url": "URL",
    "api": "API",
    "llm": "LLM",
    "ocr": "OCR",
    "pdf": "PDF",
    "npi": "NPI",
    "tin": "TIN",
    "zip": "ZIP Code",
    "po": "P.O.",
    "dba": "DBA",
}


def _humanize_key(key: str) -> str:
    """Convert snake_case / camelCase / UPPER_CASE keys to a readable label."""
    # camelCase → snake_case
    key = re.sub(r"([a-z])([A-Z])", r"\1_\2", key)
    # Replace non-word separators with space
    key = re.sub(r"[\s_\-]+", " ", key).strip().lower()

    # Check known abbreviations for the whole key first
    if key.replace(" ", "") in _ABBREV:
        return _ABBREV[key.replace(" ", "")]
    if key in _ABBREV:
        return _ABBREV[key]

    # Title-case, but expand any abbreviation tokens
    tokens = key.split()
    result = []
    for tok in tokens:
        result.append(_ABBREV.get(tok, tok.capitalize()))
    return " ".join(result)


def _value_to_str(key: str, value) -> str:
    """Render a single key-value pair as a natural-language sentence."""
    label = _humanize_key(key)
    key_lower = key.lower().replace(" ", "_")

    if value is None or value == "" or value == []:
        return f"The {label} is not available."

    if isinstance(value, bool):
        return f"The {label} is {'yes' if value else 'no'}."

    if isinstance(value, (int, float)):
        if any(ck in key_lower for ck in _CURRENCY_KEYS):
            return f"The {label} is {value:,.2f}."
        return f"The {label} is {value}."

    if isinstance(value, list):
        if not value:
            return f"The {label} list is empty."
        items = ", ".join(str(v) for v in value)
        return f"The {label} includes: {items}."

    if isinstance(value, dict):
        # Recursively render nested dicts as a sub-sentence
        sub = "; ".join(
            f"{_humanize_key(k)}: {v}" for k, v in value.items()
        )
        return f"The {label} contains: {sub}."

    # Plain string value
    val = str(value).strip()
    if not val:
        return f"The {label} is not specified."
    return f"The {label} is **{val}**."


def _try_parse_json(text: str):
    """Try to extract and parse JSON from text. Returns (parsed, raw_json_str)
    or (None, None) if the text doesn't contain parseable JSON."""
    text = text.strip()

    # Markdown code fence: ```json ... ``` or ``` ... ```
    fence = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    candidates = [fence.group(1) if fence else None, text]

    for candidate in candidates:
        if candidate is None:
            continue
        try:
            parsed = json.loads(candidate)
            return parsed, candidate
        except (json.JSONDecodeError, ValueError):
            continue

    return None, None


def json_to_prose(response_text: str) -> str:
    """Convert a JSON LLM response to readable natural-language prose.

    If the response is not JSON, it is returned unchanged.
    Handles:
      - Flat dicts  {"key": "value", ...}
      - Single-key dicts  {"DOB": "03/15/1985"}
      - Nested dicts
      - JSON wrapped in markdown code fences
    """
    parsed, _ = _try_parse_json(response_text)

    if parsed is None:
        return response_text  # Not JSON — pass through

    if not isinstance(parsed, dict):
        return response_text  # Array or scalar JSON — pass through

    sentences = [_value_to_str(k, v) for k, v in parsed.items()]
    return "  \n".join(sentences)  # Markdown line-break between sentences


def apply_skills(response_text: str) -> str:
    """Run all post-processing skills on the LLM response in order.

    Skills are applied only when their trigger condition is met;
    otherwise the response passes through unchanged.
    """
    response_text = json_to_prose(response_text)
    return response_text
