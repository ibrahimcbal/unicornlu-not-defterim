// Not Defterim servis çalışanı: uygulama dosyalarını önbelleğe alır, çevrimdışı açılmayı sağlar.
// Strateji: aynı kaynaktaki dosyalar için önce ağ (hep güncel), ağ yoksa önbellek. GitHub API'ye hiç dokunmaz.
const VERSION = '1.1.0';
const CACHE = 'not-defterim-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/boot-theme.js',
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

  // ?title=…&text=… (paylaşım) ve ?new=… (kısayol) istekleri önbelleğe yazılmaz.
  if (url.search) {
    event.respondWith(
      fetch(req).catch(async () => {
        const c = await caches.open(CACHE);
        return (req.mode === 'navigate' && ((await c.match('index.html')) || (await c.match('./')))) || Response.error();
      }),
    );
    return;
  }

  const isFont = /\.(woff2?|png|svg)$/.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isFont) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      const fallback = async () =>
        (await cache.match(req)) ||
        (req.mode === 'navigate' ? (await cache.match('index.html')) || (await cache.match('./')) : null);
      const network = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      });
      event.waitUntil(network.catch(() => {}));
      const cached = await fallback();
      if (!cached) return network;
      // Ağ yavaşsa 3 sn sonra önbellekten aç (zayıf bağlantıda boş ekran kalmasın).
      const timer = new Promise((resolve) => setTimeout(() => resolve(cached), 3000));
      return Promise.race([network.catch(() => cached), timer]);
    })(),
  );
});
