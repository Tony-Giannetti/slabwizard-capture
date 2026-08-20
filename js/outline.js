/* Slab outline detection — a faithful port of the desktop pipeline
 * (core/slab_photo/outline.py), structured the same way:
 *
 *   1. SEGMENT the downscaled image around the reference quad: inside the
 *      quad eroded by the band = sure slab, outside the dilated quad =
 *      sure background, and the band between is classified by colour
 *      models built from the sure regions (k-means stands in for
 *      GrabCut's GMMs — same prior, same role).
 *   2. Largest connected foreground region -> DENSE boundary trace.
 *   3. EDGE-SNAP refinement at high resolution: every boundary point
 *      samples along its outward normal, classifies each sample against
 *      per-ray self-calibrated slab/background references, and snaps to
 *      the outermost slab->background transition (corrects the
 *      segmentation's inward colour bias on shadowed edges). The scalar
 *      offsets are smoothed circularly along the contour.
 *   4. SANITY GATES, same numbers as the desktop: detected area must be
 *      0.70-1.20x the quad, and >=15% of boundary points must have locked
 *      onto a real colour transition. A proposal, never an authority.
 *   5. Douglas-Peucker simplify at the desktop's 4 mm tolerance.
 *
 * Pure functions over {data, width, height} raster objects, so the whole
 * thing is node-testable without a canvas.
 */

// Desktop's gates and tolerances (outline.py) — keep in step.
const AREA_RATIO_MIN = 0.70;
const AREA_RATIO_MAX = 1.20;
const MIN_CONFIDENCE = 0.15;
const MIN_RAY_CONTRAST = 15.0;
export const SIMPLIFY_TOL_MM = 4.0;
const REFINE_IN_MM = 12.0;
const REFINE_OUT_MM = 45.0;

/* ── Geometry helpers ──────────────────────────────────────────────── */

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

export function simplify(points, epsilon) {
  if (points.length <= 2) return points.slice();
  let maxD = -1, index = -1;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) { maxD = d; index = i; }
  }
  if (maxD <= epsilon) return [a, b];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

export function simplifyClosed(points, epsilon, maxPoints = 128) {
  let out = simplify([...points, points[0]], epsilon).slice(0, -1);
  while (out.length > maxPoints) {
    epsilon *= 1.5;
    out = simplify([...out, out[0]], epsilon).slice(0, -1);
  }
  return out;
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/* ── Raster helpers (small-res segmentation stage) ─────────────────── */

/** Scanline polygon fill into a Uint8Array mask. */
function fillPolygon(quad, w, h) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const xs = [];
    for (let i = 0; i < quad.length; i++) {
      const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % quad.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]));
      const to = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = from; x <= to; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Two-pass chamfer distance (3-4) to the nearest zero pixel. */
function chamferDistance(mask, w, h) {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 3);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + 4);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 3);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 3);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + 4);
      }
      dist[i] = d;
    }
  }
  // Chamfer 3-4 approximates distance*3.
  for (let i = 0; i < w * h; i++) dist[i] /= 3;
  return dist;
}

/** k-means (Lloyd) on RGB samples. Returns cluster centres. */
function kmeans(samples, k = 4, iters = 8) {
  if (samples.length === 0) return [];
  const centres = [];
  for (let i = 0; i < k; i++) {
    centres.push([...samples[Math.floor((i * samples.length) / k)]]);
  }
  const assign = new Int32Array(samples.length);
  for (let it = 0; it < iters; it++) {
    for (let s = 0; s < samples.length; s++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = dist2rgb(samples[s], centres[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[s] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let s = 0; s < samples.length; s++) {
      const a = sums[assign[s]];
      a[0] += samples[s][0]; a[1] += samples[s][1];
      a[2] += samples[s][2]; a[3] += 1;
    }
    for (let c = 0; c < centres.length; c++) {
      if (sums[c][3] > 0) {
        centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3],
                      sums[c][2] / sums[c][3]];
      }
    }
  }
  return centres;
}

const dist2rgb = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
};

const minDist2 = (px, centres) => {
  let best = Infinity;
  for (const c of centres) {
    const d = dist2rgb(px, c);
    if (d < best) best = d;
  }
  return best;
};

/** Moore-neighbour boundary trace of a labelled region. Dense points. */
function traceBoundary(region, w, h) {
  let start = -1;
  for (let i = 0; i < w * h; i++) {
    if (region[i]) { start = i; break; }
  }
  if (start < 0) return null;
  const sx = start % w, sy = (start / w) | 0;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1],
                [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const inside = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && region[y * w + x];
  const pts = [];
  let cx = sx, cy = sy, dir = 6;              // entered heading "up"
  const maxSteps = w * h * 4;
  for (let step = 0; step < maxSteps; step++) {
    pts.push([cx, cy]);
    let found = false;
    for (let t = 0; t < 8; t++) {
      const d = (dir + 6 + t) % 8;            // start looking backwards-left
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (inside(nx, ny)) {
        cx = nx; cy = ny; dir = d; found = true;
        break;
      }
    }
    if (!found) break;                        // single-pixel region
    if (cx === sx && cy === sy && pts.length > 2) break;
  }
  return pts.length >= 8 ? pts : null;
}

/* ── Stage 3: edge-snap refinement (port of _snap_to_silhouette) ───── */

export function snapToSilhouette(getPixel, pts, pxPerMm,
                                 inMm = REFINE_IN_MM, outMm = REFINE_OUT_MM) {
  const n = pts.length;
  if (n < 8) return { pts, confidence: 0 };

  // Outward normals from neighbours k apart, oriented away from centroid.
  const k = 3;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const normals = pts.map((p, i) => {
    const a = pts[(i - k + n) % n], b = pts[(i + k) % n];
    let nx = b[1] - a[1], ny = -(b[0] - a[0]);
    const len = Math.hypot(nx, ny) || 1e-9;
    nx /= len; ny /= len;
    if (nx * (p[0] - cx) + ny * (p[1] - cy) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  });

  const inPx = Math.max(3, inMm * pxPerMm);
  const outPx = Math.max(4, outMm * pxPerMm);
  const step = 1.5;
  const ts = [];
  for (let t = -inPx; t <= outPx; t += step) ts.push(t);
  const nS = ts.length;
  const q = Math.max(2, nS >> 2);

  const offsets = new Float64Array(n);
  const valid = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const [nx, ny] = normals[i];
    const ray = ts.map((t) => getPixel(px + nx * t, py + ny * t));

    // Per-ray references: innermost quarter = slab, outermost = background.
    const mean = (arr) => {
      const m = [0, 0, 0];
      for (const c of arr) { m[0] += c[0]; m[1] += c[1]; m[2] += c[2]; }
      return m.map((v) => v / arr.length);
    };
    const fgRef = mean(ray.slice(0, q));
    const bgRef = mean(ray.slice(-q));
    const contrast = Math.sqrt(dist2rgb(fgRef, bgRef));

    const slabLike = ray.map((c) => dist2rgb(c, fgRef) < dist2rgb(c, bgRef));
    // Outermost run of TWO consecutive slab-like samples.
    let last = -1;
    for (let s = nS - 2; s >= 0; s--) {
      if (slabLike[s] && slabLike[s + 1]) { last = s; break; }
    }
    const outerIdx = last >= 0 ? Math.min(last + 1, nS - 1) : -1;
    const ok = last >= 0 && outerIdx < nS - 1 && contrast >= MIN_RAY_CONTRAST;
    if (ok) {
      offsets[i] = (ts[outerIdx] + ts[Math.min(outerIdx + 1, nS - 1)]) / 2;
      valid[i] = 1;
    }
  }

  // Circular smoothing of the offset field (win=7) — kills ray-to-ray
  // jitter without rounding corners (points move only along their normal).
  const win = 7, pad = win >> 1;
  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -pad; d <= pad; d++) s += offsets[(i + d + n) % n];
    smoothed[i] = s / win;
  }

  const refined = pts.map((p, i) => [
    p[0] + normals[i][0] * smoothed[i],
    p[1] + normals[i][1] * smoothed[i],
  ]);
  let hits = 0;
  for (let i = 0; i < n; i++) hits += valid[i];
  return { pts: refined, confidence: hits / n };
}

/* ── The full pipeline ─────────────────────────────────────────────── */

/**
 * @param {object} small     {data, width, height} downscaled RGBA raster
 * @param {Array} quadSmall  reference quad in small-raster px
 * @param {function} getPixelFull  (x, y) -> [r,g,b] at refine resolution
 * @param {number} upscale   refine-res px per small-res px
 * @param {number} pxPerMmRefine   refine-res px per mm
 * @param {object} opts      {bandMm}
 * @returns {{ok, polygon, confidence, reason}} polygon in refine-res px
 */
export function detectSlabOutline(small, quadSmall, getPixelFull, upscale,
                                  pxPerMmRefine,
                                  { bandMm = 100,
                                    simplifyTolMm = SIMPLIFY_TOL_MM } = {}) {
  const { data, width: w, height: h } = small;
  const fail = (reason) => ({ ok: false, polygon: null, confidence: 0, reason });

  const quadArea = polygonArea(quadSmall);
  if (quadArea <= 0) return fail("reference quad is degenerate");

  const pxPerMmSmall = pxPerMmRefine / upscale;
  // Scale the band to the piece: a quarter of its short side, capped at
  // the desktop's 100mm slab default. A 300mm sample book gets ~75mm of
  // band instead of being swallowed whole.
  const xs = quadSmall.map((q) => q[0]), ys = quadSmall.map((q) => q[1]);
  const shortSideMm = Math.min(Math.max(...xs) - Math.min(...xs),
                               Math.max(...ys) - Math.min(...ys))
                      / pxPerMmSmall;
  const effBandMm = Math.min(bandMm, Math.max(10, shortSideMm * 0.25));
  const bandPx = Math.max(2, Math.round(effBandMm * pxPerMmSmall));

  // Band masks from the quad, the desktop's erode/dilate via distances.
  const quadMask = fillPolygon(quadSmall, w, h);
  const dIn = chamferDistance(quadMask, w, h);            // 0 outside
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = quadMask[i] ? 0 : 1;
  const dOut = chamferDistance(inv, w, h);                // 0 inside

  // Outward band clamped to the room available before the canvas border,
  // keeping a sure-background ring outside it.
  let borderRoom = Infinity;
  for (const [qx, qy] of quadSmall) {
    borderRoom = Math.min(borderRoom, qx, qy, w - qx, h - qy);
  }
  const outBandPx = Math.min(bandPx, Math.max(2, Math.floor(borderRoom * 0.6)));

  const px = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  const fgSamples = [], bgSamples = [];
  let innerCount = 0, bgCount = 0;
  const stride = Math.max(1, Math.floor((w * h) / 20000));
  for (let i = 0; i < w * h; i += stride) {
    if (quadMask[i] && dIn[i] > bandPx) {
      innerCount++;
      fgSamples.push(px(i));
    } else if (!quadMask[i] && dOut[i] > outBandPx) {
      bgCount++;
      bgSamples.push(px(i));
    }
  }
  if (innerCount === 0) {
    return fail("detection band wider than the slab itself");
  }
  if (bgCount * stride < 0.02 * w * h) {
    return fail("not enough background room - increase the margin");
  }

  const fgC = kmeans(fgSamples, 4);
  const bgC = kmeans(bgSamples, 4);

  // Classify: sure-inside stays slab; the band goes to the nearer model.
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (quadMask[i] && dIn[i] > bandPx) fg[i] = 1;
    else if (!quadMask[i] && dOut[i] > outBandPx) fg[i] = 0;
    else fg[i] = minDist2(px(i), fgC) < minDist2(px(i), bgC) ? 1 : 0;
  }

  // Spatial regularisation: two 3x3 majority votes (GrabCut's smoothness
  // term, poor man's edition) then a close to heal pinholes.
  majority(fg, w, h);
  majority(fg, w, h);
  morph(fg, w, h, true);
  morph(fg, w, h, false);

  // Largest component containing the sure-slab seed (BFS).
  const region = new Uint8Array(w * h);
  const queue = [];
  for (let i = 0; i < w * h; i++) {
    if (quadMask[i] && dIn[i] > bandPx && fg[i] && !region[i]) {
      queue.push(i);
      region[i] = 1;
    }
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (fg[j] && !region[j]) { region[j] = 1; queue.push(j); }
    }
  }
  let regionArea = 0;
  for (let i = 0; i < w * h; i++) regionArea += region[i];
  const areaRatio = regionArea / quadArea;
  if (areaRatio < AREA_RATIO_MIN || areaRatio > AREA_RATIO_MAX) {
    return fail("detected area is " + areaRatio.toFixed(2)
                + "x the reference - contrast too low?");
  }

  const dense = traceBoundary(region, w, h);
  if (!dense) return fail("no usable foreground boundary");

  // Refinement at high resolution, exactly the desktop's pass.
  const densePts = dense.map(([x, y]) => [x * upscale, y * upscale]);
  const { pts: refined, confidence } =
    snapToSilhouette(getPixelFull, densePts, pxPerMmRefine);
  if (confidence < MIN_CONFIDENCE) {
    return fail(confidence < 0.05
      ? "no slab edge is visible near your corners - the photo must "
        + "show the slab's actual edges against the background"
      : "only " + Math.round(confidence * 100)
        + "% of the boundary found a colour transition");
  }

  // Base at 1mm detail — what a smoothing slider re-simplifies from, in
  // both directions (the desktop's _outline_base_px).
  const base = simplifyClosed(refined, Math.max(0.5, 1.0 * pxPerMmRefine),
                              512);
  const eps = Math.max(1, simplifyTolMm * pxPerMmRefine);
  const polygon = simplifyClosed(base, eps);
  if (polygon.length < 3) return fail("simplified outline is degenerate");
  return { ok: true, polygon, base, confidence, reason: null };
}

