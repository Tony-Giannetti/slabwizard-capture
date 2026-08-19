/* Service worker — makes the app open and capture with no signal at all.
 *
 * Only the app shell is cached, and only same-origin requests are touched.
 * Google's endpoints (sign-in, Drive) are deliberately left alone: caching
 * an auth or upload response would be worse than useless. Uploads survive
 * offline through the IndexedDB queue, not through here. */

// Bumped automatically by tools/deploy_pages.py on every deploy that
// changes a file. It has to change, or `activate` keeps the old cache and a
// phone that already has the app serves yesterday's config.js forever.
const CACHE = "slabwizard-capture-v4";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./js/settings.js",
  "./js/db.js",
  "./js/image.js",
  "./js/capture.js",
  "./js/corners.js",
  "./js/drive.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
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

  // Stale-while-revalidate: instant open in the yard, fresh on the next
  // launch after a deploy.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      const response = cached || (await network);
      if (response) return response;
      // Navigations with nothing cached and no network: fall back to the
      // shell so the app still opens.
      if (request.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }),
  );
});
