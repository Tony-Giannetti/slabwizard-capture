/* Detection Web Worker.
 *
 * The GrabCut stage costs seconds of solid compute plus an 11 MB WASM
 * compile on first use — on the UI thread that reads as "the app froze".
 * Here it runs off-thread: the page stays live, and a hung detection can
 * be terminated instead of hanging the phone.
 *
 * Classic worker (importScripts), because opencv.js is a UMD script.
 * Protocol: {rgba, width, height, quad, pxPerMm} in (buffer transferred),
 * {ok, dense, reason} out. The pure-math refinement (edge snap, gates,
 * simplify) runs back on the main thread — it is milliseconds.
 */

/* global cvSegment */

let ready = null;

function ensureLoaded(id) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      self.postMessage({ id, progress: "downloading detector…" });
      importScripts("../vendor/opencv.js", "cv_segment.js");
      self.postMessage({ id, progress: "starting detector…" });
      const t0 = Date.now();
      // POLL for readiness rather than trusting onRuntimeInitialized:
      // if the runtime finished initialising before the callback is
      // attached, the callback never fires and the app hangs on
      // "Detecting…" forever. Polling cannot race.
      const settle = () => {
        let cv = self.cv;
        if (cv && typeof cv.then === "function") {
          cv.then((m) => { self.cv = m; resolve(m); }, reject);
          return;
        }
        if (cv && typeof cv.grabCut === "function") {
          resolve(cv);
          return;
        }
        if (Date.now() - t0 > 90_000) {
          reject(new Error("detector runtime never became ready"));
          return;
        }
        setTimeout(settle, 100);
      };
      settle();
    } catch (err) {
      ready = null;
      reject(err);
    }
  });
  return ready;
}

self.onmessage = async (ev) => {
  if (ev.data && ev.data.type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }
  const { id, rgba, width, height, quad, pxPerMm } = ev.data;
  try {
    const cv = await ensureLoaded(id);
    self.postMessage({ id, progress: "detecting…" });
    const imageData = { data: new Uint8ClampedArray(rgba), width, height };
    const result = cvSegment(cv, imageData, quad, pxPerMm);
    self.postMessage({ id, ...result });
  } catch (err) {
    ready = null;
    self.postMessage({
      id, ok: false, dense: null,
      reason: "could not load the detector ("
              + (err && err.message ? err.message : err) + ")",
    });
  }
};
