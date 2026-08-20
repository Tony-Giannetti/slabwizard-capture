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
  // Douglas-Peucker can fold a simple polygon into a crossing; every
  // simplify (detection AND the Smooth slider) ends untangled.
  return out.length >= 5 ? removeLoops(out) : out;
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
export function fillPolygon(quad, w, h) {
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

/** Fill internal holes: flood the OUTSIDE from the raster border; any
 * zero pixel the flood never reaches is enclosed by the region. A holey
 * mask hands the tracer a fractal boundary. */
export function fillHoles(region, w, h) {
  const outside = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!region[i] && !outside[i]) { outside[i] = 1; queue.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const i = queue.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  for (let i = 0; i < w * h; i++) {
    if (!region[i] && !outside[i]) region[i] = 1;
  }
}

/** Boundary of a binary region via MARCHING SQUARES — the previous
 * Moore-neighbour walk emitted paths with dozens of self-intersections
 * (the "scribble" outlines seen in the field: 91 crossings in one
 * 96-point polygon). Marching squares yields simple closed loops by
 * construction; the longest loop is the outline. Dense midpoint vertices,
 * ordered. */
export function traceBoundary(region, w, h) {
  const at = (x, y) =>
    (x >= 0 && y >= 0 && x < w && y < h && region[y * w + x]) ? 1 : 0;
  // For each cell (corner-sampled 2x2), the case index picks the crossing
  // segments. Segment endpoints are edge midpoints in pixel coords.
  const segsFor = (x, y) => {
    const tl = at(x, y), tr = at(x + 1, y);
    const bl = at(x, y + 1), br = at(x + 1, y + 1);
    const idx = tl * 8 + tr * 4 + br * 2 + bl;
    const T = [x + 0.5, y], R = [x + 1, y + 0.5];
    const B = [x + 0.5, y + 1], L = [x, y + 0.5];
    switch (idx) {
      case 1: return [[B, L]];
      case 2: return [[R, B]];
      case 3: return [[R, L]];
      case 4: return [[T, R]];
      case 5: return [[T, R], [B, L]];      // saddle
      case 6: return [[T, B]];
      case 7: return [[T, L]];
      case 8: return [[L, T]];
      case 9: return [[B, T]];
      case 10: return [[L, T], [R, B]];     // saddle
      case 11: return [[R, T]];
      case 12: return [[L, R]];
      case 13: return [[B, R]];
      case 14: return [[L, B]];
      default: return [];
    }
  };
  // Collect all segments keyed by start point, then chain into loops.
  const key = (p) => p[0] * 2 + "," + p[1] * 2;
  const byStart = new Map();
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      for (const [a, b] of segsFor(x, y)) {
        byStart.set(key(a), { a, b, used: false });
      }
    }
  }
  let best = null;
  for (const seg of byStart.values()) {
    if (seg.used) continue;
    const loop = [];
    let cur = seg;
    while (cur && !cur.used) {
      cur.used = true;
      loop.push(cur.a);
      cur = byStart.get(key(cur.b));
    }
    if (loop.length >= 8 && (!best || loop.length > best.length)) {
      best = loop;
    }
  }
  return best;
}

/** Resample a closed polyline to uniform arc-length spacing. The traced
 * contour has ~half-pixel point spacing; snapping points that close
 * together folds the polygon (neighbouring normals disagree more than the
 * spacing can absorb). */
export function resampleClosed(pts, spacing) {
  const n = pts.length;
  let perimeter = 0;
  const lens = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(l);
    perimeter += l;
  }
  const count = Math.max(16, Math.round(perimeter / spacing));
  const step = perimeter / count;
  const out = [];
  let seg = 0, into = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (into + lens[seg] < target) { into += lens[seg]; seg = (seg + 1) % n; }
    const a = pts[seg], b = pts[(seg + 1) % n];
    const t = lens[seg] ? (target - into) / lens[seg] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Remove self-intersections by cutting out the smaller of the two loops
 * a crossing creates. Snap offsets are local, so folds are local — a few
 * cuts restore a simple polygon without moving the true edge. */
