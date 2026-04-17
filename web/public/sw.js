// Minimal service worker for PWA installability.
//
// Purpose: Chrome / Edge / Android require a registered service worker with a
// `fetch` handler before they surface the "Install app" prompt. This worker
// intentionally does NOT cache anything — we pass every request straight
// through to the network so a bad deploy can't get pinned in a client cache.
//
// If you ever want real offline support or asset precaching, swap this out for
// a proper Workbox / Serwist setup (the stack has to be webpack-compatible for
// either plugin to run).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Non-GET requests (POST/PUT/...) must not be intercepted by a SW unless
  // it produces a Response. Leaving them to the browser default avoids
  // breaking mutations and uploads.
  if (event.request.method !== 'GET') return;

  // Network passthrough. Return the network response as-is; no caching.
  event.respondWith(fetch(event.request));
});
