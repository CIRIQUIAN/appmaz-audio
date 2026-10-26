const PREFIX = 'appmaz-touch-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE = PREFIX + 'v2';
const ASSETS = ['./index.html','./style.css','./app.js','./core.mjs','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];
const allowed = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  // Never cache API calls, user data, audio, or credentials.
  if (event.request.method !== 'GET' || !allowed.has(event.request.url)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