export function removeLoops(poly, maxPasses = 24) {
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let pts = poly.slice();
  for (let pass = 0; pass < maxPasses; pass++) {
    const n = pts.length;
    if (n < 5) break;
    let cut = null;
    outer:
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        if (cross(a, b, c) * cross(a, b, d) < 0
            && cross(c, d, a) * cross(c, d, b) < 0) {
          cut = [i, j];
          break outer;
        }
      }
    }
    if (!cut) return pts;
    const [i, j] = cut;
    const inner = j - i;                       // points strictly inside
    if (inner <= n - inner) {
      pts = pts.slice(0, i + 1).concat(pts.slice(j + 1));
    } else {
      pts = pts.slice(i + 1, j + 1);
    }
  }
  return pts;
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
  // An INVALID ray means "no edge evidence here" — black-on-black, glare,
  // a sheen the segmentation mistook for background. Keeping offset 0
  // there preserves the segmentation's WRONG boundary (the bite carved
  // out of a glossy black cover). Instead, bridge invalid runs by
  // interpolating the offset field between the nearest VALID rays on
  // either side (circular): where there is no evidence, the evidenced
  // neighbours speak for the edge.
  interpolateInvalid(offsets, valid);

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
  return { pts: refined, confidence: hits / n, valid };
}

/** Linear circular interpolation of `offsets` across runs of invalid
 * rays, anchored on the valid rays either side. All-invalid → zeros. */
function interpolateInvalid(offsets, valid) {
  const n = offsets.length;
  let anyValid = false;
  for (let i = 0; i < n; i++) if (valid[i]) { anyValid = true; break; }
  if (!anyValid) return;
  let i = 0;
  while (i < n) {
    if (valid[i]) { i++; continue; }
    // Run of invalid [i .. j-1]; prev/next valid circularly.
    let j = i;
    while (j < n && !valid[j]) j++;
    const prev = (i - 1 + n) % n;
    const next = j % n;
    const runLen = j - i;
    for (let k = 0; k < runLen; k++) {
      const t = (k + 1) / (runLen + 1);
      offsets[i + k] = offsets[prev] * (1 - t) + offsets[next] * t;
    }
    i = j;
  }
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

  fillHoles(region, w, h);
  const dense = traceBoundary(region, w, h);
  if (!dense) return fail("no usable foreground boundary");

  const densePts = dense.map(([x, y]) => [x * upscale, y * upscale]);
  const quadRefine = quadSmall.map(([x, y]) => [x * upscale, y * upscale]);
  const refined = refineContour(getPixelFull, densePts, pxPerMmRefine,
                                quadRefine);
  if (!refined.ok) return fail(refined.reason);

  const eps = Math.max(1, simplifyTolMm * pxPerMmRefine);
  const polygon = simplifyClosed(refined.base, eps);
  if (polygon.length < 3) return fail("simplified outline is degenerate");
  return { ok: true, polygon, base: refined.base,
           confidence: refined.confidence, reason: null };
}

/**
 * The shared contour finishing pass, used by BOTH detectors (WASM GrabCut
 * and the pure-JS fallback): uniform resampling, edge-snap with reach
 * scaled to the piece, circular smoothing, loop removal, confidence gate,
 * and the 1 mm detail base for the Smooth slider.
 *
 * Order matters, and each stage exists because of an observed failure:
 * sub-pixel point spacing folded the polygon at the snap stage (91
 * self-crossings in one field capture), and a 45 mm snap reach on a
 * 200 mm test piece let single rays teleport across the object.
 */
export function refineContour(getPixel, densePts, pxPerMmRefine,
                              quadPx = null, { reachMm = null } = {}) {
  const fail = (reason) => ({ ok: false, base: null, confidence: 0, reason });

  // Uniform spacing: ~4px between points, bounded count.
  const evenly = resampleClosed(densePts, 4);

  // Snap reach scaled to the piece: never more than 15% of the short side.
  const xs = evenly.map((p) => p[0]), ys = evenly.map((p) => p[1]);
  const shortSideMm = Math.min(Math.max(...xs) - Math.min(...xs),
                               Math.max(...ys) - Math.min(...ys))
                      / pxPerMmRefine;
  const reach = reachMm !== null ? reachMm
                                 : Math.max(4, shortSideMm * 0.15);
  const { pts: snapped, confidence, valid } = snapToSilhouette(
    getPixel, evenly, pxPerMmRefine,
    Math.min(REFINE_IN_MM, reach), Math.min(REFINE_OUT_MM, reach));

  if (confidence < MIN_CONFIDENCE) {
    return fail(confidence < 0.05
      ? "no slab edge is visible near your corners - the photo must "
        + "show the slab's actual edges against the background"
      : "only " + Math.round(confidence * 100)
        + "% of the boundary found a colour transition");
  }

  // PRIOR ENFORCEMENT. Segmentation carves "bites" out of glossy pieces
  // wherever sheen resembles the background (observed on a black book —
  // and the desktop pipeline does the very same). Ray validity tells us
  // which contour points carry actual edge evidence; a point WITHOUT
  // evidence that dives deeper into the reference quad than its
  // evidenced neighbours is the segmentation guessing — delete it, and
  // let the contour reconnect straight between evidenced anchors.
  let kept = snapped;
  if (quadPx && snapped.length > 8) {
    const depth = snapped.map((p) => inwardDepth(p, quadPx) / pxPerMmRefine);
    const n = snapped.length;
    const tolMm = 6;
    kept = snapped.filter((p, i) => {
      if (valid[i]) return true;
      // Nearest valid neighbours' depth, circularly.
      let before = i, after = i;
      for (let s = 1; s < n; s++) {
        const b = (i - s + n) % n;
        if (valid[b]) { before = b; break; }
      }
      for (let s = 1; s < n; s++) {
        const a = (i + s) % n;
        if (valid[a]) { after = a; break; }
      }
      const anchor = Math.max(depth[before], depth[after]);
      return depth[i] <= anchor + tolMm;
    });
    if (kept.length < 8) kept = snapped;   // pathological — keep evidence
  }

  // Any residual folds are local — cut them out, then build the detail
  // base the Smooth slider re-simplifies from (desktop's 1mm base).
  const untangled = removeLoops(kept);
  const base = simplifyClosed(untangled,
                              Math.max(0.5, 1.0 * pxPerMmRefine), 512);
  if (base.length < 3) return fail("refined outline is degenerate");
  return { ok: true, base, confidence, reason: null };
}

/** Depth of a point INSIDE a polygon (px): 0 outside, else the distance
 * to the nearest edge. */
function inwardDepth(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1])
        && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  if (!inside) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2
      ? Math.max(0, Math.min(1,
          ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
      : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx),
                                     p[1] - (a[1] + t * dy)));
  }
  return best;
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


/**
 * Finisher for NEURAL masks. The net's boundary is already accurate and
 * smooth — the edge-snap built for GrabCut's colour bias only adds
 * wobble here. What the net DOES get wrong is shadow: it carves bites
 * where the slab falls into deep shade. The reference quad already
 * declares where the edge lives, so enforce it as a corridor: contour
 * points farther from the quad's BOUNDARY than ~60% of the search band
 * are not edge, and are cut (the contour reconnects straight across).
 * Rays are still fired — but only as EVIDENCE for the confidence gate,
 * never to move points.
 */
