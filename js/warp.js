/* Projective warp on the GPU.
 *
 * Given the photo, its 4 marked corners, and the slab's real-world quad,
 * render the flattened, dimensionally-true image the way the desktop
 * pipeline would: every output pixel samples the source photo through the
 * inverse homography. Exact projective sampling in the fragment shader —
 * no mesh subdivision approximation.
 *
 * Returns null when WebGL is unavailable; the caller falls back to
 * shipping corners + measurements for the PC to rectify instead.
 */

import { solveHomography, invert3x3 } from "./homography.js";

const MAX_OUTPUT_EDGE = 4096;    // matches the PC's ingest cap

const VERT = `
attribute vec2 aPos;
varying vec2 vOut;
uniform vec2 uOutSize;
void main() {
  vOut = (aPos * 0.5 + 0.5) * uOutSize;   // clip -> output px, y-down
  gl_Position = vec4(aPos.x, -aPos.y, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vOut;
uniform sampler2D uTex;
uniform mat3 uHinv;             // output px -> source px
uniform vec2 uSrcSize;
uniform vec3 uBg;
void main() {
  vec3 s = uHinv * vec3(vOut, 1.0);
  vec2 sp = s.xy / s.z;
  if (sp.x < 0.0 || sp.y < 0.0 || sp.x > uSrcSize.x || sp.y > uSrcSize.y) {
    gl_FragColor = vec4(uBg, 1.0);
  } else {
    gl_FragColor = texture2D(uTex, sp / uSrcSize);
  }
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(shader));
  }
  return shader;
}

/**
 * Flatten the photo.
 *
 * @param {ImageBitmap|HTMLImageElement} image  the source photo
 * @param {Array} srcCorners   4 marked corners, source px, TL TR BR BL
 * @param {Array} dstCornersMm 4 real-world corners, mm, same order
 * @param {number} widthMm / heightMm  bounding size of the mm quad
 * @param {number} marginMm    extra context around the quad
 * @returns {{canvas, pxPerMm, widthPx, heightPx}|null}
 */
export function warpToCanvas(image, srcCorners, dstCornersMm,
                             widthMm, heightMm, marginMm = 0) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true })
          || canvas.getContext("experimental-webgl",
                               { preserveDrawingBuffer: true });
  if (!gl) return null;

  const totalW = widthMm + 2 * marginMm;
  const totalH = heightMm + 2 * marginMm;
  // Resolution: as sharp as the ingest cap allows, never above 2 px/mm
  // (a 3200mm slab at 2px/mm would already be 6400px).
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
  const cap = Math.min(MAX_OUTPUT_EDGE, maxTex);
  const pxPerMm = Math.min(2, cap / totalW, cap / totalH);
  const outW = Math.max(1, Math.round(totalW * pxPerMm));
  const outH = Math.max(1, Math.round(totalH * pxPerMm));
  canvas.width = outW;
  canvas.height = outH;

  // Source may exceed the GPU's texture limit — downscale it (and the
  // marked corners with it) before upload.
  let src = image;
  let srcW = image.width || image.naturalWidth;
  let srcH = image.height || image.naturalHeight;
  let corners = srcCorners;
  const srcMax = Math.max(srcW, srcH);
  if (srcMax > maxTex) {
    const k = maxTex / srcMax;
    const shrink = document.createElement("canvas");
    shrink.width = Math.round(srcW * k);
    shrink.height = Math.round(srcH * k);
    shrink.getContext("2d").drawImage(src, 0, 0, shrink.width, shrink.height);
    src = shrink;
    corners = srcCorners.map(([x, y]) => [x * k, y * k]);
    srcW = shrink.width;
    srcH = shrink.height;
  }

  // dst px = (mm + margin) * scale; H maps source px -> output px.
  const dstPx = dstCornersMm.map(([x, y]) => [
    (x + marginMm) * pxPerMm, (y + marginMm) * pxPerMm]);
  const Hinv = invert3x3(solveHomography(corners, dstPx));

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]),   // one big triangle
                gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

  // uniformMatrix3fv wants column-major; Hinv is row-major.
  const m = Hinv;
  const colMajor = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  gl.uniformMatrix3fv(gl.getUniformLocation(program, "uHinv"), false,
                      new Float32Array(colMajor));
  gl.uniform2f(gl.getUniformLocation(program, "uSrcSize"), srcW, srcH);
  gl.uniform2f(gl.getUniformLocation(program, "uOutSize"), outW, outH);
  // SlabWizard's window background as the out-of-photo fill.
  gl.uniform3f(gl.getUniformLocation(program, "uBg"),
               0x16 / 255, 0x18 / 255, 0x1c / 255);

  gl.viewport(0, 0, outW, outH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.finish();

  return { canvas, pxPerMm, widthPx: outW, heightPx: outH };
}

/** Crop a region (output px) out of a warped canvas into a JPEG blob. */
export function cropToBlob(canvas, x, y, w, h, quality = 0.9) {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w));
  out.height = Math.max(1, Math.round(h));
  out.getContext("2d").drawImage(canvas, x, y, w, h,
                                 0, 0, out.width, out.height);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => (blob ? resolve(blob)
                               : reject(new Error("could not encode"))),
               "image/jpeg", quality);
  });
}
