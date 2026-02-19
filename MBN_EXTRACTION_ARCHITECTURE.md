# MBN PDF Extraction — Architecture, Fixes & Operations Guide

## Overview

This document describes how the Unstract MBN extraction pipeline works end to
end, what went wrong, what was fixed, and how `start-unstract.ps1` keeps
everything consistent across restarts.

---

## 1. System Architecture

### 1.1 Components

```
┌─────────────────────────────────────────────────────────────────┐
│  Host Machine (Windows 11)                                      │
│                                                                 │
│  ┌─────────────────┐   ┌─────────────────────────────────────┐ │
│  │  Test UI        │   │  LM Studio (port 1234)              │ │
│  │  Node.js :5555  │   │  Qwen3-VL-8B  (26k ctx, vision)     │ │
│  └────────┬────────┘   └──────────────────────┬──────────────┘ │
│           │ HTTP POST                          │ OpenAI API     │
└───────────┼────────────────────────────────────┼───────────────┘
            │                                    │ host.docker.internal:1234
┌───────────┼────────────────────────────────────┼───────────────┐
│  Docker   │                                    │               │
│           ▼                                    │               │
│  ┌─────────────────┐                           │               │
│  │  unstract-      │  Celery task              │               │
│  │  backend :8000  ├──────────────────────►    │               │
│  └─────────────────┘  unstract-worker          │               │
│           ▲                                    │               │
│           │ REST                               │               │
│  ┌────────┴────────┐   ┌──────────────────┐   │               │
│  │  tool-structure │──►│ unstract-prompt- │───┘               │
│  │  container      │   │ service :3003    │                   │
│  └─────────────────┘   └────────┬─────────┘                   │
│                                 │ REST                         │
│                         ┌───────▼──────────┐                  │
│                         │ unstract-platform │                  │
│                         │ -service         │                  │
│                         └───────┬──────────┘                  │
│                                 │                              │
│  ┌──────────────────────────────▼──────────────────────────┐  │
│  │  unstract-db (PostgreSQL)  │  unstract-redis             │  │
│  │  unstract-rabbitmq         │  unstract-minio (storage)   │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 Request Flow for a PDF Extraction

1. **Test UI** (`http://<IP>:5555`) — user uploads a PDF and clicks Process
2. **Backend API** (`/deployment/api/mock_org/mbn_api/`) receives the POST,
   enqueues a Celery task via RabbitMQ
3. **Worker** picks up the task, spins up a **tool-structure container**
   (image `unstract/tool-structure:0.0.96`)
4. **Tool-structure container** fetches its full configuration from the backend
   — this config comes from `prompt_studio_registry.tool_metadata` (a static
   serialized snapshot, **not** the live profile tables)
5. For each prompt (`MBN_3`), the tool-structure container calls the
   **prompt-service** with the prompt text, context, adapter UUIDs, and
   any PDF images
6. **Prompt-service** calls the **platform-service** to decrypt and load the
   LLM adapter credentials
7. **Platform-service** looks up `adapter_instance` by UUID → returns
   connection details (API base URL, model name, key, max_tokens)
8. **Prompt-service** calls the **LLM** (LM Studio / Qwen3-VL) with the
   structured prompt + images
9. The JSON answer is returned up the chain back to the test UI

---

## 2. Key Database Tables

### `adapter_instance`
Stores encrypted LLM/embedding/vector-DB adapter configurations.
**Current adapters:**

| Name | Type | Purpose |
|------|------|---------|
| Qwen-3L | LLM | Primary extraction model (LM Studio, Qwen3-VL-8B, 26k ctx) |
| Qwen-3L-30B | LLM | Large model (LM Studio) |
| Anthropic | LLM | Claude via Anthropic API |
| Sonnet 4.5 | LLM | Claude Sonnet 4.5 |
| GPT-OSS | LLM | OpenAI-compatible endpoint |
| Embedding | EMBEDDING | Text embedding model |
| Qrant | VECTOR_DB | Qdrant vector store |
| Unstract | X2TEXT | **Unstructured IO Community** text extractor (`strategy: auto`) |

> **Note:** The `Unstract` X2TEXT adapter uses **Unstructured IO Community**
> (adapter ID `unstructuredcommunity|eeed506f-1875-457f-9101-846fc7115676`),
> not LLMWhisperer as previously documented. It extracts the static text layer
> of PDFs only — it cannot read AcroForm interactive field values.

### `profile_manager`
Maps a named profile to a set of adapters + retrieval settings.