export function finishNeuralContour(getPixel, densePts, pxPerMmRefine,
                                    quadPx) {
  const fail = (reason) => ({ ok: false, base: null, confidence: 0, reason });

  const evenly = resampleClosed(densePts, 4);
  const xs = quadPx.map((q) => q[0]), ys = quadPx.map((q) => q[1]);
  const shortSideMm = Math.min(Math.max(...xs) - Math.min(...xs),
                               Math.max(...ys) - Math.min(...ys))
                      / pxPerMmRefine;
  const bandMm = Math.min(100, Math.max(10, shortSideMm * 0.25));
  const corridorMm = bandMm * 0.45;

  // Corridor clamp against the quad boundary (either side of it) — cuts
  // shadow bites the net carves into dark slabs. SAFETY: corners more
  // than slightly off would make the corridor amputate real edge, so if
  // it wants to remove more than a quarter of the contour, trust the
  // net's boundary instead and skip the clamp.
  const corridorPx = corridorMm * pxPerMmRefine;
  let kept = evenly.filter((p) => distToPolyEdge(p, quadPx) <= corridorPx);
  if (kept.length < evenly.length * 0.75 || kept.length < 8) {
    kept = evenly;
  }

  // Evidence-only confidence (no movement): same ray test as the snap.
  const probe = snapToSilhouette(getPixel, kept, pxPerMmRefine, 8,
                                 Math.min(20, bandMm * 0.3));
  if (probe.confidence < MIN_CONFIDENCE) {
    return fail(probe.confidence < 0.05
      ? "no slab edge is visible near your corners - the photo must "
        + "show the slab's actual edges against the background"
      : "only " + Math.round(probe.confidence * 100)
        + "% of the boundary found a colour transition");
  }

  // Shadow bites are canyons — deep, narrow concavities the net carves
  // where a slab falls into shade. Bridge those; keep real features.
  const bridged = bridgeCanyons(kept);

  // Light smoothing (window 3) to sand the resample steps, then the 1mm
  // Smooth base. No snap displacement.
  const n = bridged.length;
  const smoothed = bridged.map((p, i) => {
    const a = bridged[(i - 1 + n) % n], b = bridged[(i + 1) % n];
    return [(a[0] + p[0] * 2 + b[0]) / 4, (a[1] + p[1] * 2 + b[1]) / 4];
  });
  const base = simplifyClosed(removeLoops(smoothed),
                              Math.max(0.5, 1.0 * pxPerMmRefine), 512);
  if (base.length < 3) return fail("refined outline is degenerate");
  return { ok: true, base, confidence: probe.confidence, reason: null };
}

/** Distance from a point to the nearest edge of a polygon (px). */
function distToPolyEdge(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2
      ? Math.max(0, Math.min(1,
          ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
      : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx),
                                     p[1] - (a[1] + t * dy)));
  }
  return best;
}


/**
 * Bridge deep-and-narrow concavities. A shadow bite is a canyon: it cuts
 * far into the shape through a narrow mouth. Real slab features — clipped
 * corners, edge chips — are wide and shallow. Walk the convex hull; for
 * each concave chain between hull vertices, bridge it straight when its
 * depth exceeds its mouth width, keep it when it is a genuine shape
 * feature.
 */
export function bridgeCanyons(poly, depthOverWidth = 0.75) {
  if (poly.length < 5) return poly;
  const hull = convexHullIndices(poly);
  if (hull.length < 3) return poly;
  const out = [];
  for (let k = 0; k < hull.length; k++) {
    const i = hull[k], j = hull[(k + 1) % hull.length];
    const a = poly[i], b = poly[j];
    out.push(a);
    const chain = [];
    for (let s = (i + 1) % poly.length; s !== j; s = (s + 1) % poly.length) {
      chain.push(poly[s]);
    }
    if (!chain.length) continue;
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let depth = 0;
    for (const p of chain) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - p[1])
                       - (a[0] - p[0]) * (b[1] - a[1])) / Math.max(1e-9, width);
      depth = Math.max(depth, d);
    }
    if (depth <= width * depthOverWidth) {
      out.push(...chain);          // legitimate concave feature — keep
    }
    // else: bridged — the hull edge a->b replaces the canyon
  }
  return out;
}

/** Indices of the convex hull of a polygon, in polygon order. */
function convexHullIndices(poly) {
  const idx = poly.map((_, i) => i);
  idx.sort((p, q) => poly[p][0] - poly[q][0] || poly[p][1] - poly[q][1]);
  const cross = (o, a, b) =>
    (poly[a][0] - poly[o][0]) * (poly[b][1] - poly[o][1])
    - (poly[a][1] - poly[o][1]) * (poly[b][0] - poly[o][0]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2
           && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) {
      lower.pop();
    }
    lower.push(i);
  }
  const upper = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2
           && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) {
      upper.pop();
    }
    upper.push(i);
  }
  const hullSet = new Set(lower.slice(0, -1).concat(upper.slice(0, -1)));
  // Return in POLYGON order so chains between hull points are walkable.
  return poly.map((_, i) => i).filter((i) => hullSet.has(i));
}
