// 定义缓存名称和版本，便于后续更新和管理
const CACHE_NAME = 'ptcg-cache-v16';
// 需要预缓存的静态资源列表
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
  '/ptcg/js/core/TsvCardDataLoader.js',
  '/ptcg/js/ui/CardGrid.js',
  '/ptcg/js/ui/ModalView.js',
  '/ptcg/js/ui/TabManager.js',
  '/ptcg/js/ui/StatsManager.js',
  '/ptcg/js/features/DeckEditor.js',
  '/ptcg/js/features/CardBrowser.js',
  '/ptcg/js/features/AIChatPanel.js',
  '/ptcg/js/services/AIChatService.js',
  '/ptcg/js/services/AISystemPrompt.js',
  '/ptcg/js/services/AICardDataService.js',
  '/ptcg/data/meta.json',
  '/ptcg/js/core/ApiKeyManager.js',
  '/ptcg/js/utils/helpers.js',
  '/ptcg/js/utils/ButtonManager.js',
  '/ptcg/js/utils/constants.js',
  '/ptcg/js/utils/TouchManager.js',
  '/ptcg/data_fast/pokemon.idx.tsv',
  '/ptcg/data_fast/pokemon.search.tsv',
  '/ptcg/data_fast/pokemon.filter.tsv',
  '/ptcg/data_fast/supporter.idx.tsv',
  '/ptcg/data_fast/item.idx.tsv',
  '/ptcg/data_fast/pokemon-tool.idx.tsv',
  '/ptcg/data_fast/stadium.idx.tsv',
  '/ptcg/data_fast/basic-energy.idx.tsv',
  '/ptcg/data_fast/special-energy.idx.tsv',
];
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
  '/ptcg/js/core/TsvCardDataLoader.js',
  '/ptcg/js/ui/CardGrid.js',
  '/ptcg/js/ui/ModalView.js',
  '/ptcg/js/ui/TabManager.js',
  '/ptcg/js/ui/StatsManager.js',
  '/ptcg/js/features/DeckEditor.js',
  '/ptcg/js/features/CardBrowser.js',
  '/ptcg/js/features/AIChatPanel.js',
  '/ptcg/js/services/AIChatService.js',
  '/ptcg/js/services/AISystemPrompt.js',
  '/ptcg/js/services/AICardDataService.js',
  '/ptcg/js/services/AIAnalysisService.js',
  '/ptcg/data/meta.json',
  '/ptcg/js/core/ApiKeyManager.js',
  '/ptcg/js/utils/helpers.js',
  '/ptcg/js/utils/ButtonManager.js',
  '/ptcg/js/utils/constants.js',
  '/ptcg/js/utils/TouchManager.js',
  '/ptcg/data_fast/pokemon.idx.tsv',
  '/ptcg/data_fast/pokemon.search.tsv',
  '/ptcg/data_fast/pokemon.filter.tsv',
  '/ptcg/data_fast/supporter.idx.tsv',
  '/ptcg/data_fast/item.idx.tsv',
  '/ptcg/data_fast/pokemon-tool.idx.tsv',
  '/ptcg/data_fast/stadium.idx.tsv',
  '/ptcg/data_fast/basic-energy.idx.tsv',
  '/ptcg/data_fast/special-energy.idx.tsv',
  // 可以根据需要继续添加其他核心JS文件
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

// 预缓存资源路径集合，用于快速查找
const precacheSet = new Set(urlsToCache);

// 检查是否是图片请求
function isImageRequest(url) {
  return /\.(png|webp|jpg|jpeg|gif|svg)(\?|$)/i.test(url) ||
         url.includes('/ptcg/images/');
}

// 拦截请求
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const pathname = requestUrl.pathname;

  // 图片请求：直接走网络，不缓存（由浏览器缓存层处理）
  if (isImageRequest(pathname)) {
    return; // 不拦截，浏览器原生处理
  }

  // 预缓存资源：Cache-First + 后台更新
  if (precacheSet.has(pathname) || pathname.startsWith('/ptcg/data_fast/') ||
      pathname.startsWith('/ptcg/js/') || pathname.startsWith('/ptcg/css/') ||
      pathname === '/ptcg/' || pathname === '/ptcg/index.html') {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        const fetched = fetch(event.request).then(function(networkResponse) {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone).catch(function(){});
            });
          }
          return networkResponse;
        }).catch(function(){
          return cached || new Response('Offline', {status: 503});
        });
        return cached || fetched;
      })
    );
    return;
  }

  // 其他请求（data JSON、manifest 等）：网络优先，缓存兜底
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});