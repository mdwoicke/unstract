"""Abstract base class for matching skills."""

from abc import ABC, abstractmethod

from ..models.field_typing import TypedField
from ..models.value_typing import TypedValue


class MatchCandidate:
    """Mutable candidate tracking a field → value pairing and its score."""

    __slots__ = ("field", "typed_field", "value_key", "typed_value", "score")

    def __init__(
        self,
        field: "FieldDescriptor",  # noqa: F821 — forward ref
        typed_field: TypedField,
        value_key: str,
        typed_value: TypedValue,
        score: float,
    ) -> None:
        self.field = field
        self.typed_field = typed_field
        self.value_key = value_key
        self.typed_value = typed_value
        self.score = score


class MatchSkill(ABC):
    """A single scoring/filtering step in the matching pipeline."""

    @abstractmethod
    def apply(
        self,
        candidates: list[MatchCandidate],
        typed_values: list[TypedValue],
        typed_fields: list[TypedField],
    ) -> list[MatchCandidate]:
        """Process candidates: adjust scores, add, or remove entries."""
        ...
