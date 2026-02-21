/**
 * Creates and manages the Shadow DOM host element for the overlay React app.
 * Injects overlay CSS into the shadow root so host page styles can't interfere.
 */

import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Overlay, { type OverlayProps } from './Overlay'

// Import CSS as raw string for injection into Shadow DOM
const OVERLAY_CSS = `
/* Injected at runtime — see overlay.css for source */
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1f2937}.overlay-container{position:fixed;z-index:2147483647;pointer-events:none}.overlay-panel{pointer-events:all;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);width:320px;max-height:400px;display:flex;flex-direction:column;overflow:hidden;animation:overlay-in .12s ease}@keyframes overlay-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}.overlay-header{padding:10px 12px 6px;border-bottom:1px solid #f3f4f6;flex-shrink:0}.overlay-field-label{font-size:13px;font-weight:700;color:#1f2937;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overlay-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:6px}.overlay-search{width:100%;padding:6px 10px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;outline:none;background:#f9fafb;color:#111827;box-sizing:border-box;transition:border-color .15s}.overlay-search:focus{border-color:#3b82f6;background:#fff}.overlay-list{overflow-y:auto;flex:1;padding:4px 0}.overlay-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;padding:6px 12px 2px}.overlay-item{display:flex;flex-direction:column;padding:8px 12px;cursor:pointer;transition:background .1s;border-left:3px solid transparent}.overlay-item:hover,.overlay-item.selected{background:#eff6ff;border-left-color:#3b82f6}.overlay-item.suggested{border-left-color:#f59e0b}.overlay-item.suggested:hover,.overlay-item.suggested.selected{background:#fffbeb;border-left-color:#d97706}.overlay-item-key{font-size:12px;font-weight:600;color:#1f2937;font-family:'SF Mono','Fira Code',Consolas,monospace}.overlay-item-value{font-size:12px;color:#6b7280;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}.overlay-item-badge{font-size:10px;padding:1px 5px;border-radius:4px;font-weight:600;margin-left:auto;align-self:flex-start}.badge-suggested{background:rgba(245,158,11,.15);color:#92400e}.overlay-empty{padding:20px 12px;text-align:center;color:#9ca3af;font-size:13px}.overlay-footer{padding:6px 12px;border-top:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#9ca3af;flex-shrink:0}.overlay-close{background:none;border:none;color:#9ca3af;cursor:pointer;padding:2px 6px;border-radius:4px;font-size:14px;line-height:1}.overlay-close:hover{background:#f3f4f6;color:#374151}.kbd{display:inline-block;padding:1px 5px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:3px;font-size:10px;color:#374151}.overlay-mapping-confirm{font-size:11px;font-weight:600;color:#059669;margin-bottom:4px;animation:confirm-in .2s ease}@keyframes confirm-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
`

const HOST_ID = 'unstract-overlay-host'

export class ShadowHost {
  private host: HTMLElement
  private shadow: ShadowRoot
  private root: Root
  private _props: OverlayProps | null = null

  constructor() {
    // Remove any existing host
    document.getElementById(HOST_ID)?.remove()

    this.host = document.createElement('div')
    this.host.id = HOST_ID
    // Position outside normal flow
    Object.assign(this.host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      zIndex: '2147483647',
      pointerEvents: 'none',
    })

    this.shadow = this.host.attachShadow({ mode: 'open' })

    // Inject CSS
    const style = document.createElement('style')
    style.textContent = OVERLAY_CSS
    this.shadow.appendChild(style)

    // Mount point
    const mountPoint = document.createElement('div')
    this.shadow.appendChild(mountPoint)

    document.body.appendChild(this.host)
    this.root = createRoot(mountPoint)
  }

  show(props: OverlayProps) {
    this._props = props
    this.host.style.pointerEvents = 'all'
    this.root.render(React.createElement(Overlay, props))
  }

  hide() {
    this._props = null
    this.host.style.pointerEvents = 'none'
    this.root.render(null)
  }

  destroy() {
    this.root.unmount()
    this.host.remove()
  }

  get isVisible() {
    return this._props !== null
  }
}
