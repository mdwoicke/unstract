/**
 * Recursive DOM field extractor.
 * Traverses Shadow DOM boundaries and extracts a FieldDescriptor for every
 * interactive form element on the page.
 */

import type { FieldDescriptor } from '../store/state'

const FIELD_TYPES = new Set(['text', 'email', 'tel', 'number', 'date', 'url',
  'search', 'password', 'select-one', 'select-multiple', 'textarea',
  'checkbox', 'radio', 'time', 'month', 'week', 'datetime-local'])

let _observer: MutationObserver | null = null
let _onUpdate: (() => void) | null = null

/**
 * Extract all form fields from the document, including Shadow DOM hosts.
 */
export function extractFields(root: Document | ShadowRoot = document): FieldDescriptor[] {
  const results: FieldDescriptor[] = []
  _collectFields(root, results)
  return results
}

function _collectFields(root: Document | ShadowRoot, out: FieldDescriptor[]) {
  const inputs = root.querySelectorAll<HTMLElement>(
    'input, select, textarea'
  )

  // Track radio/checkbox groups to avoid duplicates
  const seenGroups = new Set<string>()

  for (const el of inputs) {
    const inputEl = el as HTMLInputElement
    const elType = inputEl.type?.toLowerCase()

    // Deduplicate radio/checkbox groups: emit ONE field per name group
    if (elType === 'radio' || elType === 'checkbox') {
      const name = inputEl.name
      if (!name) continue
      const groupKey = `${elType}:${name}`
      if (seenGroups.has(groupKey)) continue
      seenGroups.add(groupKey)

      const desc = _describeGroup(root, inputEl, elType)
      if (desc) out.push(desc)
      continue
    }

    const desc = _describeElement(el)
    if (desc) out.push(desc)
  }

  // Recurse into Shadow DOM
  const allElements = root.querySelectorAll('*')
  for (const el of allElements) {
    if ((el as HTMLElement).shadowRoot) {
      _collectFields((el as HTMLElement).shadowRoot!, out)
    }
  }
}

/**
 * Build a single FieldDescriptor for a radio or checkbox group.
 * Collects all option values and labels from the group.
 */
function _describeGroup(
  root: Document | ShadowRoot,
  firstEl: HTMLInputElement,
  type: string,
): FieldDescriptor | null {
  const name = firstEl.name
  const allInGroup = root.querySelectorAll<HTMLInputElement>(
    `input[type="${type}"][name="${CSS.escape(name)}"]`
  )

  // Collect option values and labels
  const options: string[] = []
  const optionLabels: string[] = []
  for (const el of allInGroup) {
    options.push(el.value)
    const lbl = _findLabel(el)
    if (lbl) optionLabels.push(lbl)
  }

  // Find the group-level label (often a <label for="name"> or preceding element)
  let groupLabel = ''
  // Check for <label for="name"> pointing to the group name
  const labelFor = root.querySelector(`label[for="${CSS.escape(name)}"]`)
  if (labelFor) {
    groupLabel = labelFor.textContent?.trim() ?? ''
  }
  // If no group label found, look for a preceding label/heading before the group
  if (!groupLabel) {
    const parent = firstEl.closest('.field, .form-group, fieldset, .radio-group, .checkbox-group')
    if (parent) {
      const prev = parent.previousElementSibling
      if (prev?.tagName.toLowerCase() === 'label') {
        groupLabel = prev.textContent?.trim() ?? ''
      }
    }
  }
  // Fall back to a cleaned version of the name attribute
  if (!groupLabel && optionLabels.length > 0) {
    // Use the name as label, humanized
    groupLabel = name.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  }

  const id = firstEl.id || ''
  const selector = `input[name="${CSS.escape(name)}"]`
  const context = [groupLabel, name, ...optionLabels]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!groupLabel && !name) return null

  return {
    id,
    name,
    label: groupLabel,
    placeholder: '',
    type,
    context,
    selector,
    options,
  } as FieldDescriptor
}

