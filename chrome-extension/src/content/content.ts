/**
 * Content script — injected into every page.
 *
 * Dual role:
 * 1. On the Unstract test UI page: listens for CustomEvent from the page
 *    and relays the JSON payload to the background service worker.
 * 2. On any form page: extracts fields, requests AI matching, injects values,
 *    and manages the overlay React UI for unmapped fields.
 *
 * Fill is triggered explicitly via FILL_NOW message from the popup,
 * NOT automatically on page load. This gives the user full control.
 */

import { extractFields, watchForChanges, stopWatching } from './dom-extractor'
import { injectValue, injectHighlightStyles } from './field-injector'
import { ShadowHost } from '../ui/shadow-host'
import { ProgressBar } from '../ui/progress-bar'
import { TemplateToast } from '../ui/template-toast'
import { resolveAllMappings } from './template-matcher'
import { toFriendlyName } from '../store/state'
import type { UnmappedItem, ExtensionState, FieldDescriptor } from '../store/state'
import type { TemplateFieldMapping } from '../store/template'

// ─── Debug: confirm content script injection ─────────────────────────────────
console.log('[Unstract] Content script injected on:', location.href)
// Visible debug marker (detectable from main world)
document.documentElement.setAttribute('data-unstract-loaded', Date.now().toString())

/** Returns false if the extension was reloaded and this script is orphaned. */
function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

// ─── Double-init guard ────────────────────────────────────────────────────────
// Prevents duplicate initialization when re-injected via chrome.scripting.executeScript.
// If the previous script's context is invalid (extension was reloaded), re-run setup.

if ((self as any).__unstractLoaded && isContextValid()) {
  // Already running on this page with a valid context — just notify background
  // so the FILL_NOW message can be sent immediately after inject
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {})
} else {
  (self as any).__unstractLoaded = true
  setup()
}

