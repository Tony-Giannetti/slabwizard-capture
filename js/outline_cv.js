/* Neural detection, orchestrated.
 *
 * The worker (detect_worker.js) runs U2-Net on ONNX Runtime and returns a
 * 320x320 slab-probability map. Everything geometric happens here on the
 * main thread, in milliseconds: threshold, the band prior from the
 * reference quad, largest connected region, hole fill, marching-squares
 * trace, the desktop's area gates, then outline.js's shared refinement
 * (edge-snap with evidence rules, loop removal, the 1 mm Smooth base).
 *
 * Chosen over cv.grabCut after a head-to-head on real yard slab photos —
 * cleaner silhouettes through glare and tone-on-tone backgrounds, smaller
 * download, faster solve.
 */

import { finishNeuralContour, fillHoles, fillPolygon, traceBoundary }
  from "./outline.js";
import { diagLog } from "./diag.js";

// Desktop gates — keep in step with core/slab_photo/outline.py.
const AREA_RATIO_MIN = 0.70;
const AREA_RATIO_MAX = 1.20;

const WORKER_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

let worker = null;
let nextId = 1;
const pending = new Map();

let pongSeen = false;

function getWorker() {
  if (worker) return worker;
  diagLog("detect: creating worker");
  pongSeen = false;
  worker = new Worker("js/detect_worker.js");
  worker.onmessage = (ev) => {
    if (ev.data && ev.data.type === "pong") { pongSeen = true; return; }
    const entry = pending.get(ev.data.id);
    if (!entry) return;
    if (ev.data.progress) {
      if (entry.onProgress) entry.onProgress(ev.data.progress);
      return;
    }
    pending.delete(ev.data.id);
    clearTimeout(entry.timer);
    entry.resolve(ev.data);
  };
  worker.onerror = (err) => {
    diagLog("detect: worker error " + (err.message || err));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("detector crashed: " + (err.message || err)));
    }
    pending.clear();
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
  };
  return worker;
}

async function pingWorker() {
  const w = getWorker();
  if (pongSeen) return w;
  w.postMessage({ type: "ping" });
  const t0 = Date.now();
  while (!pongSeen) {
    if (Date.now() - t0 > PING_TIMEOUT_MS) {
      diagLog("detect: worker never answered ping");
      try { w.terminate(); } catch { /* gone */ }
      worker = null;
      throw new Error("detector worker is not responding");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  diagLog("detect: worker alive");
  return w;
}

/** Start the runtime + model loading NOW (fire-and-forget), so Detect
 * starts at the inference rather than the download. */
export function warmDetector() {
  try {
    getWorker().postMessage({ type: "warm" });
  } catch { /* the Detect path will report it */ }
}

function inferInWorker(imageData, onProgress) {
  return new Promise((resolve, reject) => {
    const start = () => {
      const id = nextId++;
      const w = worker;
      const entry = { resolve, reject, onProgress: null, timer: null };
      const arm = (ms) => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          pending.delete(id);
          diagLog("detect: stage timed out");
          try { w.terminate(); } catch { /* already gone */ }
          worker = null;
          reject(new Error("detection timed out"));
        }, ms);
      };
      entry.onProgress = (stage) => {
        diagLog("detect: stage " + stage);
        arm(WORKER_TIMEOUT_MS);
        if (onProgress) onProgress(stage);
      };
      arm(WORKER_TIMEOUT_MS);
      pending.set(id, entry);
      const buf = imageData.data.buffer.slice(0);
      w.postMessage({ id, rgba: buf, width: imageData.width,
                      height: imageData.height }, [buf]);
    };
    pingWorker().then(start, reject);
  });
}

/**
 * Full detection on a refine-res RGBA raster. Same contract as the
 * pure-JS detectSlabOutline: {ok, polygon, base, confidence, reason} in
 * raster px.
 */
export async function detectSlabOutlineWorker(refine, quadRefine,
                                              pxPerMmRefine,
                                              onProgress = null) {
  const fail = (reason) => ({ ok: false, polygon: null, base: null,
                              confidence: 0, reason });
  const result = await inferInWorker(refine, onProgress);
  if (!result.ok) return fail(result.reason);

  const S = result.size;
  const prob = new Float32Array(result.prob);

  // Mask in net space, constrained by the band prior: the slab lies
  // within the quad dilated by the band — anything the net lights up
  // beyond that (ground clutter, the next slab on the rack) is not ours.
  const kx = S / refine.width, ky = S / refine.height;
  const quadNet = quadRefine.map(([x, y]) => [x * kx, y * ky]);
  const xs = quadNet.map((q) => q[0]), ys = quadNet.map((q) => q[1]);
  const shortSideNet = Math.min(Math.max(...xs) - Math.min(...xs),
                                Math.max(...ys) - Math.min(...ys));
  const bandNet = Math.max(3, Math.round(shortSideNet * 0.25));
  const quadMask = fillPolygon(quadNet, S, S);
  const allowed = dilate(quadMask, S, S, bandNet);

  const mask = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    mask[i] = prob[i] > 0.5 && allowed[i] ? 1 : 0;
  }

  // Largest component seeded from the quad's interior.
  const region = largestFromSeed(mask, quadMask, S, S);
  if (!region) return fail("the detector found no slab inside your corners");
  fillHoles(region, S, S);

  // Desktop area gate, in net space.
  let regionArea = 0, quadArea = 0;
  for (let i = 0; i < S * S; i++) {
    regionArea += region[i];
    quadArea += quadMask[i];
  }
  const areaRatio = quadArea ? regionArea / quadArea : 0;
  if (areaRatio < AREA_RATIO_MIN || areaRatio > AREA_RATIO_MAX) {
    return fail("detected area is " + areaRatio.toFixed(2)
                + "x the reference - check the corners");
  }

  const dense = traceBoundary(region, S, S);
  if (!dense) return fail("no usable slab boundary");

  // Back to refine resolution, then the shared finishing pass.
  const densePts = dense.map(([x, y]) => [x / kx, y / ky]);
  const refined = finishNeuralContour(rgbaGetter(refine), densePts,
                                      pxPerMmRefine, quadRefine);
  if (!refined.ok) return fail(refined.reason);
  return { ok: true, polygon: refined.base, base: refined.base,
           confidence: refined.confidence, reason: null };
}

/** Chebyshev dilation via two-pass chamfer-ish sweep (cheap at 320px). */
function dilate(mask, w, h, radius) {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) d = Math.min(d, dist[i - w] + 1);
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) d = Math.min(d, dist[i + w] + 1);
      dist[i] = d;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = dist[i] <= radius ? 1 : 0;
  return out;
}

/** The connected component of `mask` overlapping the seed mask. */
function largestFromSeed(mask, seed, w, h) {
  const region = new Uint8Array(w * h);
  const queue = [];
  for (let i = 0; i < w * h; i++) {
    if (seed[i] && mask[i] && !region[i]) {
      region[i] = 1;
      queue.push(i);
    }
  }
  if (!queue.length) return null;
  while (queue.length) {
    const i = queue.pop();
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j] && !region[j]) {
        region[j] = 1;
        queue.push(j);
      }
    }
  }
  return region;
}

function rgbaGetter({ data, width, height }) {
  return (x, y) => {
    const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (cy * width + cx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}
