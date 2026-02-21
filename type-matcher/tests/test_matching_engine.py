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
    """first_name key should match 'First Name' label field even with generic text type."""
    req = MatchRequest(
        payload={"first_name": "John"},
        fields=[_field(label="First Name", selector="#fname")],
    )
    results = apply_matching_skills(req)
    assert len(results) == 1
    assert results[0].jsonKey == "first_name"


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