| Profile | LLM | Chunk Size | Strategy |
|---------|-----|-----------|---------|
| MBN | Qwen-3L | 0 (full context) | simple |

### `tool_studio_prompt`
Each row is one prompt belonging to a custom tool, linked to a profile.

| Prompt | Profile | Notes |
|--------|---------|-------|
| MBN_3 | MBN | Single extraction prompt covering all form fields |

### `prompt_studio_registry`
**Critical:** Contains `tool_metadata` — a **static JSON snapshot** of the
entire tool configuration, including hardcoded adapter UUIDs. This is written
when you click "Export" in Prompt Studio and is what the tool-structure
container actually reads at runtime. It does **not** auto-update when you
change profiles in the UI.

### `custom_tool`
Top-level tool record. The MBN tool (`tool_id = 01b73efe`) has challenge,
monitor, and summarize LLM fields all null (disabled).

---

## 3. The Problems That Were Fixed

### 3.1 Garbled Fee Extraction (OCR Concatenation)

**Symptom:** Fields like `min_monthly_fee` returned `$89.00` instead of
`$0.00`; `corporate_address` was prefixed with a long number string.

**Root cause:** Unstructured IO's OCR output concatenates the fee table values
into a single unspaced string:
```
MBN28040.200.000.0089.000.150.000.00225.000.060.060.006.002.952.950.20
```
The LLM cannot reliably parse positional values from this format.

**Fix:** `prompt-service/src/unstract/prompt_service/utils/claude_preprocessor.py`

A deterministic regex preprocessor runs before the LLM call and replaces the
garbled block with labeled key-value text:
```
[SECTION 7 FEE SCHEDULE VALUES (16 values): $0.20 | $0.00 | $0.00 | ...]
[Key values by form position: Min Monthly Fee = $0.00, Customer Support Fee = $6.00, ...]
```

> **Scope:** This preprocessor only triggers for DocuSign-flattened PDFs that
> produce the `MBN2804...` concatenated pattern. It returns `None` for AcroForm
> PDFs (section 3.4) since those don't produce garbled OCR blocks.

**Confirmed position mapping** (from MPA2804 form, page 3):

| Index | Value | Field |
|-------|-------|-------|
| [0] | 0.20 | Batch Fee |
| [1] | 0.00 | One-Time Admin |
| [2] | 0.00 | Early Termination Fee |
| [3] | 89.00 | Annual Membership Fee |
| [4] | 0.15 | PIN Debit per transaction |
| [5] | 0.00 | Debit Access |
| [6] | 0.00 | EBT per transaction |
| [7] | 225.00 | EBT Monthly Access Fee |
| [8] | 0.06 | Visa/MC/Discover Auth Fee |
| [9] | 0.06 | Amex Auth Fee |
| [10] | 0.00 | **Min Monthly Fee** |
| [11] | 6.00 | **Customer Support Fee** |
| [12] | 2.95 | PCI Compliance Fee/month |
| [13] | 2.95 | IRS TIN Processing Fee/month |
| [14] | — | (unused) |
| [15] | 0.20 | PIN Debit Volume % |

### 3.2 Output Truncation

**Symptom:** Extraction JSON was cut off mid-field (e.g., ending at
`"mobile_app`).

**Root cause:** Three stale adapters in `adapter_instance` were routing some
requests to LM Studio models with insufficient context windows:
- `olmOCR` — `allenai/olmocr-2-7b`, context 2048 tokens
- `LM Studio` — `lmstudio-community/qwen2.5-7b-instruct`, max_tokens 2048
- `Docling` — pointed to the same LM Studio instance

When LM Studio loaded multiple models simultaneously, API calls routed to
the 2048-token model could not fit the full prompt + schema, so output was
silently truncated.

**Fix:** All three stale adapters deleted from `adapter_instance`. Qwen3-VL-8B
is now loaded exclusively at 26,788 token context.

### 3.3 "Final Output Processing Failed" — Stale Registry Cache

**Symptom:** After deleting the stale adapters, every extraction failed with:
```
Adapter '4d6204ea-545b-4ccc-b3e4-033e85d3f962' not found
Final output processing failed
```

**Root cause:** `prompt_studio_registry.tool_metadata` contained a hardcoded
copy of the olmOCR UUID (`4d6204ea`) in three places:
- `tool_metadata.tool_settings.llm`
- `tool_metadata.tool_settings.challenge_llm`
- `tool_metadata.outputs[0].llm`

