/**
 * MV3 Background Service Worker.
 *
 * Responsibilities:
 * - Receive LOAD_JSON from content script relay (test UI page)
 * - Persist payload in chrome.storage.session (10-min TTL)
 * - Run AI field matching (LM Studio → BERT → TF-IDF)
 * - Route FIELD_FILLED / GET_STATE / config messages
 * - Handle FILL_PAGE: inject content script if needed, send FILL_NOW
 * - Manage action badge (orange count when loaded, green ✓ after fill)
 */

import {
  matchFields, rankSuggestions,
  testTypeMatcherConnection,
  DEFAULT_TYPE_MATCHER_CONFIG,
  type TypeMatcherConfig,
} from '../ai/local-matcher'
import { matchWithChat, testConnection, DEFAULT_LMSTUDIO_CONFIG, type LMStudioConfig } from '../ai/lmstudio-matcher'
import {
  saveState, loadState, clearState, removeUnmappedItem,
  type ExtensionState, type JsonPayload, type FieldDescriptor,
} from '../store/state'
import {
  saveTemplate, deleteTemplate, getTemplate, listTemplates,
  findMatchingTemplates, updateTemplateUsage, deriveUrlPattern,
  type FormTemplate, type TemplateFieldMapping,
} from '../store/template'

// ─── Message types ────────────────────────────────────────────────────────────

type BgMessage =
  | { type: 'LOAD_JSON';          payload: JsonPayload }
  | { type: 'MATCH_FIELDS';       fields: FieldDescriptor[] }
  | { type: 'RANK_SUGGEST';       fieldText: string }
  | { type: 'FIELD_FILLED';       key: string }
  | { type: 'FILL_PAGE' }
  | { type: 'FILL_DONE';          filledCount: number; unmappedCount: number }
  | { type: 'CONTENT_READY' }
  | { type: 'GET_STATE' }
  | { type: 'CLEAR_STATE' }
  | { type: 'GET_LMSTUDIO_CONFIG' }
  | { type: 'SET_LMSTUDIO_CONFIG'; config: Partial<LMStudioConfig> }
  | { type: 'TEST_LMSTUDIO';      baseUrl: string }
  | { type: 'GET_TYPE_MATCHER_CONFIG' }
  | { type: 'SET_TYPE_MATCHER_CONFIG'; config: Partial<TypeMatcherConfig> }
  | { type: 'TEST_TYPE_MATCHER';      baseUrl: string }
  | { type: 'GET_CLOUD_CONFIG' }
  | { type: 'SET_CLOUD_CONFIG';   provider: string; apiKey: string; model?: string }
  // Template messages
  | { type: 'LIST_TEMPLATES' }
  | { type: 'GET_TEMPLATE'; templateId: string }
  | { type: 'SAVE_TEMPLATE'; name: string; urlPattern: string; capturedUrl: string; mappings: TemplateFieldMapping[] }
  | { type: 'DELETE_TEMPLATE'; templateId: string }
  | { type: 'GET_CAPTURED_MAPPINGS' }
  | { type: 'APPLY_TEMPLATE'; templateId: string }
  | { type: 'SAVE_TEMPLATE_FROM_CONTENT'; name: string; url: string; mappings: TemplateFieldMapping[] }
  | { type: 'FIND_MATCHING_TEMPLATES'; url: string }
  | { type: 'EXPORT_TEMPLATES' }
  | { type: 'IMPORT_TEMPLATES'; templates: FormTemplate[] }

// ─── Badge helpers ────────────────────────────────────────────────────────────

function setBadge(text: string, color: string) {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' })
}

// ─── Config loaders ───────────────────────────────────────────────────────────

async function getTypeMatcherConfig(): Promise<TypeMatcherConfig> {
  const data = await chrome.storage.sync.get('typeMatcherConfig')
  return { ...DEFAULT_TYPE_MATCHER_CONFIG, ...(data.typeMatcherConfig ?? {}) }
}

async function getLMStudioConfig(): Promise<LMStudioConfig> {
  const data = await chrome.storage.sync.get('lmStudioConfig')
  return { ...DEFAULT_LMSTUDIO_CONFIG, ...(data.lmStudioConfig ?? {}) }
}

