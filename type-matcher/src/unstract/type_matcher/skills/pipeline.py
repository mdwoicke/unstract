"""Matching pipeline — composes all skills to produce final matches."""

from ..models.api import MatchRequest, MatchResultItem, RankItem
from ..models.field_typing import FieldDescriptor, TypedField, infer_field_type
from ..models.value_typing import TypedValue, infer_value_type
from .base import MatchCandidate
from .name_similarity import NameSimilaritySkill, _normalize, _field_context, _best_ratio
from .name_split import NameSplitSkill
from .option_matcher import OptionMatcherSkill
from .type_alignment import TypeAlignmentSkill

AUTO_THRESHOLD = 0.65
SUGGEST_THRESHOLD = 0.35

# Skill instances (stateless, reusable)
_SKILLS = [
    NameSplitSkill(),
    TypeAlignmentSkill(),
    NameSimilaritySkill(),
    OptionMatcherSkill(),
]


def _type_both_sides(
    request: MatchRequest,
) -> tuple[list[TypedValue], list[TypedField], dict[str, TypedValue], dict[str, TypedField]]:
    """Run type inference on all values and fields."""
    typed_values: list[TypedValue] = []
    value_map: dict[str, TypedValue] = {}
    for key, value in request.payload.items():
        tv = infer_value_type(key, value)
        typed_values.append(tv)
        value_map[key] = tv

    typed_fields: list[TypedField] = []
    field_map: dict[str, TypedField] = {}
    for field in request.fields:
        tf = infer_field_type(field)
        typed_fields.append(tf)
        field_map[field.selector] = tf

    return typed_values, typed_fields, value_map, field_map


def apply_matching_skills(request: MatchRequest) -> list[MatchResultItem]:
    """Run the full matching pipeline and return scored results."""
    typed_values, typed_fields, value_map, field_map = _type_both_sides(request)

    # Build all-pairs candidate matrix
    candidates: list[MatchCandidate] = []
    for field in request.fields:
        tf = field_map[field.selector]
        for key, value in request.payload.items():
            tv = value_map[key]
            candidates.append(MatchCandidate(
                field=field,
                typed_field=tf,
                value_key=key,
                typed_value=tv,
                score=0.0,
            ))

    # Apply each skill in order
    for skill in _SKILLS:
        candidates = skill.apply(candidates, typed_values, typed_fields)

    # Select best value for each field (greedy assignment)
    # Group by field selector, pick highest score
    best_per_field: dict[str, MatchCandidate] = {}
    for c in candidates:
        sel = c.field.selector
        if sel not in best_per_field or c.score > best_per_field[sel].score:
            best_per_field[sel] = c

    # Also ensure one-to-one: a value key can only match one field
    used_keys: set[str] = set()
    results: list[MatchResultItem] = []

    # Sort by score descending so higher-confidence matches claim keys first
    for c in sorted(best_per_field.values(), key=lambda x: x.score, reverse=True):
        if c.score < SUGGEST_THRESHOLD:
            continue
        if c.value_key in used_keys:
            # Key already claimed — find next-best candidate for this field
            alternatives = [
                alt for alt in candidates
                if alt.field.selector == c.field.selector
                and alt.value_key not in used_keys
                and alt.score >= SUGGEST_THRESHOLD
            ]
            if alternatives:
                c = max(alternatives, key=lambda x: x.score)
            else:
                continue

        used_keys.add(c.value_key)
        results.append(MatchResultItem(
            fieldId=c.field.selector,
            jsonKey=c.value_key,
            jsonValue=c.typed_value.value,
            confidence=round(c.score, 4),
            auto=c.score >= AUTO_THRESHOLD,
        ))

    return results


def rank_suggestions(
    field_text: str,
    payload: dict[str, str | int | float | bool | None],
    top_n: int = 5,
) -> list[RankItem]:
    """Rank all JSON keys by relevance to a field context string."""
    from difflib import SequenceMatcher as SM

    # Build a synthetic field descriptor from the text
    field = FieldDescriptor(
        selector="__rank__",
        label=field_text,
        name="",
        placeholder="",
        type="text",
        context=field_text,
    )
    tf = infer_field_type(field)

    scored: list[RankItem] = []
    for key, value in payload.items():
        tv = infer_value_type(key, value)

        # Type alignment score
        from ..models.taxonomy import SemanticType, types_compatible
        vt = tv.semantic_type
        ft = tf.semantic_type
        if vt == ft and vt != SemanticType.TEXT:
            type_score = 1.0
        elif types_compatible(vt, ft):
            type_score = 0.7
        else:
            type_score = 0.3

        type_score *= (tv.confidence + tf.confidence) / 2

        # Name similarity
        norm_key = _normalize(key)
        ratio = SM(None, norm_key, field_text.lower()).ratio()

        exact_type = (vt == ft and vt != SemanticType.TEXT)
        both_text = (vt == SemanticType.TEXT and ft == SemanticType.TEXT)
        if exact_type:
            final = 0.85 * type_score + 0.15 * ratio
        elif both_text:
            final = 0.15 * type_score + 0.85 * ratio
        else:
            final = 0.5 * type_score + 0.5 * ratio
        scored.append(RankItem(key=key, value=value, score=round(final, 4)))

    scored.sort(key=lambda x: x.score, reverse=True)
    return scored[:top_n]
