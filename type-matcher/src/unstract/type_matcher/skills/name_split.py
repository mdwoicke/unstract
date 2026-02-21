"""Skill that splits NAME_FULL values into synthetic NAME_FIRST / NAME_MIDDLE / NAME_LAST candidates."""

import re

from ..models.field_typing import TypedField
from ..models.taxonomy import SemanticType
from ..models.value_typing import TypedValue
from .base import MatchCandidate, MatchSkill

# Single letter with optional period — "A", "A.", "J", "j."
_MIDDLE_INITIAL_RE = re.compile(r"^[A-Za-z]\.?$")


class NameSplitSkill(MatchSkill):
    """Create synthetic first/middle/last name candidates from full-name values.

    Must run BEFORE TypeAlignmentSkill so the new candidates get scored
    by downstream skills.
    """

    def apply(
        self,
        candidates: list[MatchCandidate],
        typed_values: list[TypedValue],
        typed_fields: list[TypedField],
    ) -> list[MatchCandidate]:
        # Collect all unique (field, typed_field) pairs from existing candidates
        field_pairs: dict[str, tuple] = {}
        for c in candidates:
            sel = c.field.selector
            if sel not in field_pairs:
                field_pairs[sel] = (c.field, c.typed_field)

        # Find NAME_FULL values that can be split
        new_candidates: list[MatchCandidate] = []
        seen_full_keys: set[str] = set()

        for tv in typed_values:
            if tv.semantic_type != SemanticType.NAME_FULL:
                continue
            val = str(tv.value or "").strip()
            parts = val.split()
            if len(parts) < 2:
                continue
            if tv.key in seen_full_keys:
                continue
            seen_full_keys.add(tv.key)

            first_val = parts[0]

            # Detect middle initial: 3+ parts where the second token is a
            # single letter (optionally followed by a period), e.g. "A." or "J"
            middle_val: str | None = None
            if len(parts) >= 3 and _MIDDLE_INITIAL_RE.match(parts[1]):
                middle_val = parts[1]
                last_val = " ".join(parts[2:])
            else:
                last_val = " ".join(parts[1:])

            # Synthetic typed values
            first_key = tv.key + ".first_name"
            last_key = tv.key + ".last_name"
            tv_first = TypedValue(
                key=first_key,
                value=first_val,
                semantic_type=SemanticType.NAME_FIRST,
                confidence=tv.confidence,
            )
            tv_last = TypedValue(
                key=last_key,
                value=last_val,
                semantic_type=SemanticType.NAME_LAST,
                confidence=tv.confidence,
            )

            synthetic_values = [tv_first, tv_last]

            tv_middle: TypedValue | None = None
            if middle_val is not None:
                middle_key = tv.key + ".middle_name"
                tv_middle = TypedValue(
                    key=middle_key,
                    value=middle_val,
                    semantic_type=SemanticType.NAME_MIDDLE,
                    confidence=tv.confidence,
                )
                synthetic_values.append(tv_middle)

            # Pair each synthetic value with ALL fields
            for sel, (field, tf) in field_pairs.items():
                for sv in synthetic_values:
                    new_candidates.append(MatchCandidate(
                        field=field,
                        typed_field=tf,
                        value_key=sv.key,
                        typed_value=sv,
                        score=0.0,
                    ))

            # Also register in typed_values so downstream skills see them
            typed_values.extend(synthetic_values)

        candidates.extend(new_candidates)
        return candidates
