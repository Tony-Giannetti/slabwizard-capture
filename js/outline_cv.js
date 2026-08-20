/* Slab outline detection on REAL OpenCV (WebAssembly).
 *
 * This is core/slab_photo/outline.py::detect_slab_outline ported
 * line-for-line onto opencv.js — the same cv.grabCut, the same band
 * seeding, the same morphology, contours, gates and tolerances. The
 * pure-JS approximation in outline.js remains only as the fallback for
 * a phone that cannot load the WASM (first use offline); everything
 * else runs this.
 *
 * opencv.js is ~10 MB, so it is NOT part of the app shell: it loads
 * lazily on the first "Detect", and the service worker's runtime cache
 * keeps it for every use after that.
 */

import { snapToSilhouette, simplifyClosed } from "./outline.js";

// Desktop's gates and defaults (outline.py) — keep in step.
const AREA_RATIO_MIN = 0.70;
const AREA_RATIO_MAX = 1.20;
const MIN_CONFIDENCE = 0.15;
// Desktop runs GrabCut natively at 700px/5 iters; in WASM that costs
// ~10s. 500px/3 iters cuts it ~3x — the full-res edge-snap pass after it
// recovers the precision, exactly what it exists for.
const MAX_DIM_PX = 500;
const GRABCUT_ITERS = 3;

let cvPromise = null;

/** Load opencv.js once, lazily. Resolves to the cv module. */
export function loadOpenCV(src = "vendor/opencv.js") {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    if (globalThis.cv && typeof globalThis.cv.grabCut === "function") {
      resolve(globalThis.cv);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onerror = () => {
      cvPromise = null;
      reject(new Error("could not load the detector (offline?)"));
    };
    script.onload = async () => {
      try {
        let cv = globalThis.cv;
        if (cv && typeof cv.then === "function") cv = await cv;
        if (typeof cv.grabCut === "function") {
          resolve(cv);
        } else {
          await new Promise((r) => { cv.onRuntimeInitialized = r; });
          resolve(cv);
        }
      } catch (err) {
        cvPromise = null;
        reject(err);
      }
    };
    document.head.appendChild(script);
  });
  return cvPromise;
}

/**
 * The desktop pipeline. All inputs mirror outline.js's detectSlabOutline:
 *
 * @param {object} cv        the loaded opencv.js module
 * @param {object} refine    {data, width, height} RGBA raster (<=1600 edge)
 * @param {Array} quadRefine reference quad in refine-raster px
 * @param {number} pxPerMmRefine
 * @param {object} opts      {bandMm}
 * @returns {{ok, polygon, base, confidence, reason}} in refine-res px
 */
export function detectSlabOutlineCv(cv, refine, quadRefine, pxPerMmRefine,
                                    { bandMm = 100 } = {}) {
  const fail = (reason) => ({ ok: false, polygon: null, base: null,
                              confidence: 0, reason });
  const mats = [];
  const track = (m) => { mats.push(m); return m; };
  try {
    const full = track(cv.matFromImageData(refine));
    const scale = Math.min(1, MAX_DIM_PX / Math.max(full.rows, full.cols));
    const small = track(new cv.Mat());
    if (scale < 1) {
      cv.resize(full, small,
                new cv.Size(Math.max(1, Math.round(full.cols * scale)),
                            Math.max(1, Math.round(full.rows * scale))),
                0, 0, cv.INTER_AREA);
    } else {
      full.copyTo(small);
    }
    const rgb = track(new cv.Mat());
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    const smW = rgb.cols, smH = rgb.rows;

    const quad = quadRefine.map(([x, y]) => [x * scale, y * scale]);
    const quadArea = polyArea(quad);
    if (quadArea <= 0) return fail("reference quad is degenerate");

    const pxPerMmSmall = pxPerMmRefine * scale;
    // The desktop's fixed 100mm band is slab-scale; scale it to the piece
    // (a quarter of the short side) so books and remnants work too.
    const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
    const shortSideMm = Math.min(Math.max(...xs) - Math.min(...xs),
                                 Math.max(...ys) - Math.min(...ys))
                        / pxPerMmSmall;
    const effBandMm = Math.min(bandMm, Math.max(10, shortSideMm * 0.25));
    const bandPx = Math.max(2, Math.round(effBandMm * pxPerMmSmall));
    let borderRoom = Infinity;
    for (const [qx, qy] of quad) {
      borderRoom = Math.min(borderRoom, qx, qy, smW - qx, smH - qy);
    }
    const outBandPx = Math.min(bandPx,
                               Math.max(2, Math.floor(borderRoom * 0.6)));

    // Band masks: erode/dilate of the quad, elliptical kernels (desktop).
    const quadMask = track(cv.Mat.zeros(smH, smW, cv.CV_8UC1));
    const quadPts = track(cv.matFromArray(
      quad.length, 1, cv.CV_32SC2,
      quad.flatMap(([x, y]) => [Math.round(x), Math.round(y)])));
    const vec = track(new cv.MatVector());
    vec.push_back(quadPts);
    cv.fillPoly(quadMask, vec, new cv.Scalar(255));

    const ell = (r) => track(cv.getStructuringElement(
      cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1)));
    const inner = track(new cv.Mat());
    const outer = track(new cv.Mat());
    cv.erode(quadMask, inner, ell(bandPx));
    cv.dilate(quadMask, outer, ell(outBandPx));

    if (cv.countNonZero(inner) === 0) {
      return fail("detection band wider than the slab itself");
    }
    const bgFrac = 1 - cv.countNonZero(outer) / (smW * smH);
    if (bgFrac < 0.02) {
      return fail("not enough background room - increase the margin");
    }

    // GrabCut seeded from the band prior — the actual desktop call.
    const gcMask = track(new cv.Mat(smH, smW, cv.CV_8UC1,
                                    new cv.Scalar(cv.GC_BGD)));
    setWhere(gcMask, outer, cv.GC_PR_FGD);
    setWhere(gcMask, inner, cv.GC_FGD);
    const bgd = track(new cv.Mat());
    const fgd = track(new cv.Mat());
    cv.grabCut(rgb, gcMask, new cv.Rect(0, 0, 1, 1), bgd, fgd,
               GRABCUT_ITERS, cv.GC_INIT_WITH_MASK);

    const fg = track(cv.Mat.zeros(smH, smW, cv.CV_8UC1));
    for (let i = 0; i < smW * smH; i++) {
      const v = gcMask.data[i];
      if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fg.data[i] = 255;
    }
    cv.morphologyEx(fg, fg, cv.MORPH_CLOSE, ell(2));

    // Dense external contours; the edge-snap needs every boundary pixel.
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(fg, contours, hierarchy, cv.RETR_EXTERNAL,
                    cv.CHAIN_APPROX_NONE);
    if (contours.size() === 0) {
      return fail("no foreground region found (contrast too low?)");
    }
    let largest = null, largestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > largestArea) { largestArea = a; largest = c; }
    }
    if (!largest || largestArea <= 0) {
      return fail("degenerate foreground region");
    }
    const areaRatio = largestArea / quadArea;
    if (areaRatio < AREA_RATIO_MIN || areaRatio > AREA_RATIO_MAX) {
      return fail("detected area is " + areaRatio.toFixed(2)
                  + "x the reference - contrast too low?");
    }

    // Dense boundary, back at refine resolution.
    const dense = [];
    for (let i = 0; i < largest.data32S.length; i += 2) {
      dense.push([largest.data32S[i] / scale,
                  largest.data32S[i + 1] / scale]);
    }

    // Full-res edge-snap refinement (the numpy port in outline.js).
    const getPixel = rgbaGetter(refine);
    const { pts: refined, confidence } =
      snapToSilhouette(getPixel, dense, pxPerMmRefine);
    if (confidence < MIN_CONFIDENCE) {
      return fail("only " + Math.round(confidence * 100)
                  + "% of the boundary found a colour transition");
    }

    const base = simplifyClosed(refined,
                                Math.max(0.5, 1.0 * pxPerMmRefine), 512);
    if (base.length < 3) return fail("simplified outline is degenerate");
    return { ok: true, polygon: base, base, confidence, reason: null };
  } catch (err) {
    return fail("detector error: " + (err && err.message ? err.message : err));
  } finally {
    for (const m of mats) {
      try { m.delete(); } catch { /* already freed */ }
    }
  }
}

function setWhere(dst, mask, value) {
  const n = dst.data.length;
  for (let i = 0; i < n; i++) {
    if (mask.data[i]) dst.data[i] = value;
  }
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function rgbaGetter({ data, width, height }) {
  return (x, y) => {
    const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (cy * width + cx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}
