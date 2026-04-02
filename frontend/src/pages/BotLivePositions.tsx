import { useState, useEffect, useRef, useMemo, useCallback, memo, type RefObject } from 'react'
import { apiFetch, apiUrl } from '../apiClient'
import {
  useRemotePositionsWebSocket,
  parseRemotePositionsResponse,
  type RemoteLiveAccountRow,
  type RemotePositionRow,
} from '../useRemotePositionsWebSocket'
import {
  usePositionsWebSocket,
  type LiveAccountPositions,
  type PositionsWsPayload,
} from '../usePositionsWebSocket'

export type Position = RemotePositionRow
export type AccountPositions = RemoteLiveAccountRow

export type HedgePair = {
  ticket_0: number
  account_0: string
  ticket_1: number
  account_1: string
  symbol: string
  created_at: string
  type_0?: string
  type_1?: string
  sl_pips_0?: number
  tp_pips_0?: number
  sl_pips_1?: number
  tp_pips_1?: number
}

const API = '/api'
/** Synthetic device id for rows from `/ws/positions` (MT5 on the panel server). */
const LOCAL_DEVICE_ID = '__local__'
const LIVEPOSITIONS_DEVICE_KEY = 'livepositions_selected_remote_device'

type DeviceApi = {
  device_id: string
  label: string
  probably_online?: boolean
  terminals?: { id: string; label: string; exe_path?: string }[]
}

/** Stable filter id (case-insensitive device + account; avoids UUID / id casing mismatches). */
function scopeKey(deviceId: string, accountId: string): string {
  return `${normAccount(deviceId)}|${normAccount(accountId)}`
}

function normAccount(a: string): string {
  return String(a ?? '').trim().toLowerCase()
}

/** Stable fingerprint of the allowed account scope ids (order-independent). */
function allowedScopeIdsKey(accounts: { id: string }[]): string {
  if (accounts.length === 0) return ''
  return [...accounts.map((a) => a.id)].sort().join('\x1e')
}

function loadSelectedDeviceId(): string {
  try {
    const s = localStorage.getItem(LIVEPOSITIONS_DEVICE_KEY)
    if (s != null && s.trim() !== '') return s.trim()
  } catch (_) {}
  return '__all__'
}

/** Human text from bridge_error (often JSON `{"ok":false,"error":"…"}` from mt5_bridge). */
function extractBridgeErrorDetail(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { error?: string; message?: string }
      const inner = (o.error ?? o.message ?? '').trim()
      if (inner) return inner
    } catch {
      /* ignore */
    }
  }
  return t
}

/** Group errors that only differ by terminal path. */
function bridgeErrorGroupSignature(detail: string): string {
  return detail
    .replace(/'[A-Za-z]:[^']*terminal64\.exe'/gi, "<terminal>")
    .replace(/\s+/g, ' ')
    .trim()
}

type BridgeErrorKind = 'terminal_process' | 'auth' | 'other'

function classifyBridgeError(detail: string): BridgeErrorKind {
  const u = detail.toLowerCase()
  if (
    u.includes('ipc initialize') ||
    u.includes('process create failed') ||
    u.includes('mt5 init failed') ||
    u.includes('-10003')
  ) {
    return 'terminal_process'
  }
  if (u.includes('login') && (u.includes('fail') || u.includes('invalid'))) {
    return 'auth'
  }
  return 'other'
}

function bridgeErrorHeadline(kind: BridgeErrorKind): string {
  switch (kind) {
    case 'terminal_process':
      return 'MetaTrader could not be started'
    case 'auth':
      return 'Sign-in or account issue'
    default:
      return 'Terminal or bridge error'
  }
}

function bridgeErrorGuidance(kind: BridgeErrorKind): string {
  switch (kind) {
    case 'terminal_process':
      return 'Open each affected MetaTrader, complete login, and leave it running. Verify the path to terminal64.exe in the remote agent config or panel clone settings.'
    case 'auth':
      return 'Log into the affected terminal in MT5 and confirm the account is active.'
    default:
      return 'Check the technical message below or logs on the PC running the agent or panel bridge.'
  }
}

