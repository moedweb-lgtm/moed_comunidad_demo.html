// MOED+ service worker: primero red (siempre ves la última versión), caché solo si no hay conexión.
const V = 'moed-v1';
const SHELL = ['./moed_comunidad_demo.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function red(r) {
  try {
    const res = await fetch(r, { cache: 'no-cache' });
    if (res.ok) { const c = await caches.open(V); c.put(r, res.clone()); }
    return res;
  } catch (_) {
    const m = (await caches.match(r, { ignoreSearch: true })) || (r.mode === 'navigate' && (await caches.match(SHELL[0])));
    return m || Response.error();
  }
}

self.addEventListener('fetch', e => {
  const r = e.request;
  // Solo archivos de esta web. Firebase y demás servicios externos no se tocan.
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(red(r));
});
