/**
 * Inline combobox overlay shown when a user focuses an unmapped form field.
 * Mounted inside a Shadow DOM to prevent style leakage.
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo
} from 'react'
import { toFriendlyName } from '../store/state'
import type { UnmappedItem } from '../store/state'

export interface OverlayProps {
  unmapped: UnmappedItem[]
  suggestions: Array<{ key: string; value: unknown; score: number }>
  anchorRect: DOMRect
  fieldLabel: string
  lastMapping?: string
  onSelect: (item: UnmappedItem) => void
  onTab: (item: UnmappedItem) => void
  onClose: () => void
}

function hasValue(item: UnmappedItem): boolean {
  if (item.value === null || item.value === undefined) return false
  if (typeof item.value === 'string' && item.value.trim() === '') return false
  return true
}

export default function Overlay({ unmapped, suggestions, anchorRect, fieldLabel, lastMapping, onSelect, onTab, onClose }: OverlayProps) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Focus search on mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  // Reset selection when query changes
  useEffect(() => setSelectedIdx(0), [query])

  // Apply value filter first, then search query
  const visibleUnmapped = useMemo(() => {
    const base = showAll ? unmapped : unmapped.filter(hasValue)
    if (!query) return base
    const q = query.toLowerCase()
    return base.filter(
      (u) =>
        u.key.toLowerCase().includes(q) ||
        toFriendlyName(u.key).toLowerCase().includes(q) ||
        String(u.value).toLowerCase().includes(q)
    )
  }, [unmapped, query, showAll])

  const withValueCount = useMemo(() => unmapped.filter(hasValue).length, [unmapped])

  // Top suggestions (from AI ranking), filtered out of unmapped to avoid duplication
  const topSuggestions = useMemo(() => {
    const unmappedKeys = new Set(unmapped.map(u => u.key))
    return suggestions
      .filter(s => unmappedKeys.has(s.key))
      .slice(0, 3)
      .map(s => ({ key: s.key, value: s.value as UnmappedItem['value'] }))
  }, [suggestions, unmapped])

  // Combined list for keyboard nav
  const allItems: Array<UnmappedItem & { isSuggested?: boolean }> = useMemo(() => {
    if (query) return visibleUnmapped
    const suggestedKeys = new Set(topSuggestions.map(s => s.key))
    const rest = visibleUnmapped.filter(u => !suggestedKeys.has(u.key))
    return [
      ...topSuggestions.map(s => ({ ...s, isSuggested: true })),
      ...rest,
    ]
  }, [visibleUnmapped, topSuggestions, query])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (allItems[selectedIdx]) onTab(allItems[selectedIdx])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (allItems[selectedIdx]) onSelect(allItems[selectedIdx])
    }
  }, [allItems, selectedIdx, onSelect, onTab, onClose])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const selected = list.querySelector<HTMLElement>('.selected')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // Compute panel position
  const panelStyle = useMemo(() => {
    const { top, left, bottom, height } = anchorRect
    const viewH = window.innerHeight
    const panelH = 400

    const style: React.CSSProperties = { position: 'fixed', left: Math.max(4, left) }
    if (bottom + panelH + 8 < viewH) {
      style.top = bottom + 4
    } else {
      style.top = Math.max(4, top - Math.min(panelH, top - 4) - 4)
    }
    return style
  }, [anchorRect])

  return (
    <div className="overlay-container" style={panelStyle} onKeyDown={handleKeyDown}>
      <div className="overlay-panel" role="dialog" aria-label="Form field suggestions">
        <div className="overlay-header">
          {lastMapping && (
            <div className="overlay-mapping-confirm">{'\u2713'} {lastMapping}</div>
          )}
          {fieldLabel && (
            <div className="overlay-field-label">{fieldLabel}</div>
          )}
          <div className="overlay-title-row">
            <span className="overlay-title">
              {unmapped.length} field{unmapped.length !== 1 ? 's' : ''} remaining
            </span>
            <div className="overlay-toggle">
              <button
                className={`overlay-toggle-btn${!showAll ? ' active' : ''}`}
                onClick={() => { setShowAll(false); setSelectedIdx(0) }}
              >
                With values ({withValueCount})
              </button>
              <button
                className={`overlay-toggle-btn${showAll ? ' active' : ''}`}
                onClick={() => { setShowAll(true); setSelectedIdx(0) }}
              >
                All
              </button>
            </div>
          </div>
          <input
            ref={searchRef}
            className="overlay-search"
            type="text"
            placeholder="Search fields..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search available fields"
          />
        </div>

        <div className="overlay-list" ref={listRef}>
          {allItems.length === 0 && (
            <div className="overlay-empty">
              {query ? 'No matches found' : 'All fields have been filled!'}
            </div>
          )}

          {!query && topSuggestions.length > 0 && (
            <div className="overlay-section-label">Suggested</div>
          )}

          {allItems.map((item, idx) => (
            <div
              key={item.key}
              className={[
                'overlay-item',
                item.isSuggested ? 'suggested' : '',
                idx === selectedIdx ? 'selected' : '',
              ].join(' ')}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIdx(idx)}
              role="option"
              aria-selected={idx === selectedIdx}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="overlay-item-key">{toFriendlyName(item.key)}</span>
                {item.isSuggested && (
                  <span className="overlay-item-badge badge-suggested">AI</span>
                )}
              </div>
              <div className="overlay-item-value">
                {item.value === null ? <em>null</em> : String(item.value)}
              </div>
            </div>
          ))}
        </div>

        <div className="overlay-footer">
          <span>
            <span className="kbd">↑↓</span> navigate&nbsp;&nbsp;
            <span className="kbd">↵</span> select&nbsp;&nbsp;
            <span className="kbd">Tab</span> next&nbsp;&nbsp;
            <span className="kbd">Esc</span> close
          </span>
          <button className="overlay-close" onClick={onClose} tabIndex={-1} aria-label="Close overlay">×</button>
        </div>
      </div>
    </div>
  )
}
