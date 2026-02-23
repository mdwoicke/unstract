/**
 * Extension popup — Status, Paste JSON, LM Studio settings, Cloud AI settings.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExtensionState } from '../store/state'
import { flattenJson } from '../store/state'
import type { LMStudioConfig } from '../ai/lmstudio-matcher'
import { DEFAULT_LMSTUDIO_CONFIG } from '../ai/lmstudio-matcher'
import type { TypeMatcherConfig } from '../ai/local-matcher'
import { DEFAULT_TYPE_MATCHER_CONFIG } from '../ai/local-matcher'
import type { FormTemplate, TemplateFieldMapping } from '../store/template'
import { deriveUrlPattern } from '../store/template'

// ─── Base styles injected into the popup document ─────────────────────────────

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 360px;
    min-height: 220px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #080e1c;
    color: #dde5f5;
    font-size: 14px;
  }
  #root { min-height: 220px; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #0d1929; }
  ::-webkit-scrollbar-thumb { background: #1c3052; border-radius: 3px; }
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(epoch: number): string {
  const s = Math.floor((Date.now() - epoch) / 1000)
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
}

function minutesLeft(loadedAt: number): number {
  return Math.max(0, Math.round((10 * 60 * 1000 - (Date.now() - loadedAt)) / 60000))
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: '#0d1929', borderRadius: 8, padding: '10px 8px',
      border: '1px solid #1c3052', borderTop: `3px solid ${color}`, textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#8899b4' }}>{label}</div>
    </div>
  )
}

function StatusDot({ ok, loading }: { ok: boolean | null; loading?: boolean }) {
  if (loading) return <span style={{ fontSize: 11, color: '#8899b4' }}>Testing…</span>
  if (ok === null) return null
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
      color: ok ? '#34d399' : '#f87171',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: ok ? '#34d399' : '#ef4444',
        display: 'inline-block',
      }} />
      {ok ? 'Connected' : 'Offline'}
    </span>
  )
}

// ─── Type Matcher settings tab ────────────────────────────────────────────────

function TypeMatcherTab() {
  const [cfg, setCfg] = useState<TypeMatcherConfig>(DEFAULT_TYPE_MATCHER_CONFIG)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean; latencyMs: number; error?: string
  } | null>(null)

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_TYPE_MATCHER_CONFIG' }).then((c: TypeMatcherConfig) => {
      setCfg({ ...DEFAULT_TYPE_MATCHER_CONFIG, ...c })
    }).catch(() => {})
  }, [])

  const test = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    const result = await chrome.runtime.sendMessage({ type: 'TEST_TYPE_MATCHER', baseUrl: cfg.baseUrl })
      .catch(() => ({ ok: false, latencyMs: 0, error: 'Extension error' }))
    setTestResult(result)
    setTesting(false)
  }, [cfg.baseUrl])

  const save = async () => {
    await chrome.runtime.sendMessage({ type: 'SET_TYPE_MATCHER_CONFIG', config: cfg })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div>
      {/* Enable toggle */}
      <div style={{ ...s.row, marginBottom: 14 }}>
        <label style={{ ...s.label, marginBottom: 0 }}>Use Type Matcher (Strategy 0)</label>
        <label style={s.toggle}>
          <input type="checkbox" checked={cfg.enabled} onChange={e => setCfg(prev => ({ ...prev, enabled: e.target.checked }))} />
          <span style={{
            width: 36, height: 20, borderRadius: 10, background: cfg.enabled ? '#3b82f6' : '#2a3a52',
            display: 'inline-block', position: 'relative', cursor: 'pointer', transition: 'background .15s',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: cfg.enabled ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.4)',
            }} />
          </span>
        </label>
      </div>

      {/* Base URL */}
      <div style={s.fieldGroup}>
        <div style={s.row}>
          <label style={{ ...s.label, marginBottom: 0 }}>Service URL</label>
          <StatusDot ok={testResult?.ok ?? null} loading={testing} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <input
            type="text"
            style={{ ...s.input, flex: 1 }}
            value={cfg.baseUrl}
            onChange={e => { setCfg(prev => ({ ...prev, baseUrl: e.target.value })); setTestResult(null) }}
            placeholder="http://localhost:3005"
          />
          <button onClick={test} disabled={testing} style={s.btnSm}>
            Test
          </button>
        </div>
        {testResult && (
          <div style={{
            marginTop: 6, padding: '5px 8px', borderRadius: 5, fontSize: 11,
            background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: testResult.ok ? '#34d399' : '#f87171',
            border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            {testResult.ok
              ? <>{testResult.latencyMs}ms &nbsp;·&nbsp; Pydantic type matcher running</>
              : (testResult.error ?? 'Cannot connect to type matcher')}
          </div>
        )}
      </div>

      {/* Auto-scan toggle */}
      <div style={{ ...s.row, marginBottom: 14 }}>
        <label style={{ ...s.label, marginBottom: 0, maxWidth: '80%' }}>
          Auto-fill when JSON is loaded
        </label>
        <label style={s.toggle}>
          <input type="checkbox" checked={cfg.autoScan} onChange={e => setCfg(prev => ({ ...prev, autoScan: e.target.checked }))} />
          <span style={{
            width: 36, height: 20, borderRadius: 10, background: cfg.autoScan ? '#3b82f6' : '#2a3a52',
            display: 'inline-block', position: 'relative', cursor: 'pointer', transition: 'background .15s',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: cfg.autoScan ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.4)',
            }} />
          </span>
        </label>
      </div>

      <div style={s.strategyBox}>
        <div style={{ fontSize: 12, color: '#8899b4' }}>
          The type matcher uses Pydantic to classify JSON values and form fields into semantic types (email, phone, date, name, etc.), then matches by type alignment. It runs as a lightweight Python service with pure regex — no ML models needed. Falls through to LM Studio/BERT/TF-IDF if unavailable.
        </div>
      </div>

      <button onClick={save} style={s.btnPrimary}>
        {saved ? '✓ Saved!' : 'Save Type Matcher Settings'}
      </button>
    </div>
  )
}