This snapshot was created when the tool was last exported and olmOCR was
the active adapter. The tool-structure container reads **only this snapshot**
at runtime — it never queries `profile_manager` during execution.

Despite `profile_manager` correctly pointing to Qwen-3L, the stale snapshot
sent the deleted UUID to the platform-service, which then failed the lookup.

**Fix (one-time):**
```sql
UPDATE unstract.prompt_studio_registry
SET tool_metadata = to_jsonb(
    replace(tool_metadata::text,
            '4d6204ea-545b-4ccc-b3e4-033e85d3f962',  -- olmOCR (deleted)
            '39530849-deeb-4010-aa4f-1750d27f5632'   -- Qwen-3L (correct)
    )::jsonb
)
WHERE name = 'MBN';
```

**Fix (permanent — startup script):** Step 6 of `start-unstract.ps1` now
repairs this cache on every startup (see section 4).

### 3.4 AcroForm PDFs Returning All Empty Fields

**Symptom:** Submitting a digitally-filled interactive PDF (e.g.,
`MBN MPA V2804 - Filled.pdf`) returned all fields as empty strings.

**Root cause:** Three compounding failures:

1. **X2TEXT adapter cannot read AcroForm fields.** Unstructured IO Community's
   `auto` strategy extracts the static text layer only. When a PDF is filled
   using a standard PDF editor (Adobe Acrobat, PDF-XChange, etc.), the values
   are stored in the **AcroForm interactive field layer** — a separate data
   structure invisible to OCR/text-extraction tools. The extractor only returned
   the blank form template labels, not the filled values.

2. **Vision images not generated for API-uploaded PDFs.** `_find_original_pdf`
   in `retrieval.py` only searched two paths (Prompt Studio extract path and
   `prompt-studio-data/`). It had no strategy for PDFs uploaded via the API
   endpoint, which land in `unstract/api/{org}/{workflow_id}/{execution_id}/`.

3. **Preprocessor returned None.** The `claude_preprocessor.py` regex patterns
   are specific to the DocuSign-flattened form's concatenated decimal blocks.
   AcroForm PDFs produce clean OCR text without those patterns, so the
   preprocessor correctly reported nothing to fix — but this meant no context
   improvement happened via either channel.

**Why DocuSign PDFs worked but AcroForm PDFs didn't:**

| PDF Type | How values are stored | Unstructured IO reads them? |
|---|---|---|
| DocuSign-completed | Flattened into static text layer | ✅ Yes |
| AcroForm interactive | Stored in AcroForm widget layer | ❌ No |

DocuSign converts every filled value into regular embedded text before
delivering the final PDF, so `MPA2804 SAMPLE-IC Plus.pdf` always worked.
A PDF filled with a PDF editor preserves the AcroForm structure and requires
explicit widget-layer reading.

**Fixes applied:**

**Fix A — AcroForm extraction**
(`prompt-service/src/unstract/prompt_service/utils/pdf_form_fields.py`, new file)

Uses PyMuPDF (`fitz`, v1.27.1 — already installed) to iterate every page's
widget annotations and collect field name → value pairs. Normalises checkboxes
to Yes/No, skips Signature fields, skips empty values. The result is prepended
to the context as a clearly labelled block:
```
[FORM FIELD VALUES — extracted directly from PDF AcroForm layer]
BusinessName: The Burger Joint
OwnerName: John Cabrera
...
[END FORM FIELDS]
```
This block is prepended in `retrieval.py` before the vision rendering step, so
the LLM receives it regardless of whether vision is available. For
DocuSign-flattened PDFs, `extract_acroform_fields` returns `None` (no widgets
present after flattening), so no change to existing behaviour.

**Fix B — Strategy 3 for API-uploaded PDF path**
(`retrieval.py` — `_find_original_pdf`)

Added a third path strategy that parses the execution path to derive the API
storage location:
```
file_path:  unstract/execution/{org}/{workflow_id}/{execution_id}/{file_exec_id}/EXTRACT
target:     unstract/api/{org}/{workflow_id}/{execution_id}/{doc_name}
```
Also fixed Strategy 1 to be case-insensitive (`/EXTRACT/` and `/extract/`
both handled).

**Search order in `_find_original_pdf`:**

