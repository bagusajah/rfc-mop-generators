// Google OAuth (per-user) + Drive "upload & convert to Google Doc".
// Dependency-free: raw OAuth 2.0 authorization-code flow and a multipart Drive
// upload. Each engineer authorises once; generated Docs land in their own Drive.
//
//   GOOGLE_CLIENT_ID       OAuth 2.0 client ID
//   GOOGLE_CLIENT_SECRET   OAuth 2.0 client secret
//   GOOGLE_REDIRECT_URI    must match the client's Authorized redirect URI
//                          (dev default: http://localhost:5173/api/google/callback)
//   GOOGLE_POST_AUTH       where the popup lands after consent (default: closes itself)
//
// Scope: drive.file — the app can only see/manage files it creates. Minimal.
import crypto from "node:crypto";

const CID      = process.env.GOOGLE_CLIENT_ID || "";
const CSECRET  = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT = process.env.GOOGLE_REDIRECT_URI || "http://localhost:5173/api/google/callback";
const SCOPE    = "https://www.googleapis.com/auth/drive.file";

export const googleConfigured = () => Boolean(CID && CSECRET);

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",   // get a refresh token
    prompt: "consent",        // ensure a refresh token is returned
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!r.ok) throw new Error(`Google token ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export function exchangeCode(code) {
  return tokenRequest({
    code, client_id: CID, client_secret: CSECRET,
    redirect_uri: REDIRECT, grant_type: "authorization_code",
  });
}

export function refreshAccess(refresh_token) {
  return tokenRequest({
    refresh_token, client_id: CID, client_secret: CSECRET,
    grant_type: "refresh_token",
  });
}

// Upload a .docx buffer to Drive, converting it to a native Google Doc.
// Returns { id, webViewLink, name }.
export async function uploadAsGoogleDoc(accessToken, name, docxBuffer) {
  const boundary = "rfc_" + crypto.randomBytes(12).toString("hex");
  const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.document" });
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n",
  );
  const post = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([pre, docxBuffer, post]);

  const url = "https://www.googleapis.com/upload/drive/v3/files"
            + "?uploadType=multipart&fields=id,webViewLink,name";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
