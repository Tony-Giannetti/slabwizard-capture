/* Google Drive transport.
 *
 * The scope is `drive.file`, which is the narrowest one that works: this
 * app can only ever see and touch files it created itself. It cannot read
 * the rest of the user's Drive, and revoking it cannot lose them anything
 * else. That matters when the thing being installed is a phone app for
 * staff.
 *
 * On the PC there is deliberately no counterpart to this file. Google Drive
 * for Desktop already syncs the folder onto disk, so SlabWizard only ever
 * reads a local directory (core/inventory/ingest/sources.py) — no OAuth, no
 * tokens, no network code in the desktop app at all.
 *
 * Bundle layout written here, matching FolderCaptureSource:
 *
 *     <folderName>/pending/<capture_id>/photo.jpg     <- uploaded FIRST
 *     <folderName>/pending/<capture_id>/capture.json  <- uploaded LAST
 *
 * The order is the point. The PC ignores a bundle directory that has no
 * capture.json yet, so a half-synced upload is invisible rather than
 * half-imported. */

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const IDS_KEY = "slabwizard.driveIds";

export class DriveError extends Error {
  constructor(message, { needsConsent = false, status = 0 } = {}) {
    super(message);
    this.name = "DriveError";
    this.needsConsent = needsConsent;
    this.status = status;
  }
}

let tokenClient = null;
let tokenClientId = null;
let accessToken = null;
let tokenExpiry = 0;
let inFlight = null;

/* ── Auth ──────────────────────────────────────────────────────────────── */

function gisReady() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12000;
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
      if (Date.now() > deadline) {
        return reject(new DriveError(
          "Google sign-in did not load. Check the phone's connection."));
      }
      setTimeout(poll, 120);
    })();
  });
}

function clientFor(oauth2, clientId) {
  if (tokenClient && tokenClientId === clientId) return tokenClient;
  tokenClient = oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {},        // replaced per request
  });
  tokenClientId = clientId;
  return tokenClient;
}

export function hasValidToken() {
  return Boolean(accessToken) && Date.now() < tokenExpiry - 60_000;
}

export function forgetToken() {
  accessToken = null;
  tokenExpiry = 0;
}

/** One round trip to GIS. `prompt: ""` is the silent path. */
function requestToken(client, prompt) {
  return new Promise((resolve, reject) => {
    client.callback = (response) => {
      if (response.error) {
        return reject(new DriveError(
          `Google sign-in failed: ${response.error}`, { needsConsent: true }));
      }
      accessToken = response.access_token;
      tokenExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000;
      resolve(accessToken);
    };
    client.error_callback = (err) => {
      reject(new DriveError(
        err?.type === "popup_closed"
          ? "Google sign-in was dismissed."
          : "Google sign-in needs to be tapped through once.",
        { needsConsent: true }));
    };
    try {
      client.requestAccessToken({ prompt });
    } catch (err) {
      reject(new DriveError(`Google sign-in failed: ${err.message}`,
                            { needsConsent: true }));
    }
  });
}

/**
 * Get an access token.
 *
 * Always tries the **silent** path first, whatever `interactive` says: a
 * token lasts an hour, so re-consenting on every upload run would put a
 * Google account picker in front of someone who is holding a phone in one
 * hand at a slab rack. The consent screen is only escalated to when the
 * silent path fails AND we are inside a user gesture that is allowed to
 * open it.
 *
 * @param {string} clientId
 * @param {boolean} interactive  true only from a user gesture.
 */
export async function getToken(clientId, interactive = false) {
  if (!clientId) {
    throw new DriveError("No Google client ID is set. Open Settings first.",
                         { needsConsent: true });
  }
  if (hasValidToken()) return accessToken;
  if (inFlight) return inFlight;

  const oauth2 = await gisReady();
  const client = clientFor(oauth2, clientId);

  inFlight = (async () => {
    try {
      return await requestToken(client, "");
    } catch (err) {
      if (!interactive) throw err;
      return await requestToken(client, "consent");
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function disconnect() {
  const token = accessToken;
  forgetToken();
  localStorage.removeItem(IDS_KEY);
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token, () => {});
    } catch { /* best effort */ }
  }
}

/* ── Requests ──────────────────────────────────────────────────────────── */

async function apiFetch(clientId, url, options = {}, retryOn401 = true) {
  const token = await getToken(clientId);
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 && retryOn401) {
    forgetToken();
    return apiFetch(clientId, url, options, false);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch { /* non-JSON error body */ }
    throw new DriveError(
      `Drive refused the request (${res.status}${detail ? `: ${detail}` : ""})`,
      { status: res.status, needsConsent: res.status === 401 || res.status === 403 },
    );
  }
  return res.json();
}

