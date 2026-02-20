# Unstract: Writing Workflow JSON Output to a Local Directory

This documents every step required to configure Unstract to write structured JSON output from a workflow execution to a local filesystem directory (`/output` inside the container, mapped to `docker/output/` on the host).

---

## 1. Register the LocalStorage Connector

The `LocalStorageFS` connector class existed at
`unstract/connectors/src/unstract/connectors/filesystems/local_storage/local_storage.py`
but had no `__init__.py` to register it as a discoverable connector.

**Created** `unstract/connectors/src/unstract/connectors/filesystems/local_storage/__init__.py`:

```python
from .local_storage import LocalStorageFS

__all__ = ["LocalStorageFS"]

metadata = {
    "name": LocalStorageFS.__name__,
    "version": "1.0.0",
    "connector": LocalStorageFS,
    "description": "LocalStorage connector",
    "is_active": True,
}
```

---

## 2. Create the Host Output Directory and Docker Volume Mounts

**Created** the host directory:

```bash
mkdir -p docker/output
```

**Modified** `docker/docker-compose.yaml` to mount the directory into the two worker containers that handle file execution:

```yaml
worker-file-processing:
  volumes:
    - ./output:/output    # <-- added

worker-file-processing-callback:
  volumes:
    - ./output:/output    # <-- added
```

These are the only two services that run the destination output logic (`copy_output_to_output_directory`).

---

## 3. Create a ConnectorInstance in the Database

A `ConnectorInstance` record links a connector type to its configuration (credentials/path). This was created via the Django ORM inside the backend container:

```bash
MSYS_NO_PATHCONV=1 docker exec -it unstract-backend bash
cd /app
.venv/bin/python -c "
import sys, os, django
sys.path.insert(0, '/app')
os.environ['DJANGO_SETTINGS_MODULE'] = 'backend.settings.dev'
django.setup()

from connector_v2.models import ConnectorInstance
from account_v2.models import Organization

org = Organization.objects.first()
ci = ConnectorInstance.objects.create(
    connector_name='Local Output',
    connector_id='localstorage|ded5e7f0-f527-416d-8d4a-19f559bd6da5',
    connector_type='OUTPUT',
    connector_mode='FILE_SYSTEM',
    connector_metadata={'connectorName': 'Local Output', 'path': '/output'},
    organization=org,
    created_by=org.created_by,
    modified_by=org.created_by,
)
print(ci.id)
"
```

**Result:** Connector instance ID = `50d3932c-ae64-476d-859a-6c5f30fc554b`

Key details:
- `connector_id` must match `LocalStorageFS.get_id()` = `localstorage|ded5e7f0-f527-416d-8d4a-19f559bd6da5`
- `connector_metadata.path` = `/output` (the absolute path inside the container)
- The Django ORM automatically encrypts `connector_metadata` (stored as `bytea`)
- **Important:** The `DefaultOrganizationManagerMixin` filters all queries by `UserContext.get_organization()`, so standalone scripts must import `Organization` directly from `account_v2.models` (not `tenant_account_v2.models`)

---

## 4. Update the Workflow Endpoint to Use FILESYSTEM Destination

Changed the destination endpoint from API type to FILESYSTEM via SQL:

```sql
UPDATE unstract.workflow_endpoints
SET connection_type = 'FILESYSTEM',
    connector_instance_id = '50d3932c-ae64-476d-859a-6c5f30fc554b',
    configuration = '{"outputFolder": "/output"}'
WHERE id = 'bb763331-a3f2-4ba8-8351-e964a89a1776';
```

**Critical gotchas discovered:**

| Setting | Wrong | Correct |
|---------|-------|---------|
| Config key name | `output_folder` (snake_case) | `outputFolder` (camelCase) |
| Config value | `/` | `/output` |

- The key must be camelCase to match `DestinationKey.OUTPUT_FOLDER = "outputFolder"` in `backend/workflow_manager/endpoint_v2/constants.py`
- The value must be the **full absolute path** because `get_connector_root_dir()` does not prepend the connector's `path` setting

---

## 5. Fix `get_connector_root_dir` for Local Filesystem

This was the most critical bug. The base class method at
`unstract/connectors/src/unstract/connectors/filesystems/unstract_file_system.py:225-227`:

