/* Corner marking — the phone's half of rectification.
 *
 * The phone does the UX; the PC does the mathematics. The operator taps
 * the slab's four corners on the photo (TL, TR, BR, BL), the coordinates
 * ship in capture.json, and SlabWizard runs its real rectification
 * pipeline at import — so the slab arrives with measured dimensions and a
 * flattened photo instead of hand-typed numbers.
 *
 * Mobile-first: full-screen canvas, tap to place, drag to adjust with a
 * magnifier loupe under the finger (a fingertip covers exactly the pixels
 * being picked — the loupe is what makes corner precision possible on a
 * phone at all).
 */

const HANDLE_GRAB_PX = 28;      // touch radius for grabbing a placed corner
const LOUPE_SIZE = 132;         // css px
const LOUPE_ZOOM = 3;

const ORDER = ["TOP-LEFT", "TOP-RIGHT", "BOTTOM-RIGHT", "BOTTOM-LEFT"];

/**
 * Open the full-screen marker.
 * @param {Blob} photoBlob    the prepared (rotated, downscaled) photo
 * @param {Array|null} existing  previously marked corners, image px
 * @returns {Promise<Array<[number,number]>|null>}  4 corners TL TR BR BL
 *          in image pixel space, or null on cancel.
 */
export function openCornerMarker(photoBlob, existing = null) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("corner-overlay");
    const canvas = document.getElementById("corner-canvas");
    const loupe = document.getElementById("corner-loupe");
    const prompt = document.getElementById("corner-prompt");
    const btnDone = document.getElementById("corner-done");
    const btnRedo = document.getElementById("corner-redo");
    const btnCancel = document.getElementById("corner-cancel");

    const ctx = canvas.getContext("2d");
    const lctx = loupe.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    let img = null;               // ImageBitmap or HTMLImageElement
    let imgW = 0, imgH = 0;
    let scale = 1, offX = 0, offY = 0;   // image -> screen fit transform
    let corners = existing ? existing.map((p) => [p[0], p[1]]) : [];
    let dragging = -1;            // index being dragged, -1 none
    let objectUrl = null;

    /* ── Geometry ──────────────────────────────────────────────────── */

    function layout() {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      // Fit the image, leaving room for the prompt (top) + buttons (bottom).
      const padTop = 64, padBottom = 96, pad = 10;
      scale = Math.min((w - pad * 2) / imgW,
                       (h - padTop - padBottom) / imgH);
      offX = (w - imgW * scale) / 2;
      offY = padTop + (h - padTop - padBottom - imgH * scale) / 2;
      draw();
    }

    const toScreen = (p) => [offX + p[0] * scale, offY + p[1] * scale];
    const toImage = (sx, sy) => [
      Math.min(imgW, Math.max(0, (sx - offX) / scale)),
      Math.min(imgH, Math.max(0, (sy - offY) / scale)),
    ];

    /* ── Drawing ───────────────────────────────────────────────────── */

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (img) {
        ctx.drawImage(img, offX, offY, imgW * scale, imgH * scale);
      }
      // The quad so far
      if (corners.length >= 2) {
        ctx.beginPath();
        const pts = corners.map(toScreen);
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        if (corners.length === 4) ctx.closePath();
        ctx.strokeStyle = "rgba(70, 130, 180, 0.95)";   // SlabWizard accent
        ctx.lineWidth = 2;
        ctx.stroke();
        if (corners.length === 4) {
          ctx.fillStyle = "rgba(70, 130, 180, 0.14)";
          ctx.fill();
        }
      }
      // Handles
      corners.forEach((p, i) => {
        const [x, y] = toScreen(p);
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = i === dragging ? "#5a9bd4" : "#4682b4";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#eef1f5";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), x, y);
      });
      updateChrome();
    }

    function updateChrome() {
      if (corners.length < 4) {
        prompt.textContent =
          "Tap the " + ORDER[corners.length] + " corner of the slab";
      } else {
        prompt.textContent = "Drag any corner to fine-tune, then Use corners";
      }
      btnDone.disabled = corners.length !== 4;
      btnRedo.disabled = corners.length === 0;
    }

    function drawLoupe(imagePt, screenX, screenY) {
      loupe.hidden = false;
      loupe.width = LOUPE_SIZE * dpr;
      loupe.height = LOUPE_SIZE * dpr;
      loupe.style.width = LOUPE_SIZE + "px";
      loupe.style.height = LOUPE_SIZE + "px";
      // Above the finger; below it if too close to the top edge.
      const lx = Math.min(Math.max(screenX - LOUPE_SIZE / 2, 8),
                          overlay.clientWidth - LOUPE_SIZE - 8);
      const above = screenY - LOUPE_SIZE - 36;
      loupe.style.left = lx + "px";
      loupe.style.top = (above > 8 ? above : screenY + 36) + "px";

      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.imageSmoothingEnabled = false;
      lctx.fillStyle = "#16181c";
      lctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
      const srcSpan = LOUPE_SIZE / (LOUPE_ZOOM * scale);
      lctx.drawImage(
        img,
        imagePt[0] - srcSpan / 2, imagePt[1] - srcSpan / 2, srcSpan, srcSpan,
        0, 0, LOUPE_SIZE, LOUPE_SIZE);
      // Crosshair
      lctx.strokeStyle = "rgba(70, 130, 180, 0.95)";
      lctx.lineWidth = 1;
      lctx.beginPath();
      lctx.moveTo(LOUPE_SIZE / 2, 0);
      lctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
      lctx.moveTo(0, LOUPE_SIZE / 2);
      lctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
      lctx.stroke();
    }

    /* ── Interaction ───────────────────────────────────────────────── */

    function nearestCorner(sx, sy) {
      let best = -1, bestD = HANDLE_GRAB_PX;
      corners.forEach((p, i) => {
        const [x, y] = toScreen(p);
        const d = Math.hypot(sx - x, sy - y);
        if (d < bestD) { best = i; bestD = d; }
      });
      return best;
    }

    function onDown(ev) {
      ev.preventDefault();
      const sx = ev.clientX, sy = ev.clientY;
      const hit = nearestCorner(sx, sy);
      if (hit >= 0) {
        dragging = hit;
      } else if (corners.length < 4) {
        corners.push(toImage(sx, sy));
        dragging = corners.length - 1;     // place-and-adjust in one touch
      } else {
        return;
      }
      canvas.setPointerCapture(ev.pointerId);
      drawLoupe(corners[dragging], sx, sy);
      draw();
    }

    function onMove(ev) {
      if (dragging < 0) return;
      ev.preventDefault();
      corners[dragging] = toImage(ev.clientX, ev.clientY);
      drawLoupe(corners[dragging], ev.clientX, ev.clientY);
      draw();
    }

    function onUp() {
      dragging = -1;
      loupe.hidden = true;
      draw();
    }

    /* ── Lifecycle ─────────────────────────────────────────────────── */

    function close(result) {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", layout);
      btnDone.onclick = btnRedo.onclick = btnCancel.onclick = null;
      if (img && typeof img.close === "function") img.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      overlay.hidden = true;
      document.body.style.overflow = "";
      resolve(result);
    }

    btnDone.onclick = () =>
      close(corners.map((p) => [Math.round(p[0] * 10) / 10,
                                Math.round(p[1] * 10) / 10]));
    btnRedo.onclick = () => { corners = []; dragging = -1; draw(); };
    btnCancel.onclick = () => close(null);

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", layout);

    overlay.hidden = false;
    document.body.style.overflow = "hidden";

    (async () => {
      try {
        if (typeof createImageBitmap === "function") {
          img = await createImageBitmap(photoBlob);
        } else {
          objectUrl = URL.createObjectURL(photoBlob);
          img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error("could not show the photo"));
            img.src = objectUrl;
          });
        }
        imgW = img.width || img.naturalWidth;
        imgH = img.height || img.naturalHeight;
        layout();
      } catch (err) {
        close(null);
      }
    })();
  });
}
