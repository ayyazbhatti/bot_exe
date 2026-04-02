/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PORT?: string
  /** Optional: public panel API base when the UI cannot infer it (e.g. static build + separate tunnel). */
  readonly VITE_PANEL_PUBLIC_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
