/* Service worker — makes the app open and capture with no signal at all.
 *
 * Only the app shell is cached, and only same-origin requests are touched.
 * Google's endpoints (sign-in, Drive) are deliberately left alone: caching
 * an auth or upload response would be worse than useless. Uploads survive
 * offline through the IndexedDB queue, not through here. */

// Bumped automatically by tools/deploy_pages.py on every deploy that
// changes a file. It has to change, or `activate` keeps the old cache and a
// phone that already has the app serves yesterday's config.js forever.
const CACHE = "slabwizard-capture-v18";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./js/capture.js",
  "./js/corners.js",
  "./js/cv_segment.js",
  "./js/db.js",
  "./js/detect_worker.js",
  "./js/diag.js",
  "./js/drive.js",
  "./js/homography.js",
  "./js/image.js",
  "./js/outline.js",
  "./js/outline_cv.js",
  "./js/rectify.js",
  "./js/settings.js",
  "./js/warp.js",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Google, CDNs: untouched

  // CACHE-FIRST, strictly. The versioned precache is an atomic snapshot
  // of one deploy; the old stale-while-revalidate wrote NEWER files into
  // the CURRENT cache mid-session, so the module graph could load half
  // v(N) and half v(N+1) — the "everything randomly broke" generator.
  // Freshness comes only from a new cache name: install fetches the whole
  // shell, activate claims, the page reloads itself once. Files outside
  // the shell (vendor/opencv.js) are fetched once and frozen in the same
  // versioned cache.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === "basic") {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Navigations with nothing cached and no network: fall back to
        // the shell so the app still opens.
        if (request.mode === "navigate") {
          const shell = await cache.match("./index.html");
          if (shell) return shell;
        }
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }),
  );
});