async function getCloudConfig() {
  const data = await chrome.storage.sync.get(['cloudProvider', 'cloudApiKey', 'cloudModel'])
  return {
    provider: (data.cloudProvider ?? 'anthropic') as 'anthropic' | 'openai',
    apiKey: (data.cloudApiKey ?? '') as string,
    model: (data.cloudModel ?? '') as string,
  }
}

// ─── Re-inject content scripts after extension install/reload ────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Unstract BG] Extension installed/reloaded — re-injecting content scripts')

  // Register context menu
  chrome.contextMenus.create({
    id: 'unstract-fill',
    title: 'MBN: Fill This Page',
    contexts: ['page'],
  })

  // Migrate stale type matcher config: if stored URL points to localhost,
  // clear it so the new default (server IP) takes effect.
  const stored = await chrome.storage.sync.get('typeMatcherConfig')
  if (stored.typeMatcherConfig?.baseUrl?.includes('localhost')) {
    console.log('[Unstract BG] Clearing stale localhost type matcher config')
    await chrome.storage.sync.remove('typeMatcherConfig')
  }
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })
    } catch {
      // Tab doesn't allow script injection (e.g. chrome web store) — ignore
    }
  }
})

// ─── Auto-fill helper ────────────────────────────────────────────────────────

async function triggerAutoFill() {
  // Send FILL_NOW to ALL non-chrome tabs — each content script checks
  // for form fields and returns early if none found. This handles the
  // cross-tab case where JSON is loaded on one page and the form is on another.
  const tabs = await chrome.tabs.query({ currentWindow: true })
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'FILL_NOW' })
    } catch {
      // Content script not yet injected — inject then fill
      pendingFillTabId = tab.id
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        })
      } catch {
        // Can't inject into this tab — skip
      }
    }
  }
}

// ─── Pending fill: set when content script signals it's ready ────────────────

let pendingFillTabId: number | null = null

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: BgMessage, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('[Unstract BG] Error:', err)
    sendResponse({ error: String(err) })
  })
  return true
})

