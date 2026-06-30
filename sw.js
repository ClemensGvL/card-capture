// Service worker.
//  - App code (HTML/JS/manifest): NETWORK-FIRST when online, so you always get
//    the latest version and never get stuck on stale cached code. Falls back to
//    cache when offline.
//  - Big OCR assets under vendor/ (wasm, traineddata, core, worker): CACHE-FIRST,
//    so capture works fully offline once they've been fetched.
const VERSION = "v5";
const SHELL = "shell-" + VERSION;

const PRECACHE = [
  "./", "index.html", "app.js", "db.js", "sync.js", "manifest.webmanifest",
  "vendor/tesseract.min.js", "vendor/worker.min.js",
  "vendor/icon-192.png", "vendor/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(PRECACHE.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isVendorAsset(url) {
  return url.pathname.includes("/vendor/");
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;            // never touch POSTs
  if (url.origin !== self.location.origin) return;   // ignore GitHub API etc.

  // Cache-first for the heavy, stable OCR assets.
  if (isVendorAsset(url)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }

  // Network-first for app code: fresh when online, cached fallback when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});
