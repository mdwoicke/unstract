"""Post-processing skill layer for chat responses.

These skills run deterministically after the LLM returns its text.
They do not make additional LLM calls.
"""

import ast
import json
import re


# Keys whose values are dollar amounts
_CURRENCY_KEYS = {
    "volume", "amount", "ticket", "price", "cost", "charge", "balance",
    "total", "subtotal", "premium", "payment", "fee",
}

# Keys whose values are percentages
_PERCENTAGE_KEYS = {
    "rate", "percent", "pct", "erm", "err", "surcharge",
    "markup", "discount", "interchange",
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


def _is_empty(value) -> bool:
    """Return True if a value carries no meaningful data.

    Catches None, empty strings/lists/dicts, and strings that are
    only unit symbols (e.g. '%', '$', '$ %') with no numeric content.
    """
    if value is None or value == [] or value == {}:
        return True
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return True
        # Pure unit / punctuation with no digits → treat as empty
        if re.match(r'^[$%\s./\-]+$', stripped):
            return True
    return False


def _humanize_key(key: str) -> str:
    """Convert snake_case / camelCase / UPPER_CASE keys to a readable label."""
    key = re.sub(r"([a-z])([A-Z])", r"\1_\2", key)
    key = re.sub(r"[\s_\-]+", " ", key).strip().lower()

    if key.replace(" ", "") in _ABBREV:
        return _ABBREV[key.replace(" ", "")]
    if key in _ABBREV:
        return _ABBREV[key]

    tokens = key.split()
    result = []
    for tok in tokens:
        result.append(_ABBREV.get(tok, tok.capitalize()))
    return " ".join(result)


def _is_currency_key(key_lower: str) -> bool:
    return any(ck in key_lower for ck in _CURRENCY_KEYS)


def _is_percentage_key(key_lower: str) -> bool:
    return any(pk in key_lower for pk in _PERCENTAGE_KEYS)


def _try_numeric(value) -> float | None:
    """Try to parse a value as a number. Returns float or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "").lstrip("$").rstrip("%").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _format_number(num: float, key_lower: str) -> str:
    """Format a number with the appropriate currency or percentage symbol."""
    if _is_currency_key(key_lower):
        if num == int(num):
            return f"${int(num):,}"
        return f"${num:,.2f}"
    if _is_percentage_key(key_lower):
        val = int(num) if num == int(num) else num
        return f"{val}%"
    # Plain number
    if num == int(num):
        return str(int(num))
    return str(num)


def _format_value(value, depth: int = 0, key: str = "") -> str:
    """Recursively format any value for readable display.

    Pass `key` so scalars can be rendered with the right currency/percentage symbol.
    """
    if _is_empty(value):
        return "N/A"
    if isinstance(value, bool):
        return "yes" if value else "no"

    key_lower = key.lower().replace(" ", "_").replace("-", "_")

    # Numeric value (or string that looks numeric) with key context
    if key:
        num = _try_numeric(value)
        if num is not None:
            return _format_number(num, key_lower)

    if isinstance(value, (int, float)):
        return str(int(value)) if value == int(value) else str(value)

    if isinstance(value, list):
        if not value:
            return "none"
        if all(isinstance(item, dict) for item in value):
            indent = "  " * depth
            lines = []
            for item in value:
                parts = [
                    f"**{_humanize_key(k)}**: {_format_value(v, depth + 1, k)}"
                    for k, v in item.items()
                    if not _is_empty(v)
                ]
                if parts:
                    lines.append(f"{indent}  - " + "; ".join(parts))
            return "\n" + "\n".join(lines)
        return ", ".join(_format_value(v, depth, key) for v in value)

    if isinstance(value, dict):
        parts = [
            f"{_humanize_key(k)}: {_format_value(v, depth, k)}"
            for k, v in value.items()
            if not _is_empty(v)
        ]
        return "; ".join(parts) if parts else "N/A"

    return str(value).strip()


def _value_to_str(key: str, value) -> str:
    """Render a single top-level key-value pair as a natural-language sentence."""
    label = _humanize_key(key)
    key_lower = key.lower().replace(" ", "_").replace("-", "_")

    if _is_empty(value):
        return f"The {label} is not available."

    if isinstance(value, bool):
        return f"The {label} is {'yes' if value else 'no'}."

    # Numeric scalar (or numeric string) with currency/percentage awareness
    num = _try_numeric(value) if not isinstance(value, (list, dict)) else None
    if num is not None:
        return f"The {label} is **{_format_number(num, key_lower)}**."

    if isinstance(value, list):
        if not value:
            return f"The {label} list is empty."
        if all(isinstance(item, dict) for item in value):
            lines = []
            for item in value:
                parts = [
                    f"**{_humanize_key(k)}**: {_format_value(v, depth=1, key=k)}"
                    for k, v in item.items()
                    if not _is_empty(v)
                ]
                if parts:
                    lines.append("- " + "; ".join(parts))
            return f"The {label}:\n" + "\n".join(lines)
        return f"The {label} includes: " + ", ".join(
            _format_value(v, key=key) for v in value
        ) + "."

    if isinstance(value, dict):
        parts = [
            f"{_humanize_key(k)}: {_format_value(v, key=k)}"
            for k, v in value.items()
            if not _is_empty(v)
        ]
        if not parts:
            return f"The {label} is not specified."
        return f"The {label} contains: {'; '.join(parts)}."

    val = str(value).strip()
    if not val:
        return f"The {label} is not specified."
    return f"The {label} is **{val}**."


def _try_parse_json(text: str):
    """Try to extract and parse JSON from text. Returns (parsed, raw_json_str)
    or (None, None) if the text doesn't contain parseable JSON."""
    text = text.strip()

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
    """Convert a JSON LLM response to readable natural-language prose."""
    parsed, _ = _try_parse_json(response_text)

    if parsed is None:
        return response_text

    if not isinstance(parsed, dict):
        return response_text

    sentences = [_value_to_str(k, v) for k, v in parsed.items()]
    return "  \n".join(sentences)


def python_dicts_to_prose(response_text: str) -> str:
    """Detect embedded Python dict/list literals and reformat as markdown.

    Fallback for when the LLM outputs Python repr syntax instead of JSON.
    """
    first_brace = response_text.find("{")
    if first_brace == -1:
        return response_text

    prefix = response_text[:first_brace]
    tail = response_text[first_brace:].rstrip(". \n")

    # Attempt 1: bare comma-separated dicts → wrap in [] and parse as list
    try:
        parsed = ast.literal_eval("[" + tail + "]")
        if isinstance(parsed, list) and all(isinstance(i, dict) for i in parsed):
            return prefix + "\n" + _format_value(parsed)
    except (ValueError, SyntaxError):
        pass

    # Attempt 2: tail is already a list [...] or single dict
    try:
        parsed = ast.literal_eval(tail)
        if isinstance(parsed, (list, dict)):
            return prefix + "\n" + _format_value(parsed)
    except (ValueError, SyntaxError):
        pass

    return response_text


def apply_skills(response_text: str) -> str:
    """Run all post-processing skills on the LLM response in order."""
    response_text = json_to_prose(response_text)
    response_text = python_dicts_to_prose(response_text)
    return response_text
