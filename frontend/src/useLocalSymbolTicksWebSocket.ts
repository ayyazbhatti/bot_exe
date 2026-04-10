import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiOrigin, panelWsUrl } from './apiClient'

const MAX_RECONNECT_MS = 30_000
const RECONNECT_BASE_MS = 1000

/**
 * Browser `fetch` to `VITE_API_ORIGIN` works through Cloudflare tunnels; `wss` upgrades to that same host often do not.
 * Use HTTP polling only when the app targets a separate API base (tunnel / direct port).
 */
const FORCE_HTTP_SYMBOL_TICKS = apiOrigin().trim().length > 0
/** If the socket never reaches `open` in this window (tunnel/proxy/auth), use HTTP polling like pre-WS behavior. */
const WS_OPEN_DEADLINE_MS = 5000
const HTTP_POLL_MS = 750

export type LocalSymbolTicksWsResult = {
  ticks: Record<string, { bid: number; ask: number }>
  error: string | null
  connected: boolean
  /** `http` when WebSocket could not open (common with some tunnels / auth); `ws` when streaming over `/ws/local-symbol-ticks`. */
  transport: 'ws' | 'http' | 'idle'
}

/**
 * Bid/ask from panel MT5: uses `/ws/local-symbol-ticks` when the page talks to the API on the same origin (Vite proxy).
 * With `VITE_API_ORIGIN` set (e.g. tunnel URL), uses `GET /api/local/symbol-ticks` only. Otherwise falls back to HTTP if WS fails.
 */
export function useLocalSymbolTicksWebSocket(
  accountId: string,
  symbols: string[],
): LocalSymbolTicksWsResult {
  const [ticks, setTicks] = useState<Record<string, { bid: number; ask: number }>>({})
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [useHttpFallback, setUseHttpFallback] = useState(FORCE_HTTP_SYMBOL_TICKS)
  const attemptRef = useRef(0)
  const wsRef = useRef<WebSocket | null>(null)
  const symbolsRef = useRef(symbols)
  symbolsRef.current = symbols

  const symKey = useMemo(() => symbols.join('\u0001'), [symbols])
  const hasSymbols = symbols.length > 0

  useEffect(() => {
    if (!hasSymbols) {
      setUseHttpFallback(FORCE_HTTP_SYMBOL_TICKS)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setTicks({})
      setError(null)
      setConnected(false)
      return
    }

    if (useHttpFallback) {
      return
    }

    let cancelled = false
    let startTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let openDeadline: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null
    let sawOpen = false

    const scheduleReconnect = () => {
      if (cancelled) return
      const attempt = attemptRef.current++
      const base = Math.min(MAX_RECONNECT_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5))
      const jitter = Math.floor(Math.random() * 400)
      reconnectTimer = window.setTimeout(connect, base + jitter)
    }

    const connect = () => {
      if (cancelled) return
      reconnectTimer = undefined
      sawOpen = false
      const aid = accountId.trim() || 'exness'
      const url = panelWsUrl(`/ws/local-symbol-ticks?${new URLSearchParams({ account_id: aid }).toString()}`)
      try {
        ws = new WebSocket(url)
      } catch {
        if (!cancelled) setUseHttpFallback(true)
        return
      }
      wsRef.current = ws

      openDeadline = window.setTimeout(() => {
        openDeadline = undefined
        if (cancelled || sawOpen) return
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
        setUseHttpFallback(true)
      }, WS_OPEN_DEADLINE_MS)

      ws.onopen = () => {
        if (cancelled) return
        sawOpen = true
        if (openDeadline !== undefined) {
          window.clearTimeout(openDeadline)
          openDeadline = undefined
        }
        attemptRef.current = 0
        setConnected(true)
        const syms = symbolsRef.current
        if (syms.length > 0 && ws!.readyState === WebSocket.OPEN) {
          ws!.send(JSON.stringify({ symbols: syms }))
        }
      }

      ws.onerror = () => {
        setConnected(false)
      }

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        if (openDeadline !== undefined) {
          window.clearTimeout(openDeadline)
          openDeadline = undefined
        }
        if (cancelled) return
        if (!sawOpen) {
          setUseHttpFallback(true)
          return
        }
        scheduleReconnect()
      }

      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data) as {
            ok?: boolean
            error?: string
            message?: string
            ticks?: Record<string, { bid?: number; ask?: number }>
            type?: string
          }
          if (d.type === 'local_symbol_ticks_subscribed') return
          if (d.ok === false) {
            setError(String(d.error || d.message || 'tick stream error'))
            return
          }
          if (!d.ticks || typeof d.ticks !== 'object') return
          setError(null)
          const syms = symbolsRef.current
          const norm: Record<string, { bid: number; ask: number }> = {}
          for (const s of syms) {
            const v = d.ticks[s]
            const bid = typeof v?.bid === 'number' ? v.bid : NaN
            const ask = typeof v?.ask === 'number' ? v.ask : NaN
            if (Number.isFinite(bid) && Number.isFinite(ask)) norm[s] = { bid, ask }
          }
          setTicks(norm)
        } catch {
          /* ignore malformed frame */
        }
      }
    }

    // Defer open to the next macrotask so React 18 Strict Mode's mount→unmount→remount
    // clears this timer instead of closing a WebSocket that is still connecting (noisy console).
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
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (openDeadline !== undefined) window.clearTimeout(openDeadline)
      if (ws) {
        ws.close()
        ws = null
      }
      wsRef.current = null
      setConnected(false)
    }
  }, [accountId, hasSymbols, useHttpFallback])

  useEffect(() => {
    if (!hasSymbols || !useHttpFallback) return

    let cancelled = false
    const aid = accountId.trim() || 'exness'

    const pull = async () => {
      const syms = symbolsRef.current
      if (syms.length === 0) return
      try {
        const qs = encodeURIComponent(syms.join(','))
        const r = await apiFetch(
          `/api/local/symbol-ticks?account_id=${encodeURIComponent(aid)}&symbols=${qs}`,
        )
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          message?: string
          ticks?: Record<string, { bid?: number; ask?: number }>
        }
        if (cancelled) return
        if (!r.ok || !d.ok) {
          setConnected(false)
          setError(d.error || d.message || `HTTP ${r.status}`)
          return
        }
        setError(null)
        setConnected(true)
        const raw = d.ticks && typeof d.ticks === 'object' ? d.ticks : {}
        const norm: Record<string, { bid: number; ask: number }> = {}
        for (const s of syms) {
          const v = raw[s]
          const bid = typeof v?.bid === 'number' ? v.bid : NaN
          const ask = typeof v?.ask === 'number' ? v.ask : NaN
          if (Number.isFinite(bid) && Number.isFinite(ask)) norm[s] = { bid, ask }
        }
        setTicks(norm)
      } catch {
        if (!cancelled) {
          setConnected(false)
          setError('Request failed')
        }
      }
    }

    void pull()
    const id = window.setInterval(pull, HTTP_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
      setConnected(false)
    }
  }, [accountId, hasSymbols, useHttpFallback, symKey])

  useEffect(() => {
    if (!hasSymbols || useHttpFallback) return
    const w = wsRef.current
    if (w && w.readyState === WebSocket.OPEN) {
      w.send(JSON.stringify({ symbols }))
    }
  }, [symKey, hasSymbols, useHttpFallback, symbols])

  const transport: 'ws' | 'http' | 'idle' = !hasSymbols ? 'idle' : useHttpFallback ? 'http' : 'ws'

  return { ticks, error, connected, transport }
}
