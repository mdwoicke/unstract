/**
 * Field value injector.
 * Sets values on form elements and dispatches native events so that React,
 * Vue, Angular, and other frameworks pick up the changes.
 */

export const AI_FILLED_ATTR = 'data-ai-filled'

/**
 * Inject a value into a form element and trigger framework reactivity.
 */
export function injectValue(
  selectorOrElement: string | HTMLElement,
  value: string | number | boolean | null
): boolean {
  const el = typeof selectorOrElement === 'string'
    ? (document.querySelector<HTMLElement>(selectorOrElement) ??
       findInShadow(document, selectorOrElement))
    : selectorOrElement

  if (!el) {
    console.warn('[Unstract] Element not found:', selectorOrElement)
    return false
  }

  const tag = el.tagName.toLowerCase()
  const strValue = value === null || value === undefined ? '' : String(value)
  const inputEl = el as HTMLInputElement
  const elType = inputEl.type?.toLowerCase() ?? tag

  let filled = false

  if (tag === 'select') {
    filled = injectSelect(el as HTMLSelectElement, strValue)
  } else if (tag === 'input') {
    if (inputEl.type === 'checkbox' || inputEl.type === 'radio') {
      filled = injectCheckable(inputEl, strValue)
    } else if (inputEl.type === 'date' || inputEl.type === 'datetime-local' || inputEl.type === 'month' || inputEl.type === 'week' || inputEl.type === 'time') {
      filled = injectDate(inputEl, strValue)
    } else if (inputEl.type === 'number') {
      filled = injectNumber(inputEl, strValue)
    } else {
      filled = injectText(inputEl, strValue)
    }
  } else if (tag === 'textarea') {
    filled = injectText(el as HTMLTextAreaElement, strValue)
  } else {
    console.warn(`[Unstract] Unsupported tag: ${tag}`)
    return false
  }

  if (!filled) {
    console.warn(`[Unstract] Inject returned false: tag=${tag} type=${elType} strValue="${strValue}" (len=${strValue.length})`)
  }

  // Only highlight if value was actually set
  if (filled) {
    el.setAttribute(AI_FILLED_ATTR, 'true')
  }
  return filled
}

function injectText(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  if (!value) return false

  // React uses a property descriptor to intercept assignments
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el), 'value'
  )?.set

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value)
  } else {
    el.value = value
  }

  dispatchEvents(el)
  return true
}

/**
 * Normalize a date string to YYYY-MM-DD format required by <input type="date">.
 * Handles common formats: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, Month DD YYYY, etc.
 */
function normalizeDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null

  // Already YYYY-MM-DD
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso) {
    const [, y, m, d] = iso
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // MM/DD/YYYY or MM-DD-YYYY (4-digit year)
  const mdy4 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (mdy4) {
    const [, m, d, y] = mdy4
    // If first number > 12, it's DD/MM/YYYY
    if (Number(m) > 12) return `${y}-${d.padStart(2, '0')}-${m.padStart(2, '0')}`
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // MM/DD/YY or MM-DD-YY (2-digit year)
  const mdy2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/)
  if (mdy2) {
    const [, m, d, yy] = mdy2
    const y = Number(yy) > 50 ? `19${yy}` : `20${yy}`
    if (Number(m) > 12) return `${y}-${d.padStart(2, '0')}-${m.padStart(2, '0')}`
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // "Month DD, YYYY" or "DD Month YYYY"
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  }
  const named = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i)
  if (named) {
    const m = months[named[1].toLowerCase()]
    if (m) return `${named[3]}-${m}-${named[2].padStart(2, '0')}`
  }
  const namedRev = s.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i)
  if (namedRev) {
    const m = months[namedRev[2].toLowerCase()]
    if (m) return `${namedRev[3]}-${m}-${namedRev[1].padStart(2, '0')}`
  }

  // Try native Date parsing as last resort
  const d = new Date(s)
  if (!isNaN(d.getTime()) && d.getFullYear() > 1900) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  return null
}

function injectDate(el: HTMLInputElement, value: string): boolean {
  const normalized = normalizeDate(value)
  if (!normalized) {
    console.warn('[Unstract] Could not normalize date value:', value)
    return false
  }

  // Date inputs require exact YYYY-MM-DD format via valueAsDate or value setter
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  )?.set

  if (nativeSetter) {
    nativeSetter.call(el, normalized)
  } else {
    el.value = normalized
  }

  dispatchEvents(el)
  return el.value === normalized
}

function injectNumber(el: HTMLInputElement, value: string): boolean {
  // Strip currency symbols, commas, whitespace
  const cleaned = value.replace(/[$€£¥₱,\s]/g, '').trim()
  if (!cleaned || isNaN(Number(cleaned))) {
    // Try extracting just the number
    const match = cleaned.match(/[\-+]?\d[\d.]*/)
    if (!match) return false
    return injectText(el, match[0])
  }
  return injectText(el, cleaned)
}

