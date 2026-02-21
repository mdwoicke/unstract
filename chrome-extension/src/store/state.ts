/**
 * Shared state types and chrome.storage helpers.
 * Zustand is used only in the React overlay UI context.
 * Background and content scripts use chrome.storage.session directly.
 */

export interface JsonPayload {
  [key: string]: string | number | boolean | null
}

export interface FieldDescriptor {
  id: string
  name: string
  label: string
  placeholder: string
  type: string
  context: string
  /** XPath or CSS selector to relocate element after serialization */
  selector: string
  /** Option values for radio/checkbox/select groups */
  options?: string[]
}

export interface MatchResult {
  fieldId: string       // matches FieldDescriptor.id
  jsonKey: string
  jsonValue: string | number | boolean | null
  confidence: number    // 0–1
  auto: boolean         // true if above threshold
}

export interface UnmappedItem {
  key: string
  value: string | number | boolean | null
}

export interface ExtensionState {
  payload: JsonPayload | null
  loadedAt: number | null   // epoch ms, for TTL
  matches: MatchResult[]
  unmapped: UnmappedItem[]
}

const STORAGE_KEY = 'unstract_state'
const TTL_MS = 10 * 60 * 1000 // 10 minutes

export async function saveState(state: ExtensionState): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state })
}

export async function loadState(): Promise<ExtensionState | null> {
  const data = await chrome.storage.session.get(STORAGE_KEY)
  const state = data[STORAGE_KEY] as ExtensionState | undefined
  if (!state) return null
  // TTL check
  if (state.loadedAt && Date.now() - state.loadedAt > TTL_MS) {
    await chrome.storage.session.remove(STORAGE_KEY)
    return null
  }
  return state
}

export async function clearState(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY)
}

export async function removeUnmappedItem(key: string): Promise<void> {
  const state = await loadState()
  if (!state) return
  state.unmapped = state.unmapped.filter((u) => u.key !== key)
  await saveState(state)
}

/**
 * Convert a JSON path key to a human-friendly display name.
 * e.g. "output.card_details.credit_limit" → "Credit Limit"
 *      "firstName" → "First Name"
 *      "applicant.email_address" → "Email Address"
 */
export function toFriendlyName(key: string): string {
  // Take the last segment after the final dot
  const last = key.includes('.') ? key.substring(key.lastIndexOf('.') + 1) : key
  // Strip array indices like [0]
  const clean = last.replace(/\[\d+\]/g, '')
  // Split on underscores, hyphens, and camelCase boundaries
  const words = clean
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // XMLParser → XML Parser
    .split(/[_\-\s]+/)
    .filter(Boolean)
  // Title-case each word
  return words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Flatten a nested JSON object into dot-notation key/value pairs. */
export function flattenJson(obj: unknown, prefix = ''): JsonPayload {
  const result: JsonPayload = {}

  if (obj === null || obj === undefined) return result
  if (typeof obj !== 'object') {
    result[prefix] = obj as string | number | boolean | null
    return result
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      const nested = flattenJson(item, prefix ? `${prefix}[${i}]` : `[${i}]`)
      Object.assign(result, nested)
    })
    return result
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenJson(value, fullKey))
    } else if (Array.isArray(value)) {
      Object.assign(result, flattenJson(value, fullKey))
    } else {
      result[fullKey] = value as string | number | boolean | null
    }
  }
  return result
}