type LiveBridgeErrorGroup = {
  key: string
  kind: BridgeErrorKind
  headline: string
  guidance: string
  exampleDetail: string
  labels: string[]
}

function buildBridgeErrorGroups(rows: RemoteLiveAccountRow[]): LiveBridgeErrorGroup[] {
  const byKey = new Map<string, LiveBridgeErrorGroup>()

  for (const r of rows) {
    if (!r.bridge_error) continue
    const detail = extractBridgeErrorDetail(r.bridge_error)
    if (!detail) continue
    const kind = classifyBridgeError(detail)
    const key = `${kind}:${bridgeErrorGroupSignature(detail)}`
    const label = `${r.device_label} — ${r.label}`
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.labels.includes(label)) existing.labels.push(label)
      continue
    }
    byKey.set(key, {
      key,
      kind,
      headline: bridgeErrorHeadline(kind),
      guidance: bridgeErrorGuidance(kind),
      exampleDetail: detail,
      labels: [label],
    })
  }

  return [...byKey.values()].sort((a, b) => b.labels.length - a.labels.length)
}

/** Fast poll when the socket is down; slow backup when live (avoids double-firing UI every ~2.5s). */
const POSITIONS_POLL_MS_FAST = 2500
const POSITIONS_POLL_MS_BACKUP = 30_000

function positionSymbolKey(p: RemotePositionRow): string {
  const s = String(p.symbol ?? '').trim()
  return s || '(no symbol)'
}

/** Which account scope keys appear in the feed for the current device filter (stable string; ignores position churn). */
/**
 * Whether a feed row matches the account multi-select.
 * Matches full `device|account` from the row, or any selected `device|suffix` where device and suffix
 * equal the row’s device and MT5 `account_id` (same logic for All devices and one device).
 */
function rowMatchesScopeSelection(
  r: RemoteLiveAccountRow,
  selectedScopeSet: Set<string>,
  selectedDeviceId: string,
): boolean {
  const rowKey = normAccount(scopeKey(r.device_id, r.account_id))
  if (selectedScopeSet.has(rowKey)) return true

  const rowDev = normAccount(r.device_id)
  const rowAcc = normAccount(r.account_id)

  for (const sid of selectedScopeSet) {
    const p = sid.lastIndexOf('|')
    if (p < 0) {
      if (selectedDeviceId !== '__all__' && rowDev === normAccount(selectedDeviceId) && normAccount(sid) === rowAcc) {
        return true
      }
      continue
    }
    const devPart = normAccount(sid.slice(0, p))
    const accPart = normAccount(sid.slice(p + 1))
    if (devPart === rowDev && accPart === rowAcc) return true
  }
  return false
}

function accountInventoryDigest(rows: RemoteLiveAccountRow[], selectedDeviceId: string): string {
  if (selectedDeviceId === '__all__') {
    const s = new Set<string>()
    for (const r of rows) {
      s.add(scopeKey(r.device_id, r.account_id))
    }
    return `all:${[...s].sort().join('\x1e')}`
  }
  const want = normAccount(selectedDeviceId)
  const s = new Set<string>()
  for (const r of rows) {
    if (normAccount(r.device_id) !== want) continue
    s.add(scopeKey(r.device_id, r.account_id))
  }
  return `one:${want}:${[...s].sort().join('\x1e')}`
}

type AccountFilterOption = { id: string; label: string }

