"""OptionMatcherSkill — boost select/radio fields when value matches an option."""

from ..models.field_typing import TypedField
from ..models.taxonomy import SemanticType
from ..models.value_typing import TypedValue
from .base import MatchCandidate, MatchSkill

OPTION_BOOST = 0.15


class OptionMatcherSkill(MatchSkill):
    """Boost score for select/radio fields when the JSON value matches an option."""

    def apply(
        self,
        candidates: list[MatchCandidate],
        typed_values: list[TypedValue],
        typed_fields: list[TypedField],
    ) -> list[MatchCandidate]:
        for c in candidates:
            if c.typed_field.semantic_type != SemanticType.ENUM_SELECT:
                continue
            options = c.field.options
            if not options:
                continue

            val_str = str(c.typed_value.value or "").strip().lower()
            if not val_str:
                continue

            # Check if the value matches any option (case-insensitive)
            option_lower = [o.lower() for o in options]
            if val_str in option_lower:
                c.score = min(1.0, c.score + OPTION_BOOST)

        return candidates