function majority(mask, w, h) {
  const src = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let votes = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny * w + nx]) {
            votes++;
          }
        }
      }
      mask[y * w + x] = votes >= 5 ? 1 : 0;
    }
  }
}

function morph(mask, w, h, dilate) {
  const src = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1 && (dilate ? !hit : hit); dy++) {
        for (let dx = -1; dx <= 1 && (dilate ? !hit : hit); dx++) {
          const nx = x + dx, ny = y + dy;
          const v = (nx < 0 || ny < 0 || nx >= w || ny >= h)
            ? 0 : src[ny * w + nx];
          if (dilate) { if (v) hit = 1; } else if (!v) hit = 0;
        }
      }
      mask[y * w + x] = hit;
    }
  }
}

/** Wrap an ImageData in a clamped bilinear pixel getter. */
export function pixelGetter(imageData) {
  const { data, width, height } = imageData;
  return (x, y) => {
    const cx = Math.max(0, Math.min(width - 1.001, x));
    const cy = Math.max(0, Math.min(height - 1.001, y));
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const fx = cx - x0, fy = cy - y0;
    const i00 = (y0 * width + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + width * 4;
    const i11 = i01 + 4;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      out[c] = data[i00 + c] * (1 - fx) * (1 - fy)
             + data[i10 + c] * fx * (1 - fy)
             + data[i01 + c] * (1 - fx) * fy
             + data[i11 + c] * fx * fy;
    }
    return out;
  };
}