| Strategy | Path pattern | Use case |
|---|---|---|
| 1 | Derive from `/EXTRACT/` in the extract path | Prompt Studio IDE runs |
| 2 | `unstract/prompt-studio-data/{org}/{user}/{tool_id}/{doc_name}` | Prompt Studio IDE fallback |
| 3 | `unstract/api/{org}/{workflow_id}/{execution_id}/{doc_name}` | API deployment runs |

### 3.5 "Failed to Process Image" Crashing Vision Extraction

**Symptom:** The original DocuSign PDF (`MPA2804 SAMPLE-IC Plus.pdf`) suddenly
returned `"Final output processing failed: "` with an empty error string.
Logs showed:
```
ERROR: litellm.BadRequestError: OpenAIException - Error code: 400 - {'error': 'failed to process image'}
```

**Root cause:** LM Studio returned a 400 error when attempting to process one
or more of the rendered PDF page images (likely due to model state after a
heavy vision session). The existing fallback logic in `answer_prompt.py` only
caught context-window-exceeded errors:
```python
if not (images and "exceeds" in str(e) and "context" in str(e)):
    raise  # "failed to process image" fell through here and crashed
```

**Fix:** (`prompt-service/src/unstract/prompt_service/services/answer_prompt.py`)

Extended the fallback condition to also catch `"failed to process image"` errors,
triggering the same progressive image-reduction strategy:
1. Every other page
2. First 3 pages only
3. First page only
4. No images (last resort — AcroForm text + OCR context still available)

This makes vision extraction resilient to transient LM Studio image-processing
failures. Even in the worst case (all images rejected), extraction continues
on text context alone.

---

## 4. Startup Script — `start-unstract.ps1`

Run from PowerShell: `.\start-unstract.ps1`

### Steps

| Step | Action | Why |
|------|--------|-----|
| 1 | Detect machine IP (DHCP) | IP changes between reboots |
| 2 | Patch IP into `index.html`, `server.js`, `dev.py` | CORS and API endpoint stay current |
| 3 | Ensure Docker Desktop is running | Auto-starts if not running |
| 4 | Free port 5555 | Prevent conflict with Node server |
| 5 | `docker compose up -d`, wait for DB/Redis/RabbitMQ/backend/prompt-service | Correct startup order |
| **6** | **Repair `tool_metadata` cache** | See below |
| 7 | `docker cp` patched files + restart backend & prompt-service | Container images revert on restart |
| 8 | Verify CORS headers | Catch IP mismatch early |
| 9 | Start Node.js test UI on port 5555 | |
| 10 | Check LM Studio API + context window | Warn if context < 16k tokens |
| 11 | Print status summary | |

### Step 6 — Registry Cache Repair (key step)

```powershell
$toolAdapterMap = @{
    "MBN" = "Qwen-3L"
    # Add other tool → adapter mappings here if new tools are exported
}
```

For each entry:
1. Resolve the adapter UUID by **name** from `adapter_instance`
   (name-based lookup survives UUID changes if an adapter is recreated)
2. Read the UUID currently baked into `tool_metadata`
3. If they differ: replace **all occurrences** of the stale UUID in the JSON
   blob with the correct one — this fixes `tool_settings.llm`,
   `tool_settings.challenge_llm`, and every `outputs[N].llm` in one pass
4. Belt-and-suspenders: sync `profile_manager` to match

This step is **idempotent** — if the cache is already correct it does nothing
and prints `OK`.

### Files Patched Into Containers Each Run

| Host file | Container destination | Purpose |
|-----------|----------------------|---------|
| `backend/backend/settings/dev.py` | `unstract-backend:/app/backend/settings/dev.py` | CORS allowed origins with current IP |
| `prompt-service/.../services/retrieval.py` | `unstract-prompt-service:/app/.../retrieval.py` | Vision + AcroForm orchestration |
| `prompt-service/.../services/answer_prompt.py` | `unstract-prompt-service:/app/.../answer_prompt.py` | Vision image passing + error fallback |
| `prompt-service/.../utils/claude_preprocessor.py` | `unstract-prompt-service:/app/.../claude_preprocessor.py` | OCR fee block parser |
| `prompt-service/.../utils/pdf_vision.py` | `unstract-prompt-service:/app/.../pdf_vision.py` | PDF-to-base64 image renderer |
| `prompt-service/.../utils/pdf_form_fields.py` | `unstract-prompt-service:/app/.../pdf_form_fields.py` | AcroForm field extractor (PyMuPDF) |

---

## 5. Extraction Pipeline (per prompt)

When the prompt-service processes a prompt with `chunk_size = 0` (full
context mode), the full sequence is:

