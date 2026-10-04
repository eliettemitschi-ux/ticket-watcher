// Service worker: makes the page installable and lets it open offline with the
// last data it saw. Network-first for everything (so an update is never stuck
// behind a stale cache), falling back to the cache when the network fails or is
// too slow. Bump CACHE when the shell files change shape.

const CACHE = 'ticket-watcher-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 4000;

// Saved at install too, so a first-time visitor who goes offline straight
// away still sees data. Best-effort: a blip here must not fail the install.
const DATA = ['./events.json', './status.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).then(() => Promise.allSettled(DATA.map((url) => cache.add(url)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT_MS)),
  ]);
}

async function networkFirst(request) {
  try {
    // cache: 'no-cache' makes the browser re-check with the server instead of
    // reusing its own 10-minute HTTP cache, so a page update is picked up on
    // the very next open rather than up to 10 minutes later.
    const response = await fetchWithTimeout(new Request(request, { cache: 'no-cache' }));
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
