# SlabWizard Capture

A phone app that photographs a slab, takes its dimensions, and puts it in the
SlabWizard inventory on the PC.

It is a **PWA** — a web page that installs to the home screen. No app store,
no signing certificates, no Xcode, no Play Console. One hosted copy serves
iPhones and Androids, and updating it is a file upload.

```
   PHONE                          GOOGLE DRIVE                    PC
   ─────                          ────────────                    ──
   photograph                                              SlabWizard
   type dims          upload      SlabWizard Captures/      Inventory tab
   Save        ──────────────►      pending/<id>/     ◄──── "From Phone…"
     │                                photo.jpg              │
     ▼                                capture.json           ▼
   IndexedDB queue                                     SL-2026-0042
   (survives no signal)                                + photo on disk
```

---

## Why it is built this way

**The phone never invents an inventory number.** It mints a `capture_id`
whose only job is to let the PC recognise a bundle it has already imported.
The `SL-<year>-<seq>` id is allocated by `InventoryStore.next_id()` at import
time, so two people photographing the same rack cannot collide.

**The PC talks to Drive as the same app the phone does.** In drive-direct
mode (the default) the desktop authenticates with the phone's own web OAuth
client — `drive.file` grants access per *app*, so sharing the client is what
lets the PC see the phone's uploads. Folder mode is the cloud-free
alternative: a sync client (Google Drive for Desktop, OneDrive) mirrors the
captures folder onto disk and SlabWizard just reads a local directory —
`core/inventory/ingest/sources.py` — with no OAuth or network code on the PC
at all.

**The transport is swappable.** `CaptureSource` is a two-method protocol. The
day a relay server makes more sense than a shared Drive folder, a
`RelayCaptureSource` implements the same protocol and nothing else changes —
not the bundle format, not the ingestor, not the UI.

**Nothing is lost to bad signal.** Every capture is written to IndexedDB —
photo included — *before* an upload is attempted. Uploading is a retryable
chore over that queue.

---

## Setup

### 1. Host the app

Any static HTTPS host. The whole `mobile/` directory is the site.

- **GitHub Pages** — push `mobile/` to a repo, enable Pages.
- **Netlify / Cloudflare Pages** — drag the folder onto their dashboard.
- **Firebase Hosting** — `firebase deploy`.

HTTPS is not optional: the camera, service workers and Google sign-in all
require a secure origin. `http://localhost` counts as secure, so for a local
try-out:

```bash
cd mobile && python -m http.server 8000    # then http://localhost:8000
```

### 2. Create the Google OAuth client

