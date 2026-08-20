/* U2-Net preprocessing — plain UMD script so the SAME code runs in the
 * detection Web Worker (importScripts) and in node tests (require).
 *
 * The network eats 320x320 RGB, ImageNet-normalised, NCHW float32. Chosen
 * over GrabCut after a head-to-head on real yard slab photos: the 4.6 MB
 * net traced every slab cleanly - through glare wash and tone-on-tone
 * backgrounds - where colour statistics bit chunks out of the stone.
 */
(function (root) {
  "use strict";

  var SIZE = 320;
  var MEAN = [0.485, 0.456, 0.406];
  var STD = [0.229, 0.224, 0.225];

  /** RGBA raster -> {tensor: Float32Array NCHW, size} */
  function preprocess(data, width, height) {
    var out = new Float32Array(3 * SIZE * SIZE);
    var plane = SIZE * SIZE;
    for (var y = 0; y < SIZE; y++) {
      var sy = ((y + 0.5) * height) / SIZE - 0.5;
      var y0 = Math.max(0, Math.floor(sy));
      var y1 = Math.min(height - 1, y0 + 1);
      var fy = Math.min(1, Math.max(0, sy - y0));
      for (var x = 0; x < SIZE; x++) {
        var sx = ((x + 0.5) * width) / SIZE - 0.5;
        var x0 = Math.max(0, Math.floor(sx));
        var x1 = Math.min(width - 1, x0 + 1);
        var fx = Math.min(1, Math.max(0, sx - x0));
        var i00 = (y0 * width + x0) * 4;
        var i10 = (y0 * width + x1) * 4;
        var i01 = (y1 * width + x0) * 4;
        var i11 = (y1 * width + x1) * 4;
        var o = y * SIZE + x;
        for (var c = 0; c < 3; c++) {
          var v = data[i00 + c] * (1 - fx) * (1 - fy)
                + data[i10 + c] * fx * (1 - fy)
                + data[i01 + c] * (1 - fx) * fy
                + data[i11 + c] * fx * fy;
          out[c * plane + o] = (v / 255 - MEAN[c]) / STD[c];
        }
      }
    }
    return { tensor: out, size: SIZE };
  }

  /** Min-max normalise the raw net output into 0..1 probabilities. */
  function normaliseProb(raw) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] < lo) lo = raw[i];
      if (raw[i] > hi) hi = raw[i];
    }
    var span = Math.max(1e-6, hi - lo);
    var out = new Float32Array(raw.length);
    for (i = 0; i < raw.length; i++) out[i] = (raw[i] - lo) / span;
    return out;
  }

  root.segnetPre = { preprocess: preprocess, normaliseProb: normaliseProb,
                     SIZE: SIZE };
})(typeof self !== "undefined" ? self : globalThis);
