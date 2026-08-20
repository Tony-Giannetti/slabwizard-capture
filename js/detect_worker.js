/* Detection Web Worker — U2-Net on ONNX Runtime (WASM).
 *
 * Chosen over the previous cv.grabCut after a head-to-head on real yard
 * slab photos: the 4.6 MB salient-object net traced every slab cleanly
 * (glare wash, tone-on-tone backgrounds, rough rims) where colour
 * statistics bit chunks out of the stone — and it is faster.
 *
 * Runs off-thread so the load (~18 MB, first use only, then cached by the
 * service worker) and the inference never freeze the page. Protocol:
 * {id, rgba, width, height} in (buffer transferred), {id, prob} out —
 * a 320x320 Float32Array of slab probability. Geometry (masking, prior,
 * contour, refinement) happens on the main thread in outline*.js.
 */

/* global ort, segnetPre */

let sessionPromise = null;

function ensureSession(id) {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    self.postMessage({ id, progress: "downloading detector…" });
    importScripts("../vendor/ort/ort.wasm.min.js", "segnet_pre.js");
    // GitHub Pages sends no COOP/COEP headers, so no SharedArrayBuffer:
    // run the WASM single-threaded (onnxruntime falls back cleanly).
    ort.env.wasm.wasmPaths = "../vendor/ort/";
    ort.env.wasm.numThreads = 1;
    self.postMessage({ id, progress: "starting detector…" });
    const session = await ort.InferenceSession.create(
      "../vendor/u2netp.onnx", { executionProviders: ["wasm"] });
    return session;
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

self.onmessage = async (ev) => {
  if (ev.data && ev.data.type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }
  if (ev.data && ev.data.type === "warm") {
    // Pre-load runtime + model while the operator marks corners.
    try { await ensureSession(0); } catch { /* Detect will report it */ }
    return;
  }
  const { id, rgba, width, height } = ev.data;
  try {
    const session = await ensureSession(id);
    self.postMessage({ id, progress: "detecting…" });
    const { tensor, size } = segnetPre.preprocess(
      new Uint8ClampedArray(rgba), width, height);
    const input = new ort.Tensor("float32", tensor, [1, 3, size, size]);
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const raw = outputs[session.outputNames[0]].data;
    const prob = segnetPre.normaliseProb(raw);
    self.postMessage({ id, ok: true, prob: prob.buffer, size },
                     [prob.buffer]);
  } catch (err) {
    sessionPromise = null;
    self.postMessage({
      id, ok: false, prob: null,
      reason: "could not run the detector ("
              + (err && err.message ? err.message : err) + ")",
    });
  }
};
