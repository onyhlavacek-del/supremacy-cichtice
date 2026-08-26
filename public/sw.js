// Service worker: cache statických souborů, síť má přednost (hra je živá)
const CACHE = 'supremacy-v2';
const ASSETS = ['/', '/style.css', '/map.js', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const cacheable = url.pathname === '/api/map' || url.pathname === '/api/rules' || url.pathname.startsWith('/img/');
  if (url.pathname.startsWith('/api/') && !cacheable) return; // živé API vždy ze sítě
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)),
  );
});
