/**
 * Local AI matching engine — matching strategy priority:
 *
 *   0. Pydantic type matcher (FastAPI service at localhost:3005 — pure regex,
 *                             no ML, <100ms response, type-first matching)
 *   1. LM Studio embeddings  (default — uses the same LM Studio instance
 *                             already running for PDF OCR at localhost:1234)
 *   2. Transformers.js BERT  (if model downloaded via `npm run download-model`)
 *   3. TF-IDF cosine         (always available, zero dependencies, fastest)
 *
 * Only one strategy runs per call. Failures cascade to the next strategy.
 */

import type { FieldDescriptor, MatchResult, JsonPayload } from '../store/state'
import {
  matchWithEmbeddings,
  rankSuggestionsLMStudio,
  type LMStudioConfig,
  DEFAULT_LMSTUDIO_CONFIG,
} from './lmstudio-matcher'

// ─── Strategy 0: Pydantic Type Matcher ───────────────────────────────────────

export interface TypeMatcherConfig {
  enabled: boolean
  baseUrl: string  // e.g. "http://localhost:3005"
  autoScan: boolean  // auto-fill when JSON is loaded
}

export const DEFAULT_TYPE_MATCHER_CONFIG: TypeMatcherConfig = {
  enabled: true,
  baseUrl: 'http://192.168.1.221:3005',
  autoScan: true,
}

/**
 * Match fields using the Pydantic type-matcher FastAPI service.
 * Returns null if the service is unavailable — cascade continues.
 */
async function matchWithPydanticTypes(
  payload: JsonPayload,
  fields: FieldDescriptor[],
  config: TypeMatcherConfig,
): Promise<MatchResult[] | null> {
  if (!config.enabled) return null
  try {
    const res = await fetch(`${config.baseUrl}/api/v1/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, fields }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json() as { matches: MatchResult[] }
    if (!data.matches || data.matches.length === 0) return null
    console.log(`[Unstract] Type matcher: ${data.matches.filter(m => m.auto).length} auto, ${data.matches.length} total`)
    return data.matches
  } catch {
    console.log('[Unstract] Type matcher unavailable, falling back')
    return null
  }
}

/**
 * Rank suggestions using the Pydantic type-matcher service.
 */
export async function rankSuggestionsTypeMatcher(
  fieldText: string,
  payload: JsonPayload,
  config: TypeMatcherConfig,
  topN = 5,
): Promise<Array<{ key: string; value: unknown; score: number }>> {
  if (!config.enabled) return []
  try {
    const res = await fetch(`${config.baseUrl}/api/v1/rank-suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field_text: fieldText, payload, top_n: topN }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data = await res.json() as { suggestions: Array<{ key: string; value: unknown; score: number }> }
    return data.suggestions ?? []
  } catch {
    return []
  }
}

/**
 * Test connectivity to the type-matcher service.
 */