function injectSelect(el: HTMLSelectElement, value: string): boolean {
  const lower = value.toLowerCase().trim()
  // Normalize: strip underscores/hyphens for comparison
  const normalized = lower.replace(/[_-]/g, ' ')

  // 1. Exact value match
  for (const o of el.options) {
    if (o.value === value) {
      el.value = o.value
      dispatchEvents(el)
      return true
    }
  }

  // 2. Case-insensitive value match (handles "PH" vs "ph")
  for (const o of el.options) {
    if (o.value.toLowerCase() === lower) {
      el.value = o.value
      dispatchEvents(el)
      return true
    }
  }

  // 3. Exact text match
  for (const o of el.options) {
    if (o.text.toLowerCase().trim() === lower || o.text.toLowerCase().trim() === normalized) {
      el.value = o.value
      dispatchEvents(el)
      return true
    }
  }

  // 4. Normalized value match (e.g., "self_employed" matches option value "self_employed")
  for (const o of el.options) {
    const optNorm = o.value.toLowerCase().replace(/[_-]/g, ' ')
    if (optNorm === normalized) {
      el.value = o.value
      dispatchEvents(el)
      return true
    }
  }

  // 5. Fuzzy: substring match (skip empty/placeholder options)
  for (const o of el.options) {
    if (!o.value) continue // skip "Select..." placeholder
    const optText = o.text.toLowerCase().trim()
    if (optText.includes(lower) || lower.includes(optText)) {
      el.value = o.value
      dispatchEvents(el)
      return true
    }
  }

  return false
}

function injectCheckable(el: HTMLInputElement, value: string): boolean {
  if (el.type === 'radio') {
    return injectRadio(el, value)
  }
  // Checkbox: check based on truthy/falsy value
  const truthy = ['true', '1', 'yes', 'on', 'checked'].includes(value.toLowerCase())
  el.checked = truthy
  dispatchEvents(el)
  return truthy // only "filled" if we're checking it
}

/**
 * Inject a value into a radio group by finding the matching option.
 * The element is the first radio in the group (from querySelector).
 * We search all radios with the same name and check the one whose value matches.
 */
function injectRadio(el: HTMLInputElement, value: string): boolean {
  const name = el.name
  if (!name) return false

  const lower = value.toLowerCase().trim()

  // Find all radio buttons in this group
  const radios = document.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${CSS.escape(name)}"]`
  )

  // Try exact value match first
  for (const radio of radios) {
    if (radio.value.toLowerCase() === lower) {
      radio.checked = true
      dispatchEvents(radio)
      radio.setAttribute(AI_FILLED_ATTR, 'true')
      return true
    }
  }

  // Try matching against the label text (fuzzy)
  for (const radio of radios) {
    const label = _findRadioLabel(radio)
    if (label && label.toLowerCase().includes(lower)) {
      radio.checked = true
      dispatchEvents(radio)
      radio.setAttribute(AI_FILLED_ATTR, 'true')
      return true
    }
    // Also check if value includes the label
    if (label && lower.includes(label.toLowerCase())) {
      radio.checked = true
      dispatchEvents(radio)
      radio.setAttribute(AI_FILLED_ATTR, 'true')
      return true
    }
  }

  return false
}

/** Find the visible label text for a radio/checkbox element. */
function _findRadioLabel(el: HTMLInputElement): string {
  // Check ancestor <label>
  let parent = el.parentElement
  while (parent) {
    if (parent.tagName.toLowerCase() === 'label') {
      const clone = parent.cloneNode(true) as HTMLElement
      clone.querySelectorAll('input').forEach(c => c.remove())
      return clone.textContent?.trim() ?? ''
    }
    parent = parent.parentElement
  }
  // Check next sibling text
  const next = el.nextSibling
  if (next?.nodeType === Node.TEXT_NODE) {
    return next.textContent?.trim() ?? ''
  }
  return ''
}

function dispatchEvents(el: HTMLElement) {
  // Dispatch the same sequence browsers fire on user input
  for (const eventType of ['input', 'change', 'blur']) {
    el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }))
  }
}

/** Recursively search Shadow DOM for a selector. */
function findInShadow(root: Document | Element, selector: string): HTMLElement | null {
  try {
    const el = (root as Document | Element).querySelector<HTMLElement>(selector)
    if (el) return el
  } catch { /* invalid selector, skip */ }

  const all = root.querySelectorAll('*')
  for (const host of all) {
    if ((host as HTMLElement).shadowRoot) {
      const found = findInShadow((host as HTMLElement).shadowRoot!, selector)
      if (found) return found
    }
  }
  return null
}

/**
 * Remove the gold highlight from all AI-filled elements.
 */
export function clearHighlights(): void {
  document.querySelectorAll(`[${AI_FILLED_ATTR}]`).forEach((el) => {
    el.removeAttribute(AI_FILLED_ATTR)
  })
}

/**
 * Inject the gold-border CSS for highlighted fields into the page.
 * Uses a unique id to avoid double-injection.
 */
export function injectHighlightStyles(): void {
  const STYLE_ID = 'unstract-highlight-styles'
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    [${AI_FILLED_ATTR}="true"] {
      outline: 2px solid #f59e0b !important;
      outline-offset: 1px !important;
      background-color: rgba(245, 158, 11, 0.06) !important;
      transition: outline 0.2s ease !important;
    }
  `
  document.head.appendChild(style)
}