/* ── Folders ───────────────────────────────────────────────────────────── */

function cachedIds(folderName) {
  try {
    const cache = JSON.parse(localStorage.getItem(IDS_KEY) || "{}");
    return cache.folderName === folderName ? cache : null;
  } catch {
    return null;
  }
}

function cacheIds(folderName, rootId, pendingId) {
  localStorage.setItem(IDS_KEY, JSON.stringify({ folderName, rootId, pendingId }));
}

async function findFolder(clientId, name, parentId) {
  const safe = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const clauses = [
    `name = '${safe}'`,
    `mimeType = '${FOLDER_MIME}'`,
    "trashed = false",
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const url = `${FILES_API}?q=${encodeURIComponent(clauses.join(" and "))}`
            + "&fields=files(id,name)&spaces=drive&pageSize=10";
  const body = await apiFetch(clientId, url);
  return body.files?.[0]?.id || null;
}

async function createFolder(clientId, name, parentId) {
  const metadata = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  const body = await apiFetch(clientId, `${FILES_API}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return body.id;
}

async function ensureFolder(clientId, name, parentId) {
  return (await findFolder(clientId, name, parentId))
      || (await createFolder(clientId, name, parentId));
}

/** Resolve (creating if needed) `<folderName>/pending`, with a cache. */
export async function ensurePendingFolder(clientId, folderName, { fresh = false } = {}) {
  if (!fresh) {
    const cached = cachedIds(folderName);
    if (cached?.pendingId) return cached.pendingId;
  }
  const rootId = await ensureFolder(clientId, folderName, null);
  const pendingId = await ensureFolder(clientId, "pending", rootId);
  cacheIds(folderName, rootId, pendingId);
  return pendingId;
}

/* ── Upload ────────────────────────────────────────────────────────────── */

function multipartBody(metadata, mime, payload) {
  const boundary = `sw${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const blob = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    payload,
    `\r\n--${boundary}--\r\n`,
  ]);
  return { blob, contentType: `multipart/related; boundary=${boundary}` };
}

async function uploadFile(clientId, name, parentId, mime, payload) {
  const { blob, contentType } = multipartBody(
    { name, parents: [parentId] }, mime, payload);
  return apiFetch(clientId, `${UPLOAD_API}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: blob,
  });
}

/**
 * Upload one capture bundle.
 *
 * Photo first, manifest last — see the note at the top of this file.
 *
 * @param {object} opts {clientId, folderName}
 * @param {object} record {capture_id, manifest, photo: Blob}
 */
export async function uploadBundle({ clientId, folderName }, record) {
  let pendingId = await ensurePendingFolder(clientId, folderName);

  let bundleId;
  try {
    bundleId = await createFolder(clientId, record.capture_id, pendingId);
  } catch (err) {
    // The cached folder was deleted or emptied from Drive's trash. Re-resolve
    // once from scratch before giving up.
    if (err instanceof DriveError && (err.status === 404 || err.status === 400)) {
      pendingId = await ensurePendingFolder(clientId, folderName, { fresh: true });
      bundleId = await createFolder(clientId, record.capture_id, pendingId);
    } else {
      throw err;
    }
  }

  await uploadFile(clientId, record.manifest.photo, bundleId,
                   record.photo.type || "image/jpeg", record.photo);
  if (record.rectified_photo && record.manifest.rectified) {
    // The flattened image is part of the bundle's contract — it must be
    // in place before capture.json declares it.
    await uploadFile(clientId, record.manifest.rectified.photo, bundleId,
                     "image/jpeg", record.rectified_photo);
  }
  await uploadFile(clientId, "capture.json", bundleId, "application/json",
                   new Blob([JSON.stringify(record.manifest, null, 2)],
                            { type: "application/json" }));
  return bundleId;
}
