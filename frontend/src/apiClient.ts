/**
 * Optional shared secret when `PANEL_API_KEY` is set on the API.
 * - Dev: prefer `PANEL_API_KEY` in `.env` so Vite proxy adds `X-Panel-Api-Key` (not bundled).
 * - Prod static hosting: set `VITE_PANEL_API_KEY` at build time (exposed in JS) or terminate TLS at a proxy that injects the header.
 */
const PANEL_KEY = import.meta.env.VITE_PANEL_API_KEY as string | undefined

/**
 * Optional panel API origin in dev when Vite’s proxy is wrong or you want to skip it.
 * Example: `VITE_API_ORIGIN=http://127.0.0.1:3001` (must match the Rust server `PORT`, default 3001).
 * Use scheme://host only — not `.../api`. Requests already use paths like `/api/...`; a trailing `/api`
 * here would become `.../api/api/...` (404 on the panel).
 */
function normalizePanelApiOrigin(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '')
  if (!s) return ''
  if (s.endsWith('/api')) {
    s = s.slice(0, -4).replace(/\/+$/, '')
  }
  return s
}

export function apiOrigin(): string {
  const o = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim()
  if (!o) return ''
  return normalizePanelApiOrigin(o)
}

/** Resolve `/api/...` to full URL when `VITE_API_ORIGIN` is set; otherwise keep a path for the Vite proxy. */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const b = apiOrigin()
  return b ? `${b}${p}` : p
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (PANEL_KEY?.trim() && !headers.has('X-Panel-Api-Key')) {
    headers.set('X-Panel-Api-Key', PANEL_KEY.trim())
  }
  let resolved: RequestInfo | URL = input
  if (typeof input === 'string') {
    const b = apiOrigin()
    if (b && input.startsWith('/api')) {
      resolved = `${b}${input}`
    }
  }
  return fetch(resolved, { ...init, headers, credentials: 'include' })
}

/** WebSocket URLs cannot send custom headers in the browser; append `panel_key` when using `VITE_PANEL_API_KEY`. */
export function appendPanelKeyToWsUrl(url: string): string {
  const k = PANEL_KEY?.trim()
  if (!k) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}panel_key=${encodeURIComponent(k)}`
}

/** WebSocket URL for paths like `/ws/remote-positions`; uses `VITE_API_ORIGIN` when set (same rules as `apiUrl`). */
export function panelWsUrl(wsPath: string): string {
  const p = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
  const b = apiOrigin()
  let url: string
  if (b) {
    try {
      const u = new URL(b)
      const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
      url = `${wsProto}//${u.host}${p}`
    } catch {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      url = `${proto}//${window.location.host}${p}`
    }
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url = `${proto}//${window.location.host}${p}`
  }
  return appendPanelKeyToWsUrl(url)
}
