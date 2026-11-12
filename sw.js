const CACHE = 'dictation-buddy-v0.3.1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './core.js', './ocr-utils.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dictation-buddy-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const u = new URL(request.url);
  if (u.origin !== self.location.origin) return; // Do not claim to cache OCR CDN bundles or language data.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(res => { if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(cache => cache.put('./index.html', clone)); } return res; }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(res => {
    if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(cache => cache.put(request, clone)); }
    return res;
  })));
});
