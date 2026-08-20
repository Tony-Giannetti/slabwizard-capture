/* Desktop-parity detection, orchestrated.
 *
 * The pipeline is core/slab_photo/outline.py: band-seeded cv.grabCut ->
 * dense contour -> area gates (all in js/cv_segment.js, running inside a
 * Web Worker so seconds of WASM compute never freeze the page) -> then
 * here on the main thread the pure-math finish from outline.js: edge-snap
 * refinement, confidence gate, 1 mm base + simplify.
 *
 * opencv.js (~11 MB) loads inside the WORKER on first use — neither its
 * download nor its WASM compile ever touches the UI thread. The service
 * worker's runtime cache keeps it for every use after the first.
 */

import { snapToSilhouette, simplifyClosed } from "./outline.js";
import { diagLog } from "./diag.js";

const MIN_CONFIDENCE = 0.15;       // desktop gate — keep in step
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
      // Staged status ("downloading detector…", "detecting…") — surfaced
      // so a long first run is visibly alive, never a silent hang.
      if (entry.onProgress) entry.onProgress(ev.data.progress);
      return;
    }
    pending.delete(ev.data.id);
    clearTimeout(entry.timer);
    entry.resolve(ev.data);
  };
  worker.onerror = (err) => {
    diagLog("detect: worker error " + (err.message || err));
    // The worker itself died — fail everything in flight and start fresh
    // next time.
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

/** Prove the worker is alive at all before trusting it with a job —
 * a script that failed to parse or load answers nothing, and 5 seconds
 * of silence is a much better failure than a minute of "Detecting…". */
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

async function segmentInWorker(imageData, quad, pxPerMm, onProgress) {
  const w = await pingWorker();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      diagLog("detect: segmentation timed out");
      // A detection that outlives the timeout is wedged — kill the whole
      // worker (there is no way to interrupt WASM) and recover.
      try { w.terminate(); } catch { /* already gone */ }
      worker = null;
      reject(new Error("detection timed out"));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, onProgress });
    // Copy the pixels into a transferable buffer — ownership moves to the
    // worker, nothing is serialised.
    const buf = imageData.data.buffer.slice(0);
    w.postMessage({ id, rgba: buf, width: imageData.width,
                    height: imageData.height, quad, pxPerMm }, [buf]);
  });
}

/**
 * Full detection on a refine-res RGBA raster. Same contract as the pure-JS
 * detectSlabOutline: {ok, polygon, base, confidence, reason} in raster px.
 */
export async function detectSlabOutlineWorker(refine, quadRefine,
                                              pxPerMmRefine,
                                              onProgress = null) {
  const fail = (reason) => ({ ok: false, polygon: null, base: null,
                              confidence: 0, reason });
  const seg = await segmentInWorker(refine, quadRefine, pxPerMmRefine,
                                    onProgress);
  if (!seg.ok) return fail(seg.reason);

  const dense = [];
  for (let i = 0; i < seg.dense.length; i += 2) {
    dense.push([seg.dense[i], seg.dense[i + 1]]);
  }

  const getPixel = rgbaGetter(refine);
  const { pts: refined, confidence } =
    snapToSilhouette(getPixel, dense, pxPerMmRefine);
  if (confidence < MIN_CONFIDENCE) {
    return fail(confidence < 0.05
      ? "no slab edge is visible near your corners - the photo must "
        + "show the slab's actual edges against the background"
      : "only " + Math.round(confidence * 100)
        + "% of the boundary found a colour transition");
  }

  const base = simplifyClosed(refined,
                              Math.max(0.5, 1.0 * pxPerMmRefine), 512);
  if (base.length < 3) return fail("simplified outline is degenerate");
  return { ok: true, polygon: base, base, confidence, reason: null };
}

function rgbaGetter({ data, width, height }) {
  return (x, y) => {
    const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (cy * width + cx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}
