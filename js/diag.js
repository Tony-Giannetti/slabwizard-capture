/* On-device diagnostics.
 *
 * Remote debugging a phone in a stone yard means: when something sticks,
 * the phone itself must be able to say what happened. Every notable stage
 * and every uncaught error lands in a small ring buffer in localStorage,
 * readable (and copyable) from the Settings screen.
 */

const KEY = "slabwizard.diag";
const MAX = 40;

function readAll() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function diagLog(message) {
  try {
    const list = readAll();
    const stamp = new Date();
    const t = String(stamp.getMonth() + 1).padStart(2, "0") + "-"
            + String(stamp.getDate()).padStart(2, "0") + " "
            + String(stamp.getHours()).padStart(2, "0") + ":"
            + String(stamp.getMinutes()).padStart(2, "0") + ":"
            + String(stamp.getSeconds()).padStart(2, "0");
    list.push(t + "  " + String(message).slice(0, 300));
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch { /* diagnostics must never break the app */ }
}

export function diagList() {
  return readAll();
}

export function diagClear() {
  try { localStorage.removeItem(KEY); } catch { /* fine */ }
}

/** Hook uncaught errors and promise rejections app-wide. */
export function diagInstall() {
  window.addEventListener("error", (ev) => {
    diagLog("ERROR " + (ev.message || "?") + " @ "
            + (ev.filename || "?").split("/").pop() + ":" + (ev.lineno || 0));
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    diagLog("REJECTION " + (r && r.message ? r.message : String(r)).slice(0, 200));
  });
  diagLog("app start " + (document.getElementById("app-version")?.textContent
                          || "?"));
}