// ─── LM Studio settings tab ───────────────────────────────────────────────────

function LMStudioTab() {
  const [cfg, setCfg] = useState<LMStudioConfig>(DEFAULT_LMSTUDIO_CONFIG)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean; embeddingModel: string; chatModel: string; latencyMs: number; error?: string
  } | null>(null)

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_LMSTUDIO_CONFIG' }).then((c: LMStudioConfig) => {
      setCfg({ ...DEFAULT_LMSTUDIO_CONFIG, ...c })
    }).catch(() => {})
  }, [])

  const test = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    const result = await chrome.runtime.sendMessage({ type: 'TEST_LMSTUDIO', baseUrl: cfg.baseUrl })
      .catch(() => ({ ok: false, embeddingModel: '', chatModel: '', latencyMs: 0, error: 'Extension error' }))
    setTestResult(result)
    if (result.ok) {
      setCfg(prev => ({
        ...prev,
        embeddingModel: prev.embeddingModel || result.embeddingModel,
        chatModel: prev.chatModel || result.chatModel,
      }))
    }
    setTesting(false)
  }, [cfg.baseUrl])

  const save = async () => {
    await chrome.runtime.sendMessage({ type: 'SET_LMSTUDIO_CONFIG', config: cfg })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const update = (key: keyof LMStudioConfig, value: unknown) =>
    setCfg(prev => ({ ...prev, [key]: value }))

  return (
    <div>
      {/* Enable toggle */}
      <div style={{ ...s.row, marginBottom: 14 }}>
        <label style={{ ...s.label, marginBottom: 0 }}>Use LM Studio (default AI)</label>
        <label style={s.toggle}>
          <input type="checkbox" checked={cfg.enabled} onChange={e => update('enabled', e.target.checked)} />
          <span style={{
            width: 36, height: 20, borderRadius: 10, background: cfg.enabled ? '#3b82f6' : '#2a3a52',
            display: 'inline-block', position: 'relative', cursor: 'pointer', transition: 'background .15s',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: cfg.enabled ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.4)',
            }} />
          </span>
        </label>
      </div>

      {/* Base URL */}
      <div style={s.fieldGroup}>
        <div style={s.row}>
          <label style={{ ...s.label, marginBottom: 0 }}>LM Studio URL</label>
          <StatusDot ok={testResult?.ok ?? null} loading={testing} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <input
            type="text"
            style={{ ...s.input, flex: 1 }}
            value={cfg.baseUrl}
            onChange={e => { update('baseUrl', e.target.value); setTestResult(null) }}
            placeholder="http://localhost:1234"
          />
          <button onClick={test} disabled={testing} style={s.btnSm}>
            Test
          </button>
        </div>
        {testResult && (
          <div style={{
            marginTop: 6, padding: '5px 8px', borderRadius: 5, fontSize: 11,
            background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: testResult.ok ? '#34d399' : '#f87171',
            border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            {testResult.ok ? (
              <>
                {testResult.latencyMs}ms &nbsp;·&nbsp;
                {testResult.embeddingModel
                  ? <>Embedding: <strong>{testResult.embeddingModel}</strong></>
                  : <span style={{ color: '#f59e0b' }}>No embedding model detected</span>}
                {testResult.chatModel && <> &nbsp;·&nbsp; Chat: <strong>{testResult.chatModel}</strong></>}
              </>
            ) : (
              testResult.error ?? 'Cannot connect to LM Studio'
            )}
          </div>
        )}
      </div>

      {/* Embedding model */}
      <div style={s.fieldGroup}>
        <label style={s.label}>Embedding model</label>
        <input
          type="text"
          style={s.input}
          value={cfg.embeddingModel}
          onChange={e => update('embeddingModel', e.target.value)}
          placeholder="Auto-detect from LM Studio (click Test)"
        />
        <div style={s.hint}>
          Load a text embedding model in LM Studio (e.g. nomic-embed-text-v1.5, bge-m3) for best matching accuracy.
        </div>
      </div>

      {/* Chat model */}
      <div style={s.fieldGroup}>
        <label style={s.label}>Chat model (for disambiguation)</label>
        <input
          type="text"
          style={s.input}
          value={cfg.chatModel}
          onChange={e => update('chatModel', e.target.value)}
          placeholder="Auto-detect (uses Qwen3-VL-8B if loaded)"
        />
      </div>

      {/* Chat fallback toggle */}
      <div style={{ ...s.row, marginBottom: 14 }}>
        <label style={{ ...s.label, marginBottom: 0, maxWidth: '80%' }}>
          Use chat model when embeddings uncertain
        </label>
        <label style={s.toggle}>
          <input type="checkbox" checked={cfg.useChatFallback} onChange={e => update('useChatFallback', e.target.checked)} />
          <span style={{
            width: 36, height: 20, borderRadius: 10, background: cfg.useChatFallback ? '#3b82f6' : '#2a3a52',
            display: 'inline-block', position: 'relative', cursor: 'pointer', transition: 'background .15s',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: cfg.useChatFallback ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.4)',
            }} />
          </span>
        </label>
      </div>

      <div style={s.strategyBox}>
        <div style={s.strategyTitle}>Matching priority</div>
        <div style={s.strategyRow}>
          <span style={{ ...s.badge, background: 'rgba(59,130,246,0.2)', color: '#5ab4f0' }}>0</span>
          <span>Pydantic type matcher <em style={{ color: '#5a6a84' }}>(if running)</em></span>
        </div>
        <div style={s.strategyRow}>
          <span style={{ ...s.badge, background: cfg.enabled ? 'rgba(59,130,246,0.2)' : '#122035', color: cfg.enabled ? '#5ab4f0' : '#5a6a84' }}>1</span>
          <span>LM Studio embeddings {cfg.enabled ? '' : '(disabled)'}</span>
        </div>
        <div style={s.strategyRow}>
          <span style={s.badge}>2</span>
          <span>BERT / all-MiniLM-L6-v2 <em style={{ color: '#5a6a84' }}>(if downloaded)</em></span>
        </div>
        <div style={s.strategyRow}>
          <span style={s.badge}>3</span>
          <span>TF-IDF cosine <em style={{ color: '#5a6a84' }}>(always available)</em></span>
        </div>
      </div>

      <button onClick={save} style={s.btnPrimary}>
        {saved ? '✓ Saved!' : 'Save LM Studio Settings'}
      </button>
    </div>
  )
}

