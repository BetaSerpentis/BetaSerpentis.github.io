// sw.js - Service Worker 仅缓存图片资源，JS/HTML 直通网络
const CACHE_NAME = 'pokemon-match-v3';
const MAX_RUNTIME_CACHE = 150;

// 仅预缓存核心 HTML 和 SW 自身依赖，不做全量 addAll（避免单文件失败导致整体失败）
const urlsToCache = [
  './index.html',
  './main.js',
  './manifest.json',
  './core/PokemonData.js',
  './core/GameBoard.js',
  './core/SummonSystem.js',
  './core/RuleEngine.js',
  './core/EvolutionManager.js',
  './utils/ImageLoader.js',
  './utils/AudioManager.js',
  './ui/PokemonCell.js',
  './ui/MessageBoard.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 逐个缓存，单个失败不阻塞整体
      return Promise.allSettled(
        urlsToCache.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] 预缓存失败:', url, err)
          )
        )
      );
    })
  );
});

self.addEventListener('fetch', event => {
  // 仅拦截图片请求；JS/HTML/CSS 等全部直通网络
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (!event.request.url.match(/\.(png|jpg|jpeg|svg|gif|webp)$/)) return;

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;

      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;

        const cloned = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.keys().then(keys => {
            if (keys.length >= MAX_RUNTIME_CACHE) {
              Promise.all(keys.slice(0, 20).map(k => cache.delete(k)));
            }
          }).then(() => cache.put(event.request, cloned));
        });

        return response;
      }).catch(() => new Response('', { status: 204 }));
    })
  );
});

self.addEventListener('activate', event => {
  const whitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(n => whitelist.includes(n) ? null : caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});