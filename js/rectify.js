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
import { warpToCanvas, cropToBlobMasked } from "./warp.js";
import { detectSlabOutline, pixelGetter, simplifyClosed } from "./outline.js";

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
    if (defaults.marginMm !== undefined) {
      $("m-margin").value = defaults.marginMm;
    }

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

/* ── Preview: rotation, crop, edge outline ──────────────────────────── */

const rotatePoint = ([x, y], [cx, cy], rad) => {
  const c = Math.cos(rad), s = Math.sin(rad);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};

/** Rotate the mm geometry about its centroid, re-origin to the bbox. */
function rotateGeom(geom, deg) {
  if (!deg) return geom;
  const rad = (deg * Math.PI) / 180;
  const c = [geom.widthMm / 2, geom.heightMm / 2];
  const pts = geom.corners.map((p) => rotatePoint(p, c, rad));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return {
    corners: pts.map(([x, y]) => [x - minX, y - minY]),
    widthMm: Math.max(...xs) - minX,
    heightMm: Math.max(...ys) - minY,
  };
}

/** The desktop detection pipeline, staged like outline.py: segment on a
 * small raster, refine (edge-snap) at higher resolution. Returns
 * {ok, polygon (canvas px), reason}. */
function detectOnCanvas(canvas, dstPx, pxPerMm) {
  const raster = (maxEdge) => {
    const k = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(canvas.width * k));
    c.height = Math.max(1, Math.round(canvas.height * k));
    const cctx = c.getContext("2d", { willReadFrequently: true });
    cctx.drawImage(canvas, 0, 0, c.width, c.height);
    return { k, data: cctx.getImageData(0, 0, c.width, c.height) };
  };
  const seg = raster(500);           // segmentation stage (GrabCut-scale)
  const ref = raster(1600);          // edge-snap refinement stage

  const result = detectSlabOutline(
    seg.data,
    dstPx.map(([x, y]) => [x * seg.k, y * seg.k]),
    pixelGetter(ref.data),
    ref.k / seg.k,
    pxPerMm * ref.k,
    { simplifyTolMm: 1.0 },       // detailed base; Smooth re-simplifies
  );
  if (!result.ok) return result;
  const back = (pts) => pts.map(([x, y]) => [x / ref.k, y / ref.k]);
  return { ok: true, reason: null,
           polygon: back(result.polygon), base: back(result.base) };
}

/**
 * The preview stage. `makeWarp(angleDeg)` re-runs the GPU warp with the
 * rotation baked into the target geometry (the desktop's
 * output_rotation_deg semantics — never a lossy second resample).
 *
 * Resolves {angle, crop, outlinePx, warped} or null (Back).
 */
