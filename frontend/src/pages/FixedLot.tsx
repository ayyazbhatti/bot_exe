import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch, appendPanelKeyToWsUrl } from '../apiClient'

const API = '/api'
const FIXEDLOT_STORAGE_KEY = 'fixedlot_settings'

type Account = { id: string; label: string }

const DEFAULT_ACCOUNTS_FALLBACK: Account[] = [
  { id: 'default', label: 'MT5 (Default)' },
  { id: 'exness', label: 'MT5 - EXNESS' },
]

/** Preset: major USD pairs (no suffix). */
const MAJOR_USD_SYMBOLS = [
  'AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDCNH', 'USDJPY', 'USDSEK',
]
/** Preset: common symbols with "m" suffix (e.g. Exness). Selection is persisted. */
const MAJOR_M_SYMBOLS = [
  'AUDUSDm', 'BTCUSDm', 'ETHUSDm', 'EURUSDm', 'GBPUSDm', 'USDCHFm', 'USDJPYm', 'XAUUSDm',
]

type FixedLotSaved = {
  /** Legacy single account */
  accountId?: string
  accountIds?: string[]
  minVolume?: number
  maxVolume?: number
  minIntervalMinutes?: number
  maxIntervalMinutes?: number
  selectedSymbols?: string[]
  intervalEnabled?: boolean
  lastDirection?: 'buy' | 'sell' | null
  maxOpenPositions?: number
}

function loadFixedLotSettings(): FixedLotSaved {
  try {
    const raw = localStorage.getItem(FIXEDLOT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as FixedLotSaved
    return parsed
  } catch {
    return {}
  }
}

function initialAccountIds(): string[] {
  const s = loadFixedLotSettings()
  if (Array.isArray(s.accountIds) && s.accountIds.length > 0) return s.accountIds
  if (s.accountId) return [s.accountId]
  return ['default']
}

function saveFixedLotSettings(s: FixedLotSaved) {
  try {
    localStorage.setItem(FIXEDLOT_STORAGE_KEY, JSON.stringify(s))
  } catch (_) {}
}

function sortIdsByAccountsOrder(ids: string[], accts: Account[]): string[] {
  const order = new Map(accts.map((a, i) => [a.id, i]))
  return [...ids].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999))
}

