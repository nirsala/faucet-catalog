const CACHE_NAME = 'faucet-catalog-v1';
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/images/placeholder.svg',
  '/manifest.json'
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
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'store-data').map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For store pages, serve the HTML shell
  if (url.pathname.startsWith('/store/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/store/offline'))
    );
    return;
  }

  // For images, cache first
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/images/')) {
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

  // For API calls, network first with cache fallback
  if (url.pathname.startsWith('/api/store/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open('store-data').then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Default: cache first for static, network first for others
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
