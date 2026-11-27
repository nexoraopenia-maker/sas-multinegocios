/* Service worker: la aplicación abre y navega sin internet. Los datos viven en IndexedDB.
 * Generado por scripts/build-sw.mjs; no editar public/sw.js. */
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const SHELL = __PAGES__;
const CACHE = `app-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...ASSETS, ...SHELL].map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = (await caches.keys()).filter((k) => k.startsWith('app-') && k !== CACHE);
    // Se conserva la versión anterior para las pestañas que aún la usan.
    await Promise.all(keys.slice(0, -1).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // La API y el SuperAdmin nunca se guardan en caché.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/super')) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
      return res;
    })));
    return;
  }

  if (request.mode === 'navigate') {
    // Red primero (con límite de espera); sin red, la página guardada.
    event.respondWith(Promise.race([fetch(request), timeout(4000)]).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(url.pathname)) || (await cache.match('/app')) || Response.error();
    }));
    return;
  }

  if (url.pathname === '/manifest.webmanifest') event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(request)));
});
