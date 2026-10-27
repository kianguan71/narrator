// sw.js - makes Narrator work offline and enables multi-core voice synthesis.
// Every same-origin response is served with COOP/COEP headers, which lets the
// voice engine use several CPU cores (GitHub Pages cannot set these headers itself).
// Registered as "sw.js?coi=0" to turn the headers off (fallback for old browsers).
const CACHE = 'narrator-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'doc.js', 'tts-worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'lib/kokoro.web.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/jszip.min.js'];
const COI = new URL(self.location.href).searchParams.get('coi') !== '0';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('narrator-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function withHeaders(resp) {
  if (!COI || !resp || resp.status === 0 || resp.type === 'opaque' || resp.type === 'opaqueredirect') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // voices etc.: browser default
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('.html') });
    const network = fetch(req).then(r => {
      if (r && r.ok && r.type === 'basic') cache.put(req, r.clone());
      return r;
    }).catch(() => null);
    const resp = cached || await network;
    if (cached) e.waitUntil(network);   // refresh in the background
    return withHeaders(resp || new Response('Offline', { status: 503 }));
  })());
});
