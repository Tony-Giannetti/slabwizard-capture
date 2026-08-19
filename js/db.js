/* The local capture queue.
 *
 * A slab yard is a bad place for signal. Every capture is written to
 * IndexedDB — photo blob included — *before* anything is attempted over the
 * network, so closing the app, losing reception or running out of battery
 * costs nothing. Upload is a separate, retryable step over this queue. */

const DB_NAME = "slabwizard-capture";
const DB_VERSION = 1;
const STORE = "captures";

export const STATUS = {
  QUEUED: "queued",
  UPLOADING: "uploading",
  UPLOADED: "uploaded",
  ERROR: "error",
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "capture_id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("created_at", "created_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try {
      out = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function putCapture(record) {
  return tx("readwrite", (store) => store.put(record));
}

export function getCapture(id) {
  return tx("readonly", (store) => store.get(id));
}

export function deleteCapture(id) {
  return tx("readwrite", (store) => store.delete(id));
}

/** Everything, newest first. */
export async function allCaptures() {
  const rows = await tx("readonly", (store) => store.getAll());
  const list = Array.isArray(rows) ? rows : [];
  return list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

/** Oldest first — upload order should match capture order so the PC's
 *  SL- ids come out in the sequence the slabs were shot. */
export async function pendingCaptures() {
  const all = await allCaptures();
  return all
    .filter((c) => c.status === STATUS.QUEUED || c.status === STATUS.ERROR)
    .reverse();
}

export async function countByStatus() {
  const all = await allCaptures();
  return all.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, {});
}

export async function patchCapture(id, patch) {
  const existing = await getCapture(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await putCapture(next);
  return next;
}

export async function clearUploaded() {
  const all = await allCaptures();
  const done = all.filter((c) => c.status === STATUS.UPLOADED);
  await Promise.all(done.map((c) => deleteCapture(c.capture_id)));
  return done.length;
}
