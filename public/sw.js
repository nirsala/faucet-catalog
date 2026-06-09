const CACHE_NAME = 'faucet-catalog-v2';
const STATIC_ASSETS = [
  '/css/style.css',
  '/images/placeholder.svg',
  '/images/palyam-logo.png',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3/dist/JsBarcode.all.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'store-data' && k !== 'store-images').map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Store pages — network first, cache the HTML shell
  if (url.pathname.startsWith('/store/')) {
    event.respondWith(
      caches.match('/store-shell').then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('/store-shell', clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Images — cache first, update in background (stale-while-revalidate)
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/images/')) {
    event.respondWith(
      caches.open('store-images').then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // API store data — network first, cache fallback
  if (url.pathname.startsWith('/api/store/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open('store-data').then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Non-critical API calls (clicks, cart-events) — network only, fail silently offline
  if (url.pathname.startsWith('/api/clicks') || url.pathname.startsWith('/api/cart-events')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // Static assets & CDN — cache first, refresh in background
  if (url.pathname.startsWith('/css/') || url.pathname.endsWith('.js') ||
      url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Default: network first, cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