// ─── Cloud AI settings tab ────────────────────────────────────────────────────

function CloudTab() {
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_CLOUD_CONFIG' }).then((cfg: { provider: string; apiKey: string; model: string }) => {
      setProvider(cfg.provider as 'anthropic' | 'openai')
      setApiKey(cfg.apiKey)
      setModel(cfg.model)
    }).catch(() => {})
  }, [])

  const save = async () => {
    await chrome.runtime.sendMessage({ type: 'SET_CLOUD_CONFIG', provider, apiKey, model })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div>
      <div style={{ ...s.strategyBox, marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: '#8899b4' }}>
          Cloud AI is a last-resort fallback — only used when LM Studio is offline <em>and</em> BERT is not installed. PII (emails, phone numbers, SSNs) is automatically masked before any data is sent.
        </div>
      </div>
      <div style={s.fieldGroup}>
        <label style={s.label}>Provider</label>
        <select style={s.select} value={provider} onChange={e => setProvider(e.target.value as 'anthropic' | 'openai')}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI (GPT)</option>
        </select>
      </div>
      <div style={s.fieldGroup}>
        <label style={s.label}>API Key</label>
        <input type="password" style={s.input} value={apiKey}
          onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-... or sk-..." />
      </div>
      <div style={s.fieldGroup}>
        <label style={s.label}>Model override <em style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</em></label>
        <input type="text" style={s.input} value={model}
          onChange={e => setModel(e.target.value)} placeholder="claude-haiku-4-5 / gpt-4o-mini" />
      </div>
      <button onClick={save} style={s.btnPrimary}>
        {saved ? '✓ Saved!' : 'Save Cloud Settings'}
      </button>
    </div>
  )
}

