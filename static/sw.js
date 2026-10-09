'use strict';
// Service worker: сохраняет приложение в телефоне, чтобы оно открывалось без интернета.
// При каждом обновлении приложения номер версии увеличивается — здесь и в
// адресах файлов в .html (?v=...), чтобы телефоны точно скачали новые файлы.
const VERSION = 'v6';
const STATIC_CACHE = 'gym-static-' + VERSION;
const API_CACHE = 'gym-api';

const PRECACHE = [
  '/', '/progress', '/settings', '/login', '/friends',
  '/static/style.css', '/static/common.js', '/static/workout.js',
  '/static/progress.js', '/static/settings.js', '/static/friends.js',
  '/static/icons/icon-192.png', '/static/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // cache: 'reload' — брать файлы с сервера, а не из кэша браузера
      .then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== STATIC_CACHE && k !== API_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Сначала пробуем интернет (чтобы всегда была свежая версия).
// Если связи нет или она слишком медленная — показываем сохранённую копию.
async function networkFirst(request, cacheName, waitMs) {
  const cache = await caches.open(cacheName);
  // cache: 'no-cache' — всегда сверяться с сервером, не верить старой копии браузера
  const network = fetch(request, { cache: 'no-cache' }).then(resp => {
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  });
  network.catch(() => {});  // ошибку сети обработаем ниже
  const timeout = new Promise(resolve => setTimeout(resolve, waitMs, null));
  try {
    const resp = await Promise.race([network, timeout]);
    if (resp) return resp;
  } catch (e) { /* нет сети */ }
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  return network.catch(() => new Response('Нет интернета', { status: 503 }));
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request, API_CACHE, 6000));
  } else {
    event.respondWith(networkFirst(event.request, STATIC_CACHE, 3000));
  }
});
