/* The capture bundle — the contract with the PC.
 *
 * This file is the wire-format twin of core/inventory/ingest/capture.py.
 * If you change a field here, change it there (and bump SCHEMA in both).
 *
 * Note what is NOT here: an SL- inventory id. The PC allocates those, so
 * that two phones photographing the same rack cannot mint the same one.
 * All this app mints is capture_id, whose only job is to let the PC
 * recognise a bundle it has already imported. */

export const SCHEMA = 1;
export const PHOTO_NAME = "photo.jpg";
export const MANIFEST_NAME = "capture.json";

/**
 * A time-ordered, filename-safe id.
 *
 * Time-ordered because the PC ingests bundles in name order, so capture
 * order becomes SL- id order — the sequence a stonemason expects when they
 * walk down a rack. The random tail keeps two phones in the same
 * millisecond apart.
 */
export function newCaptureId() {
  const stamp = Date.now().toString(36);
  const rand = (crypto?.randomUUID?.() || `${Math.random()}`)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 10);
  return `c${stamp}-${rand}`;
}

/** Fields the operator keeps between slabs when working down a rack. */
export const STICKY_FIELDS = ["material", "thickness_mm", "supplier",
                              "lot_number", "location"];

/**
 * ISO-8601 in **local** time with the UTC offset, e.g.
 * `2026-08-19T09:48:45+10:00`.
 *
 * Deliberately not `toISOString()`. The PC takes the date part of this
 * string as the slab's received_date, and in UTC+10 anything photographed
 * before 10am is still "yesterday" in UTC — every morning's stock would be
 * booked in a day early.
 */
export function localTimestamp(now = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offset = -now.getTimezoneOffset();       // minutes east of UTC
  const sign = offset >= 0 ? "+" : "-";
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
       + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
       + `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * Build the capture.json payload.
 * @param {object} form   validated form values
 * @param {object} meta   {capture_id, tenant, device, corners}
 *
 * `corners` (optional): the 4 slab corners marked on the prepared photo,
 * TL TR BR BL in image px. When present, the PC rectifies at import and
 * the slab arrives with measured dimensions; the typed width/height are
 * the real-world size of that corner rectangle.
 */
export function buildManifest(form, meta) {
  return {
    ...(meta.corners ? { corners: meta.corners } : {}),
    schema: SCHEMA,
    capture_id: meta.capture_id,
    tenant: meta.tenant || "default",
    device: meta.device || "",
    captured_at: localTimestamp(),
    name: form.name || "",
    material: form.material,
    thickness_mm: form.thickness_mm,
    width_mm: form.width_mm,
    height_mm: form.height_mm,
    supplier: form.supplier || "",
    lot_number: form.lot_number || "",
    location: form.location || "",
    cost: form.cost || 0,
    notes: form.notes || "",
    kind: form.kind || "slab",
    photo: PHOTO_NAME,
  };
}

/**
 * Validate the form the way the PC will.
 * @returns {{ok: true, value: object} | {ok: false, field: string, message: string}}
 */
export function validateForm(raw) {
  const material = (raw.material || "").trim();
  if (!material) {
    return { ok: false, field: "material", message: "Material is required." };
  }

  const dims = { thickness_mm: "Thickness", width_mm: "Width", height_mm: "Height" };
  const value = { material, name: (raw.name || "").trim() };
  for (const [key, label] of Object.entries(dims)) {
    const n = Number.parseFloat(raw[key]);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, field: key, message: `${label} must be a number greater than zero.` };
    }
    value[key] = n;
  }

  const cost = raw.cost === "" || raw.cost == null ? 0 : Number.parseFloat(raw.cost);
  if (!Number.isFinite(cost) || cost < 0) {
    return { ok: false, field: "cost", message: "Cost cannot be negative." };
  }
  value.cost = cost;

  value.supplier = (raw.supplier || "").trim();
  value.lot_number = (raw.lot_number || "").trim();
  value.location = (raw.location || "").trim();
  value.notes = (raw.notes || "").trim();
  value.kind = raw.kind === "remnant" ? "remnant" : "slab";

  return { ok: true, value };
}

/** One-line description for the queue list. */
export function describe(manifest) {
  const name = manifest.name || manifest.material;
  const dims = `${Math.round(manifest.width_mm)} × ${Math.round(manifest.height_mm)}`
             + ` × ${manifest.thickness_mm}mm`;
  return { title: name, sub: dims };
}
