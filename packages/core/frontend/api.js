// Backend endpoint resolution — one source of truth for every API call.
//
// VITE_API_BASE_URL lets you point the frontend at any backend without code
// changes (e.g. a remote host, a different port, a tunnel). Set it in
// frontend/.env (see frontend/.env.example).
//
//   ""                       → relative /api/... (default; uses the Vite dev
//                              proxy in dev, or the same origin in production)
//   "http://10.0.0.5:3001"   → absolute backend, useful when the SPA is served
//                              from a different host than the API
//
// Vite only exposes env vars prefixed with VITE_, via import.meta.env.

// Trim a trailing slash so apiUrl() never produces a double slash.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

// Build a full URL for an API path. Pass paths starting with "/api/...".
export const apiUrl = (path) => `${API_BASE}${path}`;
