"""FastAPI application factory."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routes.health import router as health_router
from .routes.match import router as match_router


def create_app() -> FastAPI:
    app = FastAPI(title="Unstract Type Matcher", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(match_router, prefix="/api/v1")

    return app