function _describeElement(el: HTMLElement): FieldDescriptor | null {
  const tag = el.tagName.toLowerCase()
  const inputEl = el as HTMLInputElement

  // Determine type
  let type: string
  if (tag === 'textarea') {
    type = 'textarea'
  } else if (tag === 'select') {
    type = 'select'
  } else {
    type = inputEl.type?.toLowerCase() ?? 'text'
  }

  if (!FIELD_TYPES.has(type)) return null

  // Skip hidden inputs
  if (type === 'hidden') return null

  // Skip disabled/readonly if they have no value potential
  const id = inputEl.id || ''
  const name = inputEl.name || ''

  // Find associated label text
  const label = _findLabel(el)
  const placeholder = (el as HTMLInputElement).placeholder || ''

  if (!id && !name && !label && !placeholder) return null

  const context = [label, name, placeholder, id]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  const selector = _buildSelector(el)

  // Collect options for select elements
  let options: string[] | undefined
  if (tag === 'select') {
    options = Array.from((el as HTMLSelectElement).options)
      .filter(o => o.value) // skip empty/placeholder options
      .map(o => o.text.trim())
  }

  const result: FieldDescriptor = {
    id,
    name,
    label,
    placeholder,
    type,
    context,
    selector,
  }
  if (options) result.options = options
  return result
}

function _findLabel(el: HTMLElement): string {
  // 1. aria-label attribute
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return ariaLabel.trim()

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const labeller = document.getElementById(labelledBy)
    if (labeller) return labeller.textContent?.trim() ?? ''
  }

  // 3. <label for="...">
  const elId = el.id
  if (elId) {
    const label = document.querySelector(`label[for="${CSS.escape(elId)}"]`)
    if (label) return label.textContent?.trim() ?? ''
  }

  // 4. Ancestor <label>
  let parent = el.parentElement
  while (parent) {
    if (parent.tagName.toLowerCase() === 'label') {
      // Return text content minus the input's own value
      const clone = parent.cloneNode(true) as HTMLElement
      clone.querySelectorAll('input, select, textarea').forEach(c => c.remove())
      const text = clone.textContent?.trim() ?? ''
      if (text) return text
    }
    parent = parent.parentElement
  }

  // 5. Preceding sibling text / label element
  const prev = el.previousElementSibling
  if (prev) {
    const tag = prev.tagName.toLowerCase()
    if (tag === 'label' || tag === 'span' || tag === 'p' || tag === 'div') {
      const text = prev.textContent?.trim() ?? ''
      if (text.length < 80) return text
    }
  }

  // 6. title attribute
  const title = el.getAttribute('title')
  if (title) return title.trim()

  return ''
}

/**
 * Build a CSS selector robust enough to re-locate the element after
 * the FieldDescriptor has been serialised and sent across messaging.
 */
function _buildSelector(el: HTMLElement): string {
  if (el.id) {
    return `#${CSS.escape(el.id)}`
  }
  if ((el as HTMLInputElement).name) {
    const tag = el.tagName.toLowerCase()
    const name = (el as HTMLInputElement).name
    return `${tag}[name="${name}"]`
  }
  // Fallback: positional selector
  return _buildPositionalSelector(el)
}

function _buildPositionalSelector(el: HTMLElement): string {
  const parts: string[] = []
  let current: HTMLElement | null = el

  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase()
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName.toLowerCase() === tag
      )
      const index = siblings.indexOf(current) + 1
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
    } else {
      parts.unshift(tag)
    }
    current = current.parentElement
  }

  return parts.join(' > ')
}

/**
 * Install a MutationObserver that re-runs extraction when the DOM changes
 * (handles dynamic / SPA forms that render after page load).
 */
export function watchForChanges(callback: () => void): void {
  _onUpdate = callback
  if (_observer) _observer.disconnect()

  _observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) =>
      m.addedNodes.length > 0 ||
      (m.type === 'attributes' && ['type', 'name', 'id', 'aria-label'].includes(m.attributeName ?? ''))
    )
    if (relevant) {
      // Debounce
      setTimeout(() => _onUpdate?.(), 300)
    }
  })

  _observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'name', 'id', 'aria-label', 'placeholder'],
  })
}

export function stopWatching(): void {
  _observer?.disconnect()
  _observer = null
  _onUpdate = null
}
