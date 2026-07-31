// 周家财务 — Service Worker (cache-first)

const CACHE_NAME = 'zhou-finance-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/constants.js',
  './js/utils.js',
  './js/storage.js',
  './js/model.js',
  './js/ui/confirmDialog.js',
  './js/ui/summaryBar.js',
  './js/ui/filterBar.js',
  './js/ui/recordList.js',
  './js/ui/entryForm.js',
  './manifest.json'
];

// 安装：预缓存所有 App Shell 文件
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.allSettled(
      PRECACHE_URLS.map(url =>
        fetch(url, { cache: 'no-cache' })
          .then(response => {
            if (!response.ok) throw new Error(`Failed to fetch ${url}`);
            return caches.open(CACHE_NAME).then(cache => cache.put(url, response));
          })
          .catch(err => console.warn('Precache failed for', url, err))
      )
    ).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 请求拦截：Cache-first，后台更新
self.addEventListener('fetch', event => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;
  // 只处理同源请求
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // 后台发起网络请求更新缓存
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse.ok) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        }
        return networkResponse;
      }).catch(() => {
        // 网络失败，如果有缓存就走缓存
      });

      // 优先返回缓存，同时后台更新
      return cached || fetchPromise;
    })
  );
});
