/**
 * Cloud LLM fallback for semantic field matching.
 * Sends masked JSON keys + page field labels to Claude/OpenAI API.
 * PII is masked before the request and rehydrated from the response.
 */

import type { FieldDescriptor, JsonPayload, MatchResult } from '../store/state'
import { maskPayload, rehydrate } from './pii-masker'
import { AUTO_FILL_THRESHOLD } from './local-matcher'

export interface CloudConfig {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model?: string
}

export async function cloudMatch(
  payload: JsonPayload,
  fields: FieldDescriptor[],
  config: CloudConfig
): Promise<MatchResult[]> {
  const stringPayload: Record<string, string> = {}
  for (const [k, v] of Object.entries(payload)) {
    stringPayload[k] = v === null ? 'null' : String(v)
  }

  const { masked, tokenMap } = maskPayload(stringPayload)

  const fieldList = fields
    .map((f) => `  - id: "${f.selector}", label: "${f.label || f.name || f.id}"`)
    .join('\n')

  const keyList = Object.keys(masked)
    .map((k) => `  - "${k}": "${masked[k]}"`)
    .join('\n')

  const prompt = `You are a form-filling assistant. Given the following JSON data fields and HTML form fields, return a JSON mapping of JSON keys to form field selectors.

JSON data:
${keyList}

Form fields:
${fieldList}

Return ONLY a valid JSON object like:
{
  "json_key": "field_selector",
  ...
}

Only include confident matches. Omit fields that don't have a clear match.`

  let responseText: string

  if (config.provider === 'anthropic') {
    responseText = await callAnthropic(prompt, config)
  } else {
    responseText = await callOpenAI(prompt, config)
  }

  // Rehydrate PII tokens in the response
  const rehydrated = rehydrate(responseText, tokenMap)

  let mapping: Record<string, string>
  try {
    const jsonMatch = rehydrated.match(/\{[\s\S]+\}/)
    mapping = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
  } catch {
    console.warn('[Unstract] Failed to parse cloud matcher response:', rehydrated)
    return []
  }

  const results: MatchResult[] = []
  for (const [jsonKey, fieldSelector] of Object.entries(mapping)) {
    if (!(jsonKey in payload)) continue
    results.push({
      fieldId: fieldSelector,
      jsonKey,
      jsonValue: payload[jsonKey],
      confidence: AUTO_FILL_THRESHOLD,  // cloud match treated as high confidence
      auto: true,
    })
  }
  return results
}

async function callAnthropic(prompt: string, config: CloudConfig): Promise<string> {
  const model = config.model ?? 'claude-haiku-4-5-20251001'
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text ?? ''
}

async function callOpenAI(prompt: string, config: CloudConfig): Promise<string> {
  const model = config.model ?? 'gpt-4o-mini'
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}
