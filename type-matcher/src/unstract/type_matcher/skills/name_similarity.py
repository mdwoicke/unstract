"""NameSimilaritySkill — tiebreaker using key/label text similarity."""

import re
from difflib import SequenceMatcher

from ..models.field_typing import TypedField
from ..models.taxonomy import SemanticType
from ..models.value_typing import TypedValue
from .base import MatchCandidate, MatchSkill

# When types match exactly (both non-TEXT), type dominates — name is just a tiebreaker
EXACT_TYPE_WEIGHT = 0.85
EXACT_NAME_WEIGHT = 0.15

# When both sides are TEXT, name similarity is the ONLY useful signal
TEXT_TYPE_WEIGHT = 0.15
TEXT_NAME_WEIGHT = 0.85

# When types are mixed/different, blend both signals
DEFAULT_TYPE_WEIGHT = 0.5
DEFAULT_NAME_WEIGHT = 0.5


def _normalize(text: str) -> str:
    """Normalize a key or label for comparison."""
    # Take last segment of dot-paths
    if "." in text:
        text = text[text.rfind(".") + 1:]
    text = re.sub(r"\[\d+\]", "", text)
    text = re.sub(r"[_\-]", " ", text)
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return text.lower().strip()


def _field_context(selector: str, label: str, name: str, placeholder: str, field_id: str) -> str:
    """Build context string from field attributes."""
    return " ".join(filter(None, [label, name, placeholder, field_id])).lower()


def _best_ratio(norm_key: str, label: str, name: str, placeholder: str, field_id: str) -> float:
    """Compare normalized key against each field component individually.

    SequenceMatcher penalizes large length differences, so comparing a 4-char
    key like "city" against a 40-char concatenated context gives a poor ratio.
    Comparing against each component separately and taking the max is more accurate.
    """
    best = 0.0
    for text in [label, name, field_id]:
        if not text:
            continue
        normalized = _normalize(text)
        if not normalized:
            continue
        ratio = SequenceMatcher(None, norm_key, normalized).ratio()
        if ratio > best:
            best = ratio
    # Also check the full context as a fallback
    full_ctx = _field_context("", label, name, placeholder, field_id)
    if full_ctx:
        ratio = SequenceMatcher(None, norm_key, full_ctx).ratio()
        if ratio > best:
            best = ratio
    return best


class NameSimilaritySkill(MatchSkill):
    """Blend name similarity into candidate scores.

    For exact type matches (both non-TEXT), type score dominates (85/15).
    For TEXT-TEXT matches, name similarity dominates (85/15 reversed).
    For mixed types, even blend (50/50).
    """

    def apply(
        self,
        candidates: list[MatchCandidate],
        typed_values: list[TypedValue],
        typed_fields: list[TypedField],
    ) -> list[MatchCandidate]:
        for c in candidates:
            norm_key = _normalize(c.value_key)
            ratio = _best_ratio(
                norm_key,
                c.field.label,
                c.field.name,
                c.field.placeholder,
                c.field.id,
            )

            vt = c.typed_value.semantic_type
            ft = c.typed_field.semantic_type
            exact_type = (vt == ft and vt != SemanticType.TEXT)
            both_text = (vt == SemanticType.TEXT and ft == SemanticType.TEXT)

            if exact_type:
                c.score = EXACT_TYPE_WEIGHT * c.score + EXACT_NAME_WEIGHT * ratio
            elif both_text:
                c.score = TEXT_TYPE_WEIGHT * c.score + TEXT_NAME_WEIGHT * ratio
            else:
                c.score = DEFAULT_TYPE_WEIGHT * c.score + DEFAULT_NAME_WEIGHT * ratio

        return candidates
