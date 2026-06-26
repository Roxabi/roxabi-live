/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for the Worker API. Empty/undefined = same-origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
