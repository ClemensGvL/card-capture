// Service worker: cache the app shell + OCR assets so the app opens with zero
// network. Capture must work fully offline; only "Sync now" needs the LAN.
const VERSION = "v1";
const SHELL = "shell-" + VERSION;

const SHELL_FILES = [
  "./", "index.html", "app.js", "db.js", "sync.js",
  "manifest.webmanifest",
  "vendor/tesseract.min.js", "vendor/worker.min.js",
  "vendor/icon-192.png", "vendor/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      // Don't fail install if an optional vendor asset is missing.
      Promise.allSettled(SHELL_FILES.map((f) => c.add(f)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;          // never cache /sync POSTs
  if (url.pathname.endsWith("/health") || url.pathname.endsWith("/sync")) return;

  // Cache-first for same-origin shell + vendor (incl. wasm/traineddata fetched
  // by Tesseract at runtime); fall back to network and populate the cache.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        }).catch(() => hit)
      )
    );
  }
});
