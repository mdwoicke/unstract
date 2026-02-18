# Unstructured.io Setup for Unstract

## Problem

Running the container manually with the base library image failed:

```bash
docker run -d --name unstract-unstructured-io --network unstract-network -p 8001:8000 downloads.unstructured.io/unstructured-io/unstructured:latest
```

**Why it failed:** The `unstructured:latest` image is the Python library image, not the API server. Its default command is `/bin/bash`, which exits immediately in detached mode. No API server ever starts.

## Fix

The project already defines the correct service in `docker/docker-compose-dev-essentials.yaml` under the `optional` profile using the **API image** (`unstructured-api:0.0.61`).

### Step 1: Remove the broken container

```bash
docker rm unstract-unstructured-io
```

### Step 2: Start via Docker Compose with the optional profile

```bash
docker compose -f "C:\Users\mwoic\PycharmProjects\PythonProject\unstract\docker\docker-compose.yaml" --profile optional up -d unstructured-io
```

This pulls and starts `downloads.unstructured.io/unstructured-io/unstructured-api:0.0.61` with the correct entrypoint, port mapping (`8083:8000`), and network (`unstract-network`).

### Step 3: Verify the container is running

```bash
docker ps --filter "name=unstract-unstructured-io"
```

Expected: status `Up`, ports `0.0.0.0:8083->8000/tcp`.

### Step 4: Verify API connectivity

From another unstract container (e.g., backend):

```bash
docker exec unstract-backend python -c "import urllib.request; r = urllib.request.urlopen('http://unstract-unstructured-io:8000/healthcheck'); print(r.status, r.read().decode())"
```

Expected: `200 {"healthcheck":"HEALTHCHECK STATUS: EVERYTHING OK!"}`

## Access URLs

| Context | URL |
|---|---|
| From unstract containers | `http://unstract-unstructured-io:8000/general/v0/general` |
| From host machine | `http://localhost:8083/general/v0/general` |

## Key Difference

| | Wrong image | Correct image |
|---|---|---|
| Image | `unstructured-io/unstructured:latest` | `unstructured-io/unstructured-api:0.0.61` |
| Purpose | Python library only | API server (FastAPI/Uvicorn) |
| Default CMD | `/bin/bash` (exits immediately) | Starts Uvicorn on port 8000 |
