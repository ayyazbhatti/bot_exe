import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Must match the Rust panel `PORT` (default 3001) so `/api` and `/ws` proxy to the real server.
  const apiPort = env.API_PORT || env.VITE_API_PORT || '3001'
  const panelKey = (env.PANEL_API_KEY || env.VITE_PANEL_API_KEY || '').trim()
  const proxyHeaders = panelKey ? { 'X-Panel-Api-Key': panelKey } : undefined
  const backendProxy = {
    target: `http://localhost:${apiPort}`,
    changeOrigin: true,
    ...(proxyHeaders ? { headers: proxyHeaders } : {}),
  }
  const proxy = {
    '/api': backendProxy,
    '/ws': { ...backendProxy, ws: true },
  }
  const tunnelHosts = ['.trycloudflare.com', 'localhost', '127.0.0.1']
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Bind IPv4 + IPv6 so http://127.0.0.1:5173 works on Windows (not only [::1]).
      host: true,
      // Cloudflare quick tunnel (and similar) send Host: *.trycloudflare.com — Vite blocks unknown hosts by default.
      allowedHosts: tunnelHosts,
      proxy,
    },
    // Same proxy as dev: `vite preview` + a UI tunnel otherwise returns 404 for `/api/*`.
    preview: {
      port: 4173,
      host: true,
      allowedHosts: tunnelHosts,
      proxy,
    },
  }
})
