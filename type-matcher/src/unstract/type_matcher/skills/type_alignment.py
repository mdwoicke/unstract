"""TypeAlignmentSkill — primary scoring by semantic type compatibility."""

from ..models.field_typing import TypedField
from ..models.taxonomy import SemanticType, types_compatible
from ..models.value_typing import TypedValue
from .base import MatchCandidate, MatchSkill


class TypeAlignmentSkill(MatchSkill):
    """Score candidates based on type alignment between value and field.

    Exact type match  → 1.0 base score (modulated by confidence).
    Compatible types  → 0.7 base score.
    Incompatible      → 0.0 (candidate removed).
    TEXT on either side acts as a wildcard with 0.3 base.
    """

    def apply(
        self,
        candidates: list[MatchCandidate],
        typed_values: list[TypedValue],
        typed_fields: list[TypedField],
    ) -> list[MatchCandidate]:
        result: list[MatchCandidate] = []

        for c in candidates:
            vt = c.typed_value.semantic_type
            ft = c.typed_field.semantic_type

            if vt == ft and vt != SemanticType.TEXT:
                # Exact type match
                base = 1.0
            elif vt == SemanticType.TEXT or ft == SemanticType.TEXT:
                # One side is generic text — weak signal
                base = 0.3
            elif types_compatible(vt, ft):
                # Compatible but not exact
                base = 0.7
            else:
                # Incompatible — drop
                continue

            # Modulate by the confidence of both type inferences
            confidence_factor = (c.typed_value.confidence + c.typed_field.confidence) / 2
            c.score = base * confidence_factor
            result.append(c)

        return result