async function handleMessage(msg: BgMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {

    case 'LOAD_JSON': {
      const state: ExtensionState = {
        payload: msg.payload,
        loadedAt: Date.now(),
        matches: [],
        unmapped: Object.entries(msg.payload).map(([key, value]) => ({ key, value })),
      }
      await saveState(state)
      const keyCount = Object.keys(msg.payload).length
      console.log('[Unstract BG] Payload loaded:', keyCount, 'keys')
      setBadge(String(keyCount), '#f59e0b')  // orange badge with key count

      // Auto-scan: trigger fill on the active tab if enabled
      const tmCfg = await getTypeMatcherConfig()
      if (tmCfg.autoScan) {
        // Fire-and-forget — don't block the LOAD_JSON response
        triggerAutoFill().catch(err =>
          console.warn('[Unstract BG] Auto-scan fill failed:', err)
        )
      }

      return { ok: true, keyCount }
    }

    case 'FILL_PAGE': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) return { error: 'No active tab' }
      if (tab.url.startsWith('chrome://')) return { error: 'Cannot fill browser pages' }

      try {
        // Try sending FILL_NOW to already-loaded content script
        await chrome.tabs.sendMessage(tab.id, { type: 'FILL_NOW' })
      } catch {
        // Content script not injected — inject it programmatically, then send FILL_NOW
        console.log('[Unstract BG] Injecting content script into tab', tab.id)
        pendingFillTabId = tab.id

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        })
        // CONTENT_READY handler below will send FILL_NOW when script is ready
      }
      return { ok: true }
    }

    case 'CONTENT_READY': {
      // Content script just loaded (fresh inject) — send FILL_NOW if we were waiting
      if (pendingFillTabId !== null && sender?.tab?.id === pendingFillTabId) {
        const tabId = pendingFillTabId
        pendingFillTabId = null
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'FILL_NOW' })
        } catch (e) {
          console.error('[Unstract BG] Failed to send FILL_NOW after inject:', e)
        }
      }
      return { ok: true }
    }

    case 'FILL_DONE': {
      // Content script reports fill results — update badge
      const { filledCount, unmappedCount } = msg
      if (unmappedCount === 0) {
        setBadge('✓', '#10b981')   // green check — all done
      } else {
        setBadge(String(unmappedCount), '#f59e0b')  // orange — unmapped remain
      }
      return { ok: true }
    }

    case 'MATCH_FIELDS': {
      const state = await loadState()
      if (!state?.payload) {
        console.log('[Unstract BG] MATCH_FIELDS: no payload in state')
        return { matches: [], unmapped: [] }
      }

      const tmConfig = await getTypeMatcherConfig()
      const lmConfig = await getLMStudioConfig()
      console.log(`[Unstract BG] MATCH_FIELDS: ${Object.keys(state.payload).length} keys, ${msg.fields.length} fields, typeMatcher=${tmConfig.enabled}/${tmConfig.baseUrl}`)

      // Primary matching: Type Matcher → LM Studio → BERT → TF-IDF
      let matches = await matchFields(state.payload, msg.fields, lmConfig, tmConfig)
      console.log(`[Unstract BG] matchFields returned ${matches.length} matches, ${matches.filter(m => m.auto).length} auto`)

      // If embedding returned no auto-fills and chat fallback is enabled, try Qwen3
      const autoCount = matches.filter(m => m.auto).length
      if (autoCount === 0 && lmConfig.enabled && lmConfig.useChatFallback) {
        const unmappedFields = msg.fields.filter(
          f => !matches.some(m => m.fieldId === f.selector && m.auto)
        )
        if (unmappedFields.length > 0) {
          console.log('[Unstract BG] No auto-fills from embedding — trying LM Studio chat')
          const chatMatches = await matchWithChat(state.payload, unmappedFields, lmConfig)
          const matchedSelectors = new Set(matches.map(m => m.fieldId))
          for (const cm of chatMatches) {
            if (!matchedSelectors.has(cm.fieldId)) matches.push(cm)
          }
        }
      }

      const autoKeys = new Set(matches.filter(m => m.auto).map(m => m.jsonKey))
      const unmapped = state.unmapped.filter(u => !autoKeys.has(u.key))

      state.matches = matches
      state.unmapped = unmapped
      await saveState(state)

      return { matches, unmapped }
    }

    case 'RANK_SUGGEST': {
      const state = await loadState()
      if (!state?.payload) return { suggestions: [] }
      const tmCfg = await getTypeMatcherConfig()
      const lmConfig = await getLMStudioConfig()
      const suggestions = await rankSuggestions(msg.fieldText, state.payload, 5, lmConfig, tmCfg)
      return { suggestions }
    }

    case 'FIELD_FILLED': {
      await removeUnmappedItem(msg.key)
      return { ok: true }
    }

    case 'GET_STATE': {
      const state = await loadState()
      return state ?? { payload: null, loadedAt: null, matches: [], unmapped: [] }
    }

    case 'CLEAR_STATE': {
      await clearState()
      clearBadge()
      return { ok: true }
    }

    // ── Type Matcher config ──────────────────────────────────────────────────

    case 'GET_TYPE_MATCHER_CONFIG':
      return getTypeMatcherConfig()

    case 'SET_TYPE_MATCHER_CONFIG': {
      const currentTm = await getTypeMatcherConfig()
      const updatedTm = { ...currentTm, ...msg.config }
      await chrome.storage.sync.set({ typeMatcherConfig: updatedTm })
      return { ok: true }
    }

    case 'TEST_TYPE_MATCHER':
      return testTypeMatcherConnection(msg.baseUrl)

    // ── LM Studio config ─────────────────────────────────────────────────────

    case 'GET_LMSTUDIO_CONFIG':
      return getLMStudioConfig()

    case 'SET_LMSTUDIO_CONFIG': {
      const current = await getLMStudioConfig()
      const updated = { ...current, ...msg.config }
      await chrome.storage.sync.set({ lmStudioConfig: updated })
      return { ok: true }
    }

    case 'TEST_LMSTUDIO':
      return testConnection(msg.baseUrl)

    // ── Cloud config ─────────────────────────────────────────────────────────

    case 'GET_CLOUD_CONFIG':
      return getCloudConfig()

    case 'SET_CLOUD_CONFIG': {
      await chrome.storage.sync.set({
        cloudProvider: msg.provider,
        cloudApiKey: msg.apiKey,
        cloudModel: msg.model ?? '',
      })
      return { ok: true }
    }

    // ── Template CRUD ─────────────────────────────────────────────────────

    case 'LIST_TEMPLATES':
      return { templates: await listTemplates() }

    case 'GET_TEMPLATE':
      return { template: await getTemplate(msg.templateId) }

    case 'SAVE_TEMPLATE': {
      const state = await loadState()
      const jsonKeySnapshot = state?.payload ? Object.keys(state.payload) : []
      const now = new Date().toISOString()
      const template: FormTemplate = {
        id: crypto.randomUUID(),
        name: msg.name,
        urlPattern: msg.urlPattern,
        capturedUrl: msg.capturedUrl,
        createdAt: now,
        lastUsedAt: now,
        useCount: 0,
        mappings: msg.mappings,
        jsonKeySnapshot,
      }
      await saveTemplate(template)
      return { ok: true, template }
    }

    case 'SAVE_TEMPLATE_FROM_CONTENT': {
      const state = await loadState()
      const jsonKeySnapshot = state?.payload ? Object.keys(state.payload) : []
      const now = new Date().toISOString()
      const template: FormTemplate = {
        id: crypto.randomUUID(),
        name: msg.name,
        urlPattern: deriveUrlPattern(msg.url),
        capturedUrl: msg.url,
        createdAt: now,
        lastUsedAt: now,
        useCount: 0,
        mappings: msg.mappings,
        jsonKeySnapshot,
      }
      await saveTemplate(template)
      return { ok: true, template }
    }

    case 'DELETE_TEMPLATE': {
      await deleteTemplate(msg.templateId)
      return { ok: true }
    }

    case 'GET_CAPTURED_MAPPINGS': {
      // Relay to active tab content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { mappings: [], url: '' }
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CAPTURED_MAPPINGS' })
        return result
      } catch {
        return { mappings: [], url: '' }
      }
    }

    case 'APPLY_TEMPLATE': {
      const template = await getTemplate(msg.templateId)
      if (!template) return { error: 'Template not found' }

      const state = await loadState()
      if (!state?.payload) return { error: 'No payload loaded' }

      // Compatibility check
      const currentKeys = new Set(Object.keys(state.payload))
      const templateKeys = template.jsonKeySnapshot
      const overlap = templateKeys.filter(k => currentKeys.has(k)).length
      const compatibility = templateKeys.length > 0
        ? overlap / templateKeys.length
        : 1

      // Send to active tab content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { error: 'No active tab' }

      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'APPLY_TEMPLATE_TO_PAGE',
          mappings: template.mappings,
          payload: state.payload,
        })

        // Update usage stats
        await updateTemplateUsage(msg.templateId)

        return { ...result, compatibility }
      } catch {
        return { error: 'Could not reach content script' }
      }
    }

    case 'FIND_MATCHING_TEMPLATES': {
      const templates = await findMatchingTemplates(msg.url)
      return { templates }
    }

    case 'EXPORT_TEMPLATES': {
      const templates = await listTemplates()
      return { templates }
    }

    case 'IMPORT_TEMPLATES': {
      for (const t of msg.templates) {
        await saveTemplate(t)
      }
      return { ok: true, count: msg.templates.length }
    }

    // Progress messages from content script — handled by popup listener, background ignores
    case 'FILL_PROGRESS':
      return { ok: true }

    default:
      return { error: 'Unknown message type' }
  }
}

// ─── Context menu handler ─────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'unstract-fill') return
  if (!tab?.id) return

  // Same logic as FILL_PAGE message
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FILL_NOW' })
  } catch {
    pendingFillTabId = tab.id
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })
    } catch {
      // Can't inject into this tab
    }
  }
})

// ─── Keyboard shortcut handler ───────────────────────────────────────────────

chrome.commands?.onCommand?.addListener(async (command) => {
  if (command === 'apply-template') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !tab.url) return

    const state = await loadState()
    if (!state?.payload) return

    // Find most recently used template for this URL
    const templates = await findMatchingTemplates(tab.url)
    if (templates.length === 0) return

    // Sort by lastUsedAt descending, pick most recent
    templates.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    const template = templates[0]

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'APPLY_TEMPLATE_TO_PAGE',
        mappings: template.mappings,
        payload: state.payload,
      })
      await updateTemplateUsage(template.id)
      setBadge('T', '#8b5cf6')  // purple badge for template apply
    } catch {
      // Content script not available
    }
  }
})

console.log('[Unstract BG] Service worker started')
