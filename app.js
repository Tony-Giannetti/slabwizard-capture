/* SlabWizard Capture — UI controller.
 *
 * Flow: photograph -> validate -> write to IndexedDB -> try to upload.
 * The write happens before the upload is even attempted, so the capture is
 * safe the moment the operator taps Save; uploading is a retryable
 * background chore over the queue, not part of saving. */

import {
  STATUS, putCapture, patchCapture, deleteCapture,
  allCaptures, pendingCaptures, countByStatus, clearUploaded,
} from "./js/db.js";
import {
  SCHEMA, PHOTO_NAME, STICKY_FIELDS,
  newCaptureId, buildManifest, validateForm, describe,
} from "./js/capture.js";
import { preparePhoto, formatBytes } from "./js/image.js";
import { runRectifyFlow } from "./js/rectify.js";
import {
  DriveError, uploadBundle, getToken, hasValidToken, disconnect, forgetToken,
} from "./js/drive.js";
import {
  loadSettings, saveSettings, ensureDeviceName,
  recentValues, rememberValue, SAFE_NAME_RE,
} from "./js/settings.js";
import { diagInstall, diagList, diagClear, diagLog } from "./js/diag.js";

const $ = (id) => document.getElementById(id);

const els = {
  views: {
    capture: $("view-capture"),
    queue: $("view-queue"),
    settings: $("view-settings"),
  },
  photoInput: $("photo-input"),
  photoPreview: $("photo-preview"),
  photoPlaceholder: $("photo-placeholder"),
  photoMeta: $("photo-meta"),
  form: $("slab-form"),
  formError: $("form-error"),
  btnSave: $("btn-save"),
  queueSummary: $("queue-summary"),
  queueList: $("queue-list"),
  queueHint: $("queue-hint"),
  netDot: $("net-dot"),
  toast: $("toast"),
  authState: $("auth-state"),
};

const FIELD_IDS = {
  name: "f-name", material: "f-material", thickness_mm: "f-thickness",
  width_mm: "f-width", height_mm: "f-height", supplier: "f-supplier",
  lot_number: "f-lot", location: "f-location", cost: "f-cost",
  notes: "f-notes", kind: "f-kind",
};

let photo = null;            // {blob, width, height} — the prepared photo
let rectify = null;          // result of the rectify flow, or null
let previewUrl = null;
let syncing = false;
let needsConsent = false;

/* ── Chrome ────────────────────────────────────────────────────────────── */

