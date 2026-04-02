import { useState, useEffect, useRef } from 'react'
import { panelWsUrl } from './apiClient'

export type RemotePositionRow = {
  ticket: number
  symbol: string
  type: string
  volume: number
  price_open: number
  sl: number
  tp: number
  profit: number
  comment: string
}

/** One account row after merge (includes device for filtering). */
export type RemoteLiveAccountRow = {
  device_id: string
  device_label: string
  account_id: string
  label: string
  positions: RemotePositionRow[]
  /** Set when the agent’s MT5 bridge failed for this terminal path (shown on Live page). */
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
    positions?: RemotePositionRow[]
    bridge_error?: string
  }>
}

const MAX_RECONNECT_MS = 30_000
const WS_UI_THROTTLE_MS = 150

function normalizeRow(raw: NonNullable<WsPayload['results']>[number]): RemoteLiveAccountRow | null {
  const device_id = String((raw as { device_id?: unknown }).device_id ?? '').trim()
  const account_id = String((raw as { account_id?: unknown }).account_id ?? '').trim()
  if (!device_id || !account_id) return null
  const positions = Array.isArray(raw.positions) ? raw.positions : []
  const bridge_error =
    typeof raw.bridge_error === 'string' && raw.bridge_error.trim() !== '' ? raw.bridge_error.trim() : undefined
  return {
    device_id,
    device_label: String(raw.device_label ?? device_id).trim() || device_id,
    account_id,
    label: String(raw.label ?? account_id).trim() || account_id,
    positions,
    ...(bridge_error ? { bridge_error } : {}),
  }
}

/** Parse GET `/api/agent/remote-positions` or WebSocket JSON into account rows (same shape as `/ws/remote-positions`). */
export function parseRemotePositionsResponse(json: unknown): RemoteLiveAccountRow[] {
  if (!json || typeof json !== 'object') return []
  const data = json as WsPayload
  if (data.ok === false || !Array.isArray(data.results)) return []
  return data.results.map(normalizeRow).filter((x): x is RemoteLiveAccountRow => x != null)
}

/**
 * Merged live positions from paired desktop agents (`positions_snapshot` → `/ws/remote-positions`).
 * Reconnects with backoff; pair with HTTP poll + merge in the Live page for resilience.
 */
export function useRemotePositionsWebSocket(): {
  rows: RemoteLiveAccountRow[]
  lastUpdate: Date | null
  connected: boolean
} {
  const [rows, setRows] = useState<RemoteLiveAccountRow[]>([])
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [connected, setConnected] = useState(false)
  const attemptRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let throttleTimer: ReturnType<typeof setTimeout> | undefined
    let lastUiFlush = 0
    let pendingRemote: RemoteLiveAccountRow[] | null = null

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
        ws = new WebSocket(panelWsUrl('/ws/remote-positions'))
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
            if (import.meta.env.DEV) console.warn('[remote-positions] error frame', payload)
            return
          }
          if (!Array.isArray(payload.results)) {
            if (import.meta.env.DEV) console.warn('[remote-positions] unexpected frame', payload)
            return
          }
          pendingRemote = parseRemotePositionsResponse(data)
          const delta = Date.now() - lastUiFlush
          if (delta >= WS_UI_THROTTLE_MS && throttleTimer === undefined) {
            flushRemoteRows()
          } else if (throttleTimer === undefined) {
            throttleTimer = window.setTimeout(flushRemoteRows, Math.max(0, WS_UI_THROTTLE_MS - delta))
          }
        } catch (e) {
          if (import.meta.env.DEV) console.warn('[remote-positions] parse error', e)
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
