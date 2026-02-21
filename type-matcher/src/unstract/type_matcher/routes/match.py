"""Match and rank-suggestions endpoints."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..models.api import MatchRequest, MatchResponse, RankRequest, RankResponse
from ..skills.pipeline import apply_matching_skills, rank_suggestions

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/match", response_model=MatchResponse)
async def match(request: Request):
    # Parse body manually to log validation errors
    body = await request.json()
    try:
        parsed = MatchRequest.model_validate(body)
    except Exception as e:
        # Log what failed for debugging
        payload_keys = list(body.get("payload", {}).keys())[:5] if isinstance(body.get("payload"), dict) else "NOT_DICT"
        fields_sample = body.get("fields", [])[:2] if isinstance(body.get("fields"), list) else "NOT_LIST"
        # Check for non-primitive values in payload
        bad_values = {}
        if isinstance(body.get("payload"), dict):
            for k, v in body["payload"].items():
                if not isinstance(v, (str, int, float, bool, type(None))):
                    bad_values[k] = f"{type(v).__name__}: {str(v)[:100]}"
                    if len(bad_values) >= 3:
                        break
        logger.error(
            f"Validation error: {e}\n"
            f"  payload_keys_sample={payload_keys}\n"
            f"  fields_sample={fields_sample}\n"
            f"  bad_payload_values={bad_values}"
        )
        return JSONResponse(
            status_code=422,
            content={"detail": str(e), "bad_values": bad_values},
        )

    results = apply_matching_skills(parsed)
    return MatchResponse(matches=results)


@router.post("/rank-suggestions", response_model=RankResponse)
async def rank(request: RankRequest):
    suggestions = rank_suggestions(request.field_text, request.payload, request.top_n)
    return RankResponse(suggestions=suggestions)
