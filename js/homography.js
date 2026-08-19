/* Plane geometry for phone-side rectification.
 *
 * Mirrors the semantics of core/slab_photo (the desktop pipeline):
 * corners in TL(0) TR(1) BR(2) BL(3) placement order; quad measurements
 * are the 4 sides plus the TL–BR diagonal, which determine a planar
 * quadrilateral exactly (5 shape degrees of freedom).
 *
 * All pure math — no DOM, no canvas — so it is testable in isolation.
 */

/**
 * Solve the 3x3 homography H mapping src[i] -> dst[i] (4 points, DLT).
 * @returns {number[]} row-major 9 elements, h22 = 1.
 */
export function solveHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error("need exactly 4 point correspondences");
  }
  // Build the 8x8 system A·h = b for the 8 unknowns of H (h22 = 1).
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error("degenerate corner configuration");
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/** Invert a row-major 3x3 matrix. */
export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular homography");
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** Apply a row-major 3x3 homography to a point. */
export function applyH(m, [x, y]) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w,
          (m[3] * x + m[4] * y + m[5]) / w];
}

/** A rectangle's mm corners, TL TR BR BL, y-down. */
export function rectCorners(widthMm, heightMm) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error("width and height must be positive");
  }
  return [[0, 0], [widthMm, 0], [widthMm, heightMm], [0, heightMm]];
}

/**
 * Reconstruct the TRUE quad from taped measurements (mm):
 * top |01|, right |12|, bottom |23|, left |30|, diagonal |02| (TL–BR).
 *
 * Two triangles hinged on the diagonal, corners placed y-down with the
 * top edge along +x, then translated so the bounding box starts at 0.
 * Throws with an operator-readable message when the tape numbers cannot
 * close (the desktop pipeline refuses the same way).
 */
export function quadCorners({ top, right, bottom, left, diagonal }) {
  for (const [label, v] of Object.entries({ top, right, bottom, left, diagonal })) {
    if (!(v > 0)) throw new Error(`${label} must be a positive distance`);
  }
  const c0 = [0, 0];
  const c1 = [top, 0];
  // c2: |c0-c2| = diagonal, |c1-c2| = right; below the top edge (y > 0).
  const c2 = circleIntersect(c0, diagonal, c1, right, +1);
  // c3: |c0-c3| = left, |c2-c3| = bottom; on the OTHER side of the
  // diagonal from c1, so the polygon is simple.
  const c3a = circleIntersect(c0, left, c2, bottom, +1);
  const c3b = circleIntersect(c0, left, c2, bottom, -1);
  const side = (p) => Math.sign(cross(c0, c2, p));
  const c3 = side(c3a) !== side(c1) ? c3a : c3b;

  // Normalise: bbox to origin.
  const xs = [c0, c1, c2, c3].map((p) => p[0]);
  const ys = [c0, c1, c2, c3].map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const corners = [c0, c1, c2, c3].map(([x, y]) => [x - minX, y - minY]);
  return {
    corners,
    widthMm: Math.max(...xs) - minX,
    heightMm: Math.max(...ys) - minY,
  };
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** One intersection of two circles; sign picks the side. */
function circleIntersect([x0, y0], r0, [x1, y1], r1, sign) {
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) throw new Error("measurements collapse to a point");
  if (d > r0 + r1 + 1e-6 || d < Math.abs(r0 - r1) - 1e-6) {
    throw new Error(
      "these measurements can't form a slab — re-check the diagonal");
  }
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(r0 * r0 - a * a, 0));
  const xm = x0 + (a * dx) / d;
  const ym = y0 + (a * dy) / d;
  return [xm + (sign * -dy * h) / d, ym + (sign * dx * h) / d];
}
