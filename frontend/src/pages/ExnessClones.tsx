import { useState, useEffect } from 'react'
import { apiFetch } from '../apiClient'

const API = '/api'

type Defaults = {
  default_source_dir: string
  default_parent_dir: string
  default_exness_exe: string
}

type CloneRow = {
  index: number
  destination_dir: string
  copy_ok: boolean
  launch_ok: boolean
  error?: string
}

export default function ExnessClones() {
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [count, setCount] = useState(5)
  const [sourceDir, setSourceDir] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [launchAfter, setLaunchAfter] = useState(true)
  const [loadingDefaults, setLoadingDefaults] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<CloneRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch(`${API}/exness-terminal-clone/defaults`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.ok) return
        setDefaults({
          default_source_dir: data.default_source_dir,
          default_parent_dir: data.default_parent_dir,
          default_exness_exe: data.default_exness_exe,
        })
        setSourceDir(data.default_source_dir ?? '')
        setParentDir(data.default_parent_dir ?? '')
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDefaults(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const run = async () => {
    setError(null)
    setResults(null)
    setSubmitting(true)
    try {
      const r = await apiFetch(`${API}/exness-terminal-clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: Math.min(50, Math.max(1, Math.floor(Number(count)) || 1)),
          source_dir: sourceDir.trim() || undefined,
          parent_dir: parentDir.trim() || undefined,
          launch_after: launchAfter,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setError(data.error ?? data.message ?? `Request failed (${r.status})`)
        return
      }
      setResults(Array.isArray(data.results) ? data.results : [])
    } catch {
      setError('Could not reach API. Is the backend running?')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card">
      <h2>Exness terminal clones (Windows)</h2>
      <p className="settings-desc" style={{ marginBottom: '1rem' }}>
        Each MetaTrader 5 instance needs its own installation folder. This tool copies your Exness MT5 folder with{' '}
        <code>robocopy</code> into <strong>EXNESS_clone_001</strong>, <strong>EXNESS_clone_002</strong>, … under the
        parent directory you choose, then optionally starts <code>terminal64.exe</code> in each clone so you can log in
        to separate accounts. First run may take a long time and use a lot of disk space.
      </p>
      {loadingDefaults && <p className="loading">Loading defaults…</p>}
      {!loadingDefaults && defaults && (
        <p className="settings-hint" style={{ marginBottom: '1rem' }}>
          Default source: <code>{defaults.default_exness_exe}</code> (must exist).
        </p>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <label htmlFor="exness-clone-count">Number of clones</label>
          <input
            id="exness-clone-count"
            type="number"
            min={1}
            max={50}
            step={1}
            value={count}
            onChange={(e) => setCount(Math.min(50, Math.max(1, Math.floor(Number(e.target.value)) || 1)))}
            style={{ display: 'block', marginTop: '0.25rem', width: '6rem', padding: '0.35rem' }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem', paddingBottom: '0.2rem' }}>
          <input
            type="checkbox"
            checked={launchAfter}
            onChange={(e) => setLaunchAfter(e.target.checked)}
          />
          Launch each terminal after copy
        </label>
      </div>

      <label htmlFor="exness-clone-source">Source folder (Exness MT5 root, contains terminal64.exe)</label>
      <input
        id="exness-clone-source"
        type="text"
        value={sourceDir}
        onChange={(e) => setSourceDir(e.target.value)}
        placeholder={defaults?.default_source_dir ?? 'C:\\Program Files\\MetaTrader 5 EXNESS'}
        style={{ display: 'block', width: '100%', maxWidth: '42rem', marginTop: '0.25rem', marginBottom: '1rem', padding: '0.4rem' }}
      />

      <label htmlFor="exness-clone-parent">Parent folder for clones (writable path)</label>
      <input
        id="exness-clone-parent"
        type="text"
        value={parentDir}
        onChange={(e) => setParentDir(e.target.value)}
        placeholder={defaults?.default_parent_dir ?? ''}
        style={{ display: 'block', width: '100%', maxWidth: '42rem', marginTop: '0.25rem', marginBottom: '1rem', padding: '0.4rem' }}
      />

      <button type="button" onClick={run} disabled={submitting}>
        {submitting ? 'Working… (copies can take several minutes)' : 'Create clones'}
      </button>

      {error && (
        <p className="loss" style={{ marginTop: '1rem' }}>
          {error}
        </p>
      )}

      {results && results.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>Results</h3>
          <div className="dashboard-table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Copy</th>
                  <th>Launch</th>
                  <th>Folder</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.index}>
                    <td>{row.index}</td>
                    <td>{row.copy_ok ? 'OK' : '—'}</td>
                    <td>{row.launch_ok ? 'OK' : '—'}</td>
                    <td style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{row.destination_dir}</td>
                    <td style={{ fontSize: '0.85rem' }}>{row.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