Once, in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (any name).
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **Google Auth Platform** (formerly APIs & Services → OAuth consent screen)
   - *Internal* if you have Google Workspace — nothing further to do.
   - *External* otherwise: fill in **Branding** (app name, support email,
     privacy policy URL — skip the logo, uploading one triggers a separate
     brand-verification review), then **Audience → Publish app**. With only
     the `drive.file` scope the publish is instant — no Google review, no
     CASA audit.
   - Do **not** leave the app in *Testing*: refresh tokens expire every
     7 days there (the PC's From-Phone import silently breaks weekly) and
     every Google account must be hand-added under **Test users**. The
     shipped SlabWizard Capture client has been in Production since
     2026-08-29; these steps only matter if you stand up your own client.
   - Scope needed: `.../auth/drive.file` — non-sensitive; any broader
     Drive scope is what would trigger verification.
4. **Credentials → Create credentials → OAuth client ID → Web application**
   - **Authorised JavaScript origins**: the exact origin you host on, e.g.
     `https://yourname.github.io` (no path, no trailing slash). Add
     `http://localhost:8000` too if you want to test locally.
   - Leave redirect URIs empty — this app uses the token flow, not redirects.
5. Copy the client ID (`…apps.googleusercontent.com`).

Put it either in `config.js` before you deploy, or in the app's own
**Settings** screen. Settings wins, so one deployed build can serve several
yards.

> **Scope note.** `drive.file` means the app can only ever see files it
> created itself. It cannot read the rest of anyone's Drive. That is worth
> knowing before you hand phones to staff.

### 3. Install on the phone

Open the URL, then:

- **iPhone (Safari)** — Share → *Add to Home Screen*.
- **Android (Chrome)** — the *Install app* prompt, or ⋮ → *Add to Home
  screen*.

Open Settings in the app, paste the client ID, set the **site code** if you
run more than one yard, and tap **Connect Google Drive** once.

### 4. Connect the PC

Two transports; `~/.slabwizard/capture_sync.json` picks with its `mode` key.

**Drive-direct (`"mode": "drive"`) — the default.** SlabWizard talks to
Google Drive itself; nothing to install on the PC. It authenticates as the
**same web OAuth client the phone uses** — that is load-bearing, not a
shortcut: `drive.file` grants access per *app*, and sharing one client is
what makes both sides one app (verified empirically 2026-08-19 — a separate
Desktop-type client in the same Cloud project could NOT see the phone's
uploads). It also keeps everything on the non-sensitive scope: no Google
verification, no CASA audit.

Setup, once per PC:
1. On the web client, register the loopback redirect URIs
   `http://localhost:8731` and `http://localhost:8732` (fixed ports —
   web clients reject unregistered redirects; two so a busy port fails over).
2. Put the client id + secret in `capture_sync.json` with `"mode": "drive"`
   (`CaptureSyncConfig.set_drive(...)`, or `scripts/check_drive_access.py
   --web` to test it end-to-end first).
3. **Inventory → From Phone…** — the first click opens the browser for a
   one-time consent; after that the refresh token in
   `~/.slabwizard/google_token.json` carries it.

**Synced folder (`"mode": "folder"`) — the cloud-agnostic alternative.**
Install any sync client (Google Drive for Desktop, OneDrive, Dropbox), let
it mirror the captures folder onto disk, and point **From Phone…** at it.
Prefer *Mirror* over *Stream* so imports work with the PC offline. No
Google scopes on the PC at all — the right shape if a customer's shop
already lives in OneDrive.

---

## Using it

Photograph → material, thickness, width, height → **Save to inventory**.

**Mark corners for auto-measure** (optional, after the photo): tap the
slab's four corners — TL, TR, BR, BL, guided — with a magnifier loupe
under your finger for precision, drag any mark to fine-tune. The corners
ship in the bundle and the PC runs its real rectification pipeline at
import, so the slab arrives `rectified` with **measured** dimensions and a
flattened photo. The typed width/height become the real-world size of the
corner rectangle, so measure the slab, not the photo. Skip the marking and
the slab imports as before — hand-typed dims, flagged *unrectified* in the
inventory until the desktop **Rectify Photo…** button upgrades it.

- **Material, thickness, supplier, lot and location stay filled in** between
  slabs. You photograph a whole rack of the same stone; retyping it forty
  times is how a field tool gets abandoned.
- Saving is instant and offline-safe. The queue at the bottom of the screen
  shows what is still waiting; it uploads itself when signal returns.
- Recently used materials, suppliers and locations appear as suggestions.

### What lands on the PC

A record with material, dimensions, supplier, lot, location, cost, notes,
status *in stock*, and the photo. The notes carry a provenance line naming
the device and capture.

**It is not marked as rectified.** The dimensions were typed against a
hand-held photo, not measured off a rectified one, so `rectified=False` and
`px_per_mm` is left unset — claiming otherwise would put a false provenance
on the record. Re-shoot the slab through the PC's rectify dialog when you
want dimensional truth for vein matching or layout-over-photo.

---

## Folder layout

```
SlabWizard Captures/
    pending/<capture_id>/photo.jpg        uploaded first
    pending/<capture_id>/capture.json     uploaded last
    ingested/<capture_id>/                moved here after import
    failed/<capture_id>/                  plus error.txt, if unusable
```

The upload order is the point: the PC ignores a bundle directory with no
`capture.json` yet, so a half-synced upload is invisible rather than
half-imported.

`ingested/` grows forever — it is kept so you can see what was imported and
when. Delete its contents whenever you like; the import ledger, not the
folder, is what stops a re-import.

---

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app shell and UI controller |
| `js/capture.js` | **The bundle contract** — wire-format twin of `core/inventory/ingest/capture.py` |
| `js/db.js` | The offline IndexedDB queue |
| `js/drive.js` | Google Drive auth + upload |
| `js/image.js` | EXIF rotation + downscale to the PC's 4096px ingest cap |
| `js/settings.js` | Client ID, site code, remembered field values |
| `sw.js` | Service worker — opens with no signal |
| `config.js` | Deployment defaults you can bake in |
| `tools/make_icons.py` | Regenerates the PWA icons |

**If you change a bundle field, change it in both `js/capture.js` and
`core/inventory/ingest/capture.py`, and bump `SCHEMA` /
`CAPTURE_SCHEMA_VERSION` in both.** A bundle declaring a newer schema than
the PC understands is refused rather than guessed at, because the phone app
updates itself silently and an old PC build can genuinely meet a payload it
does not know.

---

## Troubleshooting

**"Google sign-in needs to be tapped through once."** A silent token refresh
was blocked as a popup. Tap **Upload now** — a real tap is allowed to open
the consent flow.

**Uploads fail with 403 after it worked before.** The hosting origin is not
in *Authorised JavaScript origins*, or (self-hosted clients only) the OAuth
app is sitting in *Testing* and the account is not on the test-user list.
The shipped client is in Production, so for it check the origin.

**The PC's From-Phone import asks for consent again after about a week.**
That refresh token was minted while the OAuth app was in *Testing* (7-day
expiry). Sign in once more now the app is in Production — tokens minted
after 2026-08-29 do not expire.

**Nothing imports on the PC.** Check the folder you picked actually contains
`pending/`. If Drive is in *Stream files* mode, make sure the PC is online.
If you moved or renamed the folder inside Drive, pick it again — the app can
only see the folder it created, so moving it breaks the link on the phone
side too.

**A slab imported with the photo sideways.** Shouldn't happen — `js/image.js`
bakes EXIF rotation into the pixels because Pillow on the PC does not
auto-rotate. If it does, that is a bug worth reporting with the original
photo.

**Two phones, same slab, two records.** Expected — they are two captures. The
ledger only de-duplicates re-delivery of *the same* capture, not two people
photographing the same stone.
