"""Tests for form field → SemanticType inference."""

from unstract.type_matcher.models.field_typing import FieldDescriptor, infer_field_type
from unstract.type_matcher.models.taxonomy import SemanticType


def _field(**kwargs) -> FieldDescriptor:
    defaults = dict(id="", name="", label="", placeholder="", type="text", context="", selector="#test")
    defaults.update(kwargs)
    return FieldDescriptor(**defaults)


def test_email_by_html_type():
    r = infer_field_type(_field(type="email"))
    assert r.semantic_type == SemanticType.EMAIL
    assert r.confidence == 0.9


def test_phone_by_html_type():
    r = infer_field_type(_field(type="tel"))
    assert r.semantic_type == SemanticType.PHONE
    assert r.confidence == 0.9


def test_date_by_html_type():
    r = infer_field_type(_field(type="date"))
    assert r.semantic_type == SemanticType.DATE
    assert r.confidence == 0.9


def test_number_by_html_type():
    r = infer_field_type(_field(type="number"))
    assert r.semantic_type == SemanticType.NUMBER
    assert r.confidence == 0.9


def test_url_by_html_type():
    r = infer_field_type(_field(type="url"))
    assert r.semantic_type == SemanticType.URL
    assert r.confidence == 0.9


def test_checkbox_by_html_type():
    r = infer_field_type(_field(type="checkbox"))
    assert r.semantic_type == SemanticType.BOOLEAN
    assert r.confidence == 0.9


def test_radio_is_enum():
    r = infer_field_type(_field(type="radio"))
    assert r.semantic_type == SemanticType.ENUM_SELECT


def test_select_is_enum():
    r = infer_field_type(_field(type="select-one"))
    assert r.semantic_type == SemanticType.ENUM_SELECT


def test_first_name_by_label():
    r = infer_field_type(_field(label="First Name"))
    assert r.semantic_type == SemanticType.NAME_FIRST
    assert r.confidence == 0.75


def test_last_name_by_label():
    r = infer_field_type(_field(label="Last Name"))
    assert r.semantic_type == SemanticType.NAME_LAST


def test_email_by_name_attr():
    r = infer_field_type(_field(name="email"))
    assert r.semantic_type == SemanticType.EMAIL


def test_phone_by_placeholder():
    r = infer_field_type(_field(placeholder="Phone Number"))
    assert r.semantic_type == SemanticType.PHONE


def test_city_by_label():
    r = infer_field_type(_field(label="City"))
    assert r.semantic_type == SemanticType.ADDRESS_CITY


def test_zip_by_label():
    r = infer_field_type(_field(label="ZIP Code"))
    assert r.semantic_type == SemanticType.ADDRESS_ZIP


def test_generic_text_field():
    r = infer_field_type(_field(label="Notes"))
    assert r.semantic_type == SemanticType.TEXT
    assert r.confidence == 0.3
