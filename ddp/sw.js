// sw.js - Service Worker 缓存策略（带条目上限，防止 iOS Safari 配额溢出）
const CACHE_NAME = 'pokemon-match-v3';
// 性能优化：限制运行时图片缓存上限，防止超出 iOS Safari ~50MB 配额
const MAX_RUNTIME_CACHE = 150;

const urlsToCache = [
  './',
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

// 安装 Service Worker — 预缓存核心文件 + 立即激活
self.addEventListener('install', event => {
  self.skipWaiting(); // 关键：不等待旧 SW 释放，立即接管
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 缓存已打开');
        return cache.addAll(urlsToCache);
      })
  );
});

// 拦截请求
self.addEventListener('fetch', event => {
  // 只处理同源请求
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }

        return fetch(event.request).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // 仅缓存图片资源，限制条目数
          if (event.request.url.match(/\.(png|jpg|jpeg|svg|gif|webp)$/)) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.keys().then(keys => {
                if (keys.length >= MAX_RUNTIME_CACHE) {
                  const toDelete = keys.slice(0, 20);
                  Promise.all(toDelete.map(k => cache.delete(k)));
                }
              }).then(() => {
                cache.put(event.request, responseToCache);
              });
            });
          }

          return response;
        }).catch(() => {
          if (event.request.url.match(/\.(png|jpg|jpeg|svg|gif|webp)$/)) {
            return new Response('', { status: 204 });
          }
          return new Response('Network error', { status: 408 });
        });
      })
  );
});

// 激活时：清理旧缓存 + 立即接管所有页面
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('[SW] 删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // 关键：立即接管所有页面，无需手动刷新
      return self.clients.claim();
    })
  );
});