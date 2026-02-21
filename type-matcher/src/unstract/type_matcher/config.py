"""Application configuration via pydantic-settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    host: str = "0.0.0.0"
    port: int = 3005
    cors_origin_regex: str = (
        r"chrome-extension://.*|https?://localhost.*|https?://\d+\.\d+\.\d+\.\d+.*"
    )

    model_config = {"env_prefix": "TYPE_MATCHER_"}


settings = Settings()
