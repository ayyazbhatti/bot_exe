import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import { panelWsUrl } from './apiClient'

export type PositionRow = {
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

export type LiveAccountPositions = {
  account_id: string
  label: string
  positions: PositionRow[]
  /** Set when mt5_bridge returns `ok: false` for this account's terminal. */
  bridge_error?: string
}

/** Payload from `/ws/positions` (JSON text frames). */
export type PositionsWsPayload = {
  ok?: boolean
  results?: LiveAccountPositions[]
  prices?: Record<string, { bid: number; ask: number }>
}

const MAX_RECONNECT_MS = 30_000
/** Cap React updates from rapid WS frames (agent/panel may emit many per second). */
const WS_UI_THROTTLE_MS = 150

/**
 * Live positions + ticks from the panel WebSocket only (no HTTP polling).
 * Reconnects with exponential backoff after disconnect/errors.
 */
export function usePositionsWebSocket(
  onBroadcastRef: MutableRefObject<((data: PositionsWsPayload) => void) | null>,
): {
  liveResults: LiveAccountPositions[]
  liveLastUpdate: Date | null
  liveConnected: boolean
} {
  const [liveResults, setLiveResults] = useState<LiveAccountPositions[]>([])
  const [liveLastUpdate, setLiveLastUpdate] = useState<Date | null>(null)
  const [liveConnected, setLiveConnected] = useState(false)
  const attemptRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let throttleTimer: ReturnType<typeof setTimeout> | undefined
    let lastUiFlush = 0
    let pendingLive: LiveAccountPositions[] | null = null

    const flushLiveResults = () => {
      throttleTimer = undefined
      if (pendingLive !== null) {
        setLiveResults(pendingLive)
        setLiveLastUpdate(new Date())
        pendingLive = null
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
        ws = new WebSocket(panelWsUrl('/ws/positions'))
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        if (cancelled) return
        attemptRef.current = 0
        setLiveConnected(true)
      }

      ws.onerror = () => {
        setLiveConnected(false)
      }

      ws.onclose = () => {
        setLiveConnected(false)
        if (!cancelled) scheduleReconnect()
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as PositionsWsPayload
          if (data.ok !== false && Array.isArray(data.results)) {
            pendingLive = data.results.map((x) => {
              const msg =
                typeof (x as { bridge_error?: unknown }).bridge_error === 'string'
                  ? (x as { bridge_error: string }).bridge_error.trim()
                  : ''
              return {
                account_id: String((x as { account_id?: unknown }).account_id ?? ''),
                label: String((x as { label?: unknown }).label ?? (x as { account_id?: unknown }).account_id ?? ''),
                positions: Array.isArray(x.positions) ? (x.positions as PositionRow[]) : [],
                ...(msg ? { bridge_error: msg } : {}),
              }
            })
            const delta = Date.now() - lastUiFlush
            if (delta >= WS_UI_THROTTLE_MS && throttleTimer === undefined) {
              flushLiveResults()
            } else if (throttleTimer === undefined) {
              throttleTimer = window.setTimeout(flushLiveResults, Math.max(0, WS_UI_THROTTLE_MS - delta))
            }
          }
          onBroadcastRef.current?.(data)
        } catch {
          /* ignore malformed frame */
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      if (throttleTimer !== undefined) clearTimeout(throttleTimer)
      if (ws && ws.readyState === WebSocket.OPEN) ws.close()
      setLiveConnected(false)
    }
  }, [onBroadcastRef])

  return { liveResults, liveLastUpdate, liveConnected }
}
