/**
 * Field icon badges — small circular indicators on every form field.
 *
 * Uses its own Shadow DOM host (separate from overlay / progress bar) so
 * badges are visually isolated from the host page. A single fixed container
 * holds all badges; only the badges themselves receive pointer events.
 *
 * Filled fields get a green checkmark; unfilled fields get an amber pencil.
 * Clicking a badge focuses the field and opens the data mapping overlay.
 */

import type { FieldDescriptor } from '../store/state'

const HOST_ID = 'unstract-badge-host'

const CSS = `
:host{all:initial}
.badge{
  position:fixed;width:18px;height:18px;border-radius:50%;
  cursor:pointer;pointer-events:all;
  display:flex;align-items:center;justify-content:center;
  font-size:10px;line-height:1;
  box-shadow:0 1px 4px rgba(0,0,0,.18);
  transition:transform .12s,box-shadow .12s;
  z-index:2147483646;
  user-select:none;
}
.badge:hover{transform:scale(1.2);box-shadow:0 2px 8px rgba(0,0,0,.25)}
.badge.filled{background:#10b981;color:#fff}
.badge.unfilled{background:#f59e0b;color:#fff}
`

interface BadgeEntry {
  el: HTMLElement
  fieldEl: HTMLElement
  field: FieldDescriptor
  filled: boolean
}

export type BadgeClickHandler = (
  field: FieldDescriptor,
  el: HTMLElement,
  isFilled: boolean,
) => void

export class FieldBadgeManager {
  private host: HTMLElement
  private shadow: ShadowRoot
  private badges: BadgeEntry[] = []
  private rafId = 0
  private onClick: BadgeClickHandler | null = null

  // Bound listeners for cleanup
  private onScroll: () => void
  private onResize: () => void

  constructor() {
    // Remove stale instance
    document.getElementById(HOST_ID)?.remove()

    this.host = document.createElement('div')
    this.host.id = HOST_ID
    Object.assign(this.host.style, {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      overflow: 'visible', zIndex: '2147483646', pointerEvents: 'none',
    })

    this.shadow = this.host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = CSS
    this.shadow.appendChild(style)

    document.body.appendChild(this.host)

    // Bind scroll/resize handlers
    this.onScroll = () => this.scheduleReposition()
    this.onResize = () => this.scheduleReposition()
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    window.addEventListener('resize', this.onResize, { passive: true })
  }

  /**
   * Create badges for all form fields.
   * @param fields        All discovered form fields
   * @param filledSelectors  Set of selectors that were auto-filled
   * @param onClick       Callback when a badge is clicked
   */
  mount(
    fields: FieldDescriptor[],
    filledSelectors: Set<string>,
    onClick: BadgeClickHandler,
  ) {
    this.onClick = onClick
    // Clear any existing badges
    this.clearBadges()

    for (const field of fields) {
      const fieldEl = document.querySelector<HTMLElement>(field.selector)
      if (!fieldEl) continue

      const filled = filledSelectors.has(field.selector)
      const badge = document.createElement('div')
      badge.className = `badge ${filled ? 'filled' : 'unfilled'}`
      badge.textContent = filled ? '\u2713' : '\u270E'
      badge.setAttribute('data-field-selector', field.selector)

      // Position from field rect
      const rect = fieldEl.getBoundingClientRect()
      badge.style.left = `${rect.right - 22}px`
      badge.style.top = `${rect.top + 2}px`

      badge.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        const entry = this.badges.find(b => b.el === badge)
        if (entry && this.onClick) {
          this.onClick(entry.field, entry.fieldEl, entry.filled)
        }
      })

      this.shadow.appendChild(badge)
      this.badges.push({ el: badge, fieldEl, field, filled })
    }
  }

  /** Recalculate all badge positions from their field elements. */
  updatePositions() {
    for (const entry of this.badges) {
      const rect = entry.fieldEl.getBoundingClientRect()
      entry.el.style.left = `${rect.right - 22}px`
      entry.el.style.top = `${rect.top + 2}px`
    }
  }

  /** Switch a badge from unfilled (amber) to filled (green). */
  markFilled(selector: string) {
    const entry = this.badges.find(b => b.field.selector === selector)
    if (!entry || entry.filled) return
    entry.filled = true
    entry.el.className = 'badge filled'
    entry.el.textContent = '\u2713'
  }

  /** Switch a badge from filled (green) back to unfilled (amber). */
  markUnfilled(selector: string) {
    const entry = this.badges.find(b => b.field.selector === selector)
    if (!entry || !entry.filled) return
    entry.filled = false
    entry.el.className = 'badge unfilled'
    entry.el.textContent = '\u270E'
  }

  /** Remove host element and all event listeners. */
  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    window.removeEventListener('scroll', this.onScroll, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', this.onResize)
    this.badges = []
    this.host.remove()
  }

  private clearBadges() {
    for (const entry of this.badges) {
      entry.el.remove()
    }
    this.badges = []
  }

  private scheduleReposition() {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      this.updatePositions()
    })
  }
}