// ─── Templates tab ──────────────────────────────────────────────────────────

function TemplatesTab({ hasPayload }: { hasPayload: boolean }) {
  const [templates, setTemplates] = useState<FormTemplate[]>([])
  const [saving, setSaving] = useState(false)
  const [saveForm, setSaveForm] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [savePattern, setSavePattern] = useState('')
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [applyMsg, setApplyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refreshTemplates = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LIST_TEMPLATES' })
      setTemplates(res?.templates ?? [])
    } catch {}
  }, [])

  useEffect(() => { refreshTemplates() }, [refreshTemplates])

  const handleStartSave = async () => {
    setSaveMsg(null)
    const res = await chrome.runtime.sendMessage({ type: 'GET_CAPTURED_MAPPINGS' })
      .catch(() => ({ mappings: [], url: '' }))

    if (!res?.mappings?.length) {
      setSaveMsg({ ok: false, text: 'No field mappings captured yet. Fill a form first.' })
      return
    }

    setSavePattern(deriveUrlPattern(res.url))
    setSaveForm(true)
  }

  const handleSave = async () => {
    if (!saveName.trim()) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const captured = await chrome.runtime.sendMessage({ type: 'GET_CAPTURED_MAPPINGS' })
        .catch(() => ({ mappings: [], url: '' }))

      await chrome.runtime.sendMessage({
        type: 'SAVE_TEMPLATE',
        name: saveName.trim(),
        urlPattern: savePattern,
        capturedUrl: captured.url || '',
        mappings: captured.mappings,
      })

      setSaveMsg({ ok: true, text: 'Template saved!' })
      setSaveName('')
      setSaveForm(false)
      await refreshTemplates()
    } catch (err) {
      setSaveMsg({ ok: false, text: `Save failed: ${String(err)}` })
    } finally {
      setSaving(false)
    }
  }

  const handleApply = async (templateId: string) => {
    setApplyMsg(null)
    setApplying(templateId)
    try {
      const result = await chrome.runtime.sendMessage({ type: 'APPLY_TEMPLATE', templateId })
      if (result?.error) {
        setApplyMsg({ ok: false, text: result.error })
      } else {
        const compat = result.compatibility != null ? Math.round(result.compatibility * 100) : null
        let msg = `Filled ${result.filledCount ?? 0} fields`
        if (compat !== null && compat < 50) {
          msg += ` (${compat}% data compatibility — some fields may not match)`
        }
        setApplyMsg({ ok: true, text: msg })
      }
    } catch (err) {
      setApplyMsg({ ok: false, text: String(err) })
    } finally {
      setApplying(null)
    }
  }

  const handleDelete = async (templateId: string) => {
    await chrome.runtime.sendMessage({ type: 'DELETE_TEMPLATE', templateId })
    await refreshTemplates()
  }

  const handleExport = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'EXPORT_TEMPLATES' })
    const blob = new Blob([JSON.stringify(res.templates, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mbn-templates.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const imported = JSON.parse(text)
      if (!Array.isArray(imported)) throw new Error('Expected an array of templates')
      await chrome.runtime.sendMessage({ type: 'IMPORT_TEMPLATES', templates: imported })
      await refreshTemplates()
      setSaveMsg({ ok: true, text: `Imported ${imported.length} templates` })
    } catch (err) {
      setSaveMsg({ ok: false, text: `Import failed: ${(err as Error).message}` })
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div>
      {/* Save current mapping button */}
      {hasPayload && (
        <div style={{ marginBottom: 12 }}>
          {!saveForm ? (
            <button onClick={handleStartSave} style={{
              ...s.btnPrimary,
              background: '#8b5cf6',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                <polyline points="17,21 17,13 7,13 7,21" />
                <polyline points="7,3 7,8 15,8" />
              </svg>
              Save Current Mapping
            </button>
          ) : (
            <div style={{ ...s.strategyBox, border: '1px solid #8b5cf6' }}>
              <div style={s.fieldGroup}>
                <label style={s.label}>Template name</label>
                <input
                  type="text" style={s.input} value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  placeholder="e.g. Credit Card Application"
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  autoFocus
                />
              </div>
              <div style={s.fieldGroup}>
                <label style={s.label}>URL pattern</label>
                <input
                  type="text" style={s.input} value={savePattern}
                  onChange={e => setSavePattern(e.target.value)}
                  placeholder="app.example.com/forms/*"
                />
                <div style={s.hint}>
                  Use * as wildcard. Template will auto-suggest on matching pages.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handleSave} disabled={saving || !saveName.trim()} style={{ ...s.btnPrimary, background: '#8b5cf6', flex: 1 }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setSaveForm(false)} style={{ ...s.btnSm }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      {saveMsg && (
        <div style={{
          padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 10,
          background: saveMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: saveMsg.ok ? '#34d399' : '#f87171',
          border: `1px solid ${saveMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
        }}>
          {saveMsg.text}
        </div>
      )}

      {applyMsg && (
        <div style={{
          padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 10,
          background: applyMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: applyMsg.ok ? '#34d399' : '#f87171',
          border: `1px solid ${applyMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
        }}>
          {applyMsg.text}
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 ? (
        <div style={s.emptyState}>
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>T</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No saved templates</div>
          <div style={{ color: '#8899b4', fontSize: 12 }}>
            Fill a form, then save the mapping as a template for instant re-use.
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#5a6a84', marginBottom: 8,
            textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Saved Templates ({templates.length})
          </div>
          {templates.map(t => (
            <div key={t.id} style={{
              background: '#0d1929', border: '1px solid #1c3052', borderRadius: 8,
              padding: '10px 12px', marginBottom: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#dde5f5' }}>{t.name}</div>
                <div style={{ fontSize: 11, color: '#5a6a84' }}>
                  {t.useCount} use{t.useCount !== 1 ? 's' : ''}
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#5a6a84', marginBottom: 8 }}>
                {t.urlPattern} &middot; {t.mappings.length} fields
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleApply(t.id)}
                  disabled={!hasPayload || applying === t.id}
                  style={{
                    ...s.btnSm,
                    background: hasPayload ? '#122035' : '#0a1220',
                    color: hasPayload ? '#5ab4f0' : '#3a4a64',
                    borderColor: hasPayload ? '#1c3052' : '#162030',
                    flex: 1,
                  }}
                >
                  {applying === t.id ? 'Applying…' : 'Apply'}
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  style={{ ...s.btnSm, color: '#f87171', borderColor: 'rgba(239,68,68,0.3)' }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Import/Export */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button onClick={handleExport} disabled={templates.length === 0}
          style={{ ...s.btnSecondary, flex: 1, fontSize: 12 }}>
          Export All
        </button>
        <button onClick={() => fileInputRef.current?.click()}
          style={{ ...s.btnSecondary, flex: 1, fontSize: 12 }}>
          Import
        </button>
        <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport}
          style={{ display: 'none' }} />
      </div>
    </div>
  )
}

// ─── Main popup ───────────────────────────────────────────────────────────────

type Tab = 'status' | 'paste' | 'templates' | 'typematcher' | 'lmstudio' | 'cloud'

function Popup() {
  const [tab, setTab] = useState<Tab>('status')
  const [state, setState] = useState<ExtensionState | null>(null)
  const [pasteJson, setPasteJson] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [pasteSuccess, setPasteSuccess] = useState(false)
  const [filling, setFilling] = useState(false)
  const [fillResult, setFillResult] = useState<{ filledCount?: number; unmappedCount?: number; error?: string } | null>(null)
  const [fillProgress, setFillProgress] = useState<{ step: string; text: string; percent: number; current?: number; total?: number } | null>(null)

  const refreshState = useCallback(async () => {
    try {
      const s = await chrome.runtime.sendMessage({ type: 'GET_STATE' }) as ExtensionState
      setState(s)
    } catch { }
  }, [])

  useEffect(() => {
    refreshState()
    const id = setInterval(refreshState, 2000)
    return () => clearInterval(id)
  }, [refreshState])

  // Listen for real-time fill progress from content script
  useEffect(() => {
    const listener = (msg: any) => {
      if (msg.type === 'FILL_PROGRESS') {
        setFillProgress({ step: msg.step, text: msg.text, percent: msg.percent, current: msg.current, total: msg.total })
        if (msg.step === 'done' || msg.step === 'error') {
          setTimeout(() => setFillProgress(null), 3000)
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const handleClear = async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_STATE' })
    setFillResult(null)
    await refreshState()
  }

  const handleFillPage = async () => {
    setFilling(true)
    setFillResult(null)
    setFillProgress({ step: 'starting', text: 'Starting\u2026', percent: 0 })
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FILL_PAGE' })
        .catch((err: Error) => ({ error: err.message }))
      if (result?.error) {
        setFillResult({ error: result.error })
      }
      // Actual fill result (filledCount/unmappedCount) comes back via state refresh
      // badge is updated by FILL_DONE message from content script
      await refreshState()
    } finally {
      setFilling(false)
    }
  }

  const handlePaste = async () => {
    setPasteError('')
    setPasteSuccess(false)
    try {
      const raw = JSON.parse(pasteJson)
      const flat = flattenJson(raw)
      if (Object.keys(flat).length === 0) { setPasteError('JSON is empty.'); return }
      await chrome.runtime.sendMessage({ type: 'LOAD_JSON', payload: flat })
      setPasteSuccess(true)
      setPasteJson('')
      setTimeout(() => { setPasteSuccess(false); setTab('status') }, 1500)
      await refreshState()
    } catch (err) {
      setPasteError(`Invalid JSON: ${(err as Error).message}`)
    }
  }

  const keyCount     = state?.payload ? Object.keys(state.payload).length : 0
  const matchedCount = state?.matches?.filter(m => m.auto).length ?? 0
  const unmappedCount = state?.unmapped?.length ?? 0

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'status',      label: 'Status' },
    { id: 'paste',       label: 'Paste JSON' },
    { id: 'templates',   label: 'Templates' },
    { id: 'typematcher', label: 'Type Match' },
    { id: 'lmstudio',    label: 'LM Studio' },
    // { id: 'cloud',       label: 'Cloud AI' },
  ]

  const logoUrl = chrome.runtime.getURL('logo.jpg')

  return (
    <div>
      {/* Header — full-width MBN Card logo */}
      <div style={s.header}>
        <img
          src={logoUrl}
          alt="MBN Card Inc"
          style={{ maxWidth: '70%', height: 'auto', objectFit: 'contain' }}
          onError={(e) => {
            const target = e.currentTarget
            target.style.display = 'none'
            const fallback = document.createElement('div')
            fallback.style.cssText = 'font-size:18px;font-weight:800;color:#5ab4f0;letter-spacing:2px'
            fallback.textContent = 'MBN CARD INC'
            target.parentElement?.insertBefore(fallback, target)
          }}
        />
        <div style={s.subtitle}>AI-Powered Form Filler</div>
      </div>

      {/* Tab bar */}
      <div style={s.tabs}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ ...s.tab, ...(tab === t.id ? s.tabActive : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: 16, background: '#080e1c' }}>

        {/* ── Status ── */}
        {tab === 'status' && (
          !state?.payload ? (
            <div style={s.emptyState}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No data loaded</div>
              <div style={{ color: '#8899b4', fontSize: 12 }}>
                Click <strong>Fill Form</strong> in the test UI after extracting a document,
                or paste JSON in the tab above.
              </div>
            </div>
          ) : (
            <div>
              {/* Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                <StatCard label="Keys loaded"  value={keyCount}      color="#5ab4f0" />
                <StatCard label="Auto-filled"  value={matchedCount}  color="#34d399" />
                <StatCard label="Unmapped"     value={unmappedCount} color="#f59e0b" />
              </div>

              {state.loadedAt && (
                <div style={{ fontSize: 11, color: '#8899b4', marginBottom: 12 }}>
                  Loaded {timeAgo(state.loadedAt)} · expires in {minutesLeft(state.loadedAt)} min
                </div>
              )}

              {/* Fill result message */}
              {fillResult?.error && (
                <div style={{ padding: '6px 10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 6, color: '#f87171', fontSize: 12, marginBottom: 10 }}>
                  {fillResult.error}
                </div>
              )}

              {/* Primary action: Fill This Page */}
              <button
                onClick={handleFillPage}
                disabled={filling}
                style={{
                  ...s.btnPrimary,
                  marginBottom: 0,
                  background: filling ? '#1d4ed8' : '#3b82f6',
                  cursor: filling ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {filling ? (
                  <>
                    <span style={s.spinner} />
                    Filling form…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    Fill This Page
                  </>
                )}
              </button>

              {/* Real-time fill progress */}
              {fillProgress && (
                <div style={{ marginTop: 10, marginBottom: 2 }}>
                  <div style={{
                    height: 4, background: '#1c3052', borderRadius: 2,
                    overflow: 'hidden', marginBottom: 6,
                  }}>
                    <div style={{
                      height: '100%',
                      width: fillProgress.step === 'done' ? '100%'
                           : fillProgress.step === 'error' ? '100%'
                           : `${fillProgress.percent}%`,
                      background: fillProgress.step === 'done'
                        ? 'linear-gradient(90deg, #10b981, #34d399)'
                        : fillProgress.step === 'error'
                        ? 'linear-gradient(90deg, #ef4444, #f87171)'
                        : 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                      borderRadius: 2,
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{
                    fontSize: 12, color: fillProgress.step === 'done' ? '#34d399'
                                       : fillProgress.step === 'error' ? '#f87171'
                                       : '#8899b4',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {fillProgress.step !== 'done' && fillProgress.step !== 'error' && (
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: '#3b82f6',
                        animation: 'pulse-dot 1s ease-in-out infinite',
                        flexShrink: 0,
                      }} />
                    )}
                    {fillProgress.step === 'done' && (
                      <span style={{ color: '#34d399', fontSize: 13, flexShrink: 0 }}>&#10003;</span>
                    )}
                    {fillProgress.text}
                  </div>
                </div>
              )}

              <div style={{ marginTop: fillProgress ? 8 : 8 }}>
                <button onClick={handleClear} style={s.btnSecondary}>Clear Data</button>
              </div>
            </div>
          )
        )}

        {/* ── Paste JSON ── */}
        {tab === 'paste' && (
          <div>
            <label style={{ ...s.label, marginBottom: 6 }}>Paste JSON from extraction output:</label>
            <textarea
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #1c3052',
                borderRadius: 6, fontSize: 12, background: '#0d1929', resize: 'vertical',
                fontFamily: 'monospace', color: '#dde5f5', marginBottom: 8 }}
              value={pasteJson}
              onChange={e => setPasteJson(e.target.value)}
              placeholder='{"field_name": "value", ...}'
              rows={8}
            />
            {pasteError && (
              <div style={{ padding: '6px 10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 6, color: '#f87171', fontSize: 12, marginBottom: 8 }}>
                {pasteError}
              </div>
            )}
            {pasteSuccess && (
              <div style={{ padding: '6px 10px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
                borderRadius: 6, color: '#34d399', fontSize: 12, marginBottom: 8 }}>
                JSON loaded successfully!
              </div>
            )}
            <button onClick={handlePaste} style={s.btnPrimary} disabled={!pasteJson.trim()}>
              Load JSON
            </button>
          </div>
        )}

        {/* ── Templates ── */}
        {tab === 'templates' && <TemplatesTab hasPayload={!!state?.payload} />}

        {/* ── Type Matcher ── */}
        {tab === 'typematcher' && <TypeMatcherTab />}

        {/* ── LM Studio ── */}
        {tab === 'lmstudio' && <LMStudioTab />}

        {/* ── Cloud AI ── */}
        {tab === 'cloud' && <CloudTab />}

      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '16px 16px 10px', borderBottom: '1px solid #1c3052', background: '#0d1929',
  },
  title:    { fontWeight: 700, fontSize: 15, color: '#dde5f5' },
  subtitle: { fontSize: 11, color: '#ffffff', letterSpacing: '0.05em', textTransform: 'uppercase' },
  tabs: {
    display: 'flex', borderBottom: '1px solid #1c3052', background: '#0d1929',
    overflowX: 'auto',
  },
  tab: {
    flex: 1, padding: '8px 4px', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 11.5, cursor: 'pointer',
    color: '#5a6a84', transition: 'all 0.15s', whiteSpace: 'nowrap',
  },
  tabActive: { color: '#5ab4f0', borderBottomColor: '#3b82f6', fontWeight: 600 },
  emptyState: { textAlign: 'center', padding: '12px 8px', color: '#dde5f5' },
  fieldGroup: { marginBottom: 12 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#a0b0c8', marginBottom: 4 },
  hint:  { fontSize: 11, color: '#5a6a84', marginTop: 4 },
  input: {
    width: '100%', padding: '7px 10px', border: '1px solid #1c3052',
    borderRadius: 6, fontSize: 13, outline: 'none', background: '#122035', color: '#dde5f5',
  },
  select: {
    width: '100%', padding: '7px 10px', border: '1px solid #1c3052',
    borderRadius: 6, fontSize: 13, outline: 'none', background: '#122035', color: '#dde5f5',
  },
  btnPrimary: {
    width: '100%', padding: 9, background: '#3b82f6', color: '#fff',
    border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    width: '100%', padding: 9, background: '#122035', color: '#a0b0c8',
    border: '1px solid #1c3052', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnSm: {
    padding: '7px 12px', background: '#122035', color: '#a0b0c8',
    border: '1px solid #1c3052', borderRadius: 6, fontSize: 12, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  toggle: { display: 'flex', alignItems: 'center', cursor: 'pointer' },
  strategyBox: {
    background: '#0d1929', border: '1px solid #1c3052',
    borderRadius: 8, padding: '10px 12px', marginBottom: 14,
  },
  strategyTitle: { fontSize: 11, fontWeight: 700, color: '#5a6a84', marginBottom: 6,
    textTransform: 'uppercase', letterSpacing: '0.05em' },
  strategyRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5,
    fontSize: 12, color: '#a0b0c8' },
  badge: {
    width: 20, height: 20, borderRadius: '50%', background: '#122035',
    color: '#5a6a84', display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
  },
  spinner: {
    display: 'inline-block', width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)',
    borderTopColor: '#fff', borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const styleEl = document.createElement('style')
styleEl.textContent = BASE_STYLES + `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse-dot { 0%,100% { opacity: .3; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
`
document.head.appendChild(styleEl)

createRoot(document.getElementById('root')!).render(<Popup />)