```
1. Retrieve OCR text from MinIO (complete_context mode)
       ↓
2. Locate original PDF in MinIO storage (_find_original_pdf)
   Strategy 1 → /EXTRACT/ derive path (Prompt Studio)
   Strategy 2 → prompt-studio-data/ (Prompt Studio fallback)
   Strategy 3 → api/{org}/{workflow}/{execution}/ (API deployment)
       ↓ (if PDF found)
3. Extract AcroForm field values (pdf_form_fields.py)
   → Returns None for DocuSign-flattened PDFs (no widgets)
   → Returns labeled key-value block for interactive PDFs
   → Prepend to context if non-empty
       ↓
4. Render PDF pages to base64 PNG images (pdf_vision.py)
   → VISION_MAX_PAGES pages at VISION_DPI DPI (default: 10 pages, 150 DPI)
       ↓
5. Run OCR preprocessor (claude_preprocessor.py)
   → Detects MBN2804... concatenated decimal blocks (DocuSign PDFs only)
   → Replaces with labeled fee schedule text
   → Returns None if no patterns found (AcroForm PDFs — expected)
       ↓
6. Call LLM (Qwen3-VL-8B via LM Studio)
   → Sends cleaned text context + PDF page images
   → On "failed to process image": progressive image reduction fallback
     (every other page → first 3 → first 1 → no images)
   → On context overflow: same progressive fallback
```

**What each PDF type receives at step 6:**

| PDF Type | Text context | AcroForm block | Images | Preprocessor |
|---|---|---|---|---|
| DocuSign-flattened | OCR with values embedded | None | ✅ Rendered | ✅ Fixes fee block |
| AcroForm interactive | OCR of template labels only | ✅ Field values | ✅ Rendered | No-op (returns None) |

**Context window requirement:** Vision extraction requires ≥ 16,384 tokens.
With MBN_3's prompt schema (~2k tokens) + OCR text (~7.5k tokens) + AcroForm
block (~1.8k tokens for 67 fields) + images (~5–8k tokens), a 26k-token
context is comfortable. If LM Studio is loaded with a model below 16k tokens,
all images are silently dropped and extraction quality degrades significantly.

---

## 6. LM Studio Configuration

For consistent extraction results, configure LM Studio as follows:

| Setting | Recommended value | Why |
|---|---|---|
| Temperature | **0** | Deterministic output — eliminates run-to-run formatting variation |
| Context window | ≥ 26,000 tokens | Required for text + AcroForm block + images to fit |
| Thinking mode | **Disabled** (`/no_think` in system prompt) | Prevents `<think>...</think>` blocks bleeding into extracted values |
| Structured output | Not recommended globally | Breaks text-type prompts; only safe if all prompts are JSON type |

To disable thinking mode, add `/no_think` to the model's system prompt in
LM Studio's model settings.

---

## 7. Adding a New Tool or Adapter

### Adding a new exported tool

1. Build and test the tool in Prompt Studio
2. Set its profile to use the desired adapter (e.g., `Qwen-3L`)
3. Click **Export** in Prompt Studio — this writes `tool_metadata`
4. Add the tool to the startup script map:
   ```powershell
   $toolAdapterMap = @{
       "MBN"         = "Qwen-3L"
       "NewToolName" = "Qwen-3L"   # ← add here
   }
   ```

### Adding a new LLM adapter

1. Add it in Unstract Settings → Adapters
2. If it should be the default for a tool, update the tool's profile in
   Prompt Studio and re-export
3. Update `$toolAdapterMap` in the startup script if the profile name changes

### Replacing an existing LLM adapter

> **Warning:** Never delete an adapter that is referenced in
> `prompt_studio_registry.tool_metadata` without first running the startup
> script (Step 6) or manually updating the cache. The tool-structure container
> will fail immediately with "Adapter not found" if the UUID is gone.

Safe replacement procedure:
1. Add the new adapter in Unstract Settings
2. Update the tool's profile in Prompt Studio to use the new adapter
3. Click **Export** in Prompt Studio to refresh `tool_metadata`
   — OR — run `.\start-unstract.ps1` (Step 6 will auto-repair)
4. Only then delete the old adapter

---

## 8. Troubleshooting

### "Adapter not found" / "Final output processing failed"

The `tool_metadata` cache has a UUID that doesn't exist in `adapter_instance`.

**Quick fix:**
```powershell
.\start-unstract.ps1   # Step 6 repairs the cache automatically
```