function previewStage(makeWarp, marginMm) {
  return new Promise((resolve, reject) => {
    const overlay = document.getElementById("preview-overlay");
    const view = document.getElementById("preview-canvas");
    const ctx = view.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    let quarter = 0;
    let fine = 0;                    // straighten angle, deg, clamped +-45
    let shownFine = 0;               // angle the current warp was made at
    let warped = null;
    let src = null;
    let crop = null;
    let outline = null;              // canvas-px points or null
    let outlineBase = null;          // detailed base the Smooth slider
                                     // re-simplifies from (desktop's
                                     // _outline_base_px); manual edits
                                     // become the new base
    let selected = -1;               // outline point being edited
    let mode = "crop";
    let fit = { s: 1, ox: 0, oy: 0 };
    let drag = null;

    const angleNow = () => quarter * 90 + fine;

    async function rewarp() {
      warped = await makeWarp(angleNow());
      shownFine = fine;
      src = warped.canvas;
      crop = { x: 0, y: 0, w: src.width, h: src.height };
      outline = null;                // old coords belong to the old frame
      outlineBase = null;
      selected = -1;
      layout();
    }

    function layout() {
      const w = overlay.clientWidth, h = overlay.clientHeight;
      view.width = w * dpr;
      view.height = h * dpr;
      view.style.width = w + "px";
      view.style.height = h + "px";
      const padTop = 64, padBottom = 196, pad = 10;
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
      // Straighten preview: spin the already-rendered image about its own
      // centre by whatever the real re-warp still owes (desktop's
      // _paint_image) — instant feedback, full-quality warp on release.
      const pending = ((fine - shownFine) * Math.PI) / 180;
      if (pending) {
        const cxs = fit.ox + (src.width * fit.s) / 2;
        const cys = fit.oy + (src.height * fit.s) / 2;
        ctx.save();
        ctx.translate(cxs, cys);
        ctx.rotate(pending);
        ctx.translate(-cxs, -cys);
      }
      ctx.drawImage(src, fit.ox, fit.oy, src.width * fit.s, src.height * fit.s);
      if (pending) ctx.restore();

      if (mode === "crop") {
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
      if (outline) {
        ctx.beginPath();
        outline.forEach(([px, py], i) => {
          const [sx, sy] = toScreen(px, py);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.closePath();
        ctx.strokeStyle = mode === "outline" ? "#5a9bd4"
                                             : "rgba(90,155,212,.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
        if (mode === "outline") {
          outline.forEach(([px, py], i) => {
            const [sx, sy] = toScreen(px, py);
            ctx.beginPath();
            ctx.arc(sx, sy, i === selected ? 10 : 6, 0, Math.PI * 2);
            ctx.fillStyle = i === selected ? "#e0b341" : "#4682b4";
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#eef1f5";
            ctx.stroke();
          });
        }
      }
      updateChrome();
    }

    function updateChrome() {
      const hint = document.getElementById("preview-hint");
      hint.textContent = mode === "crop"
        ? "Drag the edges to crop"
        : mode === "rotate"
          ? "Drag to turn the slab (" + (quarter * 90 + fine).toFixed(1)
            + String.fromCharCode(176) + ")"
          : outline ? "Drag points; tap the line to add one"
                    : "Detect edge, or tap the image to start tracing";
      document.getElementById("preview-readout").textContent =
        Math.round(crop.w / warped.pxPerMm) + " x " +
        Math.round(crop.h / warped.pxPerMm) + " mm";
      $("pv-outline-tools").hidden = mode !== "outline";
      $("pv-mode-crop").classList.toggle("on", mode === "crop");
      $("pv-mode-outline").classList.toggle("on", mode === "outline");
      $("pv-mode-rotate").classList.toggle("on", mode === "rotate");
      $("pv-point-remove").hidden =
        !(mode === "outline" && outline && selected >= 0
          && outline.length > 3);
    }

    /* -- crop dragging -- */
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const MIN = 24;

    function cropHit(sx, sy) {
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

    /* -- outline editing -- */
    function nearestPoint(ix, iy) {
      if (!outline) return -1;
      let best = -1, bestD = 26 / fit.s;
      outline.forEach(([px, py], i) => {
        const d = Math.hypot(ix - px, iy - py);
        if (d < bestD) { best = i; bestD = d; }
      });
      return best;
    }

    function segDist(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2
        ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0;
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }

    function nearestSegment(ix, iy) {
      if (!outline) return -1;
      let best = -1, bestD = 20 / fit.s;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        const d = segDist([ix, iy], a, b);
        if (d < bestD) { best = i; bestD = d; }
      }
      return best;
    }

    // Straighten drag: angle of the pointer about the image centre, the
    // desktop's dial (drag anywhere, the image follows the hand round).
    const cursorDeg = (sx, sy) => {
      const cxs = fit.ox + (src.width * fit.s) / 2;
      const cys = fit.oy + (src.height * fit.s) / 2;
      if (Math.hypot(sx - cxs, sy - cys) < 24) return null;  // dead centre
      return (Math.atan2(sy - cys, sx - cxs) * 180) / Math.PI;
    };
    const clampFine = (v) => Math.min(45, Math.max(-45, v));

    function onDown(ev) {
      ev.preventDefault();
      const [ix, iy] = toImage(ev.clientX, ev.clientY);
      if (mode === "rotate") {
        const deg = cursorDeg(ev.clientX, ev.clientY);
        if (deg === null) return;
        drag = { kind: "rot", grabDeg: deg, from: fine };
      } else if (mode === "crop") {
        const kind = cropHit(ev.clientX, ev.clientY);
        if (!kind) return;
        drag = { kind, start: [ix, iy], orig: { x: crop.x, y: crop.y,
                                                w: crop.w, h: crop.h } };
      } else {
        if (!outline) {
          // Start a manual trace from the slab quad — the same fallback
          // the desktop uses when detection has nothing to offer.
          outline = warped.dstPx.map((p) => [p[0], p[1]]);
          outlineBase = outline.map((p) => [p[0], p[1]]);
        }
        const pt = nearestPoint(ix, iy);
        if (pt >= 0) {
          // Grab RELATIVE to the point: it must not jolt to the
          // fingertip — hold it where it is and drag from there.
          selected = pt;
          drag = { kind: "pt", idx: pt,
                   off: [outline[pt][0] - ix, outline[pt][1] - iy] };
          drawPreviewLoupe(outline[pt]);
        } else {
          const seg = nearestSegment(ix, iy);
          if (seg >= 0) {
            outline.splice(seg + 1, 0, [ix, iy]);
            selected = seg + 1;
            drag = { kind: "pt", idx: seg + 1, off: [0, 0] };
            drawPreviewLoupe(outline[selected]);
          } else {
            selected = -1;
          }
        }
      }
      view.setPointerCapture(ev.pointerId);
      draw();
    }

    function onMove(ev) {
      if (!drag) return;
      ev.preventDefault();
      const [ix, iy] = toImage(ev.clientX, ev.clientY);
      if (drag.kind === "rot") {
        const deg = cursorDeg(ev.clientX, ev.clientY);
        if (deg === null) return;
        // Unwrap across the +-180 seam so the turn follows the hand.
        const delta = ((deg - drag.grabDeg + 540) % 360) - 180;
        fine = clampFine(drag.from + delta);
        draw();
        return;
      }
      if (drag.kind === "pt") {
        outline[drag.idx] = [clamp(ix + drag.off[0], 0, src.width),
                             clamp(iy + drag.off[1], 0, src.height)];
        drawPreviewLoupe(outline[drag.idx]);
      } else {
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
      }
      draw();
    }

    function onUp() {
      const wasRot = drag && drag.kind === "rot";
      if (drag && drag.kind === "pt" && outline) {
        outlineBase = outline.map((p) => [p[0], p[1]]);
      }
      drag = null;
      $("preview-loupe").hidden = true;
      if (wasRot && Math.abs(fine - shownFine) > 0.05) {
        // The hand has settled — do the real full-quality re-warp, like
        // the desktop's debounced recompute.
        rewarp();
      } else {
        draw();
      }
    }

    function drawPreviewLoupe(pt) {
      const loupe = $("preview-loupe");
      const L = 132, Z = 3;
      loupe.hidden = false;
      loupe.width = L * dpr;
      loupe.height = L * dpr;
      loupe.style.width = L + "px";
      loupe.style.height = L + "px";
      const [sx, sy] = toScreen(pt[0], pt[1]);
      const lx = Math.min(Math.max(sx - L / 2, 8),
                          overlay.clientWidth - L - 8);
      const above = sy - L - 36;
      loupe.style.left = lx + "px";
      loupe.style.top = (above > 8 ? above : sy + 36) + "px";
      const lctx = loupe.getContext("2d");
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.imageSmoothingEnabled = false;
      lctx.fillStyle = "#16181c";
      lctx.fillRect(0, 0, L, L);
      const span = L / (Z * Math.max(fit.s, 0.05));
      lctx.drawImage(src, pt[0] - span / 2, pt[1] - span / 2, span, span,
                     0, 0, L, L);
      lctx.strokeStyle = "rgba(70, 130, 180, 0.95)";
      lctx.lineWidth = 1;
      lctx.beginPath();
      lctx.moveTo(L / 2, 0);
      lctx.lineTo(L / 2, L);
      lctx.moveTo(0, L / 2);
      lctx.lineTo(L, L / 2);
      lctx.stroke();
    }

    /* -- wiring -- */
    const buttons = ["preview-back", "preview-reset", "preview-use",
                     "pv-rotl", "pv-rotr", "pv-mode-crop",
                     "pv-mode-outline", "pv-mode-rotate", "pv-detect",
                     "pv-outline-clear", "pv-point-remove"];

    const close = (result) => {
      view.removeEventListener("pointerdown", onDown);
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      view.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", layout);
      for (const id of buttons) $(id).onclick = null;
      $("pv-smooth").oninput = null;
      $("preview-loupe").hidden = true;
      overlay.hidden = true;
      resolve(result);
    };

    $("preview-back").onclick = () => close(null);
    $("preview-reset").onclick = () => {
      if (mode === "crop") {
        crop = { x: 0, y: 0, w: src.width, h: src.height };
        draw();
      } else if (mode === "rotate") {
        fine = 0;
        rewarp();
      } else {
        outline = null;
        selected = -1;
        draw();
      }
    };
    $("preview-use").onclick = () =>
      close({ angle: angleNow(), crop: { x: crop.x, y: crop.y,
                                         w: crop.w, h: crop.h },
              outlinePx: outline ? outline.map((p) => [p[0], p[1]]) : null,
              warped });

    $("pv-rotl").onclick = () => { quarter = (quarter + 3) % 4; rewarp(); };
    $("pv-rotr").onclick = () => { quarter = (quarter + 1) % 4; rewarp(); };

    $("pv-mode-crop").onclick = () => { mode = "crop"; draw(); };
    $("pv-mode-outline").onclick = () => { mode = "outline"; draw(); };
    $("pv-mode-rotate").onclick = () => { mode = "rotate"; draw(); };

    const applySmooth = () => {
      if (!outlineBase) return;
      const tol = Number($("pv-smooth").value);
      $("pv-smooth-value").textContent = tol + "mm";
      outline = simplifyClosed(outlineBase.map((q) => [q[0], q[1]]),
                               Math.max(1, tol * warped.pxPerMm));
      selected = -1;
      draw();
    };

    $("pv-detect").onclick = () => {
      const result = detectOnCanvas(src, warped.dstPx, warped.pxPerMm);
      if (result.ok) {
        outlineBase = result.base;
        applySmooth();
      } else {
        // The desktop's contract: never fail silently — say WHY, and the
        // quad fallback (tap to trace) stays available. Set the reason
        // AFTER draw(), whose chrome update rewrites the hint.
        draw();
        document.getElementById("preview-hint").textContent =
          "Detection: " + result.reason;
      }
    };
    $("pv-smooth").oninput = applySmooth;
    $("pv-outline-clear").onclick = () => {
      outline = null;
      outlineBase = null;
      selected = -1;
      draw();
    };
    $("pv-point-remove").onclick = () => {
      if (outline && selected >= 0 && outline.length > 3) {
        outline.splice(selected, 1);
        outlineBase = outline.map((p) => [p[0], p[1]]);
        selected = -1;
        draw();
      }
    };

    view.addEventListener("pointerdown", onDown);
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp);
    view.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", layout);

    overlay.hidden = false;
    rewarp().catch(reject);
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

    // Step 3 — warp (rotation baked in), preview, crop, outline.
    const image = await decode(photoBlob);
    const makeWarp = async (angleDeg) => {
      const g = rotateGeom(geom, angleDeg);
      const warped = warpToCanvas(image, corners, g.corners,
                                  g.widthMm, g.heightMm, measure.marginMm);
      if (!warped) throw new Error("no WebGL");
      return warped;
    };

    let choice;
    try {
      choice = await previewStage(makeWarp, measure.marginMm);
    } catch (err) {
      console.warn("warp failed:", err);
      if (image && typeof image.close === "function") image.close();
      // No WebGL: ship the spec, let the PC do the flattening.
      return { corners, mode: measure.mode, dims: measure.dims,
               marginMm: measure.marginMm, output: null };
    }
    if (choice === null) {
      if (image && typeof image.close === "function") image.close();
      continue;                       // Back to measurements
    }

    const { crop, outlinePx, warped } = choice;
    const blob = await cropToBlobMasked(warped.canvas, crop.x, crop.y,
                                        crop.w, crop.h, outlinePx);
    if (image && typeof image.close === "function") image.close();

    const s = warped.pxPerMm;
    return {
      corners,
      mode: measure.mode,
      dims: measure.dims,
      marginMm: measure.marginMm,
      output: {
        blob,
        pxPerMm: s,
        widthMm: crop.w / s,
        heightMm: crop.h / s,
        outlineMm: outlinePx
          ? outlinePx.map(([x, y]) => [
              Math.round(((x - crop.x) / s) * 10) / 10,
              Math.round(((y - crop.y) / s) * 10) / 10,
            ])
          : null,
      },
    };
  }
}
