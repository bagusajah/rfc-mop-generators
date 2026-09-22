// Per-browser Google OAuth token storage — the only state a stateless app
// keeps on the server.
//
// A long-lived session cookie identifies the browser; its Google tokens live
// in one small JSON file ({ [sid]: { refresh_token, access_token, expiry } }),
// written atomically (tmp + rename). TOKENS_PATH points the file at the Docker
// volume in compose; the dev fallback is ./gtokens.json next to server.js.
//
// The cookie name is parametrized via SESSION_COOKIE (or configureSession at
// boot) so each app (RFC, MOP, …) keeps its own session without collision.
// Defaults to "rfc_sid" for backward compat.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { refreshAccess } from "./google.js";

const TOKENS_PATH = process.env.TOKENS_PATH
  || (fs.existsSync("/data") ? "/data/gtokens.json" : "gtokens.json");

let _cookieName = process.env.SESSION_COOKIE || "rfc_sid";
export function configureSession({ cookieName }) {
  if (cookieName) _cookieName = cookieName;
}
export const cookieName = () => _cookieName;

// A session id cookie identifies the browser (set lazily on first use).
export function sessionId(req, reply) {
  const re = new RegExp(`(?:^|;\\s*)${_cookieName}=([^;]+)`);
  const m = (req.headers.cookie || "").match(re);
  if (m) return decodeURIComponent(m[1]);
  const sid = crypto.randomUUID();
  reply.header("set-cookie", `${_cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return sid;
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return {}; // missing or corrupt file → start fresh (tokens are re-obtainable)
  }
}

export function saveTok(sid, tok) {
  const all = readAll();
  all[sid] = tok;
  const tmp = `${TOKENS_PATH}.tmp`;
  fs.mkdirSync(path.dirname(path.resolve(TOKENS_PATH)), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, TOKENS_PATH);
}

export function loadTok(sid) {
  return readAll()[sid] || null;
}

// Valid access token for the session, refreshing via the stored refresh token
// when stale. Returns null when the browser never connected Google.
export async function googleAccessToken(sid) {
  const tok = loadTok(sid);
  if (!tok || !tok.refresh_token) return null;
  if (tok.access_token && tok.expiry && Date.now() < tok.expiry - 60000) return tok.access_token;
  const fresh = await refreshAccess(tok.refresh_token);
  saveTok(sid, { ...tok, access_token: fresh.access_token, expiry: Date.now() + (fresh.expires_in || 3600) * 1000 });
  return fresh.access_token;
}
