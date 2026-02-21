"""Request/Response Pydantic models for the API."""

from typing import Any

from pydantic import BaseModel, model_validator

from .field_typing import FieldDescriptor


class MatchRequest(BaseModel):
    """POST /api/v1/match request body."""
    payload: dict[str, Any]
    fields: list[FieldDescriptor]

    @model_validator(mode="after")
    def _coerce_payload(self) -> "MatchRequest":
        """Coerce payload values to primitives — stringify complex values."""
        clean: dict[str, str | int | float | bool | None] = {}
        for k, v in self.payload.items():
            if isinstance(v, (str, int, float, bool)) or v is None:
                clean[k] = v
            elif isinstance(v, (list, dict)):
                # Stringify complex values so they can still participate in matching
                clean[k] = str(v)
            else:
                clean[k] = str(v)
        self.payload = clean
        return self


class MatchResultItem(BaseModel):
    """A single field-to-value match."""
    fieldId: str
    jsonKey: str
    jsonValue: str | int | float | bool | None
    confidence: float
    auto: bool


class MatchResponse(BaseModel):
    """POST /api/v1/match response body."""
    matches: list[MatchResultItem]


class RankRequest(BaseModel):
    """POST /api/v1/rank-suggestions request body."""
    field_text: str
    payload: dict[str, Any]
    top_n: int = 5

    @model_validator(mode="after")
    def _coerce_payload(self) -> "RankRequest":
        """Coerce payload values to primitives."""
        clean: dict[str, str | int | float | bool | None] = {}
        for k, v in self.payload.items():
            if isinstance(v, (str, int, float, bool)) or v is None:
                clean[k] = v
            else:
                clean[k] = str(v)
        self.payload = clean
        return self


class RankItem(BaseModel):
    key: str
    value: str | int | float | bool | None
    score: float


class RankResponse(BaseModel):
    """POST /api/v1/rank-suggestions response body."""
    suggestions: list[RankItem]
