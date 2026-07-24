// Service Worker for PTCG
const CACHE_NAME = 'ptcg-cache-v16';

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
];

const precacheSet = new Set(urlsToCache);

// Install
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(urlsToCache); })
      .then(function() { return self.skipWaiting(); })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(n) {
        if (n !== CACHE_NAME) return caches.delete(n);
      }));
    }).then(function() { return self.clients.claim(); })
  );
});

// Fetch: skip images, cache JS/CSS/TSV/HTML
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  var path = url.pathname;

  // Images go straight to network — no SW caching
  if (/\.(png|webp|jpg|jpeg|gif|svg)(\?|$)/i.test(path)) return;

  // Static files: cache-first with background update
  var isStatic = precacheSet.has(path) ||
    path.startsWith('/ptcg/data_fast/') ||
    path.startsWith('/ptcg/js/') ||
    path.startsWith('/ptcg/css/') ||
    path === '/ptcg/' ||
    path === '/ptcg/index.html';

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        var fetched = fetch(event.request).then(function(resp) {
          if (resp && resp.status === 200) {
            var clone = resp.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone).catch(function() {});
            });
          }
          return resp;
        }).catch(function() { return cached; });
        return cached || fetched;
      })
    );
    return;
  }

  // Everything else (data JSON, etc.): network first
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
