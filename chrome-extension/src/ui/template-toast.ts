/**
 * Template save toast — shown after a fill completes.
 *
 * Shadow DOM component (following progress-bar.ts pattern) that prompts
 * the user to save the current field mappings as a reusable template.
 * Auto-dismisses after 15 seconds.
 */

const HOST_ID = 'unstract-template-toast'
const AUTO_DISMISS_MS = 15_000

const CSS = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}

.toast-wrap{
  position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  z-index:2147483647;pointer-events:all;
  background:#1f2937;color:#f9fafb;border:1px solid #374151;
  border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);
  padding:12px 16px;min-width:340px;max-width:500px;
  display:flex;flex-direction:column;gap:8px;
  opacity:1;transition:opacity .3s ease,transform .3s ease;
}
.toast-wrap.fade{opacity:0;transform:translateX(-50%) translateY(12px)}

.toast-header{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.toast-text{font-size:13px;font-weight:500;color:#d1d5db;flex:1}

.toast-close{
  background:none;border:none;color:#6b7280;cursor:pointer;
  font-size:18px;line-height:1;padding:0 4px;
}
.toast-close:hover{color:#f9fafb}

.toast-form{display:flex;gap:6px;align-items:center}

.toast-input{
  flex:1;padding:6px 10px;background:#111827;border:1px solid #374151;
  border-radius:6px;color:#f9fafb;font-size:13px;outline:none;
}
.toast-input:focus{border-color:#3b82f6}
.toast-input::placeholder{color:#6b7280}

.toast-save{
  padding:6px 14px;background:#3b82f6;color:#fff;border:none;
  border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;
  white-space:nowrap;
}
.toast-save:hover{background:#2563eb}
.toast-save:disabled{background:#1e3a5f;cursor:not-allowed}

.toast-success{
  font-size:12px;color:#34d399;font-weight:500;text-align:center;
  padding:4px 0;
}
`

export class TemplateToast {
  private host: HTMLElement
  private shadow: ShadowRoot
  private wrap: HTMLElement
  private input: HTMLInputElement
  private saveBtn: HTMLButtonElement
  private dismissTimer: ReturnType<typeof setTimeout> | null = null
  private onSave: ((name: string) => void) | null = null

  constructor() {
    // Remove stale instance
    document.getElementById(HOST_ID)?.remove()

    this.host = document.createElement('div')
    this.host.id = HOST_ID
    Object.assign(this.host.style, {
      position: 'fixed', bottom: '0', left: '0', width: '100%',
      height: '0', overflow: 'visible', zIndex: '2147483647',
      pointerEvents: 'none',
    })

    this.shadow = this.host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = CSS
    this.shadow.appendChild(style)

    this.wrap = document.createElement('div')
    this.wrap.className = 'toast-wrap'

    // Header row
    const header = document.createElement('div')
    header.className = 'toast-header'

    const text = document.createElement('div')
    text.className = 'toast-text'

    const closeBtn = document.createElement('button')
    closeBtn.className = 'toast-close'
    closeBtn.textContent = '\u00d7'
    closeBtn.addEventListener('click', () => this.dismiss())

    header.appendChild(text)
    header.appendChild(closeBtn)

    // Form row
    const form = document.createElement('div')
    form.className = 'toast-form'

    this.input = document.createElement('input')
    this.input.className = 'toast-input'
    this.input.type = 'text'
    this.input.placeholder = 'Template name…'

    this.saveBtn = document.createElement('button')
    this.saveBtn.className = 'toast-save'
    this.saveBtn.textContent = 'Save'
    this.saveBtn.addEventListener('click', () => this.handleSave())

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSave()
      if (e.key === 'Escape') this.dismiss()
    })

    form.appendChild(this.input)
    form.appendChild(this.saveBtn)

    this.wrap.appendChild(header)
    this.wrap.appendChild(form)
    this.shadow.appendChild(this.wrap)

    document.body.appendChild(this.host)
  }

  /** Show the toast with a fill summary. */
  show(filledCount: number, onSave: (name: string) => void) {
    this.onSave = onSave
    const text = this.wrap.querySelector('.toast-text')!
    text.textContent = `Filled ${filledCount} fields. Save as template?`

    this.wrap.classList.remove('fade')
    this.host.style.display = ''
    this.input.value = ''
    this.input.focus()

    // Auto-dismiss after timeout
    if (this.dismissTimer) clearTimeout(this.dismissTimer)
    this.dismissTimer = setTimeout(() => this.dismiss(), AUTO_DISMISS_MS)
  }

  private handleSave() {
    const name = this.input.value.trim()
    if (!name || !this.onSave) return

    this.saveBtn.disabled = true
    this.onSave(name)

    // Show success briefly then dismiss
    const form = this.wrap.querySelector('.toast-form') as HTMLElement
    form.innerHTML = ''
    const success = document.createElement('div')
    success.className = 'toast-success'
    success.textContent = 'Template saved!'
    form.appendChild(success)

    setTimeout(() => this.dismiss(), 1500)
  }

  private dismiss() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer)
      this.dismissTimer = null
    }
    this.wrap.classList.add('fade')
    setTimeout(() => this.host.remove(), 300)
  }

  destroy() {
    if (this.dismissTimer) clearTimeout(this.dismissTimer)
    this.host.remove()
  }
}