export async function testTypeMatcherConnection(baseUrl: string): Promise<{
  ok: boolean
  latencyMs: number
  error?: string
}> {
  const start = Date.now()
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` }
    }
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) }
  }
}

export const AUTO_FILL_THRESHOLD = 0.82
export const TFIDF_AUTO_THRESHOLD = 0.55
export const SUGGEST_THRESHOLD = 0.40

// ─── Strategy 2: Transformers.js BERT ─────────────────────────────────────────

let pipelineLoaded = false
let featureExtraction: ((
  text: string | string[],
  opts?: object
) => Promise<{ data: Float32Array }>) | null = null

async function loadPipeline(): Promise<boolean> {
  if (pipelineLoaded) return featureExtraction !== null
  try {
    const { pipeline, env } = await import('@xenova/transformers')
    env.localModelPath = chrome.runtime.getURL('models/')
    env.allowRemoteModels = true
    const extractor = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    )
    featureExtraction = async (text: string | string[]) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true })
      return { data: out.data as Float32Array }
    }
    pipelineLoaded = true
    console.log('[Unstract] BERT pipeline loaded')
    return true
  } catch {
    pipelineLoaded = true
    featureExtraction = null
    return false
  }
}

// ─── Strategy 3: TF-IDF cosine ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must',
  'can','could','not','no','nor','so','yet','both','either','neither',
  'each','few','more','most','other','some','such','than','too','very',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_.\-\/\\]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
}

let _idfCache: Map<string, number> | null = null

function buildIdf(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>()
  const N = corpus.length
  for (const tokens of corpus) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1)
  }
  return idf
}

function tfidfVector(tokens: string[]): number[] {
  if (!_idfCache) return []
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  const vec: number[] = []
  for (const [term, idf] of _idfCache) {
    vec.push(((tf.get(term) ?? 0) / Math.max(tokens.length, 1)) * idf)
  }
  return vec
}

function initIdf(allTexts: string[]) {
  const corpus = allTexts.map(tokenize)
  _idfCache = buildIdf(corpus)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ─── Type-aware matching (Pydantic-style field type alignment) ───────────────

type ValueType = 'email' | 'phone' | 'date' | 'number' | 'url' | 'boolean' | 'text'

const TYPE_PATTERNS: Array<[ValueType, RegExp]> = [
  ['email',   /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['phone',   /^[\+\(\)\-\d\s\.]{7,20}$/],
  ['date',    /^(\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}|\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4})$/],
  ['url',     /^https?:\/\//i],
  ['number',  /^[\-\+]?\d[\d,]*\.?\d*$/],
  ['boolean', /^(true|false|yes|no|on|off|1|0|checked)$/i],
]

/** Infer the data type of a JSON value by pattern matching. */
function inferValueType(value: unknown): ValueType {
  const s = String(value ?? '').trim()
  if (!s) return 'text'
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(s)) return type
  }
  return 'text'
}

/** Map HTML input types to our value types. */
const FIELD_TYPE_MAP: Record<string, ValueType> = {
  'email': 'email',
  'tel': 'phone',
  'date': 'date',
  'datetime-local': 'date',
  'month': 'date',
  'week': 'date',
  'time': 'date',
  'number': 'number',
  'url': 'url',
  'checkbox': 'boolean',
  'radio': 'boolean',
}

/**
 * Apply a type-compatibility multiplier to a text-similarity score.
 * Same type → 1.3x boost. Incompatible types → 0.5x penalty.
 * Generic 'text' fields get no adjustment.
 */
function typeBoost(fieldType: string, value: unknown): number {
  const ft = FIELD_TYPE_MAP[fieldType]
  if (!ft) return 1.0  // text/select/textarea — no adjustment
  const vt = inferValueType(value)
  if (vt === 'text') return 1.0  // can't infer value type — no adjustment
  if (ft === vt) return 1.3     // same type → boost
  return 0.5                     // type mismatch → penalty
}

/**
 * Hard-block obviously wrong type combinations for auto-fill.
 * Returns true if the value should NEVER be auto-filled into this field type.
 * E.g., boolean "false" into a phone field, or a zip code into an address field.
 */
function isTypeIncompatible(fieldType: string, value: unknown): boolean {
  const vt = inferValueType(value)
  const ft = FIELD_TYPE_MAP[fieldType]
  if (!ft || vt === 'text') return false  // generic types — allow

  // Hard blocks: these combinations are always wrong
  if (ft === 'phone' && vt === 'boolean') return true
  if (ft === 'phone' && vt === 'url') return true
  if (ft === 'email' && vt !== 'email' && vt !== 'text') return true
  if (ft === 'date' && vt !== 'date' && vt !== 'text') return true
  if (ft === 'boolean' && vt !== 'boolean' && vt !== 'text') return true
  if (ft === 'url' && vt !== 'url' && vt !== 'text') return true

  return false
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Common abbreviations → expanded form for better TF-IDF/embedding matching
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
  // Use only the last segment of dot-notation paths
  // e.g. "output.card_holder.first_name" → "first name"
  const last = key.includes('.') ? key.substring(key.lastIndexOf('.') + 1) : key
  let normalized = last
    .replace(/\[\d+\]/g, '')            // strip array indices
    .replace(/[_\-\[\]]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  // Expand abbreviations for better matching
  const synonym = KEY_SYNONYMS[normalized]
  if (synonym) normalized = synonym
  return normalized
}

function fieldContext(f: FieldDescriptor): string {
  return [f.label, f.name, f.placeholder, f.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function buildResultsFromMatrix(
  keyEmbeds: number[][],
  fieldEmbeds: number[][],
  jsonKeys: string[],
  fields: FieldDescriptor[],
  payload: JsonPayload,
  autoThreshold: number = AUTO_FILL_THRESHOLD
): MatchResult[] {
  const results: MatchResult[] = []
  const usedKeys = new Set<string>()

  // Build scored pairs and sort by confidence descending for greedy assignment
  const pairs: Array<{ fi: number; ki: number; score: number }> = []
  for (let fi = 0; fi < fields.length; fi++) {
    for (let ki = 0; ki < jsonKeys.length; ki++) {
      let score = cosine(fieldEmbeds[fi], keyEmbeds[ki])
      // Apply type boost/penalty
      score *= typeBoost(fields[fi].type, payload[jsonKeys[ki]])
      if (score >= SUGGEST_THRESHOLD) {
        pairs.push({ fi, ki, score })
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score)

  // Greedy one-to-one assignment: highest scores first
  const assignedFields = new Set<number>()
  for (const { fi, ki, score } of pairs) {
    if (assignedFields.has(fi) || usedKeys.has(jsonKeys[ki])) continue

    const value = payload[jsonKeys[ki]]
    // Hard-block type-incompatible auto-fills
    const blocked = isTypeIncompatible(fields[fi].type, value)

    assignedFields.add(fi)
    usedKeys.add(jsonKeys[ki])
    results.push({
      fieldId: fields[fi].selector,
      jsonKey: jsonKeys[ki],
      jsonValue: value,
      confidence: score,
      auto: score >= autoThreshold && !blocked,
    })
  }
  return results
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Primary entry point — tries Type Matcher, LM Studio, then BERT, then TF-IDF.
 * Configs are loaded from chrome.storage.sync by the background SW.
 */
export async function matchFields(
  payload: JsonPayload,
  fields: FieldDescriptor[],
  lmStudioConfig: LMStudioConfig = DEFAULT_LMSTUDIO_CONFIG,
  typeMatcherConfig: TypeMatcherConfig = DEFAULT_TYPE_MATCHER_CONFIG,
): Promise<MatchResult[]> {
  if (fields.length === 0 || Object.keys(payload).length === 0) return []

  // Filter out empty/meaningless values — no point matching them to fields
  const cleanPayload: JsonPayload = {}
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'boolean') continue  // booleans never map to form text/phone/date fields
    if (typeof v === 'string' && v.trim() === '') continue
    cleanPayload[k] = v
  }
  if (Object.keys(cleanPayload).length === 0) return []
  payload = cleanPayload

  // ── Strategy 0: Pydantic Type Matcher ─────────────────────────────────────
  // Use type-matcher for strong typed matches (email, phone, date, etc.),
  // then fall through to embedding/TF-IDF for remaining text fields.
  let typeAutoMatches: MatchResult[] = []
  if (typeMatcherConfig.enabled) {
    const typeResults = await matchWithPydanticTypes(payload, fields, typeMatcherConfig)
    if (typeResults !== null) {
      typeAutoMatches = typeResults.filter(m => m.auto)
      console.log(`[Unstract] Type matcher: ${typeAutoMatches.length} auto of ${typeResults.length} total`)
      // Always merge: keep auto matches from type matcher, let embedding/TF-IDF handle remaining fields
    }
  }

  // Filter out fields already auto-matched by type matcher
  const typeMatchedSelectors = new Set(typeAutoMatches.map(m => m.fieldId))
  const typeMatchedKeys = new Set(typeAutoMatches.map(m => m.jsonKey))
  const remainingFields = fields.filter(f => !typeMatchedSelectors.has(f.selector))
  const remainingPayload: JsonPayload = {}
  for (const [k, v] of Object.entries(payload)) {
    if (!typeMatchedKeys.has(k)) remainingPayload[k] = v
  }
  console.log(`[Unstract] Type matcher claimed ${typeAutoMatches.length} fields, ${remainingFields.length} remaining for embedding/TF-IDF`)

  // Use remaining fields/payload for embedding strategies (excluding type-matched ones)
  const embFields = remainingFields.length > 0 ? remainingFields : fields
  const embPayload = Object.keys(remainingPayload).length > 0 ? remainingPayload : payload

  // ── Strategy 1: LM Studio Embeddings ──────────────────────────────────────
  if (lmStudioConfig.enabled) {
    const lmResults = await matchWithEmbeddings(embPayload, embFields, lmStudioConfig)
    if (lmResults !== null) {
      return [...typeAutoMatches, ...lmResults]
    }
  }

  // ── Strategy 2: Transformers.js BERT ──────────────────────────────────────
  await loadPipeline()
  if (featureExtraction) {
    try {
      const jsonKeys = Object.keys(embPayload)
      const jsonTexts = jsonKeys.map(normaliseKey)
      const fieldTexts = embFields.map(fieldContext)
      const allTexts = [...jsonTexts, ...fieldTexts]

      const allEmbed = await featureExtraction(allTexts)
      const dim = allEmbed.data.length / allTexts.length
      const embeddings = allTexts.map((_, i) =>
        Array.from(allEmbed.data.slice(i * dim, (i + 1) * dim))
      )
      const keyEmbeds = embeddings.slice(0, jsonKeys.length)
      const fieldEmbeds = embeddings.slice(jsonKeys.length)

      console.log('[Unstract] Using BERT embeddings for matching')
      return [...typeAutoMatches, ...buildResultsFromMatrix(keyEmbeds, fieldEmbeds, jsonKeys, embFields, embPayload)]
    } catch {
      console.warn('[Unstract] BERT matching failed, falling back to TF-IDF')
    }
  }

  // ── Strategy 3: TF-IDF ────────────────────────────────────────────────────
  // TF-IDF scores are inherently lower than embedding cosine scores,
  // so we use a lower auto-fill threshold for exact-token matching.
  console.log('[Unstract] Using TF-IDF for matching')
  const jsonKeys = Object.keys(embPayload)
  const jsonTexts = jsonKeys.map(normaliseKey)
  const fieldTexts = embFields.map(fieldContext)
  initIdf([...jsonTexts, ...fieldTexts])

  const keyEmbeds = jsonTexts.map(t => tfidfVector(tokenize(t)))
  const fieldEmbeds = fieldTexts.map(t => tfidfVector(tokenize(t)))
  return [...typeAutoMatches, ...buildResultsFromMatrix(keyEmbeds, fieldEmbeds, jsonKeys, embFields, embPayload, TFIDF_AUTO_THRESHOLD)]
}

/**
 * Rank JSON keys by similarity to a field context string.
 * Used by the overlay combobox for ranked suggestions.
 */
export async function rankSuggestions(
  fieldText: string,
  payload: JsonPayload,
  topN = 5,
  lmStudioConfig: LMStudioConfig = DEFAULT_LMSTUDIO_CONFIG,
  typeMatcherConfig: TypeMatcherConfig = DEFAULT_TYPE_MATCHER_CONFIG,
): Promise<Array<{ key: string; value: unknown; score: number }>> {
  const keys = Object.keys(payload)
  if (keys.length === 0) return []

  // Try Type Matcher first
  if (typeMatcherConfig.enabled) {
    const suggestions = await rankSuggestionsTypeMatcher(fieldText, payload, typeMatcherConfig, topN)
    if (suggestions.length > 0) return suggestions
  }

  // Try LM Studio
  if (lmStudioConfig.enabled) {
    const suggestions = await rankSuggestionsLMStudio(fieldText, payload, lmStudioConfig, topN)
    if (suggestions.length > 0) return suggestions
  }

  // BERT
  await loadPipeline()
  if (featureExtraction) {
    try {
      const texts = [fieldText, ...keys.map(normaliseKey)]
      const allEmbed = await featureExtraction(texts)
      const dim = allEmbed.data.length / texts.length
      const embeddings = texts.map((_, i) =>
        Array.from(allEmbed.data.slice(i * dim, (i + 1) * dim))
      )
      const fieldEmbed = embeddings[0]
      const keyEmbeds = embeddings.slice(1)
      return keys
        .map((key, i) => ({ key, value: payload[key], score: cosine(fieldEmbed, keyEmbeds[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
    } catch { /* fall through */ }
  }

  // TF-IDF
  initIdf([fieldText, ...keys.map(normaliseKey)])
  const fieldVec = tfidfVector(tokenize(fieldText))
  return keys
    .map(key => ({
      key,
      value: payload[key],
      score: cosine(fieldVec, tfidfVector(tokenize(normaliseKey(key)))),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}