function setup() {
  // ─── State ──────────────────────────────────────────────────────────────────

  let shadowHost: ShadowHost | null = null
  let progressBar: ProgressBar | null = null
  let templateToast: TemplateToast | null = null
  let unmappedItems: UnmappedItem[] = []
  let focusedField: FieldDescriptor | null = null
  let allFields: FieldDescriptor[] = []
  let autoFilledSet: Set<string> = new Set()
  let capturedMappings: Map<string, TemplateFieldMapping> = new Map()
  let processing = false   // concurrent-safe, allows re-trigger

  // ─── Relay: Unstract test UI → background ──────────────────────────────────

  window.addEventListener('unstract:fillForm', async (e: Event) => {
    document.documentElement.setAttribute('data-unstract-event', 'fillForm-received')
    const detail = (e as CustomEvent<{ payload: Record<string, unknown> }>).detail
    if (!detail?.payload) {
      document.documentElement.setAttribute('data-unstract-event', 'fillForm-no-payload')
      return
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LOAD_JSON',
        payload: detail.payload,
      })
      console.log('[Unstract] Payload sent to extension:', response)
      document.documentElement.setAttribute('data-unstract-event', 'fillForm-sent:' + JSON.stringify(response))
    } catch (err) {
      console.error('[Unstract] Failed to relay payload to extension:', err)
      document.documentElement.setAttribute('data-unstract-event', 'fillForm-error:' + String(err))
    }
  })

  // ─── Background → content messages ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FILL_NOW') {
      handleFill()
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: String(err) }))
      return true
    }

    if (msg.type === 'GET_CAPTURED_MAPPINGS') {
      sendResponse({
        mappings: Array.from(capturedMappings.values()),
        url: location.href,
      })
      return false
    }

    if (msg.type === 'APPLY_TEMPLATE_TO_PAGE') {
      handleApplyTemplate(msg.mappings, msg.payload)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: String(err) }))
      return true
    }
  })

  // ─── Main fill flow ──────────────────────────────────────────────────────────

  async function handleFill() {
    document.documentElement.setAttribute('data-unstract-fill', 'started')
    if (!isContextValid()) {
      document.documentElement.setAttribute('data-unstract-fill', 'context-invalid')
      return { error: 'Extension context invalidated' }
    }
    if (processing) {
      document.documentElement.setAttribute('data-unstract-fill', 'already-processing')
      return { skipped: true }
    }
    processing = true

    // Show progress bar
    if (!progressBar) progressBar = new ProgressBar()
    progressBar.update(5, 'Scanning form fields\u2026')
    chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'scanning', text: 'Scanning form fields\u2026', percent: 5 }).catch(() => {})

    try {
      const state: ExtensionState = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
      if (!state?.payload) {
        document.documentElement.setAttribute('data-unstract-fill', 'no-payload')
        progressBar.error('No data loaded — open the popup to load JSON first')
        chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'error', text: 'No data loaded', percent: 0 }).catch(() => {})
        return { error: 'No payload loaded' }
      }

      injectHighlightStyles()
      progressBar.update(10, 'Scanning form fields\u2026')

      let fields = extractFields()

      if (fields.length === 0) {
        progressBar.update(-1, 'Waiting for form to load\u2026')
        // Wait for dynamically loaded form
        await new Promise<void>((resolve) => {
          watchForChanges(() => {
            fields = extractFields()
            if (fields.length > 0) {
              stopWatching()
              resolve()
            }
          })
          // Timeout after 5s if form never appears
          setTimeout(() => { stopWatching(); resolve() }, 5000)
        })
      }

      if (fields.length === 0) {
        progressBar.error('No form fields found on this page')
        return { error: 'No form fields found on this page' }
      }

      progressBar.update(20, `Found ${fields.length} fields — matching with AI\u2026`)
      chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'matching', text: `Matching ${fields.length} fields with AI\u2026`, percent: 20 }).catch(() => {})
      return await runMatching(fields)
    } catch (err) {
      progressBar?.error('Fill failed — see console for details')
      throw err
    } finally {
      processing = false
    }
  }

  async function runMatching(fields: FieldDescriptor[]) {
    console.log(`[Unstract] Sending MATCH_FIELDS with ${fields.length} fields`)
    progressBar?.update(30, `Matching ${fields.length} fields with AI\u2026`)

    const result: { matches: ExtensionState['matches']; unmapped: UnmappedItem[] } =
      await chrome.runtime.sendMessage({ type: 'MATCH_FIELDS', fields })

    if (!result) {
      console.warn('[Unstract] MATCH_FIELDS returned null/undefined')
      progressBar?.error('Matching failed — no results returned')
      return { filledCount: 0, unmappedCount: 0 }
    }

    console.log(`[Unstract] MATCH_FIELDS returned: ${result.matches.length} matches, ${result.unmapped.length} unmapped`)
    // Log top matches for debugging
    const autoMatches = result.matches.filter(m => m.auto)
    const topMatches = result.matches.slice(0, 5)
    console.log(`[Unstract] Auto matches: ${autoMatches.length}, top scores:`, topMatches.map(m => `${m.fieldId}←${m.jsonKey}(${m.confidence},auto=${m.auto})`))

    // Collect fillable matches (skip empty/null values)
    const fillable = autoMatches.filter(m => {
      const v = m.jsonValue
      if (v === null || v === undefined) return false
      if (typeof v === 'string' && v.trim() === '') return false
      return true
    })

    progressBar?.update(75, 'Filling matched fields\u2026', `0 / ${fillable.length}`)

    // Auto-fill with per-field progress
    capturedMappings.clear()
    let filledCount = 0
    for (let i = 0; i < fillable.length; i++) {
      const match = fillable[i]
      const v = match.jsonValue
      console.log(`[Unstract] Injecting: selector="${match.fieldId}" value="${v}" (${typeof v})`)

      // Update progress bar + popup for each field
      const pct = 60 + Math.round(((i + 1) / fillable.length) * 35)
      progressBar?.update(pct, 'Filling matched fields\u2026', `${i + 1} / ${fillable.length}`)
      chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'filling', text: `Filling field ${i + 1} of ${fillable.length}\u2026`, percent: pct, current: i + 1, total: fillable.length }).catch(() => {})

      const ok = injectValue(match.fieldId, v)
      if (!ok) console.warn(`[Unstract] FAILED to inject: selector="${match.fieldId}" value="${v}"`)
      if (ok) {
        filledCount++
        // Capture mapping for template save
        const fd = fields.find(f => f.selector === match.fieldId)
        capturedMappings.set(match.fieldId, {
          selector: match.fieldId,
          fieldId: fd?.id ?? '', fieldName: fd?.name ?? '',
          fieldLabel: fd?.label ?? '', fieldType: fd?.type ?? '',
          jsonKey: match.jsonKey, source: 'auto', confidence: match.confidence,
        })
      }

      // Brief yield so the browser can paint the field flash animation
      if (fillable.length > 3 && i < fillable.length - 1) {
        await new Promise(r => setTimeout(r, 40))
      }
    }

    console.log(`[Unstract] Auto-filled ${filledCount} fields, ${result.unmapped.length} unmapped`)
    document.documentElement.setAttribute('data-unstract-fill', `done:filled=${filledCount},unmapped=${result.unmapped.length}`)

    unmappedItems = result.unmapped
    allFields = fields
    autoFilledSet = new Set(
      result.matches.filter(m => m.auto).map(m => m.fieldId)
    )

    // Notify background of fill completion for badge update
    await chrome.runtime.sendMessage({
      type: 'FILL_DONE',
      filledCount,
      unmappedCount: result.unmapped.length,
    }).catch(() => {})

    if (unmappedItems.length === 0) {
      progressBar?.complete(`Done — filled ${filledCount} fields`)
      chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'done', text: `Filled ${filledCount} fields`, percent: 100 }).catch(() => {})
      showTemplateSaveToast(filledCount)
      return { filledCount, unmappedCount: 0 }
    }

    progressBar?.complete(
      `Filled ${filledCount} fields, ${unmappedItems.length} need manual review`,
      3500,
    )
    chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', step: 'done', text: `Filled ${filledCount} fields, ${unmappedItems.length} need review`, percent: 100 }).catch(() => {})
    showTemplateSaveToast(filledCount)

    // Mount overlay and attach focus listeners to UN-filled fields only
    mountOverlay()
    attachFocusListeners(fields, [...autoFilledSet])

    return { filledCount, unmappedCount: unmappedItems.length }
  }

  // ─── Overlay management ─────────────────────────────────────────────────────

  function mountOverlay() {
    if (!shadowHost) {
      shadowHost = new ShadowHost()
    }
  }

  function attachFocusListeners(
    fields: FieldDescriptor[],
    autoFilledSelectors: string[]
  ) {
    const autoFilled = new Set(autoFilledSelectors)

    for (const field of fields) {
      if (autoFilled.has(field.selector)) continue  // already auto-filled

      const el = document.querySelector<HTMLElement>(field.selector)
      if (!el) continue

      el.addEventListener('focus', () => onFieldFocus(field, el), { passive: true })
    }

    // Close overlay when clicking outside
    document.addEventListener('click', (e) => {
      if (!shadowHost?.isVisible) return
      const target = e.target as Node
      if ((shadowHost as any).host?.contains(target)) return
      shadowHost?.hide()
    }, { passive: true })
  }

  /** Build a display label for the focused form field. */
  function getFieldLabel(field: FieldDescriptor): string {
    return field.label || field.placeholder || field.name || field.id || ''
  }

  async function onFieldFocus(field: FieldDescriptor, el: HTMLElement) {
    if (!isContextValid()) return  // extension reloaded — bail silently
    if (!shadowHost || unmappedItems.length === 0) return

    focusedField = field

    const { suggestions } = await chrome.runtime.sendMessage({
      type: 'RANK_SUGGEST',
      fieldText: field.context,
    }).catch(() => ({ suggestions: [] }))

    const rect = el.getBoundingClientRect()

    shadowHost.show({
      unmapped: unmappedItems,
      suggestions: suggestions ?? [],
      anchorRect: rect,
      fieldLabel: getFieldLabel(field),
      onSelect: (item) => handleSelect(item, el),
      onTab: (item) => handleTab(item, el),
      onClose: () => shadowHost?.hide(),
    })
  }

  /**
   * Find the next unfilled form field after the given selector in DOM order.
   */
  function findNextUnfilledField(currentSelector: string): { field: FieldDescriptor; el: HTMLElement } | null {
    const currentIdx = allFields.findIndex(f => f.selector === currentSelector)
    if (currentIdx === -1) return null

    for (let i = currentIdx + 1; i < allFields.length; i++) {
      const f = allFields[i]
      if (autoFilledSet.has(f.selector)) continue
      const el = document.querySelector<HTMLElement>(f.selector)
      if (el) return { field: f, el }
    }
    // Wrap around from the beginning
    for (let i = 0; i < currentIdx; i++) {
      const f = allFields[i]
      if (autoFilledSet.has(f.selector)) continue
      const el = document.querySelector<HTMLElement>(f.selector)
      if (el) return { field: f, el }
    }
    return null
  }

  async function handleSelect(item: UnmappedItem, targetEl: HTMLElement) {
    if (!isContextValid()) return
    const mappingLabel = `${toFriendlyName(item.key)} \u2192 ${getFieldLabel(focusedField!)}`
    await fillAndUpdateState(item, targetEl)

    if (unmappedItems.length === 0) {
      shadowHost?.hide()
      await chrome.runtime.sendMessage({
        type: 'FILL_DONE',
        filledCount: -1,
        unmappedCount: 0,
      }).catch(() => {})
    } else if (focusedField && shadowHost?.isVisible) {
      // Refresh overlay on the same field
      const el = document.querySelector<HTMLElement>(focusedField.selector)
      if (el) {
        const { suggestions } = await chrome.runtime.sendMessage({
          type: 'RANK_SUGGEST',
          fieldText: focusedField.context,
        }).catch(() => ({ suggestions: [] }))

        shadowHost.show({
          unmapped: unmappedItems,
          suggestions: suggestions ?? [],
          anchorRect: el.getBoundingClientRect(),
          fieldLabel: getFieldLabel(focusedField!),
          lastMapping: mappingLabel,
          onSelect: (i) => handleSelect(i, el),
          onTab: (i) => handleTab(i, el),
          onClose: () => shadowHost?.hide(),
        })
      }
    }
  }

  async function handleTab(item: UnmappedItem, targetEl: HTMLElement) {
    if (!isContextValid()) return
    await fillAndUpdateState(item, targetEl)
    // Mark this field as filled so we skip it when tabbing
    if (focusedField) autoFilledSet.add(focusedField.selector)

    shadowHost?.hide()

    if (unmappedItems.length === 0) {
      await chrome.runtime.sendMessage({
        type: 'FILL_DONE',
        filledCount: -1,
        unmappedCount: 0,
      }).catch(() => {})
      return
    }

    // Focus the next unfilled field — this triggers onFieldFocus → new overlay
    const currentSelector = focusedField?.selector ?? targetEl.getAttribute('data-selector') ?? ''
    const next = findNextUnfilledField(currentSelector)
    if (next) {
      next.el.focus()
    }
  }

  async function fillAndUpdateState(item: UnmappedItem, targetEl: HTMLElement) {
    injectValue(targetEl, item.value)
    unmappedItems = unmappedItems.filter((u) => u.key !== item.key)

    // Capture manual mapping for template save
    if (focusedField) {
      capturedMappings.set(focusedField.selector, {
        selector: focusedField.selector,
        fieldId: focusedField.id, fieldName: focusedField.name,
        fieldLabel: focusedField.label, fieldType: focusedField.type,
        jsonKey: item.key, source: 'manual', confidence: 1.0,
      })
    }

    await chrome.runtime.sendMessage({ type: 'FIELD_FILLED', key: item.key }).catch(() => {})
  }

  // ─── Template save toast ────────────────────────────────────────────────────

  function showTemplateSaveToast(filledCount: number) {
    if (filledCount <= 0 || capturedMappings.size === 0) return

    templateToast = new TemplateToast()
    templateToast.show(filledCount, (name: string) => {
      chrome.runtime.sendMessage({
        type: 'SAVE_TEMPLATE_FROM_CONTENT',
        name,
        url: location.href,
        mappings: Array.from(capturedMappings.values()),
      }).catch(err => console.error('[Unstract] Failed to save template:', err))
    })
  }

  // ─── Template apply (from background relay) ────────────────────────────────

  async function handleApplyTemplate(
    mappings: TemplateFieldMapping[],
    payload: Record<string, string | number | boolean | null>
  ) {
    injectHighlightStyles()

    let fields = extractFields()
    if (fields.length === 0) {
      return { filledCount: 0, error: 'No form fields found' }
    }

    // Resolve template mappings to current page fields
    const resolved = resolveAllMappings(mappings, fields)
    let filledCount = 0

    for (const { mapping, field } of resolved) {
      const value = payload[mapping.jsonKey]
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && value.trim() === '') continue

      const ok = injectValue(field.selector, value)
      if (ok) {
        filledCount++
        // Update captured mappings with applied template data
        capturedMappings.set(field.selector, {
          ...mapping,
          selector: field.selector,
          fieldId: field.id,
          fieldName: field.name,
          fieldLabel: field.label,
          fieldType: field.type,
        })
      }
    }

    console.log(`[Unstract] Template applied: ${filledCount}/${resolved.length} fields filled`)

    // Update badge
    await chrome.runtime.sendMessage({
      type: 'FILL_DONE',
      filledCount,
      unmappedCount: 0,
    }).catch(() => {})

    return { filledCount, totalMappings: mappings.length, resolvedCount: resolved.length }
  }
}