**Manual check:**
```sql
-- What UUID is in the cache?
SELECT name,
       tool_metadata->'tool_settings'->>'llm' as cached_llm
FROM unstract.prompt_studio_registry;

-- Does it exist?
SELECT id, adapter_name FROM unstract.adapter_instance
WHERE id = '<uuid-from-above>';
```

### All fields empty — AcroForm PDF submitted

The PDF was filled interactively (not via DocuSign). Check the prompt-service
logs for:
```
[AcroForm] Extracted N form field values from PDF
```
If this line is absent, the PDF was not found in storage (Strategy 1/2/3 all
failed). Check that `doc_name` is being passed correctly and that the PDF
exists in `unstract/api/{org}/{workflow_id}/{execution_id}/` in MinIO.

If the line is present but fields are still empty, the AcroForm field names in
the PDF may not match what the LLM prompt expects. Inspect the extracted field
names:
```bash
docker exec unstract-prompt-service python3 -c "
import fitz
doc = fitz.open('path/to/pdf')
for page in doc:
    for w in page.widgets() or []:
        if w.field_value:
            print(w.field_name, '=', w.field_value)
"
```

### "Failed to process image" / extraction crashes on vision

LM Studio rejected the rendered PDF images (HTTP 400). With the fix in place,
this triggers the progressive fallback (fewer images → no images). If
extraction is still failing:

1. Check LM Studio is healthy and not in a degraded state (restart it)
2. Check that the PDF renders correctly:
   ```bash
   docker exec unstract-prompt-service python3 -c "
   from unstract.prompt_service.utils.pdf_vision import pdf_pages_to_base64
   imgs = pdf_pages_to_base64('/tmp/test.pdf', max_pages=1, dpi=150)
   print('Pages rendered:', len(imgs), 'First image size:', len(imgs[0]) if imgs else 0)
   "
   ```
3. If LM Studio consistently rejects images, lower `VISION_DPI` (e.g., 100)
   or lower `VISION_MAX_PAGES` to reduce image payload size

### Output truncated mid-JSON

Check LM Studio:
1. Only one model should be loaded (Qwen3-VL-8B)
2. Context window must be ≥ 16,384 tokens (set in LM Studio model settings)
3. The startup script Step 10 will warn if context is too small

### Fee values are wrong (e.g., min_monthly_fee = $89.00 instead of $0.00)

The OCR preprocessor position mapping may be off. Verify in the
prompt-service container:
```bash
docker exec unstract-prompt-service python3 -c "
from unstract.prompt_service.utils.claude_preprocessor import _parse_fee_values
block = 'MBN28040.200.000.0089.000.150.000.00225.000.060.060.006.002.952.950.20'
print(list(enumerate(_parse_fee_values(block))))
"
```
Expected: index 10 = `0.00` (Min Monthly Fee), index 11 = `6.00`
(Customer Support Fee), index 3 = `89.00` (Annual Membership Fee).

> **Note:** This check only applies to DocuSign-flattened PDFs. AcroForm PDFs
> read fee values directly from form fields — the preprocessor does not run.

### CORS errors in browser console

The machine IP changed. Run `.\start-unstract.ps1` — Steps 2 and 7 patch the
IP into `dev.py` and copy it into the backend container.

### Inconsistent output formatting (extra text, markdown, thinking blocks)

The LLM is sampling stochastically or Qwen3 thinking mode is active. Fix in
LM Studio:
1. Set **Temperature = 0** (fully deterministic)
2. Add `/no_think` to the model system prompt (disables `<think>` blocks)

---

## 9. File Inventory

| File | Description |
|------|-------------|
| `start-unstract.ps1` | All-in-one startup script (run after every reboot) |
| `backend/backend/settings/dev.py` | CORS allowed origins (patched with current IP each run) |
| `prompt-service/.../utils/claude_preprocessor.py` | Deterministic OCR fee block parser (DocuSign PDFs) |
| `prompt-service/.../utils/pdf_vision.py` | PDF page → base64 PNG renderer |
| `prompt-service/.../utils/pdf_form_fields.py` | AcroForm widget value extractor (PyMuPDF) |
| `prompt-service/.../services/retrieval.py` | Retrieval + AcroForm + vision orchestration |
| `prompt-service/.../services/answer_prompt.py` | LLM call with image support + vision error fallback |
| `docker/test-ui/index.html` | Upload UI (API endpoint patched with current IP) |
| `docker/test-ui/server.js` | Node.js static file server for the test UI |
