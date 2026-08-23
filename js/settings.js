/* Device settings: the OAuth client id, which yard this phone belongs to,
 * and what to call the phone in the record's provenance line.
 *
 * Settings entered in the app win over config.js, so one hosted build can
 * serve several yards. */

const KEY = "slabwizard.settings";

/** Mirrors _SAFE_NAME_RE in core/inventory/ingest/capture.py — the PC
 *  rejects anything else, so catch it here where it can be corrected. */
export const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const FALLBACK = {
  clientId: "",
  tenant: "default",
  device: "",
  folderName: "SlabWizard Captures",
};

function fromConfigJs() {
  const cfg = (typeof window !== "undefined" && window.SLABWIZARD_CONFIG) || {};
  return {
    clientId: cfg.clientId || "",
    tenant: cfg.tenant || "",
    device: cfg.device || "",
    folderName: cfg.folderName || "",
  };
}

/** Effective settings: defaults <- config.js <- what the user saved. */
export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    stored = {};
  }
  const cfg = fromConfigJs();
  const pick = (k) => stored[k] || cfg[k] || FALLBACK[k];
  return {
    clientId: pick("clientId").trim(),
    tenant: pick("tenant").trim(),
    device: pick("device").trim(),
    folderName: pick("folderName").trim(),
  };
}

export function saveSettings(patch) {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    stored = {};
  }
  localStorage.setItem(KEY, JSON.stringify({ ...stored, ...patch }));
  return loadSettings();
}

/**
 * Apply settings carried on the URL, then clean it.
 *
 * QR onboarding: the PC's "Set Up a Phone" dialog encodes overrides in
 * the link (`?site=<tenant>`), so a scanned phone configures itself and
 * the operator types nothing. Saved into localStorage (which the
 * installed app shares with the browser tab the QR opened), so the
 * override survives Add to Home Screen.
 */
export function applyUrlOverrides(loc = window.location,
                                  hist = window.history) {
  let params;
  try {
    params = new URLSearchParams(loc.search || "");
  } catch {
    return;
  }
  const patch = {};
  const site = (params.get("site") || "").trim();
  if (site && SAFE_NAME_RE.test(site)) patch.tenant = site;
  const folder = (params.get("folder") || "").trim();
  if (folder) patch.folderName = folder;
  if (!Object.keys(patch).length) return;
  saveSettings(patch);
  try {
    hist.replaceState(null, "", loc.pathname);   // don't re-apply forever
  } catch { /* history unavailable — harmless, it re-applies same values */ }
}

/** A device name for the provenance line, invented once and kept. */
export function ensureDeviceName() {
  const s = loadSettings();
  if (s.device) return s.device;
  const guess = /iPhone|iPad/i.test(navigator.userAgent) ? "iphone"
              : /Android/i.test(navigator.userAgent) ? "android-phone"
              : "phone";
  const name = `${guess}-${Math.random().toString(36).slice(2, 6)}`;
  saveSettings({ device: name });
  return name;
}

/* ── Remembered values ─────────────────────────────────────────────────────
 * You photograph a whole rack of the same material from the same supplier;
 * retyping it forty times is how a field tool gets abandoned. */

const RECENT_KEY = "slabwizard.recent";
const RECENT_MAX = 12;

export function recentValues(field) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}");
    return Array.isArray(all[field]) ? all[field] : [];
  } catch {
    return [];
  }
}

export function rememberValue(field, value) {
  const text = (value || "").trim();
  if (!text) return;
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") || {};
  } catch {
    all = {};
  }
  const list = Array.isArray(all[field]) ? all[field] : [];
  const next = [text, ...list.filter((v) => v !== text)].slice(0, RECENT_MAX);
  all[field] = next;
  localStorage.setItem(RECENT_KEY, JSON.stringify(all));
}
