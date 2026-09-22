import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// VITE_DEV_PROXY_TARGET overrides where the dev server proxies /api (default the
// local backend). Use it when the backend runs on another host/port in dev.
// In production the frontend talks to VITE_API_BASE_URL directly (see api.js),
// so this proxy is dev-only.
//
// Deps are installed at the repo root (npm workspaces — see root package.json),
// so bare imports (react, lucide-react) inside packages/core/frontend resolve
// from <repo>/node_modules just like they do for this app's own files.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_DEV_PROXY_TARGET || "http://localhost:3001";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Proxy API calls to the backend during development so fetch("/api/...") works.
      proxy: { "/api": target },
    },
  };
});
