/**
 * LM Studio matcher — the default AI strategy.
 *
 * Uses LM Studio's OpenAI-compatible API (http://localhost:1234 by default),
 * which is already running on this machine for PDF OCR extraction.
 *
 * Two modes:
 *   1. Embedding mode  — POST /v1/embeddings  → cosine similarity matrix
 *   2. Chat mode       — POST /v1/chat/completions → structured JSON mapping
 *      (used as fallback when embedding scores are all below threshold,
 *       or when no embedding model is loaded)
 */

import type { FieldDescriptor, JsonPayload, MatchResult } from '../store/state'
import { AUTO_FILL_THRESHOLD, SUGGEST_THRESHOLD } from './local-matcher'

// ─── Config type (stored in chrome.storage.sync) ─────────────────────────────

export interface LMStudioConfig {
  enabled: boolean
  baseUrl: string           // e.g. "http://localhost:1234"
  embeddingModel: string    // e.g. "nomic-embed-text-v1.5" — empty = auto-detect
  chatModel: string         // e.g. "qwen3-vl-8b-instruct" — empty = auto-detect
  useChatFallback: boolean  // use chat completion when embedding confidence is low
}

export const DEFAULT_LMSTUDIO_CONFIG: LMStudioConfig = {
  enabled: true,
  baseUrl: 'http://localhost:1234',
  embeddingModel: '',   // auto-detected on first use
  chatModel: '',        // auto-detected on first use
  useChatFallback: true,
}

// Cached detected model names (reset when background SW restarts)
let _detectedEmbeddingModel = ''
let _detectedChatModel = ''

// ─── Model discovery ──────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string
  object: string
  type?: string          // LM Studio adds this
  publisher?: string
}

/**
 * List all models currently loaded in LM Studio.
 * Returns [] if LM Studio is not running.
 */
export async function listModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return []
    const data = await res.json() as { data: ModelInfo[] }
    return data.data ?? []
  } catch {
    return []
  }
}

/**
 * Probe LM Studio: returns { ok, embeddingModel, chatModel, latencyMs }
 */
export async function testConnection(baseUrl: string): Promise<{
  ok: boolean
  embeddingModel: string
  chatModel: string
  latencyMs: number
  error?: string
}> {
  const start = Date.now()
  try {
    const models = await listModels(baseUrl)
    if (models.length === 0) {
      return { ok: false, embeddingModel: '', chatModel: '', latencyMs: Date.now() - start,
        error: 'No models loaded in LM Studio' }
    }

    // Classify loaded models
    // LM Studio sets type="embeddings" for embedding models, type="llm" for chat
    const embeddingModels = models.filter(m =>
      m.type === 'embeddings' ||
      m.id.toLowerCase().includes('embed') ||
      m.id.toLowerCase().includes('nomic') ||
      m.id.toLowerCase().includes('bge') ||
      m.id.toLowerCase().includes('e5-')
    )
    const chatModels = models.filter(m =>
      m.type === 'llm' || (!embeddingModels.some(e => e.id === m.id))
    )

    const embeddingModel = embeddingModels[0]?.id ?? ''
    const chatModel = chatModels[0]?.id ?? models[0]?.id ?? ''

    return {
      ok: true,
      embeddingModel,
      chatModel,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      ok: false,
      embeddingModel: '',
      chatModel: '',
      latencyMs: Date.now() - start,
      error: String(err),
    }
  }
}

// ─── Embedding-based matching ─────────────────────────────────────────────────

async function embedBatch(
  texts: string[],
  baseUrl: string,
  model: string
): Promise<number[][]> {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`LM Studio embeddings ${res.status}: ${err}`)
  }

  const data = await res.json() as {
    data: Array<{ embedding: number[]; index: number }>
  }

  // Sort by index to preserve order
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding)
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

