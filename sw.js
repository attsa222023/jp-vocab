// 版本號改變時，activate 事件會清掉舊快取並換上新的——
// 之後每次更新 app 的靜態檔案，記得順便把這個數字加一。
const CACHE_NAME = 'jp-vocab-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-init.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Firebase 的模組化 SDK 也一併快取，離線時 app.js 的 import 才不會失敗
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;
  // Firestore 的即時通訊/API 呼叫不攔截，交給 Firebase SDK 自己處理離線邏輯，
  // 攔截這些請求反而會干擾它內建的重試/離線佇列機制。
  if (url.includes('firestore.googleapis.com') || url.includes('googleapis.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // 離線又沒快取，就沒辦法了
      return cached || network;
    })
  );
});
