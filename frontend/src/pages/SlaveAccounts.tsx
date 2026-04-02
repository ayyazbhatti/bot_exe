import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../apiClient'

const API = '/api'

export default function SlaveAccounts() {
  const [exnessCopyCount, setExnessCopyCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [inputValue, setInputValue] = useState('1')

  const fetchConfig = useCallback(async () => {
    try {
      const r = await apiFetch(`${API}/exness-config`)
      const data = await r.json().catch(() => ({}))
      if (r.ok && data.ok && typeof data.exness_copy_count === 'number') {
        const n = Math.max(1, Math.floor(data.exness_copy_count))
        setExnessCopyCount(n)
        setInputValue(String(n))
      }
    } catch (_) {
      setExnessCopyCount(1)
      setInputValue('1')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      await fetchConfig()
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [fetchConfig])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const n = Math.floor(Number(inputValue))
    if (!Number.isFinite(n) || n < 1) {
      setMsg({ type: 'error', text: 'Enter a number ≥ 1' })
      return
    }
    setSaving(true)
    try {
      const r = await apiFetch(`${API}/exness-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exness_copy_count: n }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok && data.ok) {
        setExnessCopyCount(n)
        setInputValue(String(n))
        setMsg({ type: 'success', text: 'Saved. Exness will open volume ÷ ' + n + ' lots.' })
      } else {
        setMsg({ type: 'error', text: data.error ?? 'Failed to save' })
      }
    } catch (_) {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p className="loading">Loading…</p>
      </div>
    )
  }

  return (
    <div className="slave-accounts-page">
      {msg && (
        <div className={`msg ${msg.type}`} role="alert">
          {msg.text}
        </div>
      )}

      <div className="card">
        <h2>Exness copy hedge</h2>
        <p className="settings-desc">
          Broker B (e.g. IC Markets) opens the <strong>full</strong> volume. Exness has one account we control; we open <strong>volume ÷ N</strong> lots there. Copy trading replicates to N accounts, so total Exness exposure matches Broker B.
        </p>
        <form onSubmit={handleSave}>
          <div className="form-row">
            <label htmlFor="exness-copy-count">Number of Exness (copy) accounts (N)</label>
            <input
              id="exness-copy-count"
              type="number"
              min={1}
              max={999}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={saving}
            />
          </div>
          <p className="settings-hint" style={{ marginTop: 0 }}>
            e.g. N = 5 → Broker B 1 lot, Exness 0.2 lot. N = 2 → Broker B 1 lot, Exness 0.5 lot.
          </p>
          <button type="submit" disabled={saving}>
            Save
          </button>
        </form>
        <p className="settings-status" style={{ marginTop: '1rem' }}>
          Current: N = {exnessCopyCount}. Exness volume = Broker B volume ÷ {exnessCopyCount}.
        </p>
      </div>
    </div>
  )
}