function normaliseKey(key: string): string {
  return key
    .replace(/[_.\-\[\]]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

function fieldContext(f: FieldDescriptor): string {
  return [f.label, f.name, f.placeholder, f.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * Match JSON keys to form fields using LM Studio embeddings.
 * Returns null if LM Studio is not available or has no embedding model.
 */
export async function matchWithEmbeddings(
  payload: JsonPayload,
  fields: FieldDescriptor[],
  config: LMStudioConfig
): Promise<MatchResult[] | null> {
  if (!config.enabled || fields.length === 0) return null

  // Resolve embedding model
  let model = config.embeddingModel || _detectedEmbeddingModel
  if (!model) {
    const probe = await testConnection(config.baseUrl)
    if (!probe.ok || !probe.embeddingModel) {
      console.log('[Unstract] LM Studio has no embedding model loaded, falling back')
      return null
    }
    _detectedEmbeddingModel = probe.embeddingModel
    _detectedChatModel = probe.chatModel
    model = probe.embeddingModel
  }

  const jsonKeys = Object.keys(payload)
  const jsonTexts = jsonKeys.map(normaliseKey)
  const fieldTexts = fields.map(fieldContext)

  try {
    // Batch all texts in one request for efficiency
    const allTexts = [...jsonTexts, ...fieldTexts]
    const embeddings = await embedBatch(allTexts, config.baseUrl, model)

    const keyEmbeds = embeddings.slice(0, jsonKeys.length)
    const fieldEmbeds = embeddings.slice(jsonKeys.length)

    const results: MatchResult[] = []

    for (let fi = 0; fi < fields.length; fi++) {
      let bestScore = -1
      let bestKeyIdx = -1

      for (let ki = 0; ki < jsonKeys.length; ki++) {
        const score = cosine(fieldEmbeds[fi], keyEmbeds[ki])
        if (score > bestScore) {
          bestScore = score
          bestKeyIdx = ki
        }
      }

      if (bestScore < SUGGEST_THRESHOLD) continue

      results.push({
        fieldId: fields[fi].selector,
        jsonKey: jsonKeys[bestKeyIdx],
        jsonValue: payload[jsonKeys[bestKeyIdx]],
        confidence: bestScore,
        auto: bestScore >= AUTO_FILL_THRESHOLD,
      })
    }

    console.log(`[Unstract] LM Studio embedding match: ${results.filter(r => r.auto).length} auto, ${results.length} total`)
    return results
  } catch (err) {
    console.warn('[Unstract] LM Studio embedding request failed:', err)
    return null
  }
}

// ─── Chat-based matching (fallback / disambiguation) ─────────────────────────

/**
 * Use Qwen3 (or whatever chat model is loaded) to resolve ambiguous fields.
 * Sends masked JSON keys + field labels as a structured prompt.
 * Called when embedding scores are all below AUTO_FILL_THRESHOLD.
 */
export async function matchWithChat(
  payload: JsonPayload,
  fields: FieldDescriptor[],
  config: LMStudioConfig
): Promise<MatchResult[]> {
  const model = config.chatModel || _detectedChatModel
  if (!model) {
    const probe = await testConnection(config.baseUrl)
    if (!probe.ok || !probe.chatModel) return []
    _detectedChatModel = probe.chatModel
  }

  const keyList = Object.entries(payload)
    .map(([k, v]) => `  "${k}": ${JSON.stringify(v)}`)
    .join('\n')

  const fieldList = fields
    .map(f => `  id: "${f.selector}", label: "${f.label || f.name || f.id}"`)
    .join('\n')

  const prompt = `You are a form-filling assistant. Match these JSON data fields to HTML form fields.

JSON data:
${keyList}

Form fields:
${fieldList}

Return ONLY a valid JSON object mapping JSON keys to form field selectors, like:
{"json_key": "field_selector", ...}

Only include confident matches. Omit any field you are not sure about.`

  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.chatModel || _detectedChatModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) throw new Error(`Chat API ${res.status}`)
    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    const text = data.choices?.[0]?.message?.content ?? ''

    const jsonMatch = text.match(/\{[\s\S]+\}/)
    if (!jsonMatch) return []

    const mapping: Record<string, string> = JSON.parse(jsonMatch[0])
    return Object.entries(mapping)
      .filter(([key]) => key in payload)
      .map(([jsonKey, fieldSelector]) => ({
        fieldId: fieldSelector,
        jsonKey,
        jsonValue: payload[jsonKey],
        confidence: AUTO_FILL_THRESHOLD,
        auto: true,
      }))
  } catch (err) {
    console.warn('[Unstract] LM Studio chat match failed:', err)
    return []
  }
}

/**
 * Rank all JSON keys by similarity to a field's context string.
 * Used by the overlay to show top suggestions.
 */
export async function rankSuggestionsLMStudio(
  fieldText: string,
  payload: JsonPayload,
  config: LMStudioConfig,
  topN = 5
): Promise<Array<{ key: string; value: unknown; score: number }>> {
  const model = config.embeddingModel || _detectedEmbeddingModel
  if (!config.enabled || !model) return []

  const keys = Object.keys(payload)
  if (keys.length === 0) return []

  try {
    const texts = [fieldText, ...keys.map(normaliseKey)]
    const embeddings = await embedBatch(texts, config.baseUrl, model)
    const fieldEmbed = embeddings[0]
    const keyEmbeds = embeddings.slice(1)

    return keys
      .map((key, i) => ({
        key,
        value: payload[key],
        score: cosine(fieldEmbed, keyEmbeds[i]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  } catch {
    return []
  }
}
