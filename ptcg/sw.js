// PTCG Service Worker
var CACHE_NAME = 'ptcg-cache-v19';

var URLS = [
  '/ptcg/','/ptcg/index.html',
  '/ptcg/css/main.css','/ptcg/css/ptcg.css',
  '/ptcg/js/main.js',
  '/ptcg/js/core/CardManager.js','/ptcg/js/core/SearchEngine.js',
  '/ptcg/js/core/StorageService.js','/ptcg/js/core/DeckManager.js',
  '/ptcg/js/core/ImageLoader.js','/ptcg/js/core/TsvCardDataLoader.js',
  '/ptcg/js/core/ApiKeyManager.js',
  '/ptcg/js/ui/CardGrid.js','/ptcg/js/ui/ModalView.js',
  '/ptcg/js/ui/TabManager.js','/ptcg/js/ui/StatsManager.js',
  '/ptcg/js/features/DeckEditor.js','/ptcg/js/features/CardBrowser.js',
  '/ptcg/js/features/AIChatPanel.js',
  '/ptcg/js/services/AIChatService.js','/ptcg/js/services/AISystemPrompt.js',
  '/ptcg/js/services/AICardDataService.js',
  '/ptcg/js/utils/helpers.js','/ptcg/js/utils/ButtonManager.js',
  '/ptcg/js/utils/constants.js','/ptcg/js/utils/TouchManager.js',
  '/ptcg/data/meta.json',
  '/ptcg/data_fast/pokemon.idx.tsv','/ptcg/data_fast/pokemon.search.tsv',
  '/ptcg/data_fast/pokemon.filter.tsv',
  '/ptcg/data_fast/supporter.idx.tsv','/ptcg/data_fast/item.idx.tsv',
  '/ptcg/data_fast/pokemon-tool.idx.tsv','/ptcg/data_fast/stadium.idx.tsv',
  '/ptcg/data_fast/basic-energy.idx.tsv','/ptcg/data_fast/special-energy.idx.tsv'
];
var PRECACHE = new Set(URLS);

// Install: precache one by one (避免 addAll 一个失败全体失败)
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all(URLS.map(function(url) {
        return cache.add(url).catch(function() { /* 单个失败不影响其他 */ });
      }));
    }).then(function() { return self.skipWaiting(); })
  );
});

// Activate: delete old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(n) {
        if (n !== CACHE_NAME) return caches.delete(n);
      }));
    }).then(function() { return self.clients.claim(); })
  );
});

// Fetch
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;

  // 图片：直接放行，SW 不拦截
  if (/\.(png|webp|jpg|jpeg|gif|svg)(\?|$)/i.test(u.pathname)) return;

  // 静态资源：缓存优先
  if (PRECACHE.has(u.pathname) ||
      u.pathname.startsWith('/ptcg/data_fast/') ||
      u.pathname.startsWith('/ptcg/js/') ||
      u.pathname.startsWith('/ptcg/css/')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        var net = fetch(e.request).then(function(r) {
          if (r && r.ok) {
            var copy = r.clone();
            caches.open(CACHE_NAME).then(function(c) {
              c.put(e.request, copy);
            });
          }
          return r;
        });
        return cached || net;
      })
    );
  }
});
