/* Slab edge detection on the flattened image.
 *
 * Same idea as the desktop's outline detection (core/slab_photo/outline.py):
 * rectification gives an unusually strong prior — the reference quad maps
 * to a KNOWN polygon in the flattened image, so the slab's true natural
 * edge (broken corners, irregular saw edges) lives in a narrow band around
 * it. Detection is therefore a refinement: sample points along the quad,
 * march each one along its normal from the background inward, and snap to
 * the colour transition. A proposal, never an authority — the operator
 * drags the points afterwards.
 *
 * Pure functions over a pixel getter, so the geometry is testable without
 * a canvas.
 */

/** Perpendicular distance from p to segment a-b. */
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Douglas-Peucker polyline simplification (open path). */
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

/** Closed-polygon simplification: keeps it closed, caps the point count. */
export function simplifyClosed(points, epsilon, maxPoints = 96) {
  let out = simplify([...points, points[0]], epsilon).slice(0, -1);
  while (out.length > maxPoints) {
    epsilon *= 1.5;
    out = simplify([...out, out[0]], epsilon).slice(0, -1);
  }
  return out;
}

const centroidOf = (quad) => [
  quad.reduce((s, p) => s + p[0], 0) / quad.length,
  quad.reduce((s, p) => s + p[1], 0) / quad.length,
];

/** Evenly spaced samples along a polygon's perimeter with outward normals. */
export function perimeterSamples(quad, spacing) {
  const c = centroidOf(quad);
  const samples = [];
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(len / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      // Edge normal; flip it to point AWAY from the centroid.
      let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      if (nx * (p[0] - c[0]) + ny * (p[1] - c[1]) < 0) { nx = -nx; ny = -ny; }
      samples.push({ p, n: [nx, ny] });
    }
  }
  return samples;
}

const dist2 = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
};

/**
 * Detect the slab's edge.
 *
 * @param {function} getPixel  (x, y) -> [r, g, b] (clamped at borders)
 * @param {Array} quad     the slab's expected polygon, image px
 * @param {object} opts    bandOut/bandIn px, threshold (colour distance),
 *                         spacing px between perimeter samples
 * @returns {Array<[x,y]>|null}  simplified closed outline, or null when
 *          no usable edge was found.
 */
export function detectOutline(getPixel, quad, {
  bandOut = 24, bandIn = 24, threshold = 42, spacing = 8,
} = {}) {
  const samples = perimeterSamples(quad, spacing);
  if (samples.length < 8) return null;

  // Background colour model: the median of what sits just OUTSIDE the
  // quad — in the flattened image that is the margin, whose look we
  // control (the warp fills it with the app background) plus whatever
  // real surroundings the photo had.
  const bg = medianColor(samples.map(({ p, n }) =>
    getPixel(p[0] + n[0] * bandOut, p[1] + n[1] * bandOut)));

  const t2 = threshold * threshold;
  const out = [];
  let hits = 0;
  for (const { p, n } of samples) {
    let found = null;
    // March from outside in; the first SUSTAINED non-background run is
    // the slab's edge (single-pixel noise doesn't count).
    for (let d = bandOut; d >= -bandIn; d -= 1) {
      const x = p[0] + n[0] * d, y = p[1] + n[1] * d;
      if (dist2(getPixel(x, y), bg) > t2
          && dist2(getPixel(x - n[0] * 2, y - n[1] * 2), bg) > t2) {
        found = [x, y];
        break;
      }
    }
    if (found) hits += 1;
    // No transition found: the edge is exactly on (or beyond) the quad —
    // fall back to the quad point itself, like the desktop's fallback.
    out.push(found || p);
  }
  // Sanity gate: if barely anything snapped, there is no real contrast
  // to work with — better to say so than to hand back noise.
  if (hits < samples.length * 0.35) return null;
  return simplifyClosed(out, 1.6);
}

function medianColor(colors) {
  const channel = (i) => {
    const vals = colors.map((c) => c[i]).sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  return [channel(0), channel(1), channel(2)];
}

/** Wrap an ImageData in a clamped pixel getter. */
export function pixelGetter(imageData) {
  const { data, width, height } = imageData;
  return (x, y) => {
    const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (cy * width + cx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}