function randomVolume(min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const range = (hi - lo) || 0
  const v = lo + Math.random() * range
  return Math.round(v * 100) / 100
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'any moment'
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${min} min ${sec} sec`
  return `${sec} sec`
}

function NextRunCountdown({ nextRunAt }: { nextRunAt: Date }) {
  const [label, setLabel] = useState(() => formatCountdown(nextRunAt.getTime() - Date.now()))
  useEffect(() => {
    const tick = () => setLabel(formatCountdown(nextRunAt.getTime() - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [nextRunAt])
  return <>{label}</>
}

type LiveTick = { bid: number; ask: number }

function asLiveTick(v: unknown): LiveTick | null {
  if (!v || typeof v !== 'object') return null
  const x = v as { bid?: unknown; ask?: unknown }
  if (typeof x.bid !== 'number' || typeof x.ask !== 'number') return null
  return { bid: x.bid, ask: x.ask }
}

function spreadPips(symbol: string, tick: LiveTick): number {
  const pip = symbol.includes('JPY') ? 0.01 : 0.0001
  return (tick.ask - tick.bid) / pip
}

export default function FixedLot() {
  const [accounts, setAccounts] = useState<Account[]>(DEFAULT_ACCOUNTS_FALLBACK)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(initialAccountIds)
  const [symbolsByAccount, setSymbolsByAccount] = useState<Record<string, string[]>>({})
  const [minVolume, setMinVolume] = useState(() => loadFixedLotSettings().minVolume ?? 0.01)
  const [maxVolume, setMaxVolume] = useState(() => loadFixedLotSettings().maxVolume ?? 0.1)
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(() => loadFixedLotSettings().minIntervalMinutes ?? 10)
  const [maxIntervalMinutes, setMaxIntervalMinutes] = useState(() => loadFixedLotSettings().maxIntervalMinutes ?? 15)
  const [symbols, setSymbols] = useState<string[]>([])
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(() => loadFixedLotSettings().selectedSymbols ?? [])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [closingAll, setClosingAll] = useState(false)
  const [intervalEnabled, setIntervalEnabled] = useState(() => loadFixedLotSettings().intervalEnabled ?? false)
  const [scheduleKey, setScheduleKey] = useState(0)
  const [lastDirection, setLastDirection] = useState<'buy' | 'sell' | null>(() => loadFixedLotSettings().lastDirection ?? null)
  const [maxOpenPositions, setMaxOpenPositions] = useState<number>(() => Math.max(0, Math.floor(Number(loadFixedLotSettings().maxOpenPositions) || 0)))
  const [nextRunAt, setNextRunAt] = useState<Date | null>(null)
  const [eurUsdTick, setEurUsdTick] = useState<LiveTick | null>(null)
  const [eurUsdSymbol, setEurUsdSymbol] = useState<string>('EURUSD')
  const [priceLiveConnected, setPriceLiveConnected] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runNowRef = useRef<() => Promise<void>>(() => Promise.resolve())

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      appendPanelKeyToWsUrl(`${proto}//${window.location.host}/ws/positions`),
    )
    ws.onopen = () => setPriceLiveConnected(true)
    ws.onerror = () => setPriceLiveConnected(false)
    ws.onclose = () => setPriceLiveConnected(false)
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { ok?: boolean; prices?: Record<string, unknown> }
        if (!data?.ok || !data.prices) return
        const direct = asLiveTick(data.prices.EURUSD)
        if (direct) {
          setEurUsdTick(direct)
          setEurUsdSymbol('EURUSD')
          return
        }
        const m = asLiveTick(data.prices.EURUSDm)
        if (m) {
          setEurUsdTick(m)
          setEurUsdSymbol('EURUSDm')
        }
      } catch {
        // Ignore malformed frames and keep last known tick.
      }
    }
    return () => {
      // Same dev StrictMode behavior as App.tsx: avoid close() on CONNECTING.
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    }
  }, [])

  useEffect(() => {
    saveFixedLotSettings({
      accountIds: selectedAccountIds,
      minVolume,
      maxVolume,
      minIntervalMinutes,
      maxIntervalMinutes,
      selectedSymbols,
      intervalEnabled,
      lastDirection,
      maxOpenPositions,
    })
  }, [
    selectedAccountIds,
    minVolume,
    maxVolume,
    minIntervalMinutes,
    maxIntervalMinutes,
    selectedSymbols,
    intervalEnabled,
    lastDirection,
    maxOpenPositions,
  ])

  useEffect(() => {
    let cancelled = false
    apiFetch(`${API}/accounts`)
      .then((r) => r.json())
      .then((data: { ok?: boolean; accounts?: Account[] }) => {
        if (cancelled || !data?.ok || !Array.isArray(data.accounts) || data.accounts.length === 0) return
        setAccounts(data.accounts)
        const saved = initialAccountIds()
        const valid = saved.filter((id) => data.accounts!.some((a) => a.id === id))
        if (valid.length > 0) {
          setSelectedAccountIds(sortIdsByAccountsOrder(valid, data.accounts))
        } else {
          setSelectedAccountIds([data.accounts[0].id])
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggleAccountId = (id: string) => {
    setSelectedAccountIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return sortIdsByAccountsOrder(
          prev.filter((x) => x !== id),
          accounts
        )
      }
      return sortIdsByAccountsOrder([...prev, id], accounts)
    })
  }

  const fetchSymbols = useCallback(async () => {
    if (selectedAccountIds.length === 0) {
      setSymbols([])
      setSymbolsByAccount({})
      return
    }
    setLoading(true)
    setMsg(null)
    try {
      const results = await Promise.all(
        selectedAccountIds.map(async (id) => {
          const r = await apiFetch(`${API}/symbols?account_id=${encodeURIComponent(id)}`)
          const data = await r.json().catch(() => ({}))
          const list = r.ok && data.ok && Array.isArray(data.symbols) ? data.symbols : []
          return { id, list, err: r.ok && data.ok ? null : (data.error || data.message || 'Failed') }
        })
      )
      const byAcc: Record<string, string[]> = {}
      const union = new Set<string>()
      const errs: string[] = []
      for (const { id, list, err } of results) {
        byAcc[id] = list
        list.forEach((s: string) => union.add(s))
        if (err && list.length === 0) errs.push(`${id}: ${err}`)
      }
      setSymbolsByAccount(byAcc)
      setSymbols([...union].sort())
      if (errs.length > 0 && union.size === 0) {
        setMsg({ type: 'error', text: errs.join(' ') })
      }
    } catch {
      setSymbols([])
      setSymbolsByAccount({})
      setMsg({ type: 'error', text: 'Failed to fetch symbols' })
    } finally {
      setLoading(false)
    }
  }, [selectedAccountIds])

  useEffect(() => {
    fetchSymbols()
  }, [fetchSymbols])

  useEffect(() => {
    if (symbols.length === 0) return
    setSelectedSymbols((prev) => prev.filter((s) => symbols.includes(s)))
  }, [symbols])

  const toggleSymbol = (s: string) => {
    setSelectedSymbols((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort()
    )
  }
  const selectAll = () => setSelectedSymbols([...symbols].sort())
  const clearAll = () => setSelectedSymbols([])
  const selectMajorUsd = () => {
    const available = MAJOR_USD_SYMBOLS.filter((s) => symbols.includes(s))
    setSelectedSymbols([...available].sort())
  }
  const selectMajorM = () => {
    const available = MAJOR_M_SYMBOLS.filter((s) => symbols.includes(s))
    setSelectedSymbols([...available].sort())
  }

  const pool = selectedSymbols.length > 0 ? selectedSymbols : symbols

  const pickSymbolForAccount = (accId: string): string | null => {
    const avail = symbolsByAccount[accId] ?? []
    const base = selectedSymbols.length > 0 ? selectedSymbols.filter((s) => symbols.includes(s)) : symbols
    const valid = base.filter((s) => avail.includes(s))
    const list = valid.length > 0 ? valid : avail
    if (list.length === 0) return null
    return list[Math.floor(Math.random() * list.length)]
  }

  const runNow = async () => {
    if (selectedAccountIds.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one account.' })
      return
    }
    if (pool.length === 0) {
      setMsg({
        type: 'error',
        text: 'No symbols. Load symbols and select at least one (or wait for symbols after selecting accounts).',
      })
      return
    }

    let orderType: 'buy' | 'sell'
    if (lastDirection === 'buy') {
      orderType = 'sell'
    } else if (lastDirection === 'sell') {
      orderType = 'buy'
    } else {
      orderType = Math.random() < 0.5 ? 'buy' : 'sell'
    }
    setLastDirection(orderType)
    setMsg(null)
    setSubmitting(true)

    const vol = Math.max(0.01, randomVolume(minVolume, maxVolume))
    const lines: string[] = []

    try {
      for (const accId of selectedAccountIds) {
        const label = accounts.find((a) => a.id === accId)?.label ?? accId

        if (maxOpenPositions > 0) {
          try {
            const r = await apiFetch(`${API}/positions?account_id=${encodeURIComponent(accId)}`)
            const data = await r.json().catch(() => ({}))
            const positions = Array.isArray(data?.positions) ? data.positions : []
            if (positions.length >= maxOpenPositions) {
              lines.push(`${label}: skipped (≥${maxOpenPositions} open)`)
              continue
            }
          } catch {
            lines.push(`${label}: skipped (could not check positions)`)
            continue
          }
        }

        const symbol = pickSymbolForAccount(accId)
        if (!symbol) {
          lines.push(`${label}: no symbol (not available on this terminal)`)
          continue
        }

        const r = await apiFetch(`${API}/positions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol,
            order_type: orderType,
            volume: vol,
            account_id: accId,
            comment: 'fixedlot',
          }),
        })
        const data = await r.json().catch(() => ({}))
        if (data?.ok) {
          lines.push(`${label}: ${symbol} ${orderType} ${vol} lots`)
        } else {
          lines.push(`${label}: ${data?.message || data?.error || 'failed'}`)
        }
      }

      const anyOk = lines.some((l) => l.includes(' lots'))
      if (lines.length === 0) {
        setMsg({ type: 'error', text: 'Nothing to place.' })
      } else if (anyOk) {
        setMsg({ type: 'success', text: lines.join(' · ') })
      } else {
        setMsg({ type: 'error', text: lines.join(' · ') })
      }
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setSubmitting(false)
    }
  }

  const closeAllSelected = async () => {
    if (selectedAccountIds.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one account.' })
      return
    }
    setMsg(null)
    setClosingAll(true)
    try {
      const r = await apiFetch(`${API}/positions/close-selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: selectedAccountIds }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok && data?.ok) {
        setMsg({
          type: 'success',
          text: data?.message || `Closed positions on ${selectedAccountIds.length} selected account(s).`,
        })
      } else {
        setMsg({ type: 'error', text: data?.error || data?.message || `Failed (${r.status})` })
      }
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setClosingAll(false)
    }
  }

  runNowRef.current = runNow

  useEffect(() => {
    if (!intervalEnabled || pool.length === 0 || selectedAccountIds.length === 0) {
      setNextRunAt(null)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }
    const minSec = Math.max(30, minIntervalMinutes * 60)
    const maxSec = Math.max(minSec, maxIntervalMinutes * 60)
    const delaySec = minSec + Math.random() * (maxSec - minSec)
    const at = new Date(Date.now() + delaySec * 1000)
    setNextRunAt(at)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runNowRef.current().then(() => setScheduleKey((k) => k + 1))
    }, delaySec * 1000)
    return () => {
      setNextRunAt(null)
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [intervalEnabled, minIntervalMinutes, maxIntervalMinutes, pool.length, selectedAccountIds.length, scheduleKey])

  const accountButtonSummary = (() => {
    const labels = selectedAccountIds
      .map((id) => accounts.find((a) => a.id === id)?.label ?? id)
      .filter(Boolean)
    if (labels.length === 0) return 'Select accounts…'
    if (labels.length === 1) return labels[0]
    if (labels.length <= 2) return labels.join(' + ')
    return `${labels.length} accounts`
  })()

  return (
    <div className="fixedlot-page">
      <div className="card trading-card fixedlot-card">
        <div className="trading-card-header">
          <div>
            <h2>Random lot worker</h2>
            <p className="fixedlot-header-sub">Automated single-side orders with random volume and alternating buy/sell bias.</p>
          </div>
          <span className="trading-badge">Single account mode</span>
        </div>

        <p className="fixedlot-lede">
          Pick one or more MT5 terminals, define lot range and optional symbol whitelist, then run on demand or on a randomised schedule. EUR/USD ticks stream below for a quick sanity check on feed latency.
        </p>

        <div className="fixedlot-live-row" aria-live="polite">
          <div className="fixedlot-live-chip fixedlot-live-price">
            <strong className="fixedlot-chip-label">EURUSD live</strong>
            <span className="fixedlot-mono">
              {eurUsdTick
                ? `${eurUsdTick.bid.toFixed(5)}  ·  ${eurUsdTick.ask.toFixed(5)}`
                : 'Waiting for ticks…'}
            </span>
          </div>
          <div className="fixedlot-live-chip fixedlot-live-spread">
            <strong className="fixedlot-chip-label">Spread</strong>
            <span className="fixedlot-mono">{eurUsdTick ? `${spreadPips(eurUsdSymbol, eurUsdTick).toFixed(1)} pips` : '—'}</span>
          </div>
          <div className={`fixedlot-live-chip fixedlot-live-feed ${priceLiveConnected ? '' : 'offline'}`}>
            <strong className="fixedlot-chip-label">Feed</strong>
            <span>
              {priceLiveConnected ? 'WebSocket connected' : 'Reconnecting…'}
              {eurUsdSymbol ? ` · ${eurUsdSymbol}` : ''}
            </span>
          </div>
        </div>

        <div className="trading-section-divider" />

        <div className="worker-block fixedlot-block">
          <span className="worker-block-label">Accounts &amp; position sizing</span>
          <div className="fixedlot-config-grid">
            <div className="account-multiselect fixedlot-account-picker" ref={accountMenuRef}>
              <label id="fixedlot-account-label">MT5 terminals</label>
              <button
                type="button"
                id="fixedlot-account"
                className="account-multiselect-toggle"
                aria-expanded={accountMenuOpen}
                aria-haspopup="listbox"
                aria-labelledby="fixedlot-account-label"
                onClick={() => setAccountMenuOpen((o) => !o)}
              >
                <span className="account-multiselect-summary" title={accountButtonSummary}>
                  {accountButtonSummary}
                </span>
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
              {accountMenuOpen && (
                <div className="account-multiselect-panel" role="listbox" aria-multiselectable>
                  {accounts.map((a) => (
                    <label key={a.id} className="account-multiselect-option">
                      <input
                        type="checkbox"
                        checked={selectedAccountIds.includes(a.id)}
                        onChange={() => toggleAccountId(a.id)}
                      />
                      <span>{a.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="fixedlot-field">
              <label htmlFor="fixedlot-min">Min volume (lots)</label>
              <input
                id="fixedlot-min"
                type="number"
                min={0.01}
                step={0.01}
                value={minVolume}
                onChange={(e) => setMinVolume(Math.max(0.01, Number(e.target.value) || 0.01))}
              />
            </div>
            <div className="fixedlot-field">
              <label htmlFor="fixedlot-max">Max volume (lots)</label>
              <input
                id="fixedlot-max"
                type="number"
                min={0.01}
                step={0.01}
                value={maxVolume}
                onChange={(e) => setMaxVolume(Math.max(0.01, Number(e.target.value) || 0.01))}
              />
            </div>
            <div className="fixedlot-field">
              <label htmlFor="fixedlot-max-positions" title="0 = no limit. Per account: skip when open count reaches this.">
                Max open positions
              </label>
              <input
                id="fixedlot-max-positions"
                type="number"
                min={0}
                step={1}
                value={maxOpenPositions}
                onChange={(e) => setMaxOpenPositions(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </div>
          </div>
          <p className="worker-block-hint fixedlot-hint-muted">
            Volume is random between min and max on each run. Max open positions applies per selected terminal (0 means no cap).
          </p>
        </div>

        <div className="worker-block fixedlot-block">
          <span className="worker-block-label">Schedule window</span>
          <p className="fixedlot-section-desc">When interval mode is on, the worker waits a random duration between these bounds before each run (minimum 30 seconds enforced).</p>
          <div className="fixedlot-schedule-grid">
            <div className="fixedlot-field">
              <label htmlFor="fixedlot-min-int">Min interval (minutes)</label>
              <input
                id="fixedlot-min-int"
                type="number"
                min={0.5}
                max={1440}
                step={0.5}
                value={minIntervalMinutes}
                onChange={(e) => {
                  const v = Math.max(0.5, Math.min(1440, Number(e.target.value) || 10))
                  setMinIntervalMinutes(v)
                  if (v > maxIntervalMinutes) setMaxIntervalMinutes(v)
                }}
              />
            </div>
            <div className="fixedlot-field">
              <label htmlFor="fixedlot-max-int">Max interval (minutes)</label>
              <input
                id="fixedlot-max-int"
                type="number"
                min={1}
                max={1440}
                step={0.5}
                value={maxIntervalMinutes}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(1440, Number(e.target.value) || 15))
                  setMaxIntervalMinutes(v)
                  if (v < minIntervalMinutes) setMinIntervalMinutes(v)
                }}
              />
            </div>
          </div>
        </div>

        <div className="trading-section-divider" />

        <div className="fixedlot-symbols-head">
          <div>
            <span className="worker-block-label fixedlot-symbols-title">Symbol universe</span>
            <p className="fixedlot-section-desc">
              Leave none selected to allow any loaded symbol per account. Presets help you narrow majors quickly.
            </p>
          </div>
          {!loading && symbols.length > 0 && (
            <div className="fixedlot-symbol-badges">
              <span className="trading-badge subtle">{symbols.length} loaded</span>
              {selectedSymbols.length > 0 && (
                <span className="trading-badge">{selectedSymbols.length} selected</span>
              )}
            </div>
          )}
        </div>
        <div className="symbol-checkbox-actions fixedlot-preset-actions">
          <button type="button" className="fixedlot-preset-btn" onClick={selectAll} disabled={symbols.length === 0}>
            Select all
          </button>
          <button type="button" className="fixedlot-preset-btn" onClick={clearAll} disabled={symbols.length === 0}>
            Clear all
          </button>
          <button type="button" className="fixedlot-preset-btn" onClick={selectMajorUsd} disabled={symbols.length === 0}>
            Major USD
          </button>
          <button type="button" className="fixedlot-preset-btn" onClick={selectMajorM} disabled={symbols.length === 0}>
            Major (m)
          </button>
        </div>
        {loading && (
          <p className="loading fixedlot-loading">Loading symbols from selected terminals…</p>
        )}
        {!loading && symbols.length === 0 && (
          <div className="fixedlot-empty-panel">
            <p className="settings-hint">Select at least one account. Symbols appear here when MT5 is running and reachable.</p>
          </div>
        )}
        {!loading && symbols.length > 0 && (
          <div className="symbol-checkbox-list fixedlot-symbol-grid">
            {symbols.map((s) => (
              <label key={s} className="symbol-checkbox-item">
                <input
                  type="checkbox"
                  checked={selectedSymbols.includes(s)}
                  onChange={() => toggleSymbol(s)}
                />
                <span>{s}</span>
              </label>
            ))}
          </div>
        )}

        <div className="trading-section-divider" />

        <div className="fixedlot-actions">
          <div className="fixedlot-actions-row">
            <button
              type="button"
              className="fixedlot-btn-run"
              onClick={runNow}
              disabled={submitting || closingAll || pool.length === 0 || selectedAccountIds.length === 0}
            >
              {submitting ? 'Placing orders…' : 'Run now'}
            </button>
            <button
              type="button"
              className="btn-danger fixedlot-btn-close"
              onClick={closeAllSelected}
              disabled={submitting || closingAll || selectedAccountIds.length === 0}
            >
              {closingAll ? 'Closing…' : 'Close all on selected'}
            </button>
          </div>
          <div className="fixedlot-automation">
            <label className="fixedlot-interval-label">
              <input
                type="checkbox"
                checked={intervalEnabled}
                onChange={(e) => setIntervalEnabled(e.target.checked)}
              />
              <span>
                Run on a random interval between{' '}
                <strong>{minIntervalMinutes}</strong> and <strong>{maxIntervalMinutes}</strong> minutes
              </span>
            </label>
            {intervalEnabled && pool.length > 0 && selectedAccountIds.length > 0 && nextRunAt && (
              <div className="fixedlot-countdown" role="status">
                <span className="fixedlot-countdown-dot" aria-hidden />
                Next automated run in{' '}
                <strong><NextRunCountdown nextRunAt={nextRunAt} /></strong>
              </div>
            )}
          </div>
        </div>

        {msg && (
          <div className={`msg ${msg.type === 'success' ? 'success' : 'error'} fixedlot-feedback`}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  )
}
