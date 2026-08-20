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

function ensureLoaded() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      importScripts("../vendor/opencv.js", "cv_segment.js");
      let cv = self.cv;
      if (cv && typeof cv.then === "function") {
        cv.then((m) => { self.cv = m; resolve(m); }, reject);
      } else if (cv && typeof cv.grabCut === "function") {
        resolve(cv);
      } else {
        cv.onRuntimeInitialized = () => resolve(cv);
      }
    } catch (err) {
      ready = null;
      reject(err);
    }
  });
  return ready;
}

self.onmessage = async (ev) => {
  const { id, rgba, width, height, quad, pxPerMm } = ev.data;
  try {
    const cv = await ensureLoaded();
    const imageData = { data: new Uint8ClampedArray(rgba), width, height };
    const result = cvSegment(cv, imageData, quad, pxPerMm);
    self.postMessage({ id, ...result });
  } catch (err) {
    self.postMessage({
      id, ok: false, dense: null,
      reason: "could not load the detector ("
              + (err && err.message ? err.message : err) + ")",
    });
  }
};
