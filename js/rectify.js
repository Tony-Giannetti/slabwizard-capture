/* The rectify flow — the phone-sized version of SlabWizard's dialog.
 *
 *   corners  ->  measurements  ->  preview + crop  ->  done
 *
 * Corners: the existing tap-with-loupe marker. Measurements: rectangle
 * (width x height) or the true quad (4 taped sides + the TL–BR diagonal),
 * plus an optional margin of context. Preview: the actual flattened
 * image, warped on the GPU — what you see here is byte-for-byte what
 * lands in the inventory — with a draggable crop.
 *
 * Returns {corners, mode, dims, marginMm, output:{blob, pxPerMm,
 * widthMm, heightMm}} or null on cancel. `output` is null when WebGL is
 * unavailable — the capture then ships corners + measurements and the PC
 * rectifies instead.
 */

import { openCornerMarker } from "./corners.js";
import { rectCorners, quadCorners } from "./homography.js";
import { warpToCanvas, cropToBlob } from "./warp.js";

const $ = (id) => document.getElementById(id);

/* ── Measurements sheet ─────────────────────────────────────────────── */

function readDims(mode) {
  const value = (id) => Number.parseFloat($(id).value);
  if (mode === "quad") {
    return {
      top: value("m-top"), right: value("m-right"),
      bottom: value("m-bottom"), left: value("m-left"),
      diagonal: value("m-diagonal"),
    };
  }
  return { width: value("m-width"), height: value("m-height") };
}

function showMeasureSheet(defaults) {
  return new Promise((resolve) => {
    const overlay = $("measure-overlay");
    const error = $("measure-error");
    let mode = defaults.mode || "rect";

    if (defaults.dims) {
      for (const [key, val] of Object.entries(defaults.dims)) {
        const el = $("m-" + key);
        if (el && val) el.value = val;
      }
    }
    $("m-margin").value = defaults.marginMm || 0;

    const applyMode = () => {
      $("measure-rect").hidden = mode !== "rect";
      $("measure-quad").hidden = mode !== "quad";
      $("mode-rect").classList.toggle("on", mode === "rect");
      $("mode-quad").classList.toggle("on", mode === "quad");
      error.hidden = true;
    };
    $("mode-rect").onclick = () => { mode = "rect"; applyMode(); };
    $("mode-quad").onclick = () => { mode = "quad"; applyMode(); };
    applyMode();

    const close = (result) => {
      overlay.hidden = true;
      $("measure-back").onclick = $("measure-next").onclick = null;
      resolve(result);
    };
    $("measure-back").onclick = () => close(null);
    $("measure-next").onclick = () => {
      const dims = readDims(mode);
      const margin = Number.parseFloat($("m-margin").value) || 0;
      for (const [key, val] of Object.entries(dims)) {
        if (!Number.isFinite(val) || val <= 0) {
          error.textContent = `${key} must be a number greater than zero.`;
          error.hidden = false;
          return;
        }
      }
      if (margin < 0) {
        error.textContent = "Margin cannot be negative.";
        error.hidden = false;
        return;
      }
      close({ mode, dims, marginMm: margin });
    };

    overlay.hidden = false;
  });
}

/* ── Preview + crop ─────────────────────────────────────────────────── */