/** Renders only when `accounts` / `summary` / selection-driven props change — not on every positions tick. */
const LivePositionsAccountDropdown = memo(function LivePositionsAccountDropdown({
  accounts,
  selectedScopeIds,
  summary,
  open,
  menuRef,
  onToggleOpen,
  onToggleScopeId,
  onSelectAll,
  onUnselectAll,
}: {
  accounts: AccountFilterOption[]
  selectedScopeIds: readonly string[]
  summary: string
  open: boolean
  menuRef: RefObject<HTMLDivElement>
  onToggleOpen: () => void
  onToggleScopeId: (id: string) => void
  onSelectAll: () => void
  onUnselectAll: () => void
}) {
  return (
    <div className="live-positions-accounts-surface remote-form-surface">
      <div className="form-row remote-form-field">
        <span className="remote-form-field-label" id="livepositions-account-filter-label">
          Accounts
        </span>
        <div className="remote-worker-accounts-dropdown" ref={menuRef}>
          <button
            type="button"
            id="livepositions-accounts-trigger"
            className="remote-worker-accounts-dropdown__trigger"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-labelledby="livepositions-account-filter-label livepositions-accounts-trigger"
            title={summary}
            onClick={onToggleOpen}
          >
            <span className="remote-worker-accounts-dropdown__trigger-text">{summary}</span>
            <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
              {open ? '▲' : '▼'}
            </span>
          </button>
          {open && (
            <div
              className="remote-worker-accounts-dropdown__panel"
              role="listbox"
              aria-multiselectable="true"
              aria-label="Accounts in remote live feed"
            >
              <div className="remote-worker-accounts-dropdown__bulk" role="presentation">
                <button
                  type="button"
                  className="remote-worker-accounts-dropdown__bulk-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectAll()
                  }}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="remote-worker-accounts-dropdown__bulk-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUnselectAll()
                  }}
                >
                  Unselect all
                </button>
              </div>
              {accounts.map((a) => {
                const checked = selectedScopeIds.includes(a.id)
                return (
                  <label key={a.id} className="remote-worker-accounts-dropdown__option">
                    <input type="checkbox" checked={checked} onChange={() => onToggleScopeId(a.id)} />
                    <span className="remote-worker-accounts-dropdown__option-text">{a.label}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * Live positions from the panel WebSocket (`/ws/positions`) plus remote paired agents (`/ws/remote-positions`).
 */
export default function BotLivePositions() {
  const {
    rows: remoteRows,
    lastUpdate: remoteLastUpdate,
    connected: remoteConnected,
  } = useRemotePositionsWebSocket()
  const localWsBroadcastRef = useRef<((data: PositionsWsPayload) => void) | null>(null)
  const {
    liveResults,
    liveLastUpdate: localLastUpdate,
    liveConnected: localConnected,
  } = usePositionsWebSocket(localWsBroadcastRef)

  const [pollLocalResults, setPollLocalResults] = useState<LiveAccountPositions[]>([])
  const [pollLocalLastUpdate, setPollLocalLastUpdate] = useState<Date | null>(null)
  const [pollRemoteResults, setPollRemoteResults] = useState<RemoteLiveAccountRow[]>([])
  const [pollRemoteLastUpdate, setPollRemoteLastUpdate] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    const parseRow = (x: unknown): LiveAccountPositions | null => {
      if (!x || typeof x !== 'object') return null
      const o = x as Record<string, unknown>
      const account_id = String(o.account_id ?? '').trim()
      if (!account_id) return null
      const be =
        typeof o.bridge_error === 'string' && o.bridge_error.trim() !== '' ? o.bridge_error.trim() : undefined
      return {
        account_id,
        label: String(o.label ?? account_id),
        positions: Array.isArray(o.positions) ? (o.positions as LiveAccountPositions['positions']) : [],
        ...(be ? { bridge_error: be } : {}),
      }
    }
    const tick = async () => {
      try {
        const r = await apiFetch(apiUrl(`${API}/positions/all`))
        const d = await r.json().catch(() => ({}))
        if (cancelled || !r.ok || !d?.ok || !Array.isArray(d.results)) return
        setPollLocalResults(
          d.results.map(parseRow).filter((x: LiveAccountPositions | null): x is LiveAccountPositions => x != null),
        )
        setPollLocalLastUpdate(new Date())
      } catch {
        /* ignore */
      }
    }
    void tick()
    const intervalMs = localConnected ? POSITIONS_POLL_MS_BACKUP : POSITIONS_POLL_MS_FAST
    const id = window.setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [localConnected])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const r = await apiFetch(apiUrl(`${API}/agent/remote-positions`))
        const d = await r.json().catch(() => ({}))
        if (cancelled) return
        if (!r.ok) return
        setPollRemoteResults(parseRemotePositionsResponse(d))
        setPollRemoteLastUpdate(new Date())
      } catch {
        /* ignore */
      }
    }
    void tick()
    const intervalMs = remoteConnected ? POSITIONS_POLL_MS_BACKUP : POSITIONS_POLL_MS_FAST
    const id = window.setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [remoteConnected])

  /**
   * When WS is live, use it only — no merge with poll (merge caused row counts to flip each tick).
   * If the socket delivers an empty `results` array while HTTP still has rows, treat WS as a glitch
   * and keep the last HTTP snapshot (empty snapshots happen between agent chunks or on bad frames).
   */
  const panelLocalSource = useMemo(() => {
    if (localConnected && localLastUpdate != null) {
      if (liveResults.length === 0 && pollLocalResults.length > 0) return pollLocalResults
      return liveResults
    }
    return pollLocalResults
  }, [localConnected, localLastUpdate, liveResults, pollLocalResults])

  const localRows = useMemo((): RemoteLiveAccountRow[] => {
    return panelLocalSource.map((r) => ({
      device_id: LOCAL_DEVICE_ID,
      device_label: 'This panel',
      account_id: r.account_id,
      label: r.label,
      positions: Array.isArray(r.positions) ? (r.positions as RemotePositionRow[]) : [],
      ...(r.bridge_error ? { bridge_error: r.bridge_error } : {}),
    }))
  }, [panelLocalSource])

  const mergedRemoteRows = useMemo(() => {
    if (remoteConnected && remoteLastUpdate != null) {
      if (remoteRows.length === 0 && pollRemoteResults.length > 0) return pollRemoteResults
      return remoteRows
    }
    return pollRemoteResults
  }, [remoteConnected, remoteLastUpdate, remoteRows, pollRemoteResults])

  const remoteFeedActive = remoteConnected || pollRemoteLastUpdate != null
  const remoteFeedLastUpdate = useMemo(() => {
    if (!remoteLastUpdate && !pollRemoteLastUpdate) return null
    if (!remoteLastUpdate) return pollRemoteLastUpdate
    if (!pollRemoteLastUpdate) return remoteLastUpdate
    return remoteLastUpdate >= pollRemoteLastUpdate ? remoteLastUpdate : pollRemoteLastUpdate
  }, [remoteLastUpdate, pollRemoteLastUpdate])

  const rows = useMemo(() => [...localRows, ...mergedRemoteRows], [localRows, mergedRemoteRows])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const [devices, setDevices] = useState<DeviceApi[]>([])
  const [devicesLoadError, setDevicesLoadError] = useState<string | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState(loadSelectedDeviceId)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  /** When true, empty `selectedScopeIds` is intentional (Unselect all); do not auto-fill all on live data ticks. */
  const accountFilterAllowEmptyRef = useRef(false)
  /** Default is all accounts in view; not persisted (refresh = all again). */
  const [selectedScopeIds, setSelectedScopeIds] = useState<string[]>([])
  /** Latest account list for effects (avoid depending on a new array reference every positions tick). */
  const allAccountsForFilterRef = useRef<{ id: string; label: string }[]>([])
  /** After user changes Device, select all accounts for that view once the list is available. */
  const pendingSelectAllForDeviceRef = useRef(false)
  const lastScopeDeviceRef = useRef<string | null>(null)
  /** Previous stable allowed-id key (for detecting new accounts → keep default “all”). */
  const lastAccountIdsKeyRef = useRef<string>('')

  useEffect(() => {
    if (selectedDeviceId === '__all__' || selectedDeviceId === LOCAL_DEVICE_ID) return
    if (devices.length === 0) return
    if (!devices.some((d) => d.device_id === selectedDeviceId)) {
      setSelectedDeviceId('__all__')
    }
  }, [devices, selectedDeviceId])

  useEffect(() => {
    accountFilterAllowEmptyRef.current = false
  }, [selectedDeviceId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await apiFetch(apiUrl(`${API}/agent/devices`))
        const data = await r.json().catch(() => ({}))
        if (cancelled) return
        if (r.ok && data.ok && Array.isArray(data.devices)) {
          setDevicesLoadError(null)
          setDevices(data.devices as DeviceApi[])
          return
        }
        if (r.status === 404) {
          setDevicesLoadError(
            'Panel API returned 404 for GET /api/agent/devices. Rebuild and restart mt5-panel-api (this route was added recently), or set VITE_API_ORIGIN to your API URL if the Vite proxy target port is wrong.',
          )
          return
        }
        setDevicesLoadError(r.status === 401 ? 'Sign in required to load devices.' : `Could not load devices (HTTP ${r.status}).`)
      } catch {
        if (!cancelled) setDevicesLoadError('Could not reach the panel API. Is it running, and does frontend API_PORT match backend PORT?')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LIVEPOSITIONS_DEVICE_KEY, selectedDeviceId)
    } catch (_) {}
  }, [selectedDeviceId])

  useEffect(() => {
    if (!accountMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = accountMenuRef.current
      if (el && !el.contains(e.target as Node)) setAccountMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [accountMenuOpen])

  const scopedRows = useMemo(() => {
    if (selectedDeviceId === '__all__') return rows
    const want = normAccount(selectedDeviceId)
    return rows.filter((r) => normAccount(r.device_id) === want)
  }, [rows, selectedDeviceId])

  /** Feed account keys only (not positions); memo stable while open positions update. */
  const accountInvDigest = useMemo(
    () => accountInventoryDigest(rows, selectedDeviceId),
    [rows, selectedDeviceId],
  )

  /**
   * Inventory = configured terminals (API) ∪ accounts seen in feed — not “who has an open trade right now”.
   * Prevents the dropdown and selection from thrashing when flat accounts drop out of `rows`.
   */
  const allAccountsForFilter = useMemo((): AccountFilterOption[] => {
    const live = rowsRef.current
    if (selectedDeviceId === '__all__') {
      /** Same as single-device: feed `account_id` first so checkboxes align with row keys; API terminals only for gaps. */
      const m = new Map<string, AccountFilterOption>()
      for (const r of live) {
        const id = scopeKey(r.device_id, r.account_id)
        m.set(id, { id, label: `${r.device_label} — ${r.label}` })
      }
      for (const d of devices) {
        const dl = d.label || d.device_id
        for (const t of d.terminals ?? []) {
          const id = scopeKey(d.device_id, t.id)
          if (!m.has(id)) {
            m.set(id, { id, label: `${dl} — ${t.label || t.id} (${t.id})` })
          }
        }
      }
      return [...m.values()]
    }
    /** Prefer MT5 `account_id` from the feed so checkbox ids align with `scopeKey` on rows; terminals fill gaps (flat accounts). */
    const m = new Map<string, AccountFilterOption>()
    const want = normAccount(selectedDeviceId)
    const dev = devices.find((d) => d.device_id === selectedDeviceId)
    for (const r of live) {
      if (normAccount(r.device_id) !== want) continue
      const id = scopeKey(r.device_id, r.account_id)
      m.set(id, { id, label: r.label })
    }
    for (const t of dev?.terminals ?? []) {
      const id = scopeKey(selectedDeviceId, t.id)
      if (!m.has(id)) {
        m.set(id, { id, label: `${t.label || t.id} (${t.id})` })
      }
    }
    return [...m.values()]
  }, [selectedDeviceId, devices, accountInvDigest])

  allAccountsForFilterRef.current = allAccountsForFilter

  /** Primitive: changes only when the set of selectable account scope ids changes (not on array identity churn). */
  const stableAllowedIdsKey = useMemo(
    () => allowedScopeIdsKey(allAccountsForFilter),
    [allAccountsForFilter],
  )

  useEffect(() => {
    const prev = lastScopeDeviceRef.current
    lastScopeDeviceRef.current = selectedDeviceId
    if (prev !== null && prev !== selectedDeviceId) {
      accountFilterAllowEmptyRef.current = false
      pendingSelectAllForDeviceRef.current = true
    }
  }, [selectedDeviceId])

  /**
   * Keep default = all accounts: fill when empty, after device change, and when new accounts appear (strict superset).
   * Respects “Unselect all” via accountFilterAllowEmptyRef.
   */
  useEffect(() => {
    const key = stableAllowedIdsKey
    const list = allAccountsForFilterRef.current

    if (pendingSelectAllForDeviceRef.current) {
      if (list.length === 0) return
      pendingSelectAllForDeviceRef.current = false
      lastAccountIdsKeyRef.current = key
      setSelectedScopeIds(list.map((a) => a.id))
      return
    }

    if (accountFilterAllowEmptyRef.current) {
      lastAccountIdsKeyRef.current = key
      return
    }

    if (list.length === 0) {
      lastAccountIdsKeyRef.current = key
      return
    }

    const allIds = list.map((a) => a.id)
    const prevKey = lastAccountIdsKeyRef.current
    const oldSet = new Set(prevKey ? prevKey.split('\x1e') : [])
    const newSet = new Set(allIds)
    const isStrictSuperset =
      oldSet.size > 0 && oldSet.size < newSet.size && [...oldSet].every((id) => newSet.has(id))

    setSelectedScopeIds((prev) => {
      if (prev.length === 0) return allIds
      if (isStrictSuperset) {
        const out = new Set(prev)
        for (const id of newSet) {
          if (!oldSet.has(id)) out.add(id)
        }
        return [...out].filter((id) => newSet.has(id))
      }
      return prev
    })

    lastAccountIdsKeyRef.current = key
  }, [stableAllowedIdsKey, selectedDeviceId])

  /** Drop ids that stay absent from the account list — debounced so incremental WS snapshots do not strip selection. */
  useEffect(() => {
    if (accountFilterAllowEmptyRef.current) return
    const list = allAccountsForFilterRef.current
    if (list.length === 0) return
    const allowed = new Set(list.map((a) => a.id))
    const timer = window.setTimeout(() => {
      setSelectedScopeIds((prev) => {
        const pruned = prev.filter((id) => allowed.has(id))
        return pruned.length === prev.length ? prev : pruned
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [stableAllowedIdsKey])

  const toggleScopeId = useCallback((id: string) => {
    accountFilterAllowEmptyRef.current = false
    setSelectedScopeIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((x) => x !== id)
      }
      return [...prev, id]
    })
  }, [])

  const selectAllAccountsInDropdown = useCallback(() => {
    accountFilterAllowEmptyRef.current = false
    const list = allAccountsForFilterRef.current
    setSelectedScopeIds(list.map((a) => a.id))
  }, [])

  const unselectAllAccountsInDropdown = useCallback(() => {
    accountFilterAllowEmptyRef.current = true
    setSelectedScopeIds([])
  }, [])

  const onToggleAccountMenu = useCallback(() => {
    setAccountMenuOpen((o) => !o)
  }, [])

  const liveAccountDropdownSummary = useMemo(() => {
    if (allAccountsForFilter.length === 0) return 'No accounts'
    if (selectedScopeIds.length === 0) return 'Select accounts…'
    if (selectedScopeIds.length === allAccountsForFilter.length) return 'All accounts'
    if (selectedScopeIds.length <= 2) {
      return selectedScopeIds
        .map((id) => allAccountsForFilter.find((a) => a.id === id)?.label ?? id)
        .join(', ')
    }
    return `${selectedScopeIds.length} accounts selected`
  }, [allAccountsForFilter, selectedScopeIds])

  const { filteredResults, accountSelectionMismatch } = useMemo(() => {
    if (selectedScopeIds.length === 0) {
      return { filteredResults: scopedRows, accountSelectionMismatch: false }
    }
    const selectedScopeSet = new Set(selectedScopeIds.map((id) => normAccount(id)))
    const strict = scopedRows.filter((r) => rowMatchesScopeSelection(r, selectedScopeSet, selectedDeviceId))
    const mismatch = strict.length === 0 && scopedRows.length > 0
    return { filteredResults: strict, accountSelectionMismatch: mismatch }
  }, [scopedRows, selectedScopeIds, selectedDeviceId])

  const totalCount = filteredResults.reduce((n, a) => n + a.positions.length, 0)
  const accountRowsInView = filteredResults.length

  const bySymbol = new Map<string, { account: RemoteLiveAccountRow; position: RemotePositionRow }[]>()
  for (const account of filteredResults) {
    for (const position of account.positions) {
      const sym = positionSymbolKey(position)
      if (!bySymbol.has(sym)) bySymbol.set(sym, [])
      bySymbol.get(sym)!.push({ account, position })
    }
  }

  const combinedPnl = filteredResults.reduce(
    (sum, a) => sum + a.positions.reduce((s, p) => s + (p.profit ?? 0), 0),
    0,
  )

  const bridgeErrorGroups = useMemo(() => buildBridgeErrorGroups(filteredResults), [filteredResults])

  const oneDevice = selectedDeviceId !== '__all__'
  const symbols = Array.from(bySymbol.keys()).sort()

  const renderSectionForSymbol = (symbol: string) => {
    const rowsSym = bySymbol.get(symbol) ?? []
    const sectionProfit = rowsSym.reduce((s, r) => s + (r.position.profit ?? 0), 0)
    return (
      <section key={symbol} className="live-positions-section">
        <h3 className="live-section-title">{symbol}</h3>
        <p className="live-section-label">
          <span className="live-section-pnl">
            P/L:{' '}
            <span className={sectionProfit >= 0 ? 'profit' : 'loss'}>
              {(sectionProfit >= 0 ? '+' : '') + sectionProfit.toFixed(2)}
            </span>
          </span>
        </p>
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Volume</th>
                <th>Price open</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {rowsSym.map(({ account, position: p }) => {
                const accountId = account.account_id
                const priceDecimals = symbol.includes('JPY') ? 2 : 5
                const acctLabel = oneDevice ? (
                  account.label
                ) : (
                  <>
                    {account.device_label}
                    <span className="muted"> · {account.label}</span>
                  </>
                )
                return (
                  <tr key={`${account.device_id}-${accountId}-${p.ticket}`}>
                    <td>{acctLabel}</td>
                    <td>
                      <span className={p.type}>{p.type}</span>
                    </td>
                    <td>{p.volume}</td>
                    <td>{Number(p.price_open).toFixed(priceDecimals)}</td>
                    <td className={p.profit >= 0 ? 'profit' : 'loss'}>
                      {(p.profit >= 0 ? '+' : '') + (p.profit ?? 0).toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  return (
    <div className="card live-positions-card">
      <div className="live-page-header">
        <div>
          <h2 className="live-page-title">Live positions</h2>
          <p className="settings-hint" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
            <strong>This panel</strong> loads MT5 on the API host via WebSocket (<code>/ws/positions</code>) with{' '}
            <strong>HTTP backup</strong> every 2.5s when a stream is disconnected, every 30s when WebSockets are connected (
            <code>/api/positions/all</code>, <code>/api/agent/remote-positions</code>).
            Remote rows use <code>/ws/remote-positions</code>. If you see nothing, set Device to <strong>All devices</strong>{' '}
            or <strong>This panel (local MT5)</strong> — a stale saved device filter can hide everything.
          </p>
          {devicesLoadError && (
            <p className="empty" style={{ marginBottom: '0.75rem', color: 'var(--danger, #f87171)' }}>
              {devicesLoadError}
            </p>
          )}
          {bridgeErrorGroups.length > 0 && (
            <div className="live-bridge-notice" role="region" aria-label="MetaTrader connectivity notices">
              <div className="live-bridge-notice__title">Account connectivity</div>
              <p className="live-bridge-notice__lead">
                Some accounts in your selection are not connected to a running, logged-in MetaTrader. Rows with open
                trades from healthy terminals still appear below.
              </p>
              {bridgeErrorGroups.map((g) => (
                <div key={g.key} className="live-bridge-notice__group">
                  <div className="live-bridge-notice__group-head">
                    <span className="live-bridge-notice__headline">{g.headline}</span>
                    <span className="live-bridge-notice__count">
                      {g.labels.length} account{g.labels.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="live-bridge-notice__guidance">{g.guidance}</p>
                  <ul className="live-bridge-notice__account-list">
                    {g.labels.slice(0, 20).map((lb) => (
                      <li key={lb}>{lb}</li>
                    ))}
                    {g.labels.length > 20 && (
                      <li className="live-bridge-notice__more">…and {g.labels.length - 20} more</li>
                    )}
                  </ul>
                  <details className="live-bridge-notice__details">
                    <summary>Technical message</summary>
                    <pre className="live-bridge-notice__pre">{g.exampleDetail}</pre>
                  </details>
                </div>
              ))}
            </div>
          )}
          <div className="live-positions-accounts-surface remote-form-surface">
            <div className="remote-form-group">
              <div className="remote-form-group__stack remote-form-group__stack--target-row">
                <div className="form-row remote-form-field">
                  <label htmlFor="livepositions-device">Device</label>
                  <select
                    id="livepositions-device"
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                  >
                    <option value="__all__">All devices</option>
                    <option value={LOCAL_DEVICE_ID}>This panel (local MT5)</option>
                    {devices.map((d) => (
                      <option key={d.device_id} value={d.device_id}>
                        {d.label} {!d.probably_online ? '(offline)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
          {allAccountsForFilter.length > 0 && (
            <LivePositionsAccountDropdown
              accounts={allAccountsForFilter}
              selectedScopeIds={selectedScopeIds}
              summary={liveAccountDropdownSummary}
              open={accountMenuOpen}
              menuRef={accountMenuRef}
              onToggleOpen={onToggleAccountMenu}
              onToggleScopeId={toggleScopeId}
              onSelectAll={selectAllAccountsInDropdown}
              onUnselectAll={unselectAllAccountsInDropdown}
            />
          )}
          <p className="live-status">
            <span className={localConnected ? 'connected' : 'disconnected'} title="/ws/positions">
              {localConnected ? '●' : '○'} Local panel
            </span>
            <span style={{ margin: '0 0.5rem', opacity: 0.45 }}>|</span>
            <span className={remoteConnected ? 'connected' : 'disconnected'} title="/ws/remote-positions">
              {remoteConnected ? '●' : '○'} Remote agents
            </span>
            {(localLastUpdate || pollLocalLastUpdate || remoteFeedLastUpdate) && (
              <span className="last-update">
                {(localLastUpdate || pollLocalLastUpdate) &&
                  ` Local ${(localLastUpdate ?? pollLocalLastUpdate)!.toLocaleTimeString()}`}
                {pollLocalLastUpdate && !localLastUpdate && !localConnected && ' (HTTP)'}
                {(localLastUpdate || pollLocalLastUpdate) && remoteFeedLastUpdate && ' ·'}
                {remoteFeedLastUpdate && ` Remote ${remoteFeedLastUpdate.toLocaleTimeString()}`}
                {pollRemoteLastUpdate && !remoteLastUpdate && !remoteConnected && remoteFeedLastUpdate && ' (HTTP)'}
              </span>
            )}
          </p>
          {accountSelectionMismatch && (
            <p className="settings-hint" style={{ marginBottom: '0.5rem' }}>
              No rows match the checked accounts (config id vs MT5 account id). Open <strong>Accounts</strong> and use{' '}
              <strong>Select all</strong>, or adjust the selection so it matches the live feed.
            </p>
          )}
          {totalCount === 0 && !localConnected && !remoteFeedActive && (
            <p className="empty">Connecting to position streams (local panel and remote agents)…</p>
          )}
          {totalCount === 0 && (localConnected || remoteFeedActive) && scopedRows.length === 0 && (
            <p className="empty">
              No position data for this device yet. For <strong>This panel</strong>, ensure MT5 and the panel Python
              bridge are running on the API host. For remote PCs, keep the desktop agent paired and MT5 logged in.
            </p>
          )}
        </div>
      </div>

      {accountRowsInView > 0 && totalCount === 0 && !accountSelectionMismatch && (
        <p className="settings-hint" style={{ margin: '0 0 1rem', padding: '0 0.25rem' }}>
          <strong>Live data is reaching the panel.</strong> {accountRowsInView} account
          {accountRowsInView === 1 ? '' : 's'} in your current filter, <strong>0 open positions</strong> (flat or logged-out
          terminals). Open trades will appear here when MT5 reports them on the API host and remote agents.
        </p>
      )}

      {totalCount > 0 && (
        <>
          <div className="live-totals-row">
            <p className="live-totals live-totals-combined live-total-chip overall" title="Sum of P/L across open positions in selection">
              Overall P/L:{' '}
              <span className={combinedPnl >= 0 ? 'profit' : 'loss'}>
                {(combinedPnl >= 0 ? '+' : '') + combinedPnl.toFixed(2)}
              </span>
            </p>
          </div>
          <div className="live-positions-sections">{symbols.map((symbol) => renderSectionForSymbol(symbol))}</div>
        </>
      )}
    </div>
  )
}
