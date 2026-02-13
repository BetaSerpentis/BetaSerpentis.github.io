// sw.js - Service Worker 缓存策略
const CACHE_NAME = 'pokemon-match-v1';
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
  './utils/AnimationManager.js',
  './ui/PokemonCell.js',
  './ui/BallCounter.js',
  './ui/MessageBoard.js'
];

// 安装 Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('缓存已打开');
        return cache.addAll(urlsToCache);
      })
  );
});

// 拦截请求，返回缓存
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果找到缓存，返回缓存
        if (response) {
          return response;
        }
        
        // 否则发起网络请求
        return fetch(event.request).then(
          response => {
            // 检查是否是有效的响应
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // 缓存图片资源
            if (event.request.url.match(/\.(png|jpg|jpeg|svg|gif)$/)) {
              const responseToCache = response.clone();
              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseToCache);
                });
            }
            
            return response;
          }
        );
      })
  );
});

// 清理旧缓存
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});