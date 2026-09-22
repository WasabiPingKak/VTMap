/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_CHANNEL_ID: string;
  readonly VITE_API_BASE: string;
  readonly VITE_GA_MEASUREMENT_ID: string;
  readonly VITE_ENABLE_SETTINGS: string;
  readonly VITE_ENABLE_NETWORK: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_TIMESTAMP__: string;

interface Window {
  queryClient?: import("@tanstack/react-query").QueryClient;
}
