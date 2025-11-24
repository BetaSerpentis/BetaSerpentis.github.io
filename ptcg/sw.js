// 定义缓存名称和版本，便于后续更新和管理
const CACHE_NAME = 'ptcg-cache-v1';
// 需要预缓存的关键静态资源列表
const urlsToCache = [
  '/ptcg/',
  '/ptcg/index.html',
  '/ptcg/css/main.css',
  '/ptcg/css/ptcg.css',
  '/ptcg/js/main.js',
  '/ptcg/js/core/CardManager.js',
  '/ptcg/js/core/SearchEngine.js',
  '/ptcg/js/core/StorageService.js',
  '/ptcg/js/core/DeckManager.js',
  '/ptcg/js/core/ImageLoader.js',
  '/ptcg/js/ui/CardGrid.js',
  '/ptcg/js/ui/ModalView.js',
  '/ptcg/js/ui/TabManager.js',
  '/ptcg/js/ui/DeckTabs.js',
  '/ptcg/js/ui/StatsManager.js',
  '/ptcg/js/features/DeckEditor.js',
  '/ptcg/js/features/CardBrowser.js',
  '/ptcg/js/utils/helpers.js',
  '/ptcg/js/utils/ButtonManager.js',
  '/ptcg/js/utils/constants.js',
  // 可以根据需要继续添加其他核心JS文件
  // 例如：'/ptcg/data/pokemon-cards.json' （如果数据量不大且关键）
];

// 安装阶段：预缓存关键静态资源
self.addEventListener('install', function(event) {
  console.log('🚀 Service Worker 安装阶段开始');
  // event.waitUntil 确保Service Worker在缓存完成之前不会进入下一阶段
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('📦 已打开缓存，开始添加静态资源');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('✅ 所有关键资源已成功缓存');
        // 跳过等待阶段，让新的Service Worker安装后立即激活
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('❌ 缓存关键资源时出错:', error);
      })
  );
});

// 激活阶段：清理旧缓存
self.addEventListener('activate', function(event) {
  console.log('✨ Service Worker 激活阶段开始');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          // 删除所有旧版本的缓存
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ 正在清理旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // 激活后立即控制所有客户端（如打开的标签页）
      console.log('🎯 Service Worker 已激活并控制客户端');
      return self.clients.claim();
    })
  );
});

// 拦截请求：使用Stale-While-Revalidate策略
self.addEventListener('fetch', function(event) {
  // 检查请求是否为我们关心的类型（例如同源的GET请求）
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return; // 直接放行不处理
  }

  event.respondWith(
    caches.match(event.request)
      .then(function(cachedResponse) {
        // 无论缓存是否存在，都立即返回缓存的响应（stale）
        const fetchPromise = fetch(event.request)
          .then(function(networkResponse) {
            // 网络请求成功，用新响应更新缓存
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then(function(cache) {
                  cache.put(event.request, responseClone);
                });
            }
            return networkResponse;
          })
          .catch(function() {
            // 网络请求失败，如果连缓存也没有，可以根据情况返回一个兜底页面
            if (!cachedResponse) {
              // 例如，可以返回一个预设的离线页面
              // return caches.match('/ptcg/offline.html');
            }
            // 如果没有兜底，这里返回undefined，最终会返回cachedResponse
          });

        // 优先返回缓存的内容，没有缓存则等待网络请求
        return cachedResponse || fetchPromise;
      })
  );
});