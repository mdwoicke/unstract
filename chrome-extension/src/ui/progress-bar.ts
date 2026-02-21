/**
 * Lightweight on-page progress bar for the fill process.
 *
 * Uses its own Shadow DOM host (separate from the overlay) so it can be
 * shown/hidden independently. The bar is fixed to the top of the viewport
 * and auto-hides after completion.
 */

const HOST_ID = 'unstract-progress-host'

const CSS = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.progress-wrap{position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center}
.progress-track{width:100%;height:3px;background:rgba(0,0,0,.06)}
.progress-fill{height:100%;background:linear-gradient(90deg,#f59e0b,#f97316);border-radius:0 2px 2px 0;transition:width .3s ease}
.progress-fill.done{background:linear-gradient(90deg,#10b981,#34d399)}
.progress-fill.error{background:linear-gradient(90deg,#ef4444,#f87171)}
.progress-label{margin-top:6px;padding:4px 14px;background:#1f2937;color:#f9fafb;font-size:12px;font-weight:500;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.15);white-space:nowrap;opacity:1;transition:opacity .3s ease}
.progress-label.fade{opacity:0}
@keyframes indeterminate{0%{left:-30%;width:30%}50%{left:30%;width:40%}100%{left:100%;width:30%}}
.progress-fill.indeterminate{position:relative;animation:indeterminate 1.4s ease-in-out infinite;width:30%!important}
`

export class ProgressBar {
  private host: HTMLElement
  private shadow: ShadowRoot
  private track: HTMLElement
  private fill: HTMLElement
  private label: HTMLElement
  private hideTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    // Remove stale instance
    document.getElementById(HOST_ID)?.remove()

    this.host = document.createElement('div')
    this.host.id = HOST_ID
    Object.assign(this.host.style, {
      position: 'fixed', top: '0', left: '0', width: '100%',
      height: '0', overflow: 'visible', zIndex: '2147483647',
      pointerEvents: 'none',
    })

    this.shadow = this.host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = CSS
    this.shadow.appendChild(style)

    const wrap = document.createElement('div')
    wrap.className = 'progress-wrap'

    this.track = document.createElement('div')
    this.track.className = 'progress-track'
    this.fill = document.createElement('div')
    this.fill.className = 'progress-fill'
    this.fill.style.width = '0%'
    this.track.appendChild(this.fill)

    this.label = document.createElement('div')
    this.label.className = 'progress-label'
    this.label.textContent = ''

    wrap.appendChild(this.track)
    wrap.appendChild(this.label)
    this.shadow.appendChild(wrap)

    document.body.appendChild(this.host)
  }

  /** Show or update the progress bar. percent: 0-100, -1 for indeterminate. */
  update(percent: number, text: string) {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }

    this.host.style.display = ''
    this.label.classList.remove('fade')
    this.label.textContent = text

    this.fill.classList.remove('done', 'error', 'indeterminate')
    if (percent < 0) {
      this.fill.classList.add('indeterminate')
    } else {
      this.fill.style.width = `${Math.min(100, Math.max(0, percent))}%`
    }
  }

  /** Show completion state and auto-hide after delay. */
  complete(text: string, autoHideMs = 2500) {
    this.fill.classList.remove('indeterminate', 'error')
    this.fill.classList.add('done')
    this.fill.style.width = '100%'
    this.label.textContent = text

    this.hideTimer = setTimeout(() => {
      this.label.classList.add('fade')
      setTimeout(() => { this.host.style.display = 'none' }, 300)
    }, autoHideMs)
  }

  /** Show error state and auto-hide. */
  error(text: string, autoHideMs = 3000) {
    this.fill.classList.remove('indeterminate', 'done')
    this.fill.classList.add('error')
    this.fill.style.width = '100%'
    this.label.textContent = text

    this.hideTimer = setTimeout(() => {
      this.label.classList.add('fade')
      setTimeout(() => { this.host.style.display = 'none' }, 300)
    }, autoHideMs)
  }

  /** Remove from DOM. */
  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.host.remove()
  }
}
