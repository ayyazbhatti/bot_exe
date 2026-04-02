import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFetch, appendPanelKeyToWsUrl } from '../apiClient'

const API = '/api'
const ADMIN_KEY_STORAGE = 'mt5bot_agent_admin_key'
const REMOTE_AGENTS_UI_KEY = 'mt5bot_remote_agents_ui'
const REMOTE_AGENTS_UI_VERSION = 1

type RemoteAgentsUiPersisted = {
  v: number
  selectedDeviceId?: string
  accountId?: string
  symbol?: string
  orderType?: string
  volume?: number
  orderComment?: string
  workerEnabled?: boolean
  workerAccounts?: string
  workerSymbols?: string
  workerMinVol?: number
  workerMaxVol?: number
  workerMinInt?: number
  workerMaxInt?: number
  workerMaxOpen?: number
  /** Comma-separated terminal ids for Enqueue order (multi-select). */
  enqueueOrderAccounts?: string
}

function loadRemoteAgentsUi(): Partial<Omit<RemoteAgentsUiPersisted, 'v'>> {
  try {
    const raw = localStorage.getItem(REMOTE_AGENTS_UI_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as RemoteAgentsUiPersisted
    if (!o || typeof o !== 'object' || o.v !== REMOTE_AGENTS_UI_VERSION) return {}
    const { v: _v, ...rest } = o
    return rest
  } catch {
    return {}
  }
}

function saveRemoteAgentsUi(patch: Omit<RemoteAgentsUiPersisted, 'v'>) {
  try {
    localStorage.setItem(REMOTE_AGENTS_UI_KEY, JSON.stringify({ ...patch, v: REMOTE_AGENTS_UI_VERSION }))
  } catch {
    /* ignore quota / private mode */
  }
}

function parseCommaIds(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** Rebuild worker `account_ids` string when toggling a terminal id; preserves non-terminal extras in order. */
function buildWorkerAccountsToggleTerminal(
  terminals: TerminalEntry[],
  workerAccounts: string,
  terminalId: string,
  checked: boolean,
): string {
  const tid = new Set(terminals.map((t) => t.id))
  const extra = parseCommaIds(workerAccounts).filter((id) => !tid.has(id))
  const selected = new Set(parseCommaIds(workerAccounts).filter((id) => tid.has(id)))
  if (checked) selected.add(terminalId)
  else selected.delete(terminalId)
  const ordered = terminals.map((t) => t.id).filter((id) => selected.has(id))
  return [...ordered, ...extra].join(',')
}

/** All listed terminals selected, in list order; preserves comma IDs not in `terminals`. */
function buildWorkerAccountsSelectAll(terminals: TerminalEntry[], workerAccounts: string): string {
  const tid = new Set(terminals.map((t) => t.id))
  const extra = parseCommaIds(workerAccounts).filter((id) => !tid.has(id))
  return [...terminals.map((t) => t.id), ...extra].join(',')
}

/** Clear selection for terminals only; keeps “Other IDs” extras. */
function buildWorkerAccountsUnselectAllTerminals(terminals: TerminalEntry[], workerAccounts: string): string {
  const tid = new Set(terminals.map((t) => t.id))
  return parseCommaIds(workerAccounts)
    .filter((id) => !tid.has(id))
    .join(',')
}

/** Enqueue-order multi-select: preserve list order from `terminals`. */
function toggleEnqueueOrderAccountId(
  terminals: TerminalEntry[],
  selected: string[],
  terminalId: string,
  checked: boolean,
): string[] {
  const order = terminals.map((t) => t.id)
  const s = new Set(selected)
  if (checked) s.add(terminalId)
  else s.delete(terminalId)
  return order.filter((id) => s.has(id))
}

const MAJOR_USD_SYMBOLS = [
  'AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDCNH', 'USDJPY', 'USDSEK',
]
const MAJOR_M_SYMBOLS = [
  'AUDUSDm', 'BTCUSDm', 'ETHUSDm', 'EURUSDm', 'GBPUSDm', 'USDCHFm', 'USDJPYm', 'XAUUSDm',
]
const SYMBOL_PRESETS = [...new Set([...MAJOR_M_SYMBOLS, ...MAJOR_USD_SYMBOLS])].sort()

function buildWorkerSymbolsToggle(
  optionOrder: string[],
  workerSymbols: string,
  sym: string,
  checked: boolean,
): string {
  const optSet = new Set(optionOrder)
  const extra = parseCommaIds(workerSymbols).filter((s) => !optSet.has(s))
  const selected = new Set(parseCommaIds(workerSymbols).filter((s) => optSet.has(s)))
  if (checked) selected.add(sym)
  else selected.delete(sym)
  const ordered = optionOrder.filter((s) => selected.has(s))
  return [...ordered, ...extra].join(',')
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '' || h === '0.0.0.0'
}

/** Before the API responds: same origin if the UI is already on a public host (e.g. trycloudflare); else LAN guess with API port. */
function computeFallbackPanelApiBase(): string {
  const envPub = import.meta.env.VITE_PANEL_PUBLIC_BASE_URL
  if (typeof envPub === 'string' && envPub.trim()) {
    return envPub.trim().replace(/\/$/, '')
  }
  try {
    if (!isLoopbackHostname(window.location.hostname)) {
      return window.location.origin.replace(/\/$/, '')
    }
    const u = new URL(window.location.origin)
    u.port = String(import.meta.env.VITE_API_PORT || '3001')
    return u.origin
  } catch {
    return `http://127.0.0.1:${import.meta.env.VITE_API_PORT || '3001'}`
  }
}

type TerminalEntry = {
  id: string
  label: string
  exe_path: string
}

type DeviceRow = {
  device_id: string
  label: string
  last_heartbeat_unix: number
  last_agent_version: string
  last_mt5_connected: boolean
  probably_online: boolean
  worker_enabled?: boolean
  worker_next_run_unix?: number
  terminals?: TerminalEntry[]
}

function computeWorkerNextRunUi(
  deviceId: string,
  row: DeviceRow | undefined,
): { main: string; sub: string } {
  if (!deviceId) return { main: '—', sub: '' }
  if (!row) return { main: '—', sub: '' }
  if (!row.worker_enabled) return { main: 'Off', sub: '' }
  const nu = row.worker_next_run_unix
  if (nu == null || nu <= 0) return { main: '—', sub: '' }
  const now = Math.floor(Date.now() / 1000)
  const rem = nu - now
  const at = new Date(nu * 1000).toLocaleTimeString()
  if (rem <= 0) return { main: 'Due now', sub: at }
  const h = Math.floor(rem / 3600)
  const m = Math.floor((rem % 3600) / 60)
  const s = rem % 60
  const main = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
  return { main, sub: at }
}

type CommandRow = {
  id: string
  device_id: string
  type?: string
  cmd_type?: string
  status: string
  created_unix: number
  result?: unknown
}

export default function RemoteAgents() {
  const ui0 = loadRemoteAgentsUi()
  const [adminKey, setAdminKey] = useState(() => {
    try {
      const s = localStorage.getItem(ADMIN_KEY_STORAGE)
      if (s) return s
    } catch (_) {}
    const env = import.meta.env.VITE_AGENT_ADMIN_KEY
    return typeof env === 'string' ? env : ''
  })
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [pairBusy, setPairBusy] = useState(false)
  const [lastCode, setLastCode] = useState<{ code: string; expires_unix: number } | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => ui0.selectedDeviceId ?? '')
  const [accountId, setAccountId] = useState(() => ui0.accountId ?? 'exness')
  const [enqueueOrderAccountIds, setEnqueueOrderAccountIds] = useState<string[]>(() => {
    const fromE = ui0.enqueueOrderAccounts?.trim()
    if (fromE) return parseCommaIds(fromE)
    const a = ui0.accountId?.trim()
    return a ? [a] : ['exness']
  })
  const [symbol, setSymbol] = useState(() => ui0.symbol ?? 'EURUSDm')
  const [orderType, setOrderType] = useState<'buy' | 'sell'>(() => (ui0.orderType === 'sell' ? 'sell' : 'buy'))
  const [volume, setVolume] = useState(() =>
    typeof ui0.volume === 'number' && Number.isFinite(ui0.volume) ? ui0.volume : 0.01,
  )
  const [orderComment, setOrderComment] = useState(() => ui0.orderComment ?? 'panel-remote')
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [workerEnabled, setWorkerEnabled] = useState(() => !!ui0.workerEnabled)
  const [workerAccounts, setWorkerAccounts] = useState(() => ui0.workerAccounts ?? 'default,exness')
  const [workerSymbols, setWorkerSymbols] = useState(() => ui0.workerSymbols ?? 'EURUSDm,XAUUSDm')
  const [workerMinVol, setWorkerMinVol] = useState(() =>
    typeof ui0.workerMinVol === 'number' && Number.isFinite(ui0.workerMinVol) ? ui0.workerMinVol : 0.01,
  )
  const [workerMaxVol, setWorkerMaxVol] = useState(() =>
    typeof ui0.workerMaxVol === 'number' && Number.isFinite(ui0.workerMaxVol) ? ui0.workerMaxVol : 0.1,
  )
  const [workerMinInt, setWorkerMinInt] = useState(() =>
    typeof ui0.workerMinInt === 'number' && Number.isFinite(ui0.workerMinInt) ? ui0.workerMinInt : 5,
  )
  const [workerMaxInt, setWorkerMaxInt] = useState(() =>
    typeof ui0.workerMaxInt === 'number' && Number.isFinite(ui0.workerMaxInt) ? ui0.workerMaxInt : 10,
  )
  const [workerMaxOpen, setWorkerMaxOpen] = useState(() =>
    typeof ui0.workerMaxOpen === 'number' && Number.isFinite(ui0.workerMaxOpen) ? ui0.workerMaxOpen : 0,
  )
  const [workerAccountsDropdownOpen, setWorkerAccountsDropdownOpen] = useState(false)
  const workerAccountsDropdownRef = useRef<HTMLDivElement>(null)
  const [enqueueAccountsDropdownOpen, setEnqueueAccountsDropdownOpen] = useState(false)
  const enqueueAccountsDropdownRef = useRef<HTMLDivElement>(null)
  const [workerSymbolOptions, setWorkerSymbolOptions] = useState<string[]>([])
  const [workerSymbolsLoading, setWorkerSymbolsLoading] = useState(false)
  const [workerSymbolsDropdownOpen, setWorkerSymbolsDropdownOpen] = useState(false)
  const workerSymbolsDropdownRef = useRef<HTMLDivElement>(null)
  const [workerCountdownTick, setWorkerCountdownTick] = useState(0)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [workerClosingAll, setWorkerClosingAll] = useState(false)
  const [commands, setCommands] = useState<CommandRow[]>([])
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [hubLive, setHubLive] = useState(false)
  const [serverKeyInfo, setServerKeyInfo] = useState<{
    persisted: boolean
    using_dev_default: boolean
  } | null>(null)
  const [newServerKey, setNewServerKey] = useState('')
  const [saveServerKeyBusy, setSaveServerKeyBusy] = useState(false)
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    deviceId: string
    label: string
    probablyOnline: boolean
  } | null>(null)
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null)
  const [revokeConfirm, setRevokeConfirm] = useState<{
    deviceId: string
    label: string
    probablyOnline: boolean
  } | null>(null)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  /** Synced from agent over WebSocket (`device_terminals`); also merged from device list on refresh. */
  const [deviceTerminals, setDeviceTerminals] = useState<Record<string, TerminalEntry[]>>({})
  const [panelApiBase, setPanelApiBase] = useState(computeFallbackPanelApiBase)

  const showToast = useCallback((text: string) => {
    const id = Date.now()
    setToast({ text, id })
    window.setTimeout(() => {
      setToast((t) => (t?.id === id ? null : t))
    }, 4200)
  }, [])

  useEffect(() => {
    try {
      if (adminKey) localStorage.setItem(ADMIN_KEY_STORAGE, adminKey)
    } catch (_) {}
  }, [adminKey])

  useEffect(() => {
    saveRemoteAgentsUi({
      selectedDeviceId,
      accountId,
      symbol,
      orderType,
      volume,
      orderComment,
      workerEnabled,
      workerAccounts,
      workerSymbols,
      workerMinVol,
      workerMaxVol,
      workerMinInt,
      workerMaxInt,
      workerMaxOpen,
      enqueueOrderAccounts: enqueueOrderAccountIds.join(','),
    })
  }, [
    selectedDeviceId,
    accountId,
    symbol,
    orderType,
    volume,
    orderComment,
    workerEnabled,
    workerAccounts,
    workerSymbols,
    workerMinVol,
    workerMaxVol,
    workerMinInt,
    workerMaxInt,
    workerMaxOpen,
    enqueueOrderAccountIds,
  ])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await apiFetch(`${API}/agent/panel-base-url`)
        const d = await r.json().catch(() => ({}))
        if (cancelled || !r.ok || !d?.ok || typeof d.panel_api_base !== 'string') return
        setPanelApiBase(d.panel_api_base.trim().replace(/\/$/, ''))
      } catch {
        /* keep fallback */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!deleteConfirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleteBusyId) setDeleteConfirm(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteConfirm, deleteBusyId])

  useEffect(() => {
    if (!revokeConfirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !revokeBusyId) setRevokeConfirm(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revokeConfirm, revokeBusyId])

  const refreshServerKeyInfo = useCallback(async () => {
    try {
      const r = await apiFetch(`${API}/agent/admin-key/status`)
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.ok) {
        setServerKeyInfo({
          persisted: !!d.persisted,
          using_dev_default: !!d.using_dev_default,
        })
      } else {
        setServerKeyInfo(null)
      }
    } catch {
      setServerKeyInfo(null)
    }
  }, [])

  useEffect(() => {
    void refreshServerKeyInfo()
  }, [refreshServerKeyInfo])

  const saveServerAdminKey = async () => {
    const nk = newServerKey.trim()
    if (nk.length < 8) {
      setMsg({ type: 'error', text: 'New server key must be at least 8 characters.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter the current admin key above (must match the server).' })
      return
    }
    setSaveServerKeyBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/admin-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_key: adminKey, new_key: nk }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setAdminKey(nk)
      setNewServerKey('')
      showToast('Admin key saved')
      void refreshServerKeyInfo()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setSaveServerKeyBusy(false)
    }
  }

  const refreshDevices = useCallback(async () => {
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key (same as server AGENT_ADMIN_KEY).' })
      return
    }
    setLoadingList(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/devices/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        setDevices([])
        return
      }
      const list = Array.isArray(data.devices) ? (data.devices as DeviceRow[]) : []
      setDevices(list)
      setDeviceTerminals((prev) => {
        const next = { ...prev }
        for (const row of list) {
          if (Array.isArray(row.terminals)) {
            next[row.device_id] = row.terminals
          }
        }
        return next
      })
      setSelectedDeviceId((prev) => {
        if (list.length === 0) return ''
        if (prev && list.some((d) => d.device_id === prev)) return prev
        return list[0].device_id
      })
    } catch {
      setMsg({ type: 'error', text: 'Could not reach API. Is the backend running?' })
      setDevices([])
    } finally {
      setLoadingList(false)
    }
  }, [adminKey])

  const refreshCommands = useCallback(async () => {
    if (!adminKey.trim()) return
    setLoadingCommands(true)
    try {
      const r = await apiFetch(`${API}/agent/commands/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: selectedDeviceId || undefined, limit: 20 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok && data.ok && Array.isArray(data.commands)) {
        setCommands(data.commands as CommandRow[])
      }
    } catch (_) {
      // keep last loaded commands
    } finally {
      setLoadingCommands(false)
    }
  }, [adminKey, selectedDeviceId])

  const refreshDevicesRef = useRef(refreshDevices)
  const refreshCommandsRef = useRef(refreshCommands)
  useEffect(() => {
    refreshDevicesRef.current = refreshDevices
    refreshCommandsRef.current = refreshCommands
  }, [refreshDevices, refreshCommands])

  useEffect(() => {
    refreshDevices()
    const id = window.setInterval(() => {
      if (!hubLive) void refreshDevices()
    }, 8000)
    return () => clearInterval(id)
  }, [refreshDevices, hubLive])

  useEffect(() => {
    refreshCommands()
    const id = window.setInterval(() => {
      if (!hubLive) void refreshCommands()
    }, 7000)
    return () => clearInterval(id)
  }, [refreshCommands, hubLive])

  useEffect(() => {
    if (!adminKey.trim()) {
      setHubLive(false)
      return
    }
    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const fullRefresh = () => {
      void refreshDevicesRef.current()
      void refreshCommandsRef.current()
    }

    const replaceDeviceTerminalsFromSnapshot = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const o = raw as Record<string, unknown>
      const next: Record<string, TerminalEntry[]> = {}
      for (const [k, v] of Object.entries(o)) {
        if (Array.isArray(v)) next[k] = v as TerminalEntry[]
      }
      setDeviceTerminals(next)
    }

    const connect = () => {
      if (cancelled) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(appendPanelKeyToWsUrl(`${proto}//${window.location.host}/ws/agent`))
      socket.onopen = () => {
        setHubLive(true)
        socket?.send(JSON.stringify({ admin_key: adminKey }))
        fullRefresh()
      }
      socket.onmessage = (ev) => {
        try {
          const d = JSON.parse(String(ev.data)) as {
            type?: string
            device_id?: string
            terminals?: TerminalEntry[]
            device_terminals?: Record<string, TerminalEntry[]>
          }
          if (d?.type === 'refresh') fullRefresh()
          if (d?.type === 'subscribed' && d.device_terminals) {
            replaceDeviceTerminalsFromSnapshot(d.device_terminals)
          }
          if (d?.type === 'device_terminals' && d.device_id && Array.isArray(d.terminals)) {
            setDeviceTerminals((prev) => ({ ...prev, [d.device_id!]: d.terminals! }))
          }
        } catch (_) {
          /* ignore */
        }
      }
      socket.onclose = () => {
        setHubLive(false)
        if (cancelled) return
        reconnectTimer = window.setTimeout(connect, 4000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      setHubLive(false)
      socket?.close()
    }
  }, [adminKey])

  /** Load worker config from API for a device (e.g. after user picks another device). Not run on page load so localStorage values survive reload. */
  const loadWorkerConfigForDevice = useCallback(async (deviceId: string) => {
    if (!adminKey.trim() || !deviceId) return
    try {
      const r = await apiFetch(`${API}/agent/worker/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: deviceId }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok || !data.config) return
      const cfg = data.config
      setWorkerEnabled(!!cfg.enabled)
      setWorkerAccounts(Array.isArray(cfg.account_ids) ? cfg.account_ids.join(',') : 'default')
      setWorkerSymbols(Array.isArray(cfg.symbols) ? cfg.symbols.join(',') : '')
      setWorkerMinVol(Math.max(0.01, Number(cfg.min_volume) || 0.01))
      setWorkerMaxVol(Math.max(0.01, Number(cfg.max_volume) || 0.1))
      setWorkerMinInt(Math.max(0.5, Number(cfg.min_interval_minutes) || 5))
      setWorkerMaxInt(Math.max(0.5, Number(cfg.max_interval_minutes) || 10))
      setWorkerMaxOpen(Math.max(0, Number(cfg.max_open_positions) || 0))
    } catch (_) {
      // ignore
    }
  }, [adminKey])

  const terminalsForSelected = useMemo((): TerminalEntry[] => {
    return (
      deviceTerminals[selectedDeviceId] ??
      devices.find((d) => d.device_id === selectedDeviceId)?.terminals ??
      []
    )
  }, [deviceTerminals, selectedDeviceId, devices])

  const selectedDeviceRow = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId),
    [devices, selectedDeviceId],
  )

  const workerNextRunUi = useMemo(() => {
    void workerCountdownTick
    return computeWorkerNextRunUi(selectedDeviceId, selectedDeviceRow)
  }, [selectedDeviceId, selectedDeviceRow, workerCountdownTick])

  const workerAccountsExtraIds = useMemo(() => {
    if (terminalsForSelected.length === 0) return [] as string[]
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    return parseCommaIds(workerAccounts).filter((id) => !tid.has(id))
  }, [terminalsForSelected, workerAccounts])

  const workerTerminalSelectedIds = useMemo(() => {
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    return parseCommaIds(workerAccounts).filter((id) => tid.has(id))
  }, [terminalsForSelected, workerAccounts])

  const workerAccountsDropdownSummary = useMemo(() => {
    if (workerTerminalSelectedIds.length === 0) return 'Select accounts…'
    const labels = workerTerminalSelectedIds.map((id) => {
      const t = terminalsForSelected.find((x) => x.id === id)
      return t ? `${t.label} (${t.id})` : id
    })
    if (labels.length <= 2) return labels.join(', ')
    return `${labels.length} accounts selected`
  }, [terminalsForSelected, workerTerminalSelectedIds])

  const enqueueOrderTerminalSelectedIds = useMemo(() => {
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    return enqueueOrderAccountIds.filter((id) => tid.has(id))
  }, [terminalsForSelected, enqueueOrderAccountIds])

  const enqueueAccountsDropdownSummary = useMemo(() => {
    if (enqueueOrderTerminalSelectedIds.length === 0) return 'Select accounts…'
    const labels = enqueueOrderTerminalSelectedIds.map((id) => {
      const t = terminalsForSelected.find((x) => x.id === id)
      return t ? `${t.label} (${t.id})` : id
    })
    if (labels.length <= 2) return labels.join(', ')
    return `${labels.length} accounts selected`
  }, [terminalsForSelected, enqueueOrderTerminalSelectedIds])

  /** First enqueue-target account drives `/symbols` (shared with worker symbol picker). */
  const symbolsAccountId = useMemo(() => {
    if (terminalsForSelected.length === 0) return accountId.trim() || 'default'
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    const first = enqueueOrderAccountIds.find((id) => tid.has(id))
    if (first) return first
    return terminalsForSelected[0].id
  }, [terminalsForSelected, accountId, enqueueOrderAccountIds])

  const workerSymbolSelectedIds = useMemo(() => {
    const opt = new Set(workerSymbolOptions)
    return parseCommaIds(workerSymbols).filter((s) => opt.has(s))
  }, [workerSymbolOptions, workerSymbols])

  const workerSymbolsExtraIds = useMemo(() => {
    const opt = new Set(workerSymbolOptions)
    return parseCommaIds(workerSymbols).filter((s) => !opt.has(s))
  }, [workerSymbolOptions, workerSymbols])

  const workerSymbolsDropdownSummary = useMemo(() => {
    if (workerSymbolsLoading) return 'Loading…'
    if (workerSymbolSelectedIds.length === 0) return 'Select symbols…'
    if (workerSymbolSelectedIds.length <= 3) return workerSymbolSelectedIds.join(', ')
    return `${workerSymbolSelectedIds.length} symbols`
  }, [workerSymbolsLoading, workerSymbolSelectedIds])

  useEffect(() => {
    let cancelled = false
    const id = symbolsAccountId.trim() || 'default'
    setWorkerSymbolsLoading(true)
    void (async () => {
      try {
        const r = await apiFetch(`${API}/symbols?account_id=${encodeURIComponent(id)}`)
        const data = await r.json().catch(() => ({}))
        const list =
          r.ok && data.ok && Array.isArray(data.symbols)
            ? (data.symbols as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            : []
        if (cancelled) return
        if (list.length > 0) {
          setWorkerSymbolOptions(list.slice(0, 800))
        } else {
          setWorkerSymbolOptions([...SYMBOL_PRESETS])
        }
      } catch {
        if (!cancelled) setWorkerSymbolOptions([...SYMBOL_PRESETS])
      } finally {
        if (!cancelled) setWorkerSymbolsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [symbolsAccountId])

  useEffect(() => {
    if (terminalsForSelected.length === 0) return
    setEnqueueOrderAccountIds((prev) => {
      const tid = new Set(terminalsForSelected.map((t) => t.id))
      const valid = prev.filter((id) => tid.has(id))
      if (valid.length > 0) return valid
      return [terminalsForSelected[0].id]
    })
  }, [selectedDeviceId, terminalsForSelected])

  useEffect(() => {
    if (terminalsForSelected.length === 0) return
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    const first = enqueueOrderAccountIds.find((id) => tid.has(id)) ?? terminalsForSelected[0].id
    if (accountId !== first) setAccountId(first)
  }, [terminalsForSelected, enqueueOrderAccountIds, accountId])

  useEffect(() => {
    if (!workerAccountsDropdownOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = workerAccountsDropdownRef.current
      if (el && !el.contains(e.target as Node)) setWorkerAccountsDropdownOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkerAccountsDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [workerAccountsDropdownOpen])

  useEffect(() => {
    if (!enqueueAccountsDropdownOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = enqueueAccountsDropdownRef.current
      if (el && !el.contains(e.target as Node)) setEnqueueAccountsDropdownOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnqueueAccountsDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [enqueueAccountsDropdownOpen])

  useEffect(() => {
    if (!workerSymbolsDropdownOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = workerSymbolsDropdownRef.current
      if (el && !el.contains(e.target as Node)) setWorkerSymbolsDropdownOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkerSymbolsDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [workerSymbolsDropdownOpen])

  useEffect(() => {
    const id = window.setInterval(() => setWorkerCountdownTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const createPairingCode = async () => {
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key first.' })
      return
    }
    setPairBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/pairing-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setLastCode({ code: data.code, expires_unix: data.expires_unix })
      setMsg({
        type: 'success',
        text: 'Code is exactly 8 characters — use Copy, then paste into the desktop agent. Valid about 1 hour.',
      })
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setPairBusy(false)
    }
  }

  const enqueueOrder = async () => {
    if (!selectedDeviceId) {
      setMsg({ type: 'error', text: 'Select a device.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    const tid = new Set(terminalsForSelected.map((t) => t.id))
    const accountTargets =
      terminalsForSelected.length > 0
        ? [...new Set(enqueueOrderAccountIds.filter((id) => tid.has(id)))]
        : parseCommaIds(accountId.trim() || 'default')
    if (accountTargets.length === 0) {
      setMsg({
        type: 'error',
        text:
          terminalsForSelected.length > 0
            ? 'Select at least one account.'
            : 'Enter at least one account id (comma-separated for multiple).',
      })
      return
    }
    setEnqueueBusy(true)
    setMsg(null)
    try {
      const side = orderType === 'buy' ? 'Buy' : 'Sell'
      const orders = accountTargets.map((account_id) => ({ account_id }))
      const r = await apiFetch(`${API}/agent/commands/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          device_id: selectedDeviceId,
          type: 'place_market_orders',
          ttl_sec: 600,
          payload: {
            orders,
            symbol: symbol.trim(),
            order_type: orderType,
            volume,
            comment: orderComment.trim() || 'panel-remote',
          },
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: (data as { error?: string }).error || `HTTP ${r.status}` })
        return
      }
      showToast(
        accountTargets.length > 1
          ? `${side} ${volume} ${symbol} — batch queued (${accountTargets.length} accounts)`
          : `${side} ${volume} ${symbol} — queued`,
      )
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setEnqueueBusy(false)
    }
  }

  const executeDeleteDevice = async () => {
    if (!deleteConfirm) return
    const { deviceId, label } = deleteConfirm
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      setDeleteConfirm(null)
      return
    }
    setDeleteBusyId(deviceId)
    try {
      const r = await apiFetch(`${API}/agent/devices/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: deviceId }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setDeleteConfirm(null)
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setDeleteConfirm(null)
      showToast(`“${label}” was removed from Remote devices.`)
      refreshDevices()
      refreshCommands()
    } catch {
      setDeleteConfirm(null)
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setDeleteBusyId(null)
    }
  }

  const executeRevokeDevice = async () => {
    if (!revokeConfirm) return
    const { deviceId, label } = revokeConfirm
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      setRevokeConfirm(null)
      return
    }
    setRevokeBusyId(deviceId)
    try {
      const r = await apiFetch(`${API}/agent/devices/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: deviceId }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setRevokeConfirm(null)
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setRevokeConfirm(null)
      setDeviceTerminals((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      showToast(`Session revoked for “${label}”. Agent must pair again with a new code.`)
      refreshDevices()
      refreshCommands()
    } catch {
      setRevokeConfirm(null)
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setRevokeBusyId(null)
    }
  }

  const enqueueCloseWorkerPositions = async () => {
    if (!selectedDeviceId) {
      setMsg({ type: 'error', text: 'Select a device.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    const account_ids = parseCommaIds(workerAccounts)
    if (account_ids.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one account under Remote worker.' })
      return
    }
    setWorkerClosingAll(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/commands/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          device_id: selectedDeviceId,
          type: 'close_positions_selected',
          ttl_sec: 600,
          payload: { account_ids },
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      showToast(`Close all queued for ${account_ids.length} account(s)`)
      void refreshCommands()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setWorkerClosingAll(false)
    }
  }

  const saveWorkerConfig = async () => {
    if (!selectedDeviceId) {
      setMsg({ type: 'error', text: 'Select a device.' })
      return
    }
    setWorkerBusy(true)
    setMsg(null)
    try {
      const account_ids = parseCommaIds(workerAccounts)
      const symbols = workerSymbols
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await apiFetch(`${API}/agent/worker/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          device_id: selectedDeviceId,
          enabled: workerEnabled,
          account_ids,
          symbols,
          min_volume: workerMinVol,
          max_volume: workerMaxVol,
          min_interval_minutes: workerMinInt,
          max_interval_minutes: workerMaxInt,
          max_open_positions: workerMaxOpen,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      showToast('Worker saved')
      refreshDevices()
      refreshCommands()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setWorkerBusy(false)
    }
  }

  return (
    <div className="remote-agents-page">
      <div className="remote-agents-inner">
      {revokeConfirm && (
        <div
          className="remote-delete-overlay"
          role="presentation"
          onClick={() => {
            if (!revokeBusyId) setRevokeConfirm(null)
          }}
        >
          <div
            className="remote-delete-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-revoke-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="remote-delete-icon-wrap" aria-hidden="true">
              <svg className="remote-delete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <h3 id="remote-revoke-title" className="remote-delete-title">
              Revoke session?
            </h3>
            <p className="remote-delete-lead">
              <strong>{revokeConfirm.label}</strong> — invalidates this device&apos;s access token. The row stays in the
              list; use <strong>Delete</strong> to remove it entirely.
            </p>
            <p className="remote-delete-meta">
              <span className="muted">ID</span>
              <code className="remote-delete-device-id">{revokeConfirm.deviceId}</code>
            </p>
            {revokeConfirm.probablyOnline && (
              <p className="remote-delete-warning remote-delete-warning-online">
                Online: the agent will stop authenticating on its next request (disconnects from the panel API).
              </p>
            )}
            <p className="remote-delete-warning">
              The desktop agent must use a new pairing code to connect again (pending commands for this device are
              dropped; remote worker is turned off for this device).
            </p>
            <div className="remote-delete-actions">
              <button
                type="button"
                className="remote-delete-btn secondary"
                disabled={revokeBusyId !== null}
                onClick={() => setRevokeConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="remote-delete-btn danger"
                disabled={revokeBusyId !== null}
                onClick={() => void executeRevokeDevice()}
              >
                {revokeBusyId === revokeConfirm.deviceId ? 'Revoking…' : 'Revoke session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div
          className="remote-delete-overlay"
          role="presentation"
          onClick={() => {
            if (!deleteBusyId) setDeleteConfirm(null)
          }}
        >
          <div
            className="remote-delete-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="remote-delete-icon-wrap" aria-hidden="true">
              <svg className="remote-delete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </div>
            <h3 id="remote-delete-title" className="remote-delete-title">
              Remove device?
            </h3>
            <p className="remote-delete-lead">
              <strong>{deleteConfirm.label}</strong> — re-pair to reconnect.
            </p>
            <p className="remote-delete-meta">
              <span className="muted">ID</span>
              <code className="remote-delete-device-id">{deleteConfirm.deviceId}</code>
            </p>
            {deleteConfirm.probablyOnline && (
              <p className="remote-delete-warning remote-delete-warning-online">
                Online: access revoked until re-paired.
              </p>
            )}
            <p className="remote-delete-warning">Pending commands for this device are dropped.</p>
            <div className="remote-delete-actions">
              <button
                type="button"
                className="remote-delete-btn secondary"
                disabled={deleteBusyId !== null}
                onClick={() => setDeleteConfirm(null)}
              >
                Keep device
              </button>
              <button
                type="button"
                className="remote-delete-btn danger"
                disabled={deleteBusyId !== null}
                onClick={() => void executeDeleteDevice()}
              >
                {deleteBusyId === deleteConfirm.deviceId ? 'Removing…' : 'Remove device'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="remote-toast" role="status" aria-live="polite">
          <span className="remote-toast-check" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          <span className="remote-toast-text">{toast.text}</span>
        </div>
      )}

      <div className="card trading-card remote-agents-card remote-agents-card--hero">
        <div className="trading-card-header remote-agents-card-header">
          <div className="remote-agents-card-heading">
            <h2 id="remote-agents-section-fleet" className="remote-agents-card-title">
              Remote devices
            </h2>
          </div>
        </div>

        <div className="remote-panel-api-banner" role="region" aria-label="Panel API URL">
          <div className="remote-panel-api-banner-main">
            <span className="remote-panel-api-label">Panel API URL</span>
            <code className="remote-panel-api-url" title="Agent api_base">
              {panelApiBase}
            </code>
            <button
              type="button"
              className="remote-panel-api-copy"
              onClick={() => {
                void navigator.clipboard.writeText(panelApiBase).then(() => {
                  showToast('Panel API URL copied.')
                })
              }}
            >
              Copy
            </button>
          </div>
        </div>

        <div className="form-row remote-agents-field remote-agents-field--admin-key">
          <label htmlFor="admin-key">Admin key</label>
          <input
            id="admin-key"
            type="password"
            autoComplete="off"
            placeholder="e.g. dev-admin-change-me"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
          />
        </div>

        {serverKeyInfo && (
          <div className="form-row remote-server-key-panel">
            <p className="settings-hint remote-server-key-panel__intro">
              {serverKeyInfo.persisted ? 'Key file on server.' : 'Env / default.'}
              {serverKeyInfo.using_dev_default ? ' Change default for remote use.' : ''}
            </p>
            <label htmlFor="new-server-admin-key">New key (≥8 chars)</label>
            <input
              id="new-server-admin-key"
              type="password"
              autoComplete="new-password"
              value={newServerKey}
              onChange={(e) => setNewServerKey(e.target.value)}
              placeholder="New secret"
            />
            <button
              type="button"
              className="remote-server-key-panel__submit"
              disabled={saveServerKeyBusy}
              onClick={() => void saveServerAdminKey()}
            >
              {saveServerKeyBusy ? 'Saving…' : 'Save on server'}
            </button>
          </div>
        )}

        <div className="trading-section-divider" />

        <div className="remote-agents-toolbar">
          <div className="remote-agents-toolbar__actions">
            <button type="button" className="remote-toolbar-btn" onClick={refreshDevices} disabled={loadingList}>
              {loadingList ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="remote-toolbar-btn remote-toolbar-btn--primary" onClick={createPairingCode} disabled={pairBusy}>
              {pairBusy ? 'Creating…' : 'Pairing code'}
            </button>
          </div>
          <span
            className={`remote-hub-status ${hubLive ? 'remote-hub-status--live' : adminKey.trim() ? 'remote-hub-status--poll' : 'remote-hub-status--idle'}`}
            title="WebSocket to /ws/agent"
          >
            <span className="remote-hub-status__dot" aria-hidden="true" />
            {hubLive ? 'Live' : adminKey.trim() ? 'Polling' : 'No key'}
          </span>
        </div>

        {lastCode && (
          <div className="msg success remote-pair-banner" role="status">
            <div className="remote-pair-banner__body">
              <span className="remote-pair-banner__label">Pairing code</span>
              <div className="remote-pair-banner__row">
                <span className="remote-pair-code">{lastCode.code}</span>
                <span className="muted remote-pair-banner__expiry">
                  {new Date(lastCode.expires_unix * 1000).toLocaleString()}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="remote-pair-banner__copy"
              onClick={() => {
                void navigator.clipboard.writeText(lastCode.code).then(() => {
                  setMsg({ type: 'success', text: 'Code copied to clipboard. Paste into MT5 Remote Agent.' })
                })
              }}
            >
              Copy code
            </button>
          </div>
        )}

        {devices.length > 0 && (
          <div
            className={`remote-device-summary ${devices.some((d) => d.probably_online) ? 'remote-device-summary--online' : 'remote-device-summary--warn'}`}
          >
            <strong>{devices.filter((d) => d.probably_online).length}</strong> / {devices.length} online
            {!devices.some((d) => d.probably_online) && (
              <span className="muted"> · Check agent &amp; API URL</span>
            )}
          </div>
        )}

        {msg && (
          <div className={`msg remote-agents-inline-msg ${msg.type === 'success' ? 'success' : 'error'}`}>
            {msg.text}
          </div>
        )}

        <div className="table-wrap remote-agents-table-wrap">
          <table className="slave-table remote-devices-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Label</th>
                <th>Device ID</th>
                <th>MT5</th>
                <th>Agent</th>
                <th>Last contact</th>
                <th>Terminals</th>
                <th className="remote-devices-table__actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No devices — pairing code + agent
                  </td>
                </tr>
              )}
              {devices.map((d) => {
                const tlist = deviceTerminals[d.device_id] ?? d.terminals ?? []
                return (
                <tr key={d.device_id}>
                  <td>
                    <span
                      className={d.probably_online ? 'remote-dot online' : 'remote-dot offline'}
                      title={d.probably_online ? 'Recent heartbeat' : 'No recent contact'}
                    />
                    {d.probably_online ? 'Online' : 'Offline'}
                  </td>
                  <td>{d.label}</td>
                  <td>
                    <code className="remote-device-id">{d.device_id}</code>
                  </td>
                  <td>{d.last_mt5_connected ? 'OK' : '—'}</td>
                  <td>{d.last_agent_version || '—'}</td>
                  <td>{d.last_heartbeat_unix ? new Date(d.last_heartbeat_unix * 1000).toLocaleString() : '—'}</td>
                  <td className="muted" title={tlist.map((x) => x.label).join('\n') || undefined}>
                    {tlist.length > 0 ? tlist.length : '—'}
                  </td>
                  <td>
                    <div className="remote-device-actions">
                      <button
                        type="button"
                        className="remote-device-revoke-btn"
                        disabled={deleteBusyId !== null || revokeBusyId !== null}
                        title="Invalidate token — agent must pair again"
                        onClick={() =>
                          setRevokeConfirm({
                            deviceId: d.device_id,
                            label: d.label,
                            probablyOnline: d.probably_online,
                          })
                        }
                      >
                        {revokeBusyId === d.device_id ? '…' : 'Revoke'}
                      </button>
                      <button
                        type="button"
                        className="btn-danger remote-device-delete-btn"
                        disabled={deleteBusyId !== null || revokeBusyId !== null}
                        title="Remove device from list"
                        onClick={() =>
                          setDeleteConfirm({
                            deviceId: d.device_id,
                            label: d.label,
                            probablyOnline: d.probably_online,
                          })
                        }
                      >
                        {deleteBusyId === d.device_id ? '…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card trading-card remote-agents-card remote-action-form-card">
        <div className="trading-card-header remote-agents-card-header">
          <div className="remote-action-form-card__heading">
            <h2 className="remote-agents-card-title">Enqueue order</h2>
          </div>
        </div>

        <div className="remote-form-surface">
          <div className="remote-form-group">
            <h3 className="remote-form-group__title">Target</h3>
            <div className="remote-form-group__stack remote-form-group__stack--target-row">
              <div className="form-row remote-form-field">
                <label htmlFor="remote-device">Device</label>
                <select
                  id="remote-device"
                  value={selectedDeviceId}
                  onChange={(e) => {
                    const id = e.target.value
                    setSelectedDeviceId(id)
                    void loadWorkerConfigForDevice(id)
                  }}
                >
                  {devices.length === 0 && <option value="">No devices — refresh list</option>}
                  {devices.map((d) => (
                    <option key={d.device_id} value={d.device_id}>
                      {d.label} {!d.probably_online ? '(offline)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row remote-form-field">
                <span className="remote-form-field-label" id="enqueue-accounts-label">
                  Account
                </span>
                {terminalsForSelected.length > 0 ? (
                  <div className="remote-worker-accounts-dropdown" ref={enqueueAccountsDropdownRef}>
                    <button
                      type="button"
                      id="enqueue-accounts-trigger"
                      className="remote-worker-accounts-dropdown__trigger"
                      aria-expanded={enqueueAccountsDropdownOpen}
                      aria-haspopup="listbox"
                      aria-labelledby="enqueue-accounts-label enqueue-accounts-trigger"
                      onClick={() => setEnqueueAccountsDropdownOpen((o) => !o)}
                    >
                      <span className="remote-worker-accounts-dropdown__trigger-text">{enqueueAccountsDropdownSummary}</span>
                      <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
                        {enqueueAccountsDropdownOpen ? '▲' : '▼'}
                      </span>
                    </button>
                    {enqueueAccountsDropdownOpen && (
                      <div
                        className="remote-worker-accounts-dropdown__panel"
                        role="listbox"
                        aria-multiselectable="true"
                        aria-label="Accounts for enqueue"
                      >
                        <div className="remote-worker-accounts-dropdown__bulk" role="presentation">
                          <button
                            type="button"
                            className="remote-worker-accounts-dropdown__bulk-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEnqueueOrderAccountIds(terminalsForSelected.map((t) => t.id))
                            }}
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            className="remote-worker-accounts-dropdown__bulk-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEnqueueOrderAccountIds([terminalsForSelected[0].id])
                            }}
                          >
                            Unselect all
                          </button>
                        </div>
                        {terminalsForSelected.map((t) => {
                          const checked = enqueueOrderTerminalSelectedIds.includes(t.id)
                          return (
                            <label key={t.id} className="remote-worker-accounts-dropdown__option">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  setEnqueueOrderAccountIds(
                                    toggleEnqueueOrderAccountId(
                                      terminalsForSelected,
                                      enqueueOrderAccountIds,
                                      t.id,
                                      e.target.checked,
                                    ),
                                  )
                                }
                              />
                              <span className="remote-worker-accounts-dropdown__option-text" title={t.exe_path}>
                                {t.label} <span className="muted">({t.id})</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    id="remote-account"
                    aria-labelledby="enqueue-accounts-label"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="account_id or id1, id2"
                  />
                )}
              </div>
            </div>
          </div>

          <div className="remote-form-divider" aria-hidden="true" />

          <div className="remote-form-group">
            <h3 className="remote-form-group__title">Order</h3>
            <div className="remote-order-field-grid">
              <div className="form-row remote-form-field">
                <label htmlFor="remote-symbol">Symbol</label>
                <input id="remote-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="EURUSDm" />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="remote-side">Side</label>
                <select
                  id="remote-side"
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as 'buy' | 'sell')}
                  className={orderType === 'sell' ? 'remote-select--sell' : 'remote-select--buy'}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="remote-vol">Volume (lots)</label>
                <input
                  id="remote-vol"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(Math.max(0.01, Number(e.target.value) || 0.01))}
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="remote-comment">Comment</label>
                <input id="remote-comment" value={orderComment} onChange={(e) => setOrderComment(e.target.value)} placeholder="panel-remote" />
              </div>
            </div>
          </div>
        </div>

        <div className="remote-form-footer">
          <button type="button" className="remote-primary-action" onClick={enqueueOrder} disabled={enqueueBusy || !selectedDeviceId}>
            {enqueueBusy ? 'Queueing…' : 'Enqueue'}
          </button>
        </div>
      </div>

      <div className="card trading-card remote-agents-card remote-action-form-card">
        <div className="trading-card-header remote-agents-card-header">
          <div className="remote-action-form-card__heading">
            <h2 className="remote-agents-card-title">Remote worker</h2>
          </div>
        </div>

        <div className="remote-form-surface">
          <div className="remote-worker-enable-panel">
            <label className="remote-worker-enable-label" htmlFor="remote-worker-enabled">
              <input
                id="remote-worker-enabled"
                type="checkbox"
                checked={workerEnabled}
                onChange={(e) => setWorkerEnabled(e.target.checked)}
              />
              <span className="remote-worker-enable-label__main">
                <span className="remote-worker-enable-label__text">Enable worker</span>
              </span>
            </label>
          </div>

          {selectedDeviceId && (
            <div className="remote-worker-next-run" role="status" aria-live="polite">
              <span className="remote-worker-next-run__label">Next run</span>
              <div className="remote-worker-next-run__body">
                <span className="remote-worker-next-run__value">{workerNextRunUi.main}</span>
                {workerNextRunUi.sub ? (
                  <span className="remote-worker-next-run__at muted">{workerNextRunUi.sub}</span>
                ) : null}
              </div>
            </div>
          )}

          <div className="remote-form-divider" aria-hidden="true" />

          <div className="remote-form-group">
            <h3 className="remote-form-group__title">Accounts &amp; symbols</h3>
            <div className="remote-form-group__stack">
              <div className="form-row remote-form-field">
                <span className="remote-form-field-label" id="worker-accounts-label">
                  Accounts
                </span>
                {terminalsForSelected.length > 0 ? (
                  <div className="remote-worker-accounts-dropdown" ref={workerAccountsDropdownRef}>
                    <button
                      type="button"
                      id="worker-accounts-trigger"
                      className="remote-worker-accounts-dropdown__trigger"
                      aria-expanded={workerAccountsDropdownOpen}
                      aria-haspopup="listbox"
                      aria-labelledby="worker-accounts-label worker-accounts-trigger"
                      onClick={() => setWorkerAccountsDropdownOpen((o) => !o)}
                    >
                      <span className="remote-worker-accounts-dropdown__trigger-text">{workerAccountsDropdownSummary}</span>
                      <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
                        {workerAccountsDropdownOpen ? '▲' : '▼'}
                      </span>
                    </button>
                    {workerAccountsDropdownOpen && (
                      <div
                        className="remote-worker-accounts-dropdown__panel"
                        role="listbox"
                        aria-multiselectable="true"
                        aria-label="Accounts on device"
                      >
                        <div className="remote-worker-accounts-dropdown__bulk" role="presentation">
                          <button
                            type="button"
                            className="remote-worker-accounts-dropdown__bulk-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setWorkerAccounts(
                                buildWorkerAccountsSelectAll(terminalsForSelected, workerAccounts),
                              )
                            }}
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            className="remote-worker-accounts-dropdown__bulk-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setWorkerAccounts(
                                buildWorkerAccountsUnselectAllTerminals(terminalsForSelected, workerAccounts),
                              )
                            }}
                          >
                            Unselect all
                          </button>
                        </div>
                        {terminalsForSelected.map((t) => {
                          const checked = workerTerminalSelectedIds.includes(t.id)
                          return (
                            <label key={t.id} className="remote-worker-accounts-dropdown__option">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  setWorkerAccounts(
                                    buildWorkerAccountsToggleTerminal(
                                      terminalsForSelected,
                                      workerAccounts,
                                      t.id,
                                      e.target.checked,
                                    ),
                                  )
                                }
                              />
                              <span className="remote-worker-accounts-dropdown__option-text" title={t.exe_path}>
                                {t.label} <span className="muted">({t.id})</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    id="worker-accounts"
                    aria-labelledby="worker-accounts-label"
                    value={workerAccounts}
                    onChange={(e) => setWorkerAccounts(e.target.value)}
                    placeholder="comma-separated ids"
                  />
                )}
              </div>
              {terminalsForSelected.length > 0 && (
                <div className="form-row remote-form-field">
                  <label htmlFor="worker-accounts-extra">Other IDs</label>
                  <input
                    id="worker-accounts-extra"
                    value={workerAccountsExtraIds.join(', ')}
                    onChange={(ev) => {
                      const tid = new Set(terminalsForSelected.map((t) => t.id))
                      const selected = parseCommaIds(workerAccounts).filter((id) => tid.has(id))
                      const newExtra = parseCommaIds(ev.target.value)
                      setWorkerAccounts([...selected, ...newExtra].join(','))
                    }}
                    placeholder="comma-separated"
                  />
                </div>
              )}
              <div className="form-row remote-form-field">
                <span className="remote-form-field-label" id="worker-symbols-label">
                  Symbols
                </span>
                <div className="remote-worker-accounts-dropdown" ref={workerSymbolsDropdownRef}>
                  <button
                    type="button"
                    id="worker-symbols-trigger"
                    className="remote-worker-accounts-dropdown__trigger"
                    disabled={workerSymbolsLoading || workerSymbolOptions.length === 0}
                    aria-expanded={workerSymbolsDropdownOpen}
                    aria-haspopup="listbox"
                    aria-labelledby="worker-symbols-label worker-symbols-trigger"
                    onClick={() => setWorkerSymbolsDropdownOpen((o) => !o)}
                  >
                    <span className="remote-worker-accounts-dropdown__trigger-text">
                      {workerSymbolsDropdownSummary}
                    </span>
                    <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
                      {workerSymbolsDropdownOpen ? '▲' : '▼'}
                    </span>
                  </button>
                  {workerSymbolsDropdownOpen && workerSymbolOptions.length > 0 && (
                    <div
                      className="remote-worker-accounts-dropdown__panel remote-worker-symbols-dropdown__panel"
                      role="listbox"
                      aria-multiselectable="true"
                      aria-label="Symbols"
                    >
                      {workerSymbolOptions.map((sym) => {
                        const checked = workerSymbolSelectedIds.includes(sym)
                        return (
                          <label key={sym} className="remote-worker-accounts-dropdown__option">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setWorkerSymbols(
                                  buildWorkerSymbolsToggle(
                                    workerSymbolOptions,
                                    workerSymbols,
                                    sym,
                                    e.target.checked,
                                  ),
                                )
                              }
                            />
                            <span className="remote-worker-accounts-dropdown__option-text">{sym}</span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
              {workerSymbolOptions.length > 0 && (
                <div className="form-row remote-form-field">
                  <label htmlFor="worker-symbols-extra">Other symbols</label>
                  <input
                    id="worker-symbols-extra"
                    value={workerSymbolsExtraIds.join(', ')}
                    onChange={(ev) => {
                      const opt = new Set(workerSymbolOptions)
                      const selected = parseCommaIds(workerSymbols).filter((s) => opt.has(s))
                      const newExtra = parseCommaIds(ev.target.value)
                      setWorkerSymbols([...selected, ...newExtra].join(','))
                    }}
                    placeholder="comma-separated"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="remote-form-divider" aria-hidden="true" />

          <div className="remote-form-group">
            <h3 className="remote-form-group__title">Volume · interval (min)</h3>
            <div className="remote-worker-quad-grid">
              <div className="form-row remote-form-field">
                <label htmlFor="worker-min-vol">Minimum</label>
                <input
                  id="worker-min-vol"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={workerMinVol}
                  onChange={(e) => setWorkerMinVol(Math.max(0.01, Number(e.target.value) || 0.01))}
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="worker-max-vol">Maximum</label>
                <input
                  id="worker-max-vol"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={workerMaxVol}
                  onChange={(e) => setWorkerMaxVol(Math.max(0.01, Number(e.target.value) || 0.01))}
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="worker-min-int">Min interval</label>
                <input
                  id="worker-min-int"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={workerMinInt}
                  onChange={(e) => setWorkerMinInt(Math.max(0.5, Number(e.target.value) || 0.5))}
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="worker-max-int">Max interval</label>
                <input
                  id="worker-max-int"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={workerMaxInt}
                  onChange={(e) => setWorkerMaxInt(Math.max(0.5, Number(e.target.value) || 0.5))}
                />
              </div>
            </div>
          </div>

          <div className="remote-form-divider" aria-hidden="true" />

          <div className="remote-form-group">
            <h3 className="remote-form-group__title">Cap</h3>
            <div className="form-row remote-form-field">
              <label htmlFor="worker-max-open">Max open (0 = none)</label>
              <input
                id="worker-max-open"
                type="number"
                min={0}
                step={1}
                value={workerMaxOpen}
                onChange={(e) => setWorkerMaxOpen(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </div>
          </div>
        </div>

        <div className="remote-form-footer">
          <div className="remote-worker-footer-actions">
            <button type="button" className="remote-primary-action" onClick={saveWorkerConfig} disabled={workerBusy || workerClosingAll || !selectedDeviceId}>
              {workerBusy ? 'Saving…' : 'Save worker'}
            </button>
            <button
              type="button"
              className="btn-danger remote-worker-close-all-btn"
              onClick={() => void enqueueCloseWorkerPositions()}
              disabled={workerBusy || workerClosingAll || !selectedDeviceId || parseCommaIds(workerAccounts).length === 0}
            >
              {workerClosingAll ? 'Queueing…' : 'Close all on selected'}
            </button>
          </div>
        </div>
      </div>

      <div className="card trading-card remote-agents-card remote-agents-card--last">
        <div className="trading-card-header remote-agents-card-header">
          <h2 className="remote-agents-card-title">Commands</h2>
          <span className="trading-badge subtle">{loadingCommands ? '…' : `${commands.length}`}</span>
        </div>
        <div className="table-wrap remote-agents-table-wrap remote-agents-commands-scroll">
          <table className="slave-table remote-devices-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Status</th>
                <th>Device</th>
              </tr>
            </thead>
            <tbody>
              {commands.length === 0 && (
                <tr><td colSpan={4} className="muted">No commands yet.</td></tr>
              )}
              {commands.map((c) => (
                <tr key={c.id}>
                  <td>{c.created_unix ? new Date(c.created_unix * 1000).toLocaleString() : '—'}</td>
                  <td>{c.type || c.cmd_type || '—'}</td>
                  <td>{c.status}</td>
                  <td><code className="remote-device-id">{c.device_id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </div>
  )
}
