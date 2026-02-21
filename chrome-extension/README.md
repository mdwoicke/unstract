# Unstract Form Filler — Chrome MV3 Extension

Auto-fills web forms using structured JSON output from Unstract document extraction.

## Quick Start

### 1. Build the extension

```bash
cd chrome-extension
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `chrome-extension/dist/` folder

The extension icon (blue **U**) will appear in your toolbar.

### 3. Extract a document

1. Open the Unstract test UI at `https://192.168.1.xxx:5555`
2. Upload a document and click **Process Document**
3. When results appear, click the **Fill Form** button (gold ✏️ icon)
4. The extension popup will show the key count

### 4. Fill a form

1. Navigate to any web form page
2. The extension auto-fills fields with confidence ≥ 0.82 (highlighted in gold)
3. Click any unfilled field → the overlay combobox appears
4. Type to filter, use ↑↓ to navigate, ↵ to fill

---

## LM Studio (Default AI — already running)

The extension uses the **same LM Studio instance** (port 1234) that you use for PDF OCR.
No extra setup needed — just make sure LM Studio is running.

Click the extension icon → **🔌 LM Studio** tab → **Test** to verify the connection.

**For best matching accuracy:** Load an embedding model alongside Qwen3-VL-8B in LM Studio.
Recommended (small and fast): `nomic-embed-text-v1.5` or `bge-m3`.
Without an embedding model, the extension falls back to Qwen3 chat-based matching,
then TF-IDF word similarity.

Matching priority order:
1. **LM Studio embeddings** — semantic cosine similarity (best, if embedding model loaded)
2. **LM Studio chat** — Qwen3 reasoning-based matching (good, no embedding model needed)
3. **BERT / all-MiniLM-L6-v2** — (only if you run `npm run download-model`)
4. **TF-IDF cosine** — always available, zero external dependencies

---

## Optional: Download BERT Model (Improves Matching)

By default the extension uses TF-IDF similarity (fast, no download).
For better accuracy, download the all-MiniLM-L6-v2 model:

```bash
npm run download-model
npm run build     # rebuild to include the model files
```

Model files are saved to `public/models/` (~25 MB) and bundled into the extension.

---

## Optional: Cloud AI Fallback (OpenAI / Claude)

Click the extension icon → **Settings** tab → enter your API key.
PII is automatically masked before any data leaves the browser.

---

## How it Works

```
Test UI "Fill Form" button
  └─ CustomEvent('unstract:fillForm') on window
       └─ Content script (running in test UI page)
            └─ chrome.runtime.sendMessage({ type: 'LOAD_JSON', payload })
                 └─ Background service worker
                      ├─ Stores payload in chrome.storage.session (10-min TTL)
                      └─ Sends ACTIVATE to content script on active form tab
                           └─ Content script
                                ├─ Extracts form fields (incl. Shadow DOM)
                                ├─ Sends fields to background for AI matching
                                │    └─ TF-IDF cosine similarity (default)
                                │    └─ BERT embeddings (if model downloaded)
                                ├─ score ≥ 0.82 → auto-fill + gold border
                                └─ score < 0.82 → overlay combobox on focus
```

## Files

```
src/
  background/service-worker.ts    Message routing, state, AI orchestration
  content/
    content.ts                    Page injection, event relay, orchestration
    dom-extractor.ts              Recursive Shadow DOM field extraction
    field-injector.ts             Native event injection (React/Vue/Angular)
  ui/
    Overlay.tsx                   React combobox (Shadow DOM isolated)
    shadow-host.ts                Shadow DOM mount point
  ai/
    local-matcher.ts              TF-IDF + optional BERT matching
    cloud-matcher.ts              OpenAI / Anthropic fallback
    pii-masker.ts                 PII detection and tokenization
  store/state.ts                  Shared types + chrome.storage helpers
  popup/Popup.tsx                 Extension popup UI
```