```python
@staticmethod
def get_connector_root_dir(input_dir: str, **kwargs: Any) -> str:
    return f"{input_dir.strip('/')}/"
```

Uses `strip('/')` which removes **both** leading and trailing slashes. This is correct for cloud connectors (S3/GCS paths don't use leading slashes), but for `LocalStorageFS` it turns the absolute path `/output` into the relative path `output/`, causing files to be written to `/app/output/` (relative to the worker's CWD) instead of the volume-mounted `/output/`.

**Added override** in `unstract/connectors/src/unstract/connectors/filesystems/local_storage/local_storage.py`:

```python
@staticmethod
def get_connector_root_dir(input_dir: str, **kwargs: Any) -> str:
    """Preserve absolute paths for local filesystem."""
    return f"{input_dir.rstrip('/')}/"
```

Uses `rstrip('/')` instead of `strip('/')` to preserve the leading `/`.

---

## 6. Set VERSION in docker/.env

The `docker-compose.build.yaml` references `${VERSION}` for image tags but it wasn't defined, causing build/compose failures.

**Added** to `docker/.env`:

```
VERSION=dev
```

---

## 7. Rebuild and Restart

```bash
cd docker/

# Rebuild backend image (includes connector code)
export VERSION=dev
docker compose -f docker-compose.yaml -f docker-compose.build.yaml build --no-cache backend

# Recreate worker containers with new image
docker compose up -d --force-recreate worker-file-processing worker-file-processing-callback
```

**Important:** `docker compose restart` does NOT pick up a new image -- you must use `up -d --force-recreate` to recreate the containers.

---

## 8. Trigger and Verify

```bash
# Trigger via API
curl -s -X POST \
  "http://localhost:8000/deployment/api/mock_org/mbn_api/" \
  -H "Authorization: Bearer 4026784b-cbab-4986-8b8a-9dbc8ae1e67e" \
  -F "files=@path/to/document.pdf"

# Check status (use the execution_id from the response)
curl -s "http://localhost:8000/deployment/api/mock_org/mbn_api/?execution_id=<EXECUTION_ID>" \
  -H "Authorization: Bearer 4026784b-cbab-4986-8b8a-9dbc8ae1e67e"

# Verify output
ls docker/output/
# => sample1.json
```

The API endpoint URL pattern is `deployment/api/{org_name}/{api_name}/` on port **8000** (backend direct), not 3001.

---

## Files Modified

| File | Change |
|------|--------|
| `unstract/connectors/src/unstract/connectors/filesystems/local_storage/__init__.py` | **Created** -- registers LocalStorageFS as a discoverable connector |
| `unstract/connectors/src/unstract/connectors/filesystems/local_storage/local_storage.py` | **Added** `get_connector_root_dir()` override to preserve absolute paths |
| `docker/docker-compose.yaml` | **Added** `./output:/output` volume mount to `worker-file-processing` and `worker-file-processing-callback` |
| `docker/.env` | **Added** `VERSION=dev` |
| `backend/workflow_manager/endpoint_v2/destination.py` | Temporary debug logging added then **removed** |

## Database Changes

| Table | Column | Value |
|-------|--------|-------|
| `unstract.connector_instance` | new row | `Local Output` connector pointing to `/output` |
| `unstract.workflow_endpoints` | `connection_type` | Changed from `API` to `FILESYSTEM` |
| `unstract.workflow_endpoints` | `connector_instance_id` | Set to the Local Output connector ID |
| `unstract.workflow_endpoints` | `configuration` | `{"outputFolder": "/output"}` |

---

## Execution Flow (for reference)

1. API request uploads PDF to MinIO (`unstract/api/mock_org/{workflow_id}/{execution_id}/`)
2. Celery task `process_file_batch` picks up the file
3. Tool container (structure tool) processes the PDF and writes JSON to MinIO under `COPY_TO_FOLDER`
4. `destination.handle_output()` checks `connection_type == FILESYSTEM`
5. `copy_output_to_output_directory()` walks `COPY_TO_FOLDER` in MinIO
6. For each file, calls `LocalStorageFS.upload_file_to_storage()` which reads from MinIO and writes to the local filesystem at `/output/{filename}.json`
7. The Docker volume mount makes `/output/` visible on the host at `docker/output/`
