/**
 * Template data model and CRUD operations.
 *
 * Templates persist field-to-JSON-key mappings in chrome.storage.local
 * so they survive browser restarts and can be reapplied to the same form.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface TemplateFieldMapping {
  selector: string        // CSS selector at capture time
  fieldId: string         // HTML id (stable identifier)
  fieldName: string       // HTML name (stable identifier)
  fieldLabel: string      // Label text (for fuzzy re-matching)
  fieldType: string       // Input type (confirming signal)
  jsonKey: string         // The JSON payload key this field maps to
  source: 'auto' | 'manual'
  confidence: number      // Manual overrides = 1.0
}

export interface FormTemplate {
  id: string              // crypto.randomUUID()
  name: string            // User-chosen name
  urlPattern: string      // "app.example.com/forms/apply*"
  capturedUrl: string     // hostname + pathname at capture time
  createdAt: string
  lastUsedAt: string
  useCount: number
  mappings: TemplateFieldMapping[]
  jsonKeySnapshot: string[]  // For compatibility warnings
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'unstract_templates'
const MAX_TEMPLATES = 50

// ─── Storage helpers ────────────────────────────────────────────────────────────

export async function loadTemplateStore(): Promise<FormTemplate[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY)
  return (data[STORAGE_KEY] as FormTemplate[] | undefined) ?? []
}

async function persistTemplates(templates: FormTemplate[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: templates })
}

// ─── CRUD ───────────────────────────────────────────────────────────────────────

export async function saveTemplate(template: FormTemplate): Promise<FormTemplate> {
  const templates = await loadTemplateStore()

  // Replace if same id exists (update case)
  const idx = templates.findIndex(t => t.id === template.id)
  if (idx >= 0) {
    templates[idx] = template
  } else {
    templates.unshift(template)
  }

  // LRU eviction: remove oldest by lastUsedAt when over cap
  if (templates.length > MAX_TEMPLATES) {
    templates.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    templates.length = MAX_TEMPLATES
  }

  await persistTemplates(templates)
  return template
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const templates = await loadTemplateStore()
  const filtered = templates.filter(t => t.id !== templateId)
  await persistTemplates(filtered)
}

export async function getTemplate(templateId: string): Promise<FormTemplate | null> {
  const templates = await loadTemplateStore()
  return templates.find(t => t.id === templateId) ?? null
}

export async function listTemplates(): Promise<FormTemplate[]> {
  return loadTemplateStore()
}

export async function findMatchingTemplates(url: string): Promise<FormTemplate[]> {
  const templates = await loadTemplateStore()
  return templates.filter(t => urlMatchesPattern(url, t.urlPattern))
}

export async function updateTemplateUsage(templateId: string): Promise<void> {
  const templates = await loadTemplateStore()
  const t = templates.find(t => t.id === templateId)
  if (t) {
    t.lastUsedAt = new Date().toISOString()
    t.useCount++
    await persistTemplates(templates)
  }
}

// ─── URL pattern helpers ────────────────────────────────────────────────────────

/**
 * Derive a URL pattern from a full URL.
 * Strips query string and hash, keeps hostname + pathname with trailing wildcard.
 * e.g. "https://app.example.com/forms/apply?id=123" → "app.example.com/forms/apply*"
 */
export function deriveUrlPattern(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname + u.pathname + '*'
  } catch {
    return url
  }
}

/**
 * Check if a URL matches a simple glob pattern (only trailing * supported).
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const u = new URL(url)
    const urlStr = u.hostname + u.pathname
    if (pattern.endsWith('*')) {
      return urlStr.startsWith(pattern.slice(0, -1))
    }
    return urlStr === pattern
  } catch {
    return false
  }
}
