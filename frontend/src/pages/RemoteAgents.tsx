import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFetch, panelWsUrl } from '../apiClient'
import { useLocalSymbolTicksWebSocket } from '../useLocalSymbolTicksWebSocket'

const API = '/api'
const ADMIN_KEY_STORAGE = 'mt5bot_agent_admin_key'
const REMOTE_AGENTS_UI_KEY = 'mt5bot_remote_agents_ui'
const REMOTE_AGENTS_UI_VERSION = 1

type RemoteAgentsUiPersisted = {
  v: number
  selectedDeviceId?: string
  /** Comma-separated selected devices for Enqueue order. */
  enqueueDeviceIds?: string
  /** Comma-separated selected devices for Remote worker. */
  workerDeviceIds?: string
  accountId?: string
  symbol?: string
  orderType?: string
  volume?: number
  orderComment?: string
  /** Enqueue order: SL distance in pips (optional). */
  enqueueSlPips?: string
  /** Enqueue order: TP distance in pips (optional). */
  enqueueTpPips?: string
  workerEnabled?: boolean
  workerAccounts?: string
  workerSymbols?: string
  workerMinVol?: number
  workerMaxVol?: number
  workerMinInt?: number
  workerMaxInt?: number
  workerMaxOpen?: number
  /** Remote worker SL/TP in pips (optional strings). */
  workerSlPips?: string
  workerTpPips?: string
  /** Max spread (pips) on agent MT5; skip open if current spread exceeds (empty = no limit). */
  workerMaxSpreadPips?: string
  /** Comma-separated terminal ids for Enqueue order (multi-select). */
  enqueueOrderAccounts?: string
  /** Symbols for Live quotes (local MT5 on panel host), comma-separated. */
  liveQuoteSymbols?: string
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

/** Rough pip/point count for spread display (majors 0.0001, JPY 0.01, metals loose). */
function estimateSpreadPips(symbol: string, bid: number, ask: number): number {
  const u = symbol.toUpperCase()
  const sp = ask - bid
  if (!(sp > 0) || !Number.isFinite(sp)) return 0
  if (u.includes('JPY')) return sp / 0.01
  if (u.includes('XAU') || u.includes('XAG')) return sp / 0.01
  if (u.includes('BTC') || u.includes('ETH')) return sp
  return sp / 0.0001
}

/** Enqueue-order multi-select: preserve list order from `options`. */
function toggleOrderedId(
  options: string[],
  selected: string[],
  id: string,
  checked: boolean,
): string[] {
  const s = new Set(selected)
  if (checked) s.add(id)
  else s.delete(id)
  return options.filter((x) => s.has(x))
}

type EnqueueAccountOption = {
  key: string
  deviceId: string
  deviceLabel: string
  accountId: string
  accountLabel: string
  exePath: string
}

const ENQUEUE_KEY_SEP = '::'
function makeEnqueueAccountKey(deviceId: string, accountId: string): string {
  return `${deviceId}${ENQUEUE_KEY_SEP}${accountId}`
}

function parseEnqueueAccountKey(key: string): { deviceId: string; accountId: string } | null {
  const i = key.indexOf(ENQUEUE_KEY_SEP)
  if (i <= 0) return null
  const deviceId = key.slice(0, i)
  const accountId = key.slice(i + ENQUEUE_KEY_SEP.length)
  if (!deviceId || !accountId) return null
  return { deviceId, accountId }
}

/**
 * MT5 on the **panel API machine** (Rust/Python bridge), not remote agent terminal ids.
 * Backend resolves `exness` → `C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe`.
 */
const PANEL_LOCAL_MT5_ACCOUNT = 'exness'

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
  const [enqueueDeviceIds, setEnqueueDeviceIds] = useState<string[]>(() => {
    const fromUi = ui0.enqueueDeviceIds?.trim()
    if (fromUi) return parseCommaIds(fromUi)
    const one = ui0.selectedDeviceId?.trim()
    return one ? [one] : []
  })
  const [accountId, setAccountId] = useState(() => ui0.accountId ?? 'exness')
  const [enqueueOrderAccountIds, setEnqueueOrderAccountIds] = useState<string[]>(() => {
    const fromE = ui0.enqueueOrderAccounts?.trim()
    if (fromE) return parseCommaIds(fromE)
    const a = ui0.accountId?.trim()
    return a ? [a] : ['exness']
  })
  const [symbol, setSymbol] = useState(() => ui0.symbol ?? 'EURUSDm')
  const [liveQuoteSymbols, setLiveQuoteSymbols] = useState(() => ui0.liveQuoteSymbols ?? 'EURUSDm,GBPUSDm')
  const [orderType, setOrderType] = useState<'buy' | 'sell'>(() => (ui0.orderType === 'sell' ? 'sell' : 'buy'))
  const [volume, setVolume] = useState(() =>
    typeof ui0.volume === 'number' && Number.isFinite(ui0.volume) ? ui0.volume : 0.01,
  )
  const [orderComment, setOrderComment] = useState(() => ui0.orderComment ?? 'panel-remote')
  const [enqueueSlPips, setEnqueueSlPips] = useState(() => ui0.enqueueSlPips ?? '')
  const [enqueueTpPips, setEnqueueTpPips] = useState(() => ui0.enqueueTpPips ?? '')
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [workerDeviceIds, setWorkerDeviceIds] = useState<string[]>(() => {
    const fromUi = ui0.workerDeviceIds?.trim()
    if (fromUi) return parseCommaIds(fromUi)
    const one = ui0.selectedDeviceId?.trim()
    return one ? [one] : []
  })
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
  const [workerSlPips, setWorkerSlPips] = useState(() => ui0.workerSlPips ?? '')
  const [workerTpPips, setWorkerTpPips] = useState(() => ui0.workerTpPips ?? '')
  const [workerMaxSpreadPips, setWorkerMaxSpreadPips] = useState(() => ui0.workerMaxSpreadPips ?? '')
  const [workerAccountsDropdownOpen, setWorkerAccountsDropdownOpen] = useState(false)
  const workerAccountsDropdownRef = useRef<HTMLDivElement>(null)
  const [workerDevicesDropdownOpen, setWorkerDevicesDropdownOpen] = useState(false)
  const workerDevicesDropdownRef = useRef<HTMLDivElement>(null)
  const [enqueueDevicesDropdownOpen, setEnqueueDevicesDropdownOpen] = useState(false)
  const enqueueDevicesDropdownRef = useRef<HTMLDivElement>(null)
  const [enqueueAccountsDropdownOpen, setEnqueueAccountsDropdownOpen] = useState(false)
  const enqueueAccountsDropdownRef = useRef<HTMLDivElement>(null)
  const [workerSymbolOptions, setWorkerSymbolOptions] = useState<string[]>([])
  const [workerSymbolsLoading, setWorkerSymbolsLoading] = useState(false)
  const [workerSymbolsDropdownOpen, setWorkerSymbolsDropdownOpen] = useState(false)
  const workerSymbolsDropdownRef = useRef<HTMLDivElement>(null)
  const [workerCountdownTick, setWorkerCountdownTick] = useState(0)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [workerClosingAll, setWorkerClosingAll] = useState(false)
  const [clearCommandsBusy, setClearCommandsBusy] = useState(false)
  const [clearCommandsConfirmOpen, setClearCommandsConfirmOpen] = useState(false)
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
  const liveQuoteSymList = useMemo(() => parseCommaIds(liveQuoteSymbols), [liveQuoteSymbols])
  const liveTickWs = useLocalSymbolTicksWebSocket(PANEL_LOCAL_MT5_ACCOUNT, liveQuoteSymList)
  const liveQuotesTicks = liveTickWs.ticks
  const liveQuotesErr =
    liveQuoteSymList.length === 0
      ? null
      : liveTickWs.error ??
        (!liveTickWs.connected && liveTickWs.transport === 'ws' ? 'WebSocket reconnecting…' : null)

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
      enqueueDeviceIds: enqueueDeviceIds.join(','),
      workerDeviceIds: workerDeviceIds.join(','),
      accountId,
      symbol,
      orderType,
      volume,
      orderComment,
      enqueueSlPips,
      enqueueTpPips,
      workerEnabled,
      workerAccounts,
      workerSymbols,
      workerMinVol,
      workerMaxVol,
      workerMinInt,
      workerMaxInt,
      workerMaxOpen,
      workerSlPips,
      workerTpPips,
      workerMaxSpreadPips,
      enqueueOrderAccounts: enqueueOrderAccountIds.join(','),
      liveQuoteSymbols,
    })
  }, [
    selectedDeviceId,
    enqueueDeviceIds,
    workerDeviceIds,
    accountId,
    symbol,
    orderType,
    volume,
    orderComment,
    enqueueSlPips,
    enqueueTpPips,
    workerEnabled,
    workerAccounts,
    workerSymbols,
    workerMinVol,
    workerMaxVol,
    workerMinInt,
    workerMaxInt,
    workerMaxOpen,
    workerSlPips,
    workerTpPips,
    workerMaxSpreadPips,
    enqueueOrderAccountIds,
    liveQuoteSymbols,
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
      setEnqueueDeviceIds((prev) => {
        if (list.length === 0) return []
        const allowed = new Set(list.map((d) => d.device_id))
        const keep = prev.filter((id) => allowed.has(id))
        if (keep.length > 0) return keep
        return [list[0].device_id]
      })
      setWorkerDeviceIds((prev) => {
        if (list.length === 0) return []
        const allowed = new Set(list.map((d) => d.device_id))
        const keep = prev.filter((id) => allowed.has(id))
        if (keep.length > 0) return keep
        return [list[0].device_id]
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

  const clearCommandsScope = useMemo(() => {
    const did = selectedDeviceId.trim()
    if (!did) {
      return { kind: 'all' as const, title: 'All devices', deviceId: null as string | null }
    }
    const row = devices.find((d) => d.device_id === did)
    return {
      kind: 'device' as const,
      title: row?.label?.trim() || 'Selected device',
      deviceId: did,
    }
  }, [selectedDeviceId, devices])

  const openClearCommandsConfirm = useCallback(() => {
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    setClearCommandsConfirmOpen(true)
  }, [adminKey])

  const executeClearCommands = useCallback(async () => {
    if (!adminKey.trim()) return
    const did = selectedDeviceId.trim()
    setClearCommandsConfirmOpen(false)
    setClearCommandsBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/commands/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          ...(did ? { device_id: did } : {}),
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      const n = typeof data.removed === 'number' ? data.removed : 0
      showToast(n > 0 ? `Cleared ${n} command(s)` : 'Nothing to clear')
      void refreshCommands()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setClearCommandsBusy(false)
    }
  }, [adminKey, selectedDeviceId, refreshCommands])

  useEffect(() => {
    if (!clearCommandsConfirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !clearCommandsBusy) setClearCommandsConfirmOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearCommandsConfirmOpen, clearCommandsBusy])

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
    let startTimer: ReturnType<typeof setTimeout> | undefined

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
      socket = new WebSocket(panelWsUrl('/ws/agent'))
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

    startTimer = window.setTimeout(() => {
      startTimer = undefined
      if (!cancelled) connect()
    }, 0)

    return () => {
      cancelled = true
      if (startTimer !== undefined) {
        window.clearTimeout(startTimer)
        startTimer = undefined
      }
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
      const ws = cfg.sl_pips
      setWorkerSlPips(typeof ws === 'number' && Number.isFinite(ws) && ws > 0 ? String(ws) : '')
      const wt = cfg.tp_pips
      setWorkerTpPips(typeof wt === 'number' && Number.isFinite(wt) && wt > 0 ? String(wt) : '')
      const mx = cfg.max_spread_pips
      setWorkerMaxSpreadPips(typeof mx === 'number' && Number.isFinite(mx) && mx > 0 ? String(mx) : '')
    } catch (_) {
      // ignore
    }
  }, [adminKey])

  const enqueueSelectedDeviceRows = useMemo(() => {
    const map = new Map(devices.map((d) => [d.device_id, d] as const))
    return enqueueDeviceIds.map((id) => map.get(id)).filter((d): d is DeviceRow => !!d)
  }, [devices, enqueueDeviceIds])

  const terminalsForEnqueue = useMemo((): TerminalEntry[] => {
    if (enqueueSelectedDeviceRows.length === 0) return []
    const byId = new Map<string, TerminalEntry>()
    for (const d of enqueueSelectedDeviceRows) {
      const ts = deviceTerminals[d.device_id] ?? d.terminals ?? []
      for (const t of ts) {
        if (!byId.has(t.id)) byId.set(t.id, t)
      }
    }
    return [...byId.values()]
  }, [enqueueSelectedDeviceRows, deviceTerminals])

  const enqueueAccountOptions = useMemo((): EnqueueAccountOption[] => {
    const out: EnqueueAccountOption[] = []
    for (const d of enqueueSelectedDeviceRows) {
      const ts = deviceTerminals[d.device_id] ?? d.terminals ?? []
      for (const t of ts) {
        out.push({
          key: makeEnqueueAccountKey(d.device_id, t.id),
          deviceId: d.device_id,
          deviceLabel: d.label,
          accountId: t.id,
          accountLabel: t.label,
          exePath: t.exe_path,
        })
      }
    }
    return out
  }, [enqueueSelectedDeviceRows, deviceTerminals])

  const enqueueAccountGroups = useMemo(() => {
    const groups: Array<{ deviceId: string; deviceLabel: string; options: EnqueueAccountOption[] }> = []
    const byDevice = new Map<string, EnqueueAccountOption[]>()
    const labelByDevice = new Map<string, string>()
    for (const opt of enqueueAccountOptions) {
      const arr = byDevice.get(opt.deviceId) ?? []
      arr.push(opt)
      byDevice.set(opt.deviceId, arr)
      if (!labelByDevice.has(opt.deviceId)) labelByDevice.set(opt.deviceId, opt.deviceLabel)
    }
    for (const d of enqueueSelectedDeviceRows) {
      const options = byDevice.get(d.device_id) ?? []
      if (options.length === 0) continue
      groups.push({
        deviceId: d.device_id,
        deviceLabel: labelByDevice.get(d.device_id) ?? d.label,
        options,
      })
    }
    return groups
  }, [enqueueAccountOptions, enqueueSelectedDeviceRows])

  useEffect(() => {
    if (enqueueDeviceIds.length === 0) return
    if (enqueueDeviceIds.includes(selectedDeviceId)) return
    const next = enqueueDeviceIds[0]
    setSelectedDeviceId(next)
    void loadWorkerConfigForDevice(next)
  }, [enqueueDeviceIds, selectedDeviceId, loadWorkerConfigForDevice])

  const selectedDeviceRow = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId),
    [devices, selectedDeviceId],
  )

  const workerSelectedDeviceRows = useMemo(() => {
    const map = new Map(devices.map((d) => [d.device_id, d] as const))
    return workerDeviceIds.map((id) => map.get(id)).filter((d): d is DeviceRow => !!d)
  }, [devices, workerDeviceIds])

  const workerNextRunUi = useMemo(() => {
    void workerCountdownTick
    return computeWorkerNextRunUi(selectedDeviceId, selectedDeviceRow)
  }, [selectedDeviceId, selectedDeviceRow, workerCountdownTick])

  const workerAccountsExtraIds = useMemo(() => {
    return parseCommaIds(workerAccounts).filter((id) => !id.includes(ENQUEUE_KEY_SEP))
  }, [workerAccounts])

  const workerAccountOptions = useMemo((): EnqueueAccountOption[] => {
    const out: EnqueueAccountOption[] = []
    for (const d of workerSelectedDeviceRows) {
      const ts = deviceTerminals[d.device_id] ?? d.terminals ?? []
      for (const t of ts) {
        out.push({
          key: makeEnqueueAccountKey(d.device_id, t.id),
          deviceId: d.device_id,
          deviceLabel: d.label,
          accountId: t.id,
          accountLabel: t.label,
          exePath: t.exe_path,
        })
      }
    }
    return out
  }, [workerSelectedDeviceRows, deviceTerminals])

  const workerScopedSelectedKeys = useMemo(() => {
    const optionKeys = new Set(workerAccountOptions.map((x) => x.key))
    const out: string[] = []
    for (const id of parseCommaIds(workerAccounts)) {
      if (optionKeys.has(id)) out.push(id)
    }
    return out
  }, [workerAccountOptions, workerAccounts])

  const workerAccountsDropdownSummary = useMemo(() => {
    if (workerScopedSelectedKeys.length === 0) return 'Select accounts…'
    return `${workerScopedSelectedKeys.length} accounts selected`
  }, [workerScopedSelectedKeys])

  const workerAccountGroups = useMemo(() => {
    const groups: Array<{ deviceId: string; deviceLabel: string; options: EnqueueAccountOption[] }> = []
    const byDevice = new Map<string, EnqueueAccountOption[]>()
    for (const opt of workerAccountOptions) {
      const arr = byDevice.get(opt.deviceId) ?? []
      arr.push(opt)
      byDevice.set(opt.deviceId, arr)
    }
    for (const d of workerSelectedDeviceRows) {
      const options = byDevice.get(d.device_id) ?? []
      if (options.length === 0) continue
      groups.push({ deviceId: d.device_id, deviceLabel: d.label, options })
    }
    return groups
  }, [workerAccountOptions, workerSelectedDeviceRows])

  const enqueueOrderScopedSelectedIds = useMemo(() => {
    const optionKeys = new Set(enqueueAccountOptions.map((x) => x.key))
    const out: string[] = []
    for (const id of enqueueOrderAccountIds) {
      if (optionKeys.has(id)) out.push(id)
    }
    return out
  }, [enqueueAccountOptions, enqueueOrderAccountIds])

  const enqueueAccountsDropdownSummary = useMemo(() => {
    if (enqueueOrderScopedSelectedIds.length === 0) return 'Select accounts…'
    return `${enqueueOrderScopedSelectedIds.length} accounts selected`
  }, [enqueueOrderScopedSelectedIds])

  /** Symbols in Remote worker config (deduped, max 48 for `/ws/local-symbol-ticks`). */
  const workerSymbolTickList = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of parseCommaIds(workerSymbols)) {
      const t = s.trim()
      if (!t) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
      if (out.length >= 48) break
    }
    return out
  }, [workerSymbols])

  const workerTickWs = useLocalSymbolTicksWebSocket(PANEL_LOCAL_MT5_ACCOUNT, workerSymbolTickList)
  const workerQuotesTicks = workerTickWs.ticks
  const workerQuotesErr =
    workerSymbolTickList.length === 0
      ? null
      : workerTickWs.error ??
        (!workerTickWs.connected && workerTickWs.transport === 'ws' ? 'WebSocket reconnecting…' : null)

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

  /** Parsed max spread limit (pips) for UI hint vs live table; agent enforces on device MT5. */
  const workerMaxSpreadLimitPips = useMemo(() => {
    const s = workerMaxSpreadPips.trim()
    if (!s) return null
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [workerMaxSpreadPips])

  /** Remote worker may only run with both SL and TP in pips (panel + API enforce). */
  const workerStopsComplete = useMemo(() => {
    const wsl = workerSlPips.trim()
    const wtp = workerTpPips.trim()
    if (!wsl || !wtp) return false
    const nsl = Number(wsl)
    const ntp = Number(wtp)
    return Number.isFinite(nsl) && nsl > 0 && Number.isFinite(ntp) && ntp > 0
  }, [workerSlPips, workerTpPips])

  useEffect(() => {
    let cancelled = false
    setWorkerSymbolsLoading(true)
    void (async () => {
      try {
        const r = await apiFetch(
          `${API}/symbols?account_id=${encodeURIComponent(PANEL_LOCAL_MT5_ACCOUNT)}`,
        )
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
  }, [])

  useEffect(() => {
    if (enqueueAccountOptions.length === 0) return
    setEnqueueOrderAccountIds((prev) => {
      const validKeys = new Set(enqueueAccountOptions.map((x) => x.key))
      const nextSet = new Set<string>()
      for (const id of prev) {
        if (validKeys.has(id)) {
          nextSet.add(id)
          continue
        }
        // Backward compatibility for previously saved plain account ids.
        for (const opt of enqueueAccountOptions) {
          if (opt.accountId === id) nextSet.add(opt.key)
        }
      }
      const ordered = enqueueAccountOptions.map((x) => x.key).filter((k) => nextSet.has(k))
      if (ordered.length > 0) return ordered
      return [enqueueAccountOptions[0].key]
    })
  }, [enqueueDeviceIds, enqueueAccountOptions])

  useEffect(() => {
    if (!enqueueDevicesDropdownOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = enqueueDevicesDropdownRef.current
      if (el && !el.contains(e.target as Node)) setEnqueueDevicesDropdownOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnqueueDevicesDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [enqueueDevicesDropdownOpen])

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
    if (!workerDevicesDropdownOpen) return
    const onDoc = (e: MouseEvent) => {
      const el = workerDevicesDropdownRef.current
      if (el && !el.contains(e.target as Node)) setWorkerDevicesDropdownOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkerDevicesDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [workerDevicesDropdownOpen])

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
    if (enqueueDeviceIds.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one device.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    const scopedTargets =
      enqueueAccountOptions.length > 0
        ? [...new Set(enqueueOrderAccountIds.filter((id) => enqueueAccountOptions.some((o) => o.key === id)))]
        : []
    const accountTargets =
      enqueueAccountOptions.length > 0 ? scopedTargets : parseCommaIds(accountId.trim() || 'default')
    if (accountTargets.length === 0) {
      setMsg({
        type: 'error',
        text:
          enqueueAccountOptions.length > 0
            ? 'Select at least one account.'
            : 'Enter at least one account id (comma-separated for multiple).',
      })
      return
    }
    let slPipsPayload: number | undefined
    let tpPipsPayload: number | undefined
    const slRaw = enqueueSlPips.trim()
    const tpRaw = enqueueTpPips.trim()
    if (slRaw) {
      const n = Number(slRaw)
      if (!Number.isFinite(n) || n <= 0) {
        setMsg({ type: 'error', text: 'Stop loss (pips) must be a positive number or leave blank.' })
        return
      }
      slPipsPayload = n
    }
    if (tpRaw) {
      const n = Number(tpRaw)
      if (!Number.isFinite(n) || n <= 0) {
        setMsg({ type: 'error', text: 'Take profit (pips) must be a positive number or leave blank.' })
        return
      }
      tpPipsPayload = n
    }
    setEnqueueBusy(true)
    setMsg(null)
    try {
      const side = orderType === 'buy' ? 'Buy' : 'Sell'
      const deviceRowMap = new Map(devices.map((d) => [d.device_id, d] as const))
      const results = await Promise.all(
        enqueueDeviceIds.map(async (device_id) => {
          const row = deviceRowMap.get(device_id)
          const devTerms = deviceTerminals[device_id] ?? row?.terminals ?? []
          const deviceAccountTargets =
            enqueueAccountOptions.length > 0
              ? accountTargets
                  .map((k) => parseEnqueueAccountKey(k))
                  .filter((x): x is { deviceId: string; accountId: string } => !!x)
                  .filter((x) => x.deviceId === device_id)
                  .map((x) => x.accountId)
              : devTerms.length > 0
                ? accountTargets.filter((id) => devTerms.some((t) => t.id === id))
                : accountTargets
          if (deviceAccountTargets.length === 0) {
            return {
              device_id,
              ok: false,
              skipped: true,
              error: 'No selected accounts exist on this device',
            }
          }
          const deviceOrders = deviceAccountTargets.map((account_id) => ({ account_id }))
          const r = await apiFetch(`${API}/agent/commands/enqueue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              admin_key: adminKey,
              device_id,
              type: 'place_market_orders',
              ttl_sec: 600,
              payload: {
                orders: deviceOrders,
                symbol: symbol.trim(),
                order_type: orderType,
                volume,
                comment: orderComment.trim() || 'panel-remote',
                ...(slPipsPayload != null ? { sl_pips: slPipsPayload } : {}),
                ...(tpPipsPayload != null ? { tp_pips: tpPipsPayload } : {}),
              },
            }),
          })
          const data = await r.json().catch(() => ({}))
          return {
            device_id,
            ok: !!(r.ok && data.ok),
            skipped: false,
            error: (data as { error?: string }).error || `HTTP ${r.status}`,
          }
        }),
      )
      const okCount = results.filter((x) => x.ok).length
      const skippedCount = results.filter((x) => x.skipped).length
      const fail = results.find((x) => !x.ok)
      if (okCount === 0) {
        setMsg({ type: 'error', text: fail?.error || 'Request failed' })
        return
      }
      if (okCount < results.length && fail) {
        setMsg({
          type: 'error',
          text: `Queued on ${okCount}/${results.length} devices. First error: ${fail.error}`,
        })
      }
      const pipHint =
        slPipsPayload != null || tpPipsPayload != null
          ? ` · SL ${slPipsPayload ?? '—'} / TP ${tpPipsPayload ?? '—'} pips`
          : ''
      showToast(
        accountTargets.length > 1
          ? `${side} ${volume} ${symbol} — queued on ${okCount}/${results.length} devices (${accountTargets.length} accounts${skippedCount > 0 ? `, ${skippedCount} skipped` : ''})${pipHint}`
          : `${side} ${volume} ${symbol} — queued on ${okCount}/${results.length} devices${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}${pipHint}`,
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
    if (workerDeviceIds.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one worker device.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    const accountScoped = parseCommaIds(workerAccounts)
    const account_ids_fallback = workerAccountsExtraIds
    if (accountScoped.length === 0 && account_ids_fallback.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one account under Remote worker.' })
      return
    }
    setWorkerClosingAll(true)
    setMsg(null)
    try {
      const results = await Promise.all(
        workerDeviceIds.map(async (device_id) => {
          const scoped = accountScoped
            .map((k) => parseEnqueueAccountKey(k))
            .filter((x): x is { deviceId: string; accountId: string } => !!x)
            .filter((x) => x.deviceId === device_id)
            .map((x) => x.accountId)
          const account_ids = scoped.length > 0 ? scoped : account_ids_fallback
          if (account_ids.length === 0) {
            return { ok: false, device_id, error: 'No selected accounts for this device' }
          }
          const r = await apiFetch(`${API}/agent/commands/enqueue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              admin_key: adminKey,
              device_id,
              type: 'close_positions_selected',
              ttl_sec: 600,
              payload: { account_ids },
            }),
          })
          const data = await r.json().catch(() => ({}))
          return { ok: !!(r.ok && data.ok), device_id, error: data.error || `HTTP ${r.status}` }
        }),
      )
      const okCount = results.filter((x) => x.ok).length
      if (okCount === 0) {
        setMsg({ type: 'error', text: results[0]?.error || 'Request failed' })
        return
      }
      showToast(`Close all queued on ${okCount}/${results.length} device(s)`)
      void refreshCommands()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setWorkerClosingAll(false)
    }
  }

  const saveWorkerConfig = async () => {
    if (workerDeviceIds.length === 0) {
      setMsg({ type: 'error', text: 'Select at least one worker device.' })
      return
    }
    if (workerEnabled && !workerStopsComplete) {
      setMsg({
        type: 'error',
        text: 'Remote worker requires both SL and TP (positive pips) while enabled. Turn the worker off or fill both fields.',
      })
      return
    }
    let workerSlPayload: number | undefined
    let workerTpPayload: number | undefined
    const wslR = workerSlPips.trim()
    const wtpR = workerTpPips.trim()
    if (wslR) {
      const n = Number(wslR)
      if (!Number.isFinite(n) || n <= 0) {
        setMsg({ type: 'error', text: 'Worker stop loss (pips) must be a positive number or leave blank.' })
        return
      }
      workerSlPayload = n
    }
    if (wtpR) {
      const n = Number(wtpR)
      if (!Number.isFinite(n) || n <= 0) {
        setMsg({ type: 'error', text: 'Worker take profit (pips) must be a positive number or leave blank.' })
        return
      }
      workerTpPayload = n
    }
    let workerMaxSpreadPayload: number | undefined
    const wmsR = workerMaxSpreadPips.trim()
    if (wmsR) {
      const n = Number(wmsR)
      if (!Number.isFinite(n) || n <= 0) {
        setMsg({
          type: 'error',
          text: 'Max spread (pips) must be a positive number or leave blank (no limit).',
        })
        return
      }
      workerMaxSpreadPayload = n
    }
    setWorkerBusy(true)
    setMsg(null)
    try {
      const scopedKeys = parseCommaIds(workerAccounts)
      const extraIds = workerAccountsExtraIds
      const symbols = workerSymbols
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const results = await Promise.all(
        workerDeviceIds.map(async (device_id) => {
          const account_ids = scopedKeys
            .map((k) => parseEnqueueAccountKey(k))
            .filter((x): x is { deviceId: string; accountId: string } => !!x)
            .filter((x) => x.deviceId === device_id)
            .map((x) => x.accountId)
          const mergedIds = account_ids.length > 0 ? account_ids : extraIds
          const r = await apiFetch(`${API}/agent/worker/set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              admin_key: adminKey,
              device_id,
              enabled: workerEnabled,
              account_ids: mergedIds,
              symbols,
              min_volume: workerMinVol,
              max_volume: workerMaxVol,
              min_interval_minutes: workerMinInt,
              max_interval_minutes: workerMaxInt,
              max_open_positions: workerMaxOpen,
              ...(workerSlPayload != null ? { sl_pips: workerSlPayload } : {}),
              ...(workerTpPayload != null ? { tp_pips: workerTpPayload } : {}),
              ...(workerMaxSpreadPayload != null ? { max_spread_pips: workerMaxSpreadPayload } : {}),
            }),
          })
          const data = await r.json().catch(() => ({}))
          return { ok: !!(r.ok && data.ok), error: data.error || `HTTP ${r.status}` }
        }),
      )
      const okCount = results.filter((x) => x.ok).length
      if (okCount === 0) {
        setMsg({ type: 'error', text: results[0]?.error || 'Request failed' })
        return
      }
      if (okCount < results.length) {
        setMsg({
          type: 'error',
          text: `Worker saved on ${okCount}/${results.length} devices. First error: ${results.find((x) => !x.ok)?.error}`,
        })
      }
      showToast(`Worker saved on ${okCount}/${results.length} devices`)
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

      {clearCommandsConfirmOpen && (
        <div
          className="remote-delete-overlay"
          role="presentation"
          onClick={() => {
            if (!clearCommandsBusy) setClearCommandsConfirmOpen(false)
          }}
        >
          <div
            className="remote-delete-card remote-delete-card--commands"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-clear-commands-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="remote-delete-icon-wrap" aria-hidden="true">
              <svg className="remote-delete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                />
              </svg>
            </div>
            <h3 id="remote-clear-commands-title" className="remote-delete-title">
              Clear commands?
            </h3>
            <p className="remote-delete-lead">
              Remove queued and finished commands for{' '}
              <strong>
                {clearCommandsScope.kind === 'all' ? 'all devices' : 'the selected device only'}
              </strong>
              ?
            </p>
            {clearCommandsScope.kind === 'device' && clearCommandsScope.deviceId && (
              <>
                <p className="remote-delete-meta">
                  <span className="muted">Device</span>
                  <strong className="remote-delete-lead" style={{ margin: 0, display: 'block' }}>
                    {clearCommandsScope.title}
                  </strong>
                  <code className="remote-delete-device-id">{clearCommandsScope.deviceId}</code>
                </p>
              </>
            )}
            {clearCommandsScope.kind === 'all' && (
              <p className="remote-delete-warning remote-delete-warning-online" style={{ marginBottom: '0.75rem' }}>
                No row selected in the device table — commands for <strong>every</strong> paired device will be cleared.
                Select a device first to limit scope.
              </p>
            )}
            <p className="remote-delete-warning">
              Commands currently in progress (<strong>in flight</strong>) are kept so agents can finish reporting results.
            </p>
            <div className="remote-delete-actions">
              <button
                type="button"
                className="remote-delete-btn secondary"
                disabled={clearCommandsBusy}
                onClick={() => setClearCommandsConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="remote-delete-btn commands-clear-confirm"
                disabled={clearCommandsBusy}
                onClick={() => void executeClearCommands()}
              >
                {clearCommandsBusy ? 'Clearing…' : 'Clear commands'}
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

        <div className="remote-live-quotes-card" aria-labelledby="remote-live-quotes-title">
          <div className="remote-live-quotes-card__head">
            <h3 id="remote-live-quotes-title" className="remote-live-quotes-card__title">
              Live quotes
            </h3>
          </div>
          <div className="remote-live-quotes-fields">
            <div>
              <label htmlFor="live-quote-symbols">Symbols (comma-separated)</label>
              <input
                id="live-quote-symbols"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={liveQuoteSymbols}
                onChange={(e) => setLiveQuoteSymbols(e.target.value)}
                placeholder="EURUSDm, GBPUSDm"
              />
            </div>
          </div>
          <div className="remote-live-quotes-table-wrap">
            <table className="remote-live-quotes-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Bid</th>
                  <th>Ask</th>
                  <th>Spread</th>
                </tr>
              </thead>
              <tbody>
                {liveQuoteSymList.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="remote-live-quotes-muted">
                      Add one or more symbols above.
                    </td>
                  </tr>
                ) : (
                  liveQuoteSymList.map((sym) => {
                    const t = liveQuotesTicks[sym]
                    if (!t) {
                      return (
                        <tr key={sym}>
                          <td className="remote-live-quotes-symbol">{sym}</td>
                          <td colSpan={3} className="remote-live-quotes-muted">
                            {liveQuotesErr || 'Waiting for tick…'}
                          </td>
                        </tr>
                      )
                    }
                    const { bid, ask } = t
                    const spread = ask - bid
                    const pips = estimateSpreadPips(sym, bid, ask)
                    return (
                      <tr key={sym}>
                        <td className="remote-live-quotes-symbol">{sym}</td>
                        <td className="remote-live-quotes-bid">{bid.toFixed(5)}</td>
                        <td className="remote-live-quotes-ask">{ask.toFixed(5)}</td>
                        <td className="remote-live-quotes-spread">
                          {spread.toFixed(5)} ({pips >= 1 || pips === 0 ? `${pips.toFixed(1)} pips` : `${pips.toFixed(2)} pts`})
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
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
                <span className="remote-form-field-label" id="enqueue-devices-label">
                  Device(s)
                </span>
                <div className="remote-worker-accounts-dropdown" ref={enqueueDevicesDropdownRef}>
                  <button
                    type="button"
                    id="enqueue-devices-trigger"
                    className="remote-worker-accounts-dropdown__trigger"
                    aria-expanded={enqueueDevicesDropdownOpen}
                    aria-haspopup="listbox"
                    aria-labelledby="enqueue-devices-label enqueue-devices-trigger"
                    onClick={() => setEnqueueDevicesDropdownOpen((o) => !o)}
                  >
                    <span className="remote-worker-accounts-dropdown__trigger-text">
                      {enqueueSelectedDeviceRows.length === 0
                        ? 'Select devices…'
                        : enqueueSelectedDeviceRows.length <= 2
                          ? enqueueSelectedDeviceRows.map((d) => d.label).join(', ')
                          : `${enqueueSelectedDeviceRows.length} devices selected`}
                    </span>
                    <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
                      {enqueueDevicesDropdownOpen ? '▲' : '▼'}
                    </span>
                  </button>
                  {enqueueDevicesDropdownOpen && (
                    <div
                      className="remote-worker-accounts-dropdown__panel"
                      role="listbox"
                      aria-multiselectable="true"
                      aria-label="Devices for enqueue"
                    >
                      <div className="remote-worker-accounts-dropdown__bulk" role="presentation">
                        <button
                          type="button"
                          className="remote-worker-accounts-dropdown__bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEnqueueDeviceIds(devices.map((d) => d.device_id))
                          }}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="remote-worker-accounts-dropdown__bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEnqueueDeviceIds([])
                          }}
                        >
                          Unselect all
                        </button>
                      </div>
                      {devices.map((d) => {
                        const checked = enqueueDeviceIds.includes(d.device_id)
                        return (
                          <label key={d.device_id} className="remote-worker-accounts-dropdown__option">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setEnqueueDeviceIds((prev) => {
                                  const s = new Set(prev)
                                  if (e.target.checked) s.add(d.device_id)
                                  else s.delete(d.device_id)
                                  return devices.map((x) => x.device_id).filter((id) => s.has(id))
                                })
                              }
                            />
                            <span className="remote-worker-accounts-dropdown__option-text">
                              {d.label} <span className="muted">{!d.probably_online ? '(offline)' : ''}</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="form-row remote-form-field">
                <span className="remote-form-field-label" id="enqueue-accounts-label">
                  Account
                </span>
                {terminalsForEnqueue.length > 0 ? (
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
                              setEnqueueOrderAccountIds(enqueueAccountOptions.map((x) => x.key))
                            }}
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            className="remote-worker-accounts-dropdown__bulk-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEnqueueOrderAccountIds([])
                            }}
                          >
                            Unselect all
                          </button>
                        </div>
                        {enqueueAccountGroups.map((g) => (
                          <div key={g.deviceId}>
                            <div
                              className="muted"
                              style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.25rem 0.35rem' }}
                            >
                              {g.deviceLabel}
                            </div>
                            {g.options.map((opt) => {
                              const checked = enqueueOrderScopedSelectedIds.includes(opt.key)
                              return (
                                <label key={opt.key} className="remote-worker-accounts-dropdown__option">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) =>
                                      setEnqueueOrderAccountIds(
                                        toggleOrderedId(
                                          enqueueAccountOptions.map((x) => x.key),
                                          enqueueOrderAccountIds,
                                          opt.key,
                                          e.target.checked,
                                        ),
                                      )
                                    }
                                  />
                                  <span className="remote-worker-accounts-dropdown__option-text" title={opt.exePath}>
                                    {opt.accountLabel} <span className="muted">({opt.accountId})</span>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        ))}
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
                <label htmlFor="remote-sl-pips">SL (pips)</label>
                <input
                  id="remote-sl-pips"
                  type="number"
                  min={0}
                  step={0.1}
                  value={enqueueSlPips}
                  onChange={(e) => setEnqueueSlPips(e.target.value)}
                  placeholder="optional"
                  title="Stop loss distance in pips from entry (MT5 bridge converts using symbol point size)"
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="remote-tp-pips">TP (pips)</label>
                <input
                  id="remote-tp-pips"
                  type="number"
                  min={0}
                  step={0.1}
                  value={enqueueTpPips}
                  onChange={(e) => setEnqueueTpPips(e.target.value)}
                  placeholder="optional"
                  title="Take profit distance in pips from entry"
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
          <button type="button" className="remote-primary-action" onClick={enqueueOrder} disabled={enqueueBusy || enqueueDeviceIds.length === 0}>
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
                onChange={(e) => {
                  const on = e.target.checked
                  if (on && !workerStopsComplete) {
                    setMsg({
                      type: 'error',
                      text: 'Set both SL and TP (positive pips) before enabling the worker.',
                    })
                    return
                  }
                  setWorkerEnabled(on)
                }}
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
                <span className="remote-form-field-label" id="worker-devices-label">
                  Device(s)
                </span>
                <div className="remote-worker-accounts-dropdown" ref={workerDevicesDropdownRef}>
                  <button
                    type="button"
                    id="worker-devices-trigger"
                    className="remote-worker-accounts-dropdown__trigger"
                    aria-expanded={workerDevicesDropdownOpen}
                    aria-haspopup="listbox"
                    aria-labelledby="worker-devices-label worker-devices-trigger"
                    onClick={() => setWorkerDevicesDropdownOpen((o) => !o)}
                  >
                    <span className="remote-worker-accounts-dropdown__trigger-text">
                      {workerSelectedDeviceRows.length === 0
                        ? 'Select devices…'
                        : workerSelectedDeviceRows.length <= 2
                          ? workerSelectedDeviceRows.map((d) => d.label).join(', ')
                          : `${workerSelectedDeviceRows.length} devices selected`}
                    </span>
                    <span className="remote-worker-accounts-dropdown__chevron" aria-hidden="true">
                      {workerDevicesDropdownOpen ? '▲' : '▼'}
                    </span>
                  </button>
                  {workerDevicesDropdownOpen && (
                    <div
                      className="remote-worker-accounts-dropdown__panel"
                      role="listbox"
                      aria-multiselectable="true"
                      aria-label="Worker devices"
                    >
                      <div className="remote-worker-accounts-dropdown__bulk" role="presentation">
                        <button
                          type="button"
                          className="remote-worker-accounts-dropdown__bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setWorkerDeviceIds(devices.map((d) => d.device_id))
                          }}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="remote-worker-accounts-dropdown__bulk-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setWorkerDeviceIds([])
                          }}
                        >
                          Unselect all
                        </button>
                      </div>
                      {devices.map((d) => {
                        const checked = workerDeviceIds.includes(d.device_id)
                        return (
                          <label key={d.device_id} className="remote-worker-accounts-dropdown__option">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setWorkerDeviceIds((prev) =>
                                  toggleOrderedId(
                                    devices.map((x) => x.device_id),
                                    prev,
                                    d.device_id,
                                    e.target.checked,
                                  ),
                                )
                              }
                            />
                            <span className="remote-worker-accounts-dropdown__option-text">
                              {d.label} <span className="muted">{!d.probably_online ? '(offline)' : ''}</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="form-row remote-form-field">
                <span className="remote-form-field-label" id="worker-accounts-label">
                  Accounts
                </span>
                {workerAccountOptions.length > 0 ? (
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
                                [...workerAccountOptions.map((x) => x.key), ...workerAccountsExtraIds].join(','),
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
                              setWorkerAccounts(workerAccountsExtraIds.join(','))
                            }}
                          >
                            Unselect all
                          </button>
                        </div>
                        {workerAccountGroups.map((g) => (
                          <div key={g.deviceId}>
                            <div
                              className="muted"
                              style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.25rem 0.35rem' }}
                            >
                              {g.deviceLabel}
                            </div>
                            {g.options.map((opt) => {
                              const checked = workerScopedSelectedKeys.includes(opt.key)
                              return (
                                <label key={opt.key} className="remote-worker-accounts-dropdown__option">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) =>
                                      setWorkerAccounts((prev) =>
                                        [...toggleOrderedId(workerAccountOptions.map((x) => x.key), parseCommaIds(prev), opt.key, e.target.checked), ...workerAccountsExtraIds].join(','),
                                      )
                                    }
                                  />
                                  <span className="remote-worker-accounts-dropdown__option-text" title={opt.exePath}>
                                    {opt.accountLabel} <span className="muted">({opt.accountId})</span>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        ))}
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
              {workerAccountOptions.length > 0 && (
                <div className="form-row remote-form-field">
                  <label htmlFor="worker-accounts-extra">Other IDs</label>
                  <input
                    id="worker-accounts-extra"
                    value={workerAccountsExtraIds.join(', ')}
                    onChange={(ev) => {
                      const selected = parseCommaIds(workerAccounts).filter((id) => id.includes(ENQUEUE_KEY_SEP))
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

              <div className="remote-worker-symbol-ticks" role="region" aria-labelledby="worker-symbol-ticks-title">
                <h4 className="remote-form-group__title" id="worker-symbol-ticks-title">
                  Live bid / ask (worker symbols)
                </h4>
                <p className="remote-worker-symbol-ticks__meta muted">
                  From panel MT5 (<code>{PANEL_LOCAL_MT5_ACCOUNT}</code>) —{' '}
                  {workerTickWs.transport === 'http' ? 'HTTP poll (~750ms)' : 'WebSocket (~500ms)'}; same symbols as above.
                </p>
                <div className="remote-live-quotes-table-wrap">
                  <table className="remote-live-quotes-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Bid</th>
                        <th>Ask</th>
                        <th>Spread</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workerSymbolTickList.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="remote-live-quotes-muted">
                            Add symbols to the worker list above to see quotes.
                          </td>
                        </tr>
                      ) : (
                        workerSymbolTickList.map((sym) => {
                          const t = workerQuotesTicks[sym]
                          if (!t) {
                            return (
                              <tr key={sym}>
                                <td className="remote-live-quotes-symbol">{sym}</td>
                                <td colSpan={3} className="remote-live-quotes-muted">
                                  {workerQuotesErr || 'Waiting for tick…'}
                                </td>
                              </tr>
                            )
                          }
                          const { bid, ask } = t
                          const spread = ask - bid
                          const pips = estimateSpreadPips(sym, bid, ask)
                          const spreadOverLimit =
                            workerMaxSpreadLimitPips != null && pips > workerMaxSpreadLimitPips
                          return (
                            <tr key={sym}>
                              <td className="remote-live-quotes-symbol">{sym}</td>
                              <td className="remote-live-quotes-bid">{bid.toFixed(5)}</td>
                              <td className="remote-live-quotes-ask">{ask.toFixed(5)}</td>
                              <td
                                className={
                                  spreadOverLimit
                                    ? 'remote-live-quotes-spread remote-live-quotes-spread--over-limit'
                                    : 'remote-live-quotes-spread'
                                }
                                title={
                                  spreadOverLimit
                                    ? `Panel reference spread is above max (${workerMaxSpreadLimitPips} pips). Agent uses its own MT5 tick when opening.`
                                    : undefined
                                }
                              >
                                {spread.toFixed(5)} (
                                {pips >= 1 || pips === 0 ? `${pips.toFixed(1)} pips` : `${pips.toFixed(2)} pts`})
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
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
            <h3 className="remote-form-group__title">Max open · risk (pips)</h3>
            {workerEnabled && !workerStopsComplete && (
              <p className="remote-form-group__hint" style={{ color: 'var(--danger, #f87171)' }}>
                Both SL and TP are required while the worker is enabled.
              </p>
            )}
            <div className="remote-worker-cap-risk-row">
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
              <div className="form-row remote-form-field">
                <label htmlFor="worker-sl-pips">SL (pips)</label>
                <input
                  id="worker-sl-pips"
                  type="number"
                  min={0}
                  step={0.1}
                  value={workerSlPips}
                  onChange={(e) => setWorkerSlPips(e.target.value)}
                  placeholder="pips"
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="worker-tp-pips">TP (pips)</label>
                <input
                  id="worker-tp-pips"
                  type="number"
                  min={0}
                  step={0.1}
                  value={workerTpPips}
                  onChange={(e) => setWorkerTpPips(e.target.value)}
                  placeholder="pips"
                />
              </div>
              <div className="form-row remote-form-field">
                <label htmlFor="worker-max-spread-pips">Max spread (pips)</label>
                <input
                  id="worker-max-spread-pips"
                  type="number"
                  min={0}
                  step={0.1}
                  value={workerMaxSpreadPips}
                  onChange={(e) => setWorkerMaxSpreadPips(e.target.value)}
                  placeholder="no limit"
                  title="If set, the agent will not open when live spread (pips) on that PC exceeds this value."
                />
              </div>
            </div>
          </div>
        </div>

        <div className="remote-form-footer">
          <div className="remote-worker-footer-actions">
            <button
              type="button"
              className="remote-primary-action"
              onClick={saveWorkerConfig}
              disabled={workerBusy || workerClosingAll || workerDeviceIds.length === 0 || (workerEnabled && !workerStopsComplete)}
            >
              {workerBusy ? 'Saving…' : 'Save worker'}
            </button>
            <button
              type="button"
              className="btn-danger remote-worker-close-all-btn"
              onClick={() => void enqueueCloseWorkerPositions()}
              disabled={workerBusy || workerClosingAll || workerDeviceIds.length === 0 || parseCommaIds(workerAccounts).length === 0}
            >
              {workerClosingAll ? 'Queueing…' : 'Close all on selected'}
            </button>
          </div>
        </div>
      </div>

      <div className="card trading-card remote-agents-card remote-agents-card--last">
        <div className="trading-card-header remote-agents-card-header">
          <h2 className="remote-agents-card-title">Commands</h2>
          <div className="remote-agents-commands-header-actions">
            <span className="trading-badge subtle">{loadingCommands ? '…' : `${commands.length}`}</span>
            <button
              type="button"
              className="remote-agents-commands-clear-btn"
              onClick={() => openClearCommandsConfirm()}
              disabled={!adminKey.trim() || clearCommandsBusy}
              title={
                selectedDeviceId.trim()
                  ? 'Clear queued and finished commands for the selected device only (keeps in-flight).'
                  : 'Clear queued and finished commands for all devices (keeps in-flight). Select a device in the table above to limit scope.'
              }
            >
              {clearCommandsBusy ? 'Clearing…' : 'Clear commands'}
            </button>
          </div>
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
