import { useState, useEffect, useRef } from 'react'
import { panelWsUrl } from './apiClient'

export type RemoteDealRow = {
  ticket: number
  time: number
  symbol: string
  type: string
  volume: number
  price: number
  profit: number
  swap?: number
  commission?: number
  entry?: number | null
  position_id?: number
  comment?: string
}

export type RemoteHistoryAccountRow = {
  device_id: string
  device_label: string
  account_id: string
  label: string
  deals: RemoteDealRow[]
  bridge_error?: string
}

type WsPayload = {
  ok?: boolean
  source?: string
  results?: Array<{
    device_id?: string
    device_label?: string
    account_id?: string
    label?: string
    deals?: RemoteDealRow[]
    bridge_error?: string
  }>
}

const MAX_RECONNECT_MS = 30_000
const WS_UI_THROTTLE_MS = 150

function finiteNum(x: unknown, fallback = 0): number {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : fallback
}

function normalizeDeal(raw: unknown): RemoteDealRow | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const ticket = finiteNum(d.ticket, NaN)
  if (!Number.isFinite(ticket)) return null
  const time = Math.floor(finiteNum(d.time, 0))
  let entry: number | null | undefined
  if (d.entry === null || d.entry === undefined) entry = undefined
  else {
    const e = finiteNum(d.entry, NaN)
    entry = Number.isFinite(e) ? Math.trunc(e) : undefined
  }
  return {
    ticket,
    time,
    symbol: String(d.symbol ?? ''),
    type: String(d.type ?? ''),
    volume: finiteNum(d.volume, 0),
    price: finiteNum(d.price, 0),
    profit: finiteNum(d.profit, 0),
    swap: d.swap !== undefined ? finiteNum(d.swap, 0) : undefined,
    commission: d.commission !== undefined ? finiteNum(d.commission, 0) : undefined,
    entry,
    position_id: d.position_id !== undefined ? finiteNum(d.position_id, 0) : undefined,
    comment: typeof d.comment === 'string' ? d.comment : '',
  }
}

function normalizeRow(raw: NonNullable<WsPayload['results']>[number]): RemoteHistoryAccountRow | null {
  const device_id = String((raw as { device_id?: unknown }).device_id ?? '').trim()
  const account_id = String((raw as { account_id?: unknown }).account_id ?? '').trim()
  if (!device_id || !account_id) return null
  const dealsIn = Array.isArray(raw.deals) ? raw.deals : []
  const deals: RemoteDealRow[] = []
  for (const x of dealsIn) {
    const nd = normalizeDeal(x)
    if (nd) deals.push(nd)
  }
  const bridge_error =
    typeof raw.bridge_error === 'string' && raw.bridge_error.trim() !== '' ? raw.bridge_error.trim() : undefined
  return {
    device_id,
    device_label: String(raw.device_label ?? device_id).trim() || device_id,
    account_id,
    label: String(raw.label ?? account_id).trim() || account_id,
    deals,
    ...(bridge_error ? { bridge_error } : {}),
  }
}

/** Parse GET `/api/agent/remote-history` or WebSocket JSON. */
export function parseRemoteHistoryResponse(json: unknown): RemoteHistoryAccountRow[] {
  if (!json || typeof json !== 'object') return []
  const data = json as WsPayload
  if (data.ok === false || !Array.isArray(data.results)) return []
  return data.results.map(normalizeRow).filter((x): x is RemoteHistoryAccountRow => x != null)
}

/**
 * Merged deal history from paired desktop agents (`history_deals_snapshot` → `/ws/remote-history`).
 */
export function useRemoteHistoryWebSocket(): {
  rows: RemoteHistoryAccountRow[]
  lastUpdate: Date | null
  connected: boolean
} {
  const [rows, setRows] = useState<RemoteHistoryAccountRow[]>([])
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [connected, setConnected] = useState(false)
  const attemptRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let throttleTimer: ReturnType<typeof setTimeout> | undefined
    let lastUiFlush = 0
    let pendingRemote: RemoteHistoryAccountRow[] | null = null

    const flushRemoteRows = () => {
      throttleTimer = undefined
      if (pendingRemote !== null) {
        setRows(pendingRemote)
        setLastUpdate(new Date())
        pendingRemote = null
      }
      lastUiFlush = Date.now()
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      const attempt = attemptRef.current++
      const base = Math.min(MAX_RECONNECT_MS, 1000 * 2 ** Math.min(attempt, 5))
      const jitter = Math.floor(Math.random() * 400)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, base + jitter)
    }

    const connect = () => {
      if (cancelled) return
      try {
        ws = new WebSocket(panelWsUrl('/ws/remote-history'))
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        if (cancelled) return
        attemptRef.current = 0
        setConnected(true)
      }

      ws.onerror = () => {
        setConnected(false)
      }

      ws.onclose = () => {
        setConnected(false)
        if (!cancelled) scheduleReconnect()
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as unknown
          if (!data || typeof data !== 'object') return
          const payload = data as WsPayload
          if (payload.ok === false) {
            if (import.meta.env.DEV) console.warn('[remote-history] error frame', payload)
            return
          }
          if (!Array.isArray(payload.results)) {
            if (import.meta.env.DEV) console.warn('[remote-history] unexpected frame', payload)
            return
          }
          pendingRemote = parseRemoteHistoryResponse(data)
          const delta = Date.now() - lastUiFlush
          if (delta >= WS_UI_THROTTLE_MS && throttleTimer === undefined) {
            flushRemoteRows()
          } else if (throttleTimer === undefined) {
            throttleTimer = window.setTimeout(flushRemoteRows, Math.max(0, WS_UI_THROTTLE_MS - delta))
          }
        } catch (e) {
          if (import.meta.env.DEV) console.warn('[remote-history] parse error', e)
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      if (throttleTimer !== undefined) clearTimeout(throttleTimer)
      if (ws && ws.readyState === WebSocket.OPEN) ws.close()
      setConnected(false)
    }
  }, [])

  return { rows, lastUpdate, connected }
}
