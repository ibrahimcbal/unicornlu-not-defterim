// Not Defterim servis çalışanı: uygulama dosyalarını önbelleğe alır, çevrimdışı açılmayı sağlar.
// Strateji: aynı kaynaktaki dosyalar için önce ağ (hep güncel), ağ yoksa önbellek. GitHub API'ye hiç dokunmaz.
const VERSION = '1.0.0';
const CACHE = 'not-defterim-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/sync.js',
  'js/dom.js',
  'js/palette.js',
  'js/fx.js',
  'fonts/fredoka-latin-wght-normal.woff2',
  'fonts/fredoka-latin-ext-wght-normal.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('not-defterim-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // api.github.com vb. doğrudan ağa gider

  const isFont = /\.(woff2?|png|svg)$/.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isFont) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('index.html') : null) || (await cache.match('./'));
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