function showView(name) {
  for (const [key, el] of Object.entries(els.views)) el.hidden = key !== name;
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`.trim();
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3600);
}

function readForm() {
  const raw = {};
  for (const [key, id] of Object.entries(FIELD_IDS)) raw[key] = $(id).value;
  return raw;
}

function markBad(field) {
  document.querySelectorAll("input.bad").forEach((el) => el.classList.remove("bad"));
  const el = $(FIELD_IDS[field]);
  if (el) {
    el.classList.add("bad");
    el.focus();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/* ── Photo ─────────────────────────────────────────────────────────────── */

function setPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  els.photoPreview.hidden = !blob;
  els.photoPlaceholder.hidden = Boolean(blob);
  if (blob) els.photoPreview.src = previewUrl;
  else els.photoPreview.removeAttribute("src");
}

const cornersBtn = $("btn-corners");
const cornersState = $("corners-state");
let rectPreviewUrl = null;

/* ── Jig target stickers ───────────────────────────────────────────────────
 * The stickers sit at a KNOWN centre-to-centre rectangle (placed by a
 * jig), so the PC can find them and flatten the photo itself: no corner
 * marking, no tape. The toggle and spans persist — a shop has one jig. */
const jigBlock = $("jig-block");
const jigToggle = $("jig-toggle");
const jigSpans = $("jig-spans");
const jigHint = $("jig-hint");
const jigX = $("jig-span-x");
const jigY = $("jig-span-y");
const JIG_STORE = { on: "slabwizard.jig.on", x: "slabwizard.jig.x",
                    y: "slabwizard.jig.y" };

function jigValue() {
  if (!jigToggle.checked) return null;
  const x = Number.parseFloat(jigX.value);
  const y = Number.parseFloat(jigY.value);
  if (!Number.isFinite(x) || x <= 0 || !Number.isFinite(y) || y <= 0) {
    return null;
  }
  return { span_x_mm: x, span_y_mm: y };
}

function updateJigUi() {
  jigSpans.hidden = !jigToggle.checked;
  jigHint.hidden = !jigToggle.checked;
}

function saveJig() {
  try {
    localStorage.setItem(JIG_STORE.on, jigToggle.checked ? "1" : "0");
    localStorage.setItem(JIG_STORE.x, jigX.value);
    localStorage.setItem(JIG_STORE.y, jigY.value);
  } catch { /* storage unavailable — the session still works */ }
}

try {
  jigToggle.checked = localStorage.getItem(JIG_STORE.on) === "1";
  jigX.value = localStorage.getItem(JIG_STORE.x) || jigX.value;
  jigY.value = localStorage.getItem(JIG_STORE.y) || jigY.value;
} catch { /* defaults stand */ }
updateJigUi();
jigToggle.addEventListener("change", () => { saveJig(); updateJigUi(); });
jigX.addEventListener("change", saveJig);
jigY.addEventListener("change", saveJig);

function setRectify(value) {
  rectify = value;
  cornersBtn.hidden = !photo;
  cornersState.hidden = !photo;
  jigBlock.hidden = !photo;
  if (rectPreviewUrl) { URL.revokeObjectURL(rectPreviewUrl); rectPreviewUrl = null; }
  if (!photo) return;
  if (rectify && rectify.output) {
    // Show the FLATTENED image — it is what will land in the inventory.
    rectPreviewUrl = URL.createObjectURL(rectify.output.blob);
    els.photoPreview.src = rectPreviewUrl;
    cornersBtn.textContent = "Re-rectify…";
    cornersBtn.classList.add("marked");
    const w = Math.round(rectify.output.widthMm);
    const h = Math.round(rectify.output.heightMm);
    $(FIELD_IDS.width_mm).value = w;
    $(FIELD_IDS.height_mm).value = h;
    $(FIELD_IDS.width_mm).disabled = true;
    $(FIELD_IDS.height_mm).disabled = true;
    cornersState.innerHTML =
      '<span class="ok">&#10003; Rectified</span> — ' +
      `${w} × ${h} mm measured off the photo. ` +
      "Dimensions are locked to the rectification.";
  } else if (rectify) {
    // Corners + measurements captured, but no WebGL — the PC will warp.
    cornersBtn.textContent = "Adjust rectification…";
    cornersBtn.classList.add("marked");
    $(FIELD_IDS.width_mm).disabled = false;
    $(FIELD_IDS.height_mm).disabled = false;
    cornersState.innerHTML =
      '<span class="ok">&#10003; Corners + measurements set</span> — ' +
      "the PC will flatten and measure the photo at import.";
  } else {
    cornersBtn.textContent = "Rectify photo…";
    cornersBtn.classList.remove("marked");
    $(FIELD_IDS.width_mm).disabled = false;
    $(FIELD_IDS.height_mm).disabled = false;
    cornersState.textContent =
      "Optional: mark the slab's corners and tape sizes to flatten the " +
      "photo to true dimensions — like the rectify dialog on the PC.";
  }
}

cornersBtn.addEventListener("click", async () => {
  if (!photo) return;
  const raw = readForm();
  const result = await runRectifyFlow(photo.blob, rectify, {
    width: Number.parseFloat(raw.width_mm) || "",
    height: Number.parseFloat(raw.height_mm) || "",
  });
  if (result) setRectify(result);
});

els.photoInput.addEventListener("change", async () => {
  const file = els.photoInput.files?.[0];
  if (!file) {
    diagLog("photo: change fired with no file");
    return;
  }
  diagLog("photo: received " + (file.type || "unknown-type") + " "
          + formatBytes(file.size) + " " + (file.name || ""));
  els.photoMeta.hidden = false;
  els.photoMeta.textContent = "Processing photo…";
  try {
    photo = await preparePhoto(file);
    diagLog("photo: prepared " + photo.width + "x" + photo.height);
    setPreview(photo.blob);
    els.photoMeta.textContent =
      `${photo.width} × ${photo.height} px · ${formatBytes(photo.blob.size)}`;
    setRectify(null);            // old marks belong to the old pixels
  } catch (err) {
    diagLog("photo: FAILED " + err.message);
    photo = null;
    setRectify(null);
    setPreview(null);
    els.photoMeta.textContent = "";
    els.photoMeta.hidden = true;
    const heifHint = /hei[cf]/i.test(file.type || "")
      || !/^image\/(jpeg|png|webp)/i.test(file.type || "image/jpeg");
    toast(heifHint
      ? "This photo format isn't supported — set the camera to save "
        + "JPEG (turn off high-efficiency/HEIF pictures) and retake."
      : `Could not read that photo: ${err.message}`, "err");
  } finally {
    // Let the same file be picked again if they retake it.
    els.photoInput.value = "";
  }
});

/* ── Saving ────────────────────────────────────────────────────────────── */

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.formError.hidden = true;

  if (!photo) {
    els.formError.textContent = "Photograph the slab first.";
    els.formError.hidden = false;
    return;
  }

  const result = validateForm(readForm());
  if (!result.ok) {
    els.formError.textContent = result.message;
    els.formError.hidden = false;
    markBad(result.field);
    return;
  }

  const settings = loadSettings();
  if (!SAFE_NAME_RE.test(settings.tenant)) {
    toast("The site code in Settings is not a valid name.", "err");
    showView("settings");
    return;
  }

  const targetJig = jigValue();
  if (jigToggle.checked && !targetJig) {
    els.formError.textContent =
      "Target sticker spans must be numbers greater than zero.";
    els.formError.hidden = false;
    return;
  }

  els.btnSave.disabled = true;
  try {
    const capture_id = newCaptureId();
    const manifest = buildManifest(result.value, {
      capture_id,
      tenant: settings.tenant,
      device: ensureDeviceName(),
      rectify,
      targetJig,
    });

    await putCapture({
      capture_id,
      status: STATUS.QUEUED,
      created_at: new Date().toISOString(),
      attempts: 0,
      error: "",
      manifest,
      photo: photo.blob,
      photo_name: PHOTO_NAME,
      rectified_photo: rectify?.output ? rectify.output.blob : null,
      bytes: photo.blob.size + (rectify?.output ? rectify.output.blob.size : 0),
      schema: SCHEMA,
    });

    for (const field of STICKY_FIELDS) rememberValue(field, String(result.value[field] ?? ""));
    resetForm(result.value);
    toast("Saved. It will upload when there's signal.", "ok");
    await refreshQueueSummary();
    sync({ interactive: false });
  } catch (err) {
    toast(`Could not save: ${err.message}`, "err");
  } finally {
    els.btnSave.disabled = false;
  }
});

/** Clear the per-slab fields, keep the ones that repeat down a rack. */
function resetForm(saved) {
  photo = null;
  setRectify(null);
  setPreview(null);
  els.photoMeta.hidden = true;
  els.photoMeta.textContent = "";
  for (const key of ["name", "width_mm", "height_mm", "cost", "notes"]) {
    $(FIELD_IDS[key]).value = "";
  }
  for (const key of STICKY_FIELDS) {
    if (saved[key] != null) $(FIELD_IDS[key]).value = saved[key];
  }
  document.querySelectorAll("input.bad").forEach((el) => el.classList.remove("bad"));
  els.formError.hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Uploading ─────────────────────────────────────────────────────────── */

async function sync({ interactive = false } = {}) {
  if (syncing) return;
  if (!navigator.onLine) {
    if (interactive) toast("No connection — captures are saved and waiting.");
    return;
  }
  const queue = await pendingCaptures();
  if (!queue.length) {
    if (interactive) toast("Nothing waiting to upload.");
    return;
  }

  const settings = loadSettings();
  if (!settings.clientId) {
    if (interactive) {
      toast("Set the Google client ID in Settings first.", "err");
      showView("settings");
    }
    return;
  }

  syncing = true;
  renderQueue();
  try {
    // One token acquisition for the whole batch. Consent can only be
    // granted from a gesture, so a silent failure just parks the queue.
    try {
      await getToken(settings.clientId, interactive);
      needsConsent = false;
    } catch (err) {
      needsConsent = true;
      if (interactive) toast(err.message, "err");
      return;
    }

    let done = 0;
    for (const record of queue) {
      await patchCapture(record.capture_id, { status: STATUS.UPLOADING });
      renderQueue();
      try {
        await uploadBundle(settings, record);
        await patchCapture(record.capture_id, {
          status: STATUS.UPLOADED, error: "", uploaded_at: new Date().toISOString(),
        });
        done += 1;
      } catch (err) {
        await patchCapture(record.capture_id, {
          status: STATUS.ERROR,
          error: err.message,
          attempts: (record.attempts || 0) + 1,
        });
        if (err instanceof DriveError && err.needsConsent) {
          needsConsent = true;
          forgetToken();
          if (interactive) toast(err.message, "err");
          break;                     // no point hammering the rest
        }
        if (interactive) toast(`Upload failed: ${err.message}`, "err");
        break;                       // usually the network; retry later
      }
    }
    if (done) toast(`${done} slab${done === 1 ? "" : "s"} uploaded.`, "ok");
  } finally {
    syncing = false;
    await refreshQueueSummary();
    renderQueue();
  }
}

/* ── Queue view ────────────────────────────────────────────────────────── */

async function refreshQueueSummary() {
  const counts = await countByStatus();
  const waiting = (counts[STATUS.QUEUED] || 0) + (counts[STATUS.ERROR] || 0);
  const uploaded = counts[STATUS.UPLOADED] || 0;
  els.queueSummary.textContent = waiting
    ? `${waiting} waiting to upload${uploaded ? ` · ${uploaded} sent` : ""}`
    : uploaded ? `All ${uploaded} uploaded` : "Nothing waiting to upload";
}

const queueUrls = new Set();

async function renderQueue() {
  if (els.views.queue.hidden) return;
  const rows = await allCaptures();

  queueUrls.forEach((u) => URL.revokeObjectURL(u));
  queueUrls.clear();

  els.queueHint.textContent = needsConsent
    ? "Google Drive needs reconnecting — tap Upload now."
    : navigator.onLine ? "" : "Offline. Captures upload as soon as there's signal.";

  els.queueList.textContent = "";
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "No captures yet.";
    els.queueList.append(li);
    return;
  }

  for (const row of rows) {
    const { title, sub } = describe(row.manifest);
    const li = document.createElement("li");
    li.className = "queue-item";

    if (row.photo) {
      const url = URL.createObjectURL(row.photo);
      queueUrls.add(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      li.append(img);
    }

    const body = document.createElement("div");
    body.className = "qi-body";
    const t = document.createElement("div");
    t.className = "qi-title";
    t.textContent = title;
    const s = document.createElement("div");
    s.className = "qi-sub";
    s.textContent = row.status === STATUS.ERROR && row.error
      ? `${sub} · ${row.error}` : sub;
    body.append(t, s);

    const status = document.createElement("span");
    status.className = `qi-status ${row.status}`;
    status.textContent = {
      [STATUS.QUEUED]: "waiting",
      [STATUS.UPLOADING]: "sending…",
      [STATUS.UPLOADED]: "sent",
      [STATUS.ERROR]: "failed",
    }[row.status] || row.status;

    const del = document.createElement("button");
    del.className = "qi-del";
    del.type = "button";
    del.setAttribute("aria-label", `Delete ${title}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete this capture of ${title}?`)) return;
      await deleteCapture(row.capture_id);
      await refreshQueueSummary();
      renderQueue();
    });

    li.append(body, status, del);
    els.queueList.append(li);
  }
}

/* ── Settings view ─────────────────────────────────────────────────────── */

function fillDiagnostics() {
  const pre = $("diag-log");
  const entries = diagList();
  pre.textContent = entries.length ? entries.join("\n") : "(no entries)";
}

function fillSettings() {
  fillDiagnostics();
  const s = loadSettings();
  $("s-client-id").value = s.clientId;
  $("s-tenant").value = s.tenant;
  $("s-device").value = s.device || ensureDeviceName();
  $("s-folder").value = s.folderName;
  updateAuthState();
}

function updateAuthState() {
  const s = loadSettings();
  els.authState.textContent = !s.clientId
    ? "No client ID set — uploads are parked until you add one."
    : hasValidToken() ? "Connected to Google Drive."
    : "Not connected. Captures are saved locally until you connect.";
}

$("btn-save-settings").addEventListener("click", () => {
  const tenant = $("s-tenant").value.trim() || "default";
  if (!SAFE_NAME_RE.test(tenant)) {
    toast("Site code: letters, digits, dot, dash and underscore only.", "err");
    return;
  }
  saveSettings({
    clientId: $("s-client-id").value.trim(),
    tenant,
    device: $("s-device").value.trim(),
    folderName: $("s-folder").value.trim() || "SlabWizard Captures",
  });
  updateAuthState();
  toast("Settings saved.", "ok");
});

$("btn-connect").addEventListener("click", async () => {
  const s = loadSettings();
  if (!s.clientId) {
    toast("Enter and save the client ID first.", "err");
    return;
  }
  try {
    await getToken(s.clientId, true);
    needsConsent = false;
    updateAuthState();
    toast("Google Drive connected.", "ok");
    sync({ interactive: false });
  } catch (err) {
    toast(err.message, "err");
  }
});

$("btn-disconnect").addEventListener("click", async () => {
  await disconnect();
  updateAuthState();
  toast("Disconnected. Captures stay on this phone.");
});

/* ── Wiring ────────────────────────────────────────────────────────────── */

$("btn-settings").addEventListener("click", () => {
  fillSettings();
  showView("settings");
});
$("btn-queue").addEventListener("click", async () => {
  showView("queue");
  await renderQueue();
});
$("btn-sync").addEventListener("click", () => sync({ interactive: true }));
$("btn-clear-done").addEventListener("click", async () => {
  const n = await clearUploaded();
  await refreshQueueSummary();
  renderQueue();
  toast(n ? `Cleared ${n}.` : "Nothing uploaded yet to clear.");
});
document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView("capture"));
});

function updateNetDot() {
  els.netDot.classList.toggle("offline", !navigator.onLine);
  els.netDot.title = navigator.onLine ? "Online" : "Offline";
}
window.addEventListener("online", () => {
  updateNetDot();
  renderQueue();
  sync({ interactive: false });
});
window.addEventListener("offline", () => { updateNetDot(); renderQueue(); });

function fillDatalists() {
  const pairs = [
    ["material-list", "material"],
    ["supplier-list", "supplier"],
    ["location-list", "location"],
  ];
  for (const [listId, field] of pairs) {
    const list = $(listId);
    list.textContent = "";
    for (const value of recentValues(field)) {
      const opt = document.createElement("option");
      opt.value = value;
      list.append(opt);
    }
  }
  // Thickness repeats hardest of all — prefill the last one used.
  const lastThickness = recentValues("thickness_mm")[0];
  if (lastThickness && !$(FIELD_IDS.thickness_mm).value) {
    $(FIELD_IDS.thickness_mm).value = lastThickness;
  }
}

async function init() {
  diagInstall();
  $("diag-clear").addEventListener("click", () => {
    diagClear();
    fillDiagnostics();
  });
  updateNetDot();
  fillDatalists();
  ensureDeviceName();
  await refreshQueueSummary();

  if ("serviceWorker" in navigator) {
    try {
      // Self-update: the SW uses skipWaiting + clients.claim, so when a
      // new deploy's worker installs it takes control immediately and
      // fires controllerchange — one silent reload swaps the whole app to
      // the new version. Without this, a phone can serve a stale bundle
      // until its storage is cleared by hand.
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloaded) return;   // first install: no reload
        reloaded = true;
        location.reload();
      });
      const registration = await navigator.serviceWorker.register("sw.js");
      registration.update();      // check for a new deploy on every launch
      // A PWA brought back from the recents list is RESUMED, not
      // relaunched — init never re-runs, so a phone that is never fully
      // closed never sees a new deploy. Check again whenever the app
      // returns to the foreground, but only while no capture is loaded:
      // the update reload must never eat a half-filled form.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !photo) {
          registration.update();
        }
      });
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  }

  const s = loadSettings();
  if (s.clientId && navigator.onLine) sync({ interactive: false });
}

init();
