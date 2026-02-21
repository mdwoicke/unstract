# Form Fill Debugging — Lessons Learned

This document captures the debugging session that fixed several issues preventing the Chrome extension from correctly filling form fields from PDF extraction data.

## Problem Statement

After extracting data from a merchant application PDF, the Chrome extension form filler exhibited three issues:

1. **"false" appearing in Work Phone** — boolean values incorrectly matched to phone fields
2. **DOB (Date of Birth) never filled** — the date value was invisible to the matching engine
3. **Wrong phone assignments** — phone numbers assigned to incorrect fields

---

## Root Causes & Fixes (in order of discovery)

### 1. PHONE Key Pattern False Positive

**Symptom**: `mobile_app_used: false` was being matched to a phone field.

**Root cause**: The type matcher's `_KEY_PATTERNS` regex for PHONE was `r"phone|tel|mobile|cell|fax"`, which matched `"mobile"` inside `"mobile_app_used"` — a boolean field.

**Fix** (`type-matcher/src/unstract/type_matcher/models/value_typing.py`):
```python
# Before:
(SemanticType.PHONE, re.compile(r"phone|tel(?:ephone)?|mobile|cell|fax", re.IGNORECASE))

# After — negative lookahead prevents matching "mobile_app_*":
(SemanticType.PHONE, re.compile(
    r"phone|tel(?:ephone)?|mobile(?![-_\s]*(?:app|device|platform|os|version))|cell|fax",
    re.IGNORECASE,
))
```

**Lesson**: Key-name regex patterns need negative lookaheads for common false positives. The word `"mobile"` appears in both phone-related keys and technology-related keys (`mobile_app_used`, `mobile_device`, `mobile_platform`).

---

### 2. Boolean Values Leaking Into Form Fields

**Symptom**: Boolean values like `false` and `true` matched to text/phone fields.

**Root cause**: The `cleanPayload` filter in `local-matcher.ts` removed null/empty values but didn't filter booleans.

**Fix** (`chrome-extension/src/ai/local-matcher.ts`):
```typescript
// Added to cleanPayload filter:
if (typeof v === 'boolean') continue  // booleans never map to form text/phone/date fields
```

**Lesson**: Booleans in JSON extraction should never auto-fill text/phone/date fields. Filter them early in the pipeline rather than trying to match them.

---

### 3. Type Matcher Results Discarded by 50% Threshold

**Symptom**: Type matcher would correctly identify matches but they'd be thrown away.

