"""Tests for the matching pipeline."""

from unstract.type_matcher.models.api import MatchRequest
from unstract.type_matcher.models.field_typing import FieldDescriptor
from unstract.type_matcher.skills.pipeline import apply_matching_skills


def _field(**kwargs) -> FieldDescriptor:
    defaults = dict(id="", name="", label="", placeholder="", type="text", context="", selector="#test")
    defaults.update(kwargs)
    return FieldDescriptor(**defaults)


def test_email_exact_type_match():
    """Email value should match email field with high confidence."""
    req = MatchRequest(
        payload={"email": "john@example.com"},
        fields=[_field(type="email", name="email", label="Email", selector="#email")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "email"
    assert results[0].fieldId == "#email"
    assert results[0].auto is True


def test_phone_type_match():
    """Phone value should match tel field."""
    req = MatchRequest(
        payload={"phone": "+1 555-123-4567"},
        fields=[_field(type="tel", name="phone", label="Phone", selector="#phone")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "phone"
    assert results[0].auto is True


def test_name_type_match_by_key():
    """first_name key should match 'First Name' label field and auto-fill."""
    req = MatchRequest(
        payload={"first_name": "John"},
        fields=[_field(label="First Name", selector="#fname")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "first_name"
    assert results[0].auto is True


def test_name_camel_case_key():
    """camelCase keys like firstName should match name fields."""
    req = MatchRequest(
        payload={"firstName": "Jane", "lastName": "Doe"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    auto_results = [r for r in results if r.auto]
    matched_keys = {r.jsonKey for r in auto_results}
    assert "firstName" in matched_keys
    assert "lastName" in matched_keys


def test_multiple_fields():
    """Multiple typed fields should each get their correct match."""
    req = MatchRequest(
        payload={
            "email": "john@example.com",
            "first_name": "John",
            "phone": "+1 555-0000",
        },
        fields=[
            _field(type="email", name="email", label="Email", selector="#email"),
            _field(label="First Name", selector="#fname"),
            _field(type="tel", label="Phone", selector="#phone"),
        ],
    )
    results = apply_matching_skills(req)
    matched_keys = {r.jsonKey for r in results}
    assert "email" in matched_keys
    assert "phone" in matched_keys
    assert "first_name" in matched_keys


def test_dotpath_key_matches():
    """Dot-path keys like 'output.mbn.card_holder.first_name' should match."""
    req = MatchRequest(
        payload={"output.mbn.card_holder.first_name": "Jane"},
        fields=[_field(label="First Name", selector="#fname")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "output.mbn.card_holder.first_name"


def test_no_match_below_threshold():
    """Completely unrelated value/field should produce no results."""
    req = MatchRequest(
        payload={"random_uuid": "abc-123-xyz"},
        fields=[_field(type="email", label="Email Address", selector="#email")],
    )
    results = apply_matching_skills(req)
    # Either no results or very low confidence (not auto)
    auto_results = [r for r in results if r.auto]
    assert len(auto_results) == 0


def test_one_to_one_assignment():
    """Each value key should only be assigned to one field."""
    req = MatchRequest(
        payload={"email": "john@example.com"},
        fields=[
            _field(type="email", label="Email", selector="#email1"),
            _field(type="email", label="Backup Email", selector="#email2"),
        ],
    )
    results = apply_matching_skills(req)
    assigned_keys = [r.jsonKey for r in results]
    # The same key can appear at most once
    assert len(assigned_keys) == len(set(assigned_keys))


def test_company_name_not_confused_with_full_name():
    """company_name should match COMPANY_NAME, not NAME_FULL."""
    req = MatchRequest(
        payload={"company_name": "Acme Corp", "full_name": "John Doe"},
        fields=[
            _field(label="Company / Employer Name", name="company_name", selector="#company"),
            _field(label="Full Name", selector="#name"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#company"].jsonKey == "company_name"
    assert by_field["#company"].auto is True
    assert by_field["#name"].jsonKey == "full_name"


def test_gender_radio_field():
    """Gender value should match radio field (ENUM_SELECT)."""
    req = MatchRequest(
        payload={"gender": "Male"},
        fields=[_field(label="Gender", name="gender", type="radio", selector="#gender")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "gender"
    assert results[0].auto is True


def test_income_currency_field():
    """Income key should match a number field labeled 'Monthly Income'."""
    req = MatchRequest(
        payload={"monthly_income": "85000"},
        fields=[_field(type="number", label="Monthly Income", name="monthly_income", selector="#income")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "monthly_income"
    assert results[0].auto is True


def test_full_name_splits_to_first_last():
    """NAME_FULL 'John Doe' should auto-fill both first_name and last_name fields."""
    req = MatchRequest(
        payload={"contact_name": "John Doe"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#fname"].jsonValue == "John"
    assert by_field["#fname"].auto is True
    assert by_field["#lname"].jsonValue == "Doe"
    assert by_field["#lname"].auto is True


def test_full_name_with_middle_initial():
    """NAME_FULL 'John A. Mitchell' should split into first/middle/last."""
    req = MatchRequest(
        payload={"contact_name": "John A. Mitchell"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Middle Name", selector="#mname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#fname"].jsonValue == "John"
    assert by_field["#fname"].auto is True
    assert by_field["#mname"].jsonValue == "A."
    assert by_field["#mname"].auto is True
    assert by_field["#lname"].jsonValue == "Mitchell"
    assert by_field["#lname"].auto is True


def test_full_name_middle_initial_no_period():
    """Middle initial without period ('John A Mitchell') should also be detected."""
    req = MatchRequest(
        payload={"contact_name": "John A Mitchell"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Middle Name", selector="#mname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#fname"].jsonValue == "John"
    assert by_field["#mname"].jsonValue == "A"
    assert by_field["#lname"].jsonValue == "Mitchell"


def test_full_name_no_middle_initial():
    """Two-part name should still split as first/last with no middle."""
    req = MatchRequest(
        payload={"contact_name": "John Mitchell"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Middle Name", selector="#mname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#fname"].jsonValue == "John"
    assert by_field["#lname"].jsonValue == "Mitchell"
    # Middle name field should not be filled (no middle initial detected)
    assert "#mname" not in by_field or by_field.get("#mname", None) is None or not by_field.get("#mname").auto


def test_dotpath_full_name_splits():
    """Dot-path NAME_FULL key like 'owners[0].name' should also split."""
    req = MatchRequest(
        payload={"output.mbn.owners[0].name": "John Cabrera"},
        fields=[
            _field(label="First Name", selector="#fname"),
            _field(label="Last Name", selector="#lname"),
        ],
    )
    results = apply_matching_skills(req)
    by_field = {r.fieldId: r for r in results}
    assert by_field["#fname"].jsonValue == "John"
    assert by_field["#lname"].jsonValue == "Cabrera"
