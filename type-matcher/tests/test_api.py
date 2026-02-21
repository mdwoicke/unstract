"""Tests for the FastAPI endpoints."""

import pytest
from httpx import ASGITransport, AsyncClient

from unstract.type_matcher.app import create_app


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


@pytest.mark.anyio
async def test_match_endpoint(client):
    resp = await client.post("/api/v1/match", json={
        "payload": {
            "email": "john@example.com",
            "first_name": "John",
        },
        "fields": [
            {"type": "email", "name": "email", "label": "Email", "selector": "#email"},
            {"type": "text", "name": "fname", "label": "First Name", "selector": "#fname"},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "matches" in data
    assert len(data["matches"]) >= 1
    keys = {m["jsonKey"] for m in data["matches"]}
    assert "email" in keys


@pytest.mark.anyio
async def test_rank_suggestions_endpoint(client):
    resp = await client.post("/api/v1/rank-suggestions", json={
        "field_text": "Email Address",
        "payload": {
            "email": "john@example.com",
            "first_name": "John",
            "phone": "555-1234",
        },
        "top_n": 3,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "suggestions" in data
    assert len(data["suggestions"]) <= 3
    # Email should be ranked highest
    assert data["suggestions"][0]["key"] == "email"


@pytest.mark.anyio
async def test_match_empty_payload(client):
    resp = await client.post("/api/v1/match", json={
        "payload": {},
        "fields": [
            {"type": "text", "name": "fname", "label": "First Name", "selector": "#fname"},
        ],
    })
    assert resp.status_code == 200
    assert resp.json()["matches"] == []


@pytest.mark.anyio
async def test_match_empty_fields(client):
    resp = await client.post("/api/v1/match", json={
        "payload": {"email": "john@example.com"},
        "fields": [],
    })
    assert resp.status_code == 200
    assert resp.json()["matches"] == []
