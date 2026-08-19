/* Photo preparation.
 *
 * Two things have to happen before a phone photo is worth uploading:
 *
 * 1. **Apply EXIF orientation.** Phones store the sensor image and a
 *    rotation flag. Pillow on the PC does not auto-rotate, so an untouched
 *    upload arrives sideways and no longer agrees with the width/height
 *    that were typed against it. Baking the rotation into the pixels here
 *    is the only place it can be done reliably.
 *
 * 2. **Downscale to the PC's ingest cap.** InventoryStore re-encodes to a
 *    4096px long edge anyway (core/inventory/photos.py INGEST_MAX_EDGE), so
 *    sending a 12MP original just spends the user's mobile data on pixels
 *    that get thrown away. */

export const MAX_EDGE = 4096;    // == INGEST_MAX_EDGE
export const QUALITY = 0.88;     // == _JPEG_QUALITY

async function decode(file) {
  // createImageBitmap is faster and lets us ask for the EXIF rotation
  // explicitly; older Safari needs the <img> path, where browsers apply
  // EXIF orientation by default.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("could not decode the photo"));
      img.src = url;
    });
    return img;
  } finally {
    // Revoked after the caller has drawn it; drawImage is synchronous
    // below, so deferring one task is enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("could not encode the photo"))),
      type,
      quality,
    );
  });
}

/**
 * Decode, rotate, downscale and re-encode one camera file.
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function preparePhoto(file, maxEdge = MAX_EDGE, quality = QUALITY) {
  const source = await decode(file);
  const srcW = source.width || source.naturalWidth;
  const srcH = source.height || source.naturalHeight;
  if (!srcW || !srcH) throw new Error("the photo has no usable dimensions");

  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  if (typeof source.close === "function") source.close();

  const blob = await canvasToBlob(canvas, "image/jpeg", quality);
  // Free the backing store on memory-tight phones.
  canvas.width = canvas.height = 0;
  return { blob, width, height };
}

export function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
