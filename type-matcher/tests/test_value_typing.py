"""Tests for JSON value → SemanticType inference."""

from unstract.type_matcher.models.taxonomy import SemanticType
from unstract.type_matcher.models.value_typing import infer_value_type


def test_email_by_value():
    r = infer_value_type("contact", "john@example.com")
    assert r.semantic_type == SemanticType.EMAIL
    assert r.confidence == 0.9


def test_phone_by_value():
    r = infer_value_type("number", "+1 (555) 123-4567")
    assert r.semantic_type == SemanticType.PHONE
    assert r.confidence == 0.9


def test_phone_with_parens():
    r = infer_value_type("tel", "(02) 8123-4567")
    assert r.semantic_type == SemanticType.PHONE


def test_phone_us_format():
    r = infer_value_type("tel", "555-123-4567")
    assert r.semantic_type == SemanticType.PHONE


def test_account_not_phone():
    """Account numbers like 0012-3456-7890 should NOT be classified as PHONE."""
    r = infer_value_type("account_number", "0012-3456-7890")
    assert r.semantic_type == SemanticType.ACCOUNT_NUMBER


def test_date_by_value():
    r = infer_value_type("field", "2024-01-15")
    assert r.semantic_type == SemanticType.DATE
    assert r.confidence == 0.9


def test_ssn_by_value():
    r = infer_value_type("id", "123-45-6789")
    assert r.semantic_type == SemanticType.SSN
    assert r.confidence == 0.9


def test_currency_by_value():
    # Key "total" matches CURRENCY, value "$1,234.56" matches CURRENCY → both agree
    r = infer_value_type("total", "$1,234.56")
    assert r.semantic_type == SemanticType.CURRENCY
    assert r.confidence == 0.95  # both key and value agree


def test_percentage_by_value():
    # Key "rate" matches PERCENTAGE, value "5.25%" matches PERCENTAGE → both agree
    r = infer_value_type("rate", "5.25%")
    assert r.semantic_type == SemanticType.PERCENTAGE
    assert r.confidence == 0.95


def test_url_by_value():
    r = infer_value_type("site", "https://example.com")
    assert r.semantic_type == SemanticType.URL
    assert r.confidence == 0.9


def test_zip_by_value():
    r = infer_value_type("code", "90210")
    assert r.semantic_type == SemanticType.ADDRESS_ZIP
    assert r.confidence == 0.9


def test_zip_4digit():
    """Philippine-style 4-digit zip code."""
    r = infer_value_type("code", "1234")
    assert r.semantic_type == SemanticType.ADDRESS_ZIP
    assert r.confidence == 0.9


def test_boolean_by_value():
    # Key "flag" matches BOOLEAN, value "true" matches BOOLEAN → both agree
    r = infer_value_type("flag", "true")
    assert r.semantic_type == SemanticType.BOOLEAN
    assert r.confidence == 0.95


def test_email_by_key():
    r = infer_value_type("email_address", "not-a-pattern")
    assert r.semantic_type == SemanticType.EMAIL
    assert r.confidence == 0.8  # key-only match


def test_first_name_by_key():
    r = infer_value_type("output.card_holder.first_name", "John")
    assert r.semantic_type == SemanticType.NAME_FIRST
    assert r.confidence == 0.8


def test_last_name_by_key():
    r = infer_value_type("surname", "Smith")
    assert r.semantic_type == SemanticType.NAME_LAST
    assert r.confidence == 0.8


def test_dob_by_key():
    r = infer_value_type("dob", "Jan 15 1990")
    assert r.semantic_type == SemanticType.DATE
    assert r.confidence == 0.8


def test_city_by_key():
    r = infer_value_type("city", "Springfield")
    assert r.semantic_type == SemanticType.ADDRESS_CITY
    assert r.confidence == 0.8


def test_generic_text():
    r = infer_value_type("misc_field", "random text value")
    assert r.semantic_type == SemanticType.TEXT
    assert r.confidence == 0.3


def test_dotpath_normalization():
    """Key normalization should use last segment only."""
    r = infer_value_type("output.mbn.card_holder.phone", "some text")
    assert r.semantic_type == SemanticType.PHONE
    assert r.confidence == 0.8


def test_key_overrides_value_mismatch():
    """Key pattern should win when key and value regex disagree."""
    # Value "85000" matches NUMBER regex, but key "income" says CURRENCY
    r = infer_value_type("income", "85000")
    assert r.semantic_type == SemanticType.CURRENCY
    assert r.confidence == 0.85  # key and value disagree, key wins


def test_key_value_agreement_boosts_confidence():
    """When key and value regex agree, confidence should be highest."""
    r = infer_value_type("email", "user@example.com")
    assert r.semantic_type == SemanticType.EMAIL
    assert r.confidence == 0.95