**Root cause**: A threshold check discarded ALL type matcher results if auto-matches were less than 50% of total fields. For forms with many text fields (where type matching doesn't help), this threshold was almost never met.

**Fix** (`chrome-extension/src/ai/local-matcher.ts`):
```typescript
// Before: if auto < 50% of fields, discard everything and fall through to TF-IDF
// After: always keep type matcher auto-matches, let embedding/TF-IDF handle remaining fields
console.log(`[Unstract] Type matcher: ${typeAutoMatches.length} auto of ${typeResults.length} total`)
// Type matcher auto-matches are always merged with embedding/TF-IDF results
```

**Lesson**: Don't apply a "minimum coverage" threshold to a specialized matching strategy. Type matching is strongest for typed fields (email, phone, date, SSN) which are typically a minority of form fields. Always keep its results and let other strategies fill the gap.

---

### 4. Type Matcher Unreachable — `localhost` vs Network IP

**Symptom**: Type matcher worked in curl tests from the server but the extension always fell back to TF-IDF.

**Root cause**: The default type matcher URL was `http://localhost:3005`. The Chrome browser runs on a different machine (192.168.1.199), so `localhost` resolved to the browser's own machine — not the server (192.168.1.221) where the type matcher runs.

**Fix** (`chrome-extension/src/ai/local-matcher.ts` + `service-worker.ts`):
```typescript
// Default URL changed to server IP:
export const DEFAULT_TYPE_MATCHER_CONFIG: TypeMatcherConfig = {
  enabled: true,
  baseUrl: 'http://192.168.1.221:3005',
  autoScan: true,
}

// Migration in service-worker.ts onInstalled listener clears stale localhost config:
const stored = await chrome.storage.sync.get('typeMatcherConfig')
if (stored.typeMatcherConfig?.baseUrl?.includes('localhost')) {
  await chrome.storage.sync.remove('typeMatcherConfig')
}
```

**Lesson**: Extensions that call local services must account for the browser being on a different machine than the service. Use the actual network IP, not `localhost`. Add config migrations for breaking changes to defaults, since `chrome.storage.sync` persists old values across extension reloads.

---

### 5. TF-IDF Can't Match Abbreviations

**Symptom**: When the type matcher was unreachable, `"dob"` never matched `"date_of_birth"` via TF-IDF.

**Root cause**: TF-IDF tokenizes keys and field labels, then computes cosine similarity. `"dob"` and `"date of birth"` share zero tokens, so similarity = 0. Other fields like `"email"` ↔ `"email address"` have obvious overlap and work fine.

**Fix** (`chrome-extension/src/ai/local-matcher.ts`):
```typescript
const KEY_SYNONYMS: Record<string, string> = {
  'dob': 'date of birth',
  'ssn': 'social security number',
  'dl': 'drivers license',
  'ein': 'employer identification number',
  'tin': 'tax identification number',
  'aba': 'routing number',
  'dba': 'doing business as',
  'pct': 'percent',
  'avg': 'average',
  'amt': 'amount',
  'addr': 'address',
  'fname': 'first name',
  'lname': 'last name',
  'mname': 'middle name',
}

function normaliseKey(key: string): string {
  // ... strip dot-path, array indices, camelCase split ...
  const synonym = KEY_SYNONYMS[normalized]
  if (synonym) normalized = synonym
  return normalized
}
```

**Lesson**: TF-IDF is a token-overlap strategy — it fundamentally cannot match abbreviations to their full forms. A synonym expansion map is essential as a fallback for common domain abbreviations.

---

### 6. `normalizeDate` Missing 2-Digit Year Support

**Symptom**: Dates with 2-digit years (e.g., `"10/12/70"`) failed to inject.

**Fix** (`chrome-extension/src/content/field-injector.ts`):
```typescript
// Added 2-digit year handling:
const mdy2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/)
if (mdy2) {
  const [, m, d, yy] = mdy2
  const y = Number(yy) > 50 ? `19${yy}` : `20${yy}`
  if (Number(m) > 12) return `${y}-${d.padStart(2, '0')}-${m.padStart(2, '0')}`
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}
```

**Lesson**: HTML `<input type="date">` requires strict `YYYY-MM-DD` format. Date normalization must handle all common formats including 2-digit years. The pivot-at-50 convention (>50 = 19xx, ≤50 = 20xx) is standard practice.

---

### 7. `flattenJson` Not Recursing Into Arrays — THE DOB KILLER

**Symptom**: DOB, owner name, owner SSN — every field nested inside an array — never appeared in the payload sent to the extension.

**Root cause**: The `flattenJson` function in the test UI handled arrays at the top level (when `obj` itself is an array) but NOT when an array appeared as a property value:

```javascript
// BEFORE (buggy):
for (var key in obj) {
  var val = obj[key];
  var fullKey = prefix ? prefix + '.' + key : key;
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    // Only recurses into plain objects — arrays fall to else!
    Object.assign(result, flattenJson(val, fullKey));
  } else {
    result[fullKey] = val;  // Stores entire array as single value!
  }
}
```

For extraction data like `{ owners: [{ dob: "10-12-1970", name: "John" }] }`, this produced:
```
"MBN_3.owners" → [{dob: "10-12-1970", name: "John"}]  // useless array object
```

Instead of:
```
"MBN_3.owners[0].dob"  → "10-12-1970"
"MBN_3.owners[0].name" → "John"
```

**Fix** (`docker/test-ui/index.html`):
```javascript
// AFTER — remove !Array.isArray(val) so arrays are recursed:
if (val !== null && typeof val === 'object') {
  Object.assign(result, flattenJson(val, fullKey));
} else {
  result[fullKey] = val;
}
```

This works because `flattenJson` already handles arrays at the top of the function:
```javascript
if (Array.isArray(obj)) {
  obj.forEach(function(item, i) {
    Object.assign(result, flattenJson(item, prefix + '[' + i + ']'));
  });
  return result;
}
```

**Lesson**: This was the most impactful bug — it silently swallowed all array-nested fields. The other fixes (type matcher, TF-IDF synonyms, date normalization) were necessary but couldn't help if the data never reached the matching engine. **Always verify the payload at the source before debugging downstream matching logic.**

---

## Debugging Strategy That Worked

1. **Start at the output** — check what the form actually received
2. **Test each component in isolation** — curl the type matcher, test date injection directly
3. **Trace the data pipeline upstream** — extraction output → test UI flatten → extension payload → matching engine → content script injection
4. **The bug is usually at the boundary** — in this case, the flatten step (test UI → extension) was silently dropping array data

## Key Architecture Notes

```
PDF → Unstract Extraction → JSON Output
  → Test UI (flattenJson) → Chrome Extension payload
    → Service Worker (MATCH_FIELDS) → local-matcher.ts
      → Strategy 0: Type Matcher (FastAPI @ :3005) — regex on types
      → Strategy 1: LM Studio Embeddings — semantic similarity
      → Strategy 2: Transformers.js BERT — local embedding
      → Strategy 3: TF-IDF — token overlap (always available)
    → Content Script (field-injector.ts) → DOM injection
```

Each stage can silently swallow data. When debugging "field X not filling":
1. Is the value in the extraction output? (check DB)
2. Is the value in the flattened payload? (check flattenJson)
3. Is the value in cleanPayload? (not filtered as null/boolean/empty)
4. Does the matcher return a match for it? (check type matcher / TF-IDF)
5. Does the match have `auto: true`? (confidence above threshold)
6. Does injectValue succeed? (selector found, value accepted by input type)