function showPreview(warped) {
  return new Promise((resolve) => {
    const overlay = $("preview-overlay");
    const view = $("preview-canvas");
    const ctx = view.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const src = warped.canvas;

    // Crop rect in warped-output px; starts at the full image.
    let crop = { x: 0, y: 0, w: src.width, h: src.height };
    let fit = { s: 1, ox: 0, oy: 0 };
    let drag = null;                 // {kind: 'move'|'l'|'r'|'t'|'b', ...}

    function layout() {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      view.width = w * dpr;
      view.height = h * dpr;
      view.style.width = w + "px";
      view.style.height = h + "px";
      const padTop = 64, padBottom = 96, pad = 10;
      const s = Math.min((w - 2 * pad) / src.width,
                         (h - padTop - padBottom) / src.height);
      fit = { s, ox: (w - src.width * s) / 2,
              oy: padTop + (h - padTop - padBottom - src.height * s) / 2 };
      draw();
    }

    const toScreen = (x, y) => [fit.ox + x * fit.s, fit.oy + y * fit.s];
    const toImage = (sx, sy) => [(sx - fit.ox) / fit.s, (sy - fit.oy) / fit.s];

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.drawImage(src, fit.ox, fit.oy,
                    src.width * fit.s, src.height * fit.s);
      // Dim outside the crop.
      const [cx, cy] = toScreen(crop.x, crop.y);
      const cw = crop.w * fit.s, ch = crop.h * fit.s;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.beginPath();
      ctx.rect(fit.ox, fit.oy, src.width * fit.s, src.height * fit.s);
      ctx.rect(cx, cy, cw, ch);
      ctx.fill("evenodd");
      ctx.restore();
      ctx.strokeStyle = "#4682b4";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);
      // Edge handles.
      ctx.fillStyle = "#4682b4";
      for (const [hx, hy] of [
        [cx + cw / 2, cy], [cx + cw / 2, cy + ch],
        [cx, cy + ch / 2], [cx + cw, cy + ch / 2],
      ]) {
        ctx.beginPath();
        ctx.arc(hx, hy, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function hit(sx, sy) {
      const [cx, cy] = toScreen(crop.x, crop.y);
      const cw = crop.w * fit.s, ch = crop.h * fit.s;
      const near = (x, y) => Math.hypot(sx - x, sy - y) < 26;
      if (near(cx + cw / 2, cy)) return "t";
      if (near(cx + cw / 2, cy + ch)) return "b";
      if (near(cx, cy + ch / 2)) return "l";
      if (near(cx + cw, cy + ch / 2)) return "r";
      if (sx > cx && sx < cx + cw && sy > cy && sy < cy + ch) return "move";
      return null;
    }

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const MIN = 24;                   // px — a crop can't collapse

    function onDown(ev) {
      ev.preventDefault();
      const kind = hit(ev.clientX, ev.clientY);
      if (!kind) return;
      drag = { kind, start: toImage(ev.clientX, ev.clientY),
               orig: { ...crop } };
      view.setPointerCapture(ev.pointerId);
    }

    function onMove(ev) {
      if (!drag) return;
      ev.preventDefault();
      const [ix, iy] = toImage(ev.clientX, ev.clientY);
      const dx = ix - drag.start[0], dy = iy - drag.start[1];
      const o = drag.orig;
      if (drag.kind === "move") {
        crop.x = clamp(o.x + dx, 0, src.width - o.w);
        crop.y = clamp(o.y + dy, 0, src.height - o.h);
      } else if (drag.kind === "l") {
        const nx = clamp(o.x + dx, 0, o.x + o.w - MIN);
        crop.w = o.w + (o.x - nx);
        crop.x = nx;
      } else if (drag.kind === "r") {
        crop.w = clamp(o.w + dx, MIN, src.width - o.x);
      } else if (drag.kind === "t") {
        const ny = clamp(o.y + dy, 0, o.y + o.h - MIN);
        crop.h = o.h + (o.y - ny);
        crop.y = ny;
      } else if (drag.kind === "b") {
        crop.h = clamp(o.h + dy, MIN, src.height - o.y);
      }
      updateReadout();
      draw();
    }

    function onUp() { drag = null; }

    function updateReadout() {
      $("preview-readout").textContent =
        `${Math.round(crop.w / warped.pxPerMm)} × ` +
        `${Math.round(crop.h / warped.pxPerMm)} mm`;
    }

    const close = (result) => {
      view.removeEventListener("pointerdown", onDown);
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      view.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", layout);
      $("preview-back").onclick = $("preview-use").onclick =
        $("preview-reset").onclick = null;
      overlay.hidden = true;
      resolve(result);
    };

    $("preview-back").onclick = () => close(null);
    $("preview-reset").onclick = () => {
      crop = { x: 0, y: 0, w: src.width, h: src.height };
      updateReadout();
      draw();
    };
    $("preview-use").onclick = () => close({ ...crop });

    view.addEventListener("pointerdown", onDown);
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp);
    view.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", layout);

    overlay.hidden = false;
    updateReadout();
    layout();
  });
}

/* ── The flow ───────────────────────────────────────────────────────── */

async function decode(blob) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("could not decode the photo"));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * @param {Blob} photoBlob   the prepared photo
 * @param {object|null} prior  a previous run's result, to re-edit
 * @param {object} formDims  {width, height} prefill from the form
 */
export async function runRectifyFlow(photoBlob, prior, formDims) {
  // Step 1 — corners.
  const corners = await openCornerMarker(photoBlob, prior?.corners || null);
  if (!corners) return null;

  // Step 2 — measurements (re-entered on preview Back).
  let defaults = {
    mode: prior?.mode,
    dims: prior?.dims || formDims,
    marginMm: prior?.marginMm,
  };
  for (;;) {
    const measure = await showMeasureSheet(defaults);
    if (!measure) return null;
    defaults = { mode: measure.mode, dims: measure.dims,
                 marginMm: measure.marginMm };

    // Real-world geometry.
    let geom;
    try {
      geom = measure.mode === "quad"
        ? quadCorners(measure.dims)
        : { corners: rectCorners(measure.dims.width, measure.dims.height),
            widthMm: measure.dims.width, heightMm: measure.dims.height };
    } catch (err) {
      $("measure-error").textContent = err.message;
      $("measure-error").hidden = false;
      $("measure-overlay").hidden = false;
      continue;                       // fix the numbers, try again
    }

    // Step 3 — warp + preview + crop.
    let warped = null;
    try {
      const image = await decode(photoBlob);
      warped = warpToCanvas(image, corners, geom.corners,
                            geom.widthMm, geom.heightMm, measure.marginMm);
      if (image && typeof image.close === "function") image.close();
    } catch (err) {
      console.warn("warp failed:", err);
    }
    if (!warped) {
      // No WebGL: ship the spec, let the PC do the flattening.
      return { corners, mode: measure.mode, dims: measure.dims,
               marginMm: measure.marginMm, output: null };
    }

    const crop = await showPreview(warped);
    if (crop === null) continue;      // Back to measurements

    const blob = await cropToBlob(warped.canvas, crop.x, crop.y,
                                  crop.w, crop.h);
    return {
      corners,
      mode: measure.mode,
      dims: measure.dims,
      marginMm: measure.marginMm,
      output: {
        blob,
        pxPerMm: warped.pxPerMm,
        widthMm: crop.w / warped.pxPerMm,
        heightMm: crop.h / warped.pxPerMm,
      },
    };
  }
}
