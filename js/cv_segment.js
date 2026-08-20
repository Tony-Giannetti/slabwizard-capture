/* GrabCut segmentation stage — plain script, no module system.
 *
 * Written UMD-style so the SAME code runs in the detection Web Worker
 * (via importScripts) and in node tests (via require). This is the first
 * half of core/slab_photo/outline.py::detect_slab_outline: band-seeded
 * cv.grabCut -> largest contour -> area gates -> DENSE boundary. The
 * second half (edge-snap refinement, confidence gate, simplify) is pure
 * math and runs on the caller's side (js/outline.js).
 */
(function (root) {
  "use strict";

  // Desktop gates (outline.py) — keep in step with outline_cv.js.
  var AREA_RATIO_MIN = 0.70;
  var AREA_RATIO_MAX = 1.20;
  var MAX_DIM_PX = 500;
  var GRABCUT_ITERS = 3;

  function polyArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  /**
   * @param {object} cv     opencv.js module (runtime-ready)
   * @param {object} rgba   {data: Uint8ClampedArray, width, height}
   * @param {Array} quadPx  reference quad in raster px
   * @param {number} pxPerMm  raster px per mm
   * @param {number} bandMm   band half-width (desktop default 100)
   * @returns {{ok, dense, reason, areaRatio}} dense boundary in raster px
   */
  function cvSegment(cv, rgba, quadPx, pxPerMm, bandMm) {
    bandMm = bandMm || 100;
    var mats = [];
    function track(m) { mats.push(m); return m; }
    function fail(reason) {
      return { ok: false, dense: null, reason: reason, areaRatio: 0 };
    }
    try {
      var full = track(cv.matFromImageData(rgba));
      var scale = Math.min(1, MAX_DIM_PX / Math.max(full.rows, full.cols));
      var small = track(new cv.Mat());
      if (scale < 1) {
        cv.resize(full, small,
                  new cv.Size(Math.max(1, Math.round(full.cols * scale)),
                              Math.max(1, Math.round(full.rows * scale))),
                  0, 0, cv.INTER_AREA);
      } else {
        full.copyTo(small);
      }
      var rgb = track(new cv.Mat());
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      var smW = rgb.cols, smH = rgb.rows;

      var quad = quadPx.map(function (q) { return [q[0] * scale, q[1] * scale]; });
      var quadArea = polyArea(quad);
      if (quadArea <= 0) return fail("reference quad is degenerate");

      var ppmSmall = pxPerMm * scale;
      var xs = quad.map(function (q) { return q[0]; });
      var ys = quad.map(function (q) { return q[1]; });
      var shortSideMm = Math.min(Math.max.apply(null, xs) - Math.min.apply(null, xs),
                                 Math.max.apply(null, ys) - Math.min.apply(null, ys))
                        / ppmSmall;
      var effBandMm = Math.min(bandMm, Math.max(10, shortSideMm * 0.25));
      var bandPx = Math.max(2, Math.round(effBandMm * ppmSmall));
      var borderRoom = Infinity;
      for (var i = 0; i < quad.length; i++) {
        borderRoom = Math.min(borderRoom, quad[i][0], quad[i][1],
                              smW - quad[i][0], smH - quad[i][1]);
      }
      var outBandPx = Math.min(bandPx, Math.max(2, Math.floor(borderRoom * 0.6)));

      var quadMask = track(cv.Mat.zeros(smH, smW, cv.CV_8UC1));
      var flat = [];
      for (i = 0; i < quad.length; i++) {
        flat.push(Math.round(quad[i][0]), Math.round(quad[i][1]));
      }
      var quadPts = track(cv.matFromArray(quad.length, 1, cv.CV_32SC2, flat));
      var vec = track(new cv.MatVector());
      vec.push_back(quadPts);
      cv.fillPoly(quadMask, vec, new cv.Scalar(255));

      function ell(r) {
        return track(cv.getStructuringElement(
          cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1)));
      }
      var inner = track(new cv.Mat());
      var outer = track(new cv.Mat());
      cv.erode(quadMask, inner, ell(bandPx));
      cv.dilate(quadMask, outer, ell(outBandPx));

      if (cv.countNonZero(inner) === 0) {
        return fail("detection band wider than the slab itself");
      }
      if (1 - cv.countNonZero(outer) / (smW * smH) < 0.02) {
        return fail("not enough background room - increase the margin");
      }

      var gcMask = track(new cv.Mat(smH, smW, cv.CV_8UC1,
                                    new cv.Scalar(cv.GC_BGD)));
      for (i = 0; i < smW * smH; i++) {
        if (outer.data[i]) gcMask.data[i] = cv.GC_PR_FGD;
      }
      for (i = 0; i < smW * smH; i++) {
        if (inner.data[i]) gcMask.data[i] = cv.GC_FGD;
      }
      var bgd = track(new cv.Mat());
      var fgd = track(new cv.Mat());
      cv.grabCut(rgb, gcMask, new cv.Rect(0, 0, 1, 1), bgd, fgd,
                 GRABCUT_ITERS, cv.GC_INIT_WITH_MASK);

      var fg = track(cv.Mat.zeros(smH, smW, cv.CV_8UC1));
      for (i = 0; i < smW * smH; i++) {
        var v = gcMask.data[i];
        if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fg.data[i] = 255;
      }
      cv.morphologyEx(fg, fg, cv.MORPH_CLOSE, ell(2));

      var contours = track(new cv.MatVector());
      var hierarchy = track(new cv.Mat());
      cv.findContours(fg, contours, hierarchy, cv.RETR_EXTERNAL,
                      cv.CHAIN_APPROX_NONE);
      if (contours.size() === 0) {
        return fail("no foreground region found (contrast too low?)");
      }
      var largest = null, largestArea = 0;
      for (i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var a = cv.contourArea(c);
        if (a > largestArea) { largestArea = a; largest = c; }
      }
      if (!largest || largestArea <= 0) {
        return fail("degenerate foreground region");
      }
      var areaRatio = largestArea / quadArea;
      if (areaRatio < AREA_RATIO_MIN || areaRatio > AREA_RATIO_MAX) {
        return fail("detected area is " + areaRatio.toFixed(2)
                    + "x the reference - contrast too low?");
      }

      var dense = [];
      for (i = 0; i < largest.data32S.length; i += 2) {
        dense.push(largest.data32S[i] / scale,
                   largest.data32S[i + 1] / scale);
      }
      return { ok: true, dense: dense, reason: null, areaRatio: areaRatio };
    } catch (err) {
      return fail("detector error: " + (err && err.message ? err.message : err));
    } finally {
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) { /* freed */ }
      }
    }
  }

  root.cvSegment = cvSegment;
})(typeof self !== "undefined" ? self : globalThis);
