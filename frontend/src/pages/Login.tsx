import { useState } from 'react'
import { apiFetch } from '../apiClient'

const API = '/api'

export default function Login({
  onLoggedIn,
}: {
  onLoggedIn: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const body: { username: string; password: string; totp?: string } = {
        username: username.trim(),
        password,
      }
      if (totp.trim()) body.totp = totp.trim()
      const r = await apiFetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await r.json().catch(() => ({}))) as { error?: string; ok?: boolean }
      if (!r.ok && data.error === 'totp_required') {
        setNeedTotp(true)
        setErr('Enter the 6-digit code from your authenticator app.')
        return
      }
      if (!r.ok || data.ok === false) {
        setErr(data.error === 'invalid_credentials' ? 'Invalid username or password.' : data.error || `HTTP ${r.status}`)
        return
      }
      onLoggedIn()
    } catch {
      setErr('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-layout" style={{ placeItems: 'center', minHeight: '100vh' }}>
      <div className="card trading-card" style={{ maxWidth: '400px', width: '100%', margin: '2rem auto' }}>
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        <p className="muted">Operator account on the MT5 panel API.</p>
        <form onSubmit={submit} className="trading-form-grid one-col">
          <div className="form-row">
            <label htmlFor="login-user">Username</label>
            <input
              id="login-user"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="login-pass">Password</label>
            <input
              id="login-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {(needTotp || totp) && (
            <div className="form-row">
              <label htmlFor="login-totp">Authenticator code</label>
              <input
                id="login-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 digits"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>
          )}
          {err && <div className="msg error">{err}</div>}
          <button type="submit" className="fixedlot-btn-run" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
