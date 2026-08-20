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

export const RECTIFIED_NAME = "rectified.jpg";

/**
 * Build the capture.json payload.
 * @param {object} form   validated form values
 * @param {object} meta   {capture_id, tenant, device, rectify}
 *
 * `rectify` (optional) is the rectify flow's result. It contributes:
 *  - `corners`: the 4 marks in prepared-photo px, TL TR BR BL — always
 *    shipped, so the PC can redo the flatten from the original;
 *  - `measurements`: rect/quad tape sizes + margin, for the PC fallback;
 *  - `rectified`: present when the phone warped locally — the flattened
 *    image travels as rectified.jpg and the PC trusts it as-is.
 */
export function buildManifest(form, meta) {
  const r = meta.rectify;
  const extras = {};
  if (r) {
    extras.corners = r.corners;
    extras.measurements = r.mode === "quad"
      ? { mode: "quad", top_mm: r.dims.top, right_mm: r.dims.right,
          bottom_mm: r.dims.bottom, left_mm: r.dims.left,
          diagonal_mm: r.dims.diagonal, margin_mm: r.marginMm }
      : { mode: "rect", margin_mm: r.marginMm };
    if (r.output) {
      extras.rectified = {
        photo: RECTIFIED_NAME,
        px_per_mm: r.output.pxPerMm,
        width_mm: r.output.widthMm,
        height_mm: r.output.heightMm,
        // The traced/detected natural edge, mm, relative to the shipped
        // flattened image. Lands on the record as outline_mm.
        ...(r.output.outlineMm ? { outline_mm: r.output.outlineMm } : {}),
      };
    }
  }
  if (globalThis.__lastDetect) {
    extras.debug_detect = globalThis.__lastDetect;
    // Carry the device's own diagnostic log with the run — one saved
    // capture then contains everything needed to replay and explain it.
    try {
      const log = JSON.parse(localStorage.getItem("slabwizard.diag") || "[]");
      extras.debug_detect.log = log.slice(-14);
    } catch { /* diagnostics only */ }
  }
  return {
    ...extras,
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
