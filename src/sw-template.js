/* Service worker của Hát ra nhạc (được sinh lúc build). */
const BUILD = '__BUILD_ID__';
const CACHE = 'hrn-app-' + BUILD;
const SAMPLES = 'hrn-samples'; // tiếng piano, giữ lại qua các bản cập nhật
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => undefined)))),
  );
  // không tự kích hoạt: trang sẽ hiện thông báo cập nhật rồi gửi SKIP_WAITING
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hrn-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // tiếng piano (tonejs.github.io): lấy từ cache trước, để dùng được khi mất mạng
  if (url.hostname === 'tonejs.github.io' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(
      caches.open(SAMPLES).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((r) => {
              if (r.ok) c.put(req, r.clone());
              return r;
            }),
        ),
      ),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  // luôn hỏi máy chủ về phiên bản mới
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/sw.js')) return;

  // trang chính: ưu tiên mạng (để nhận bản mới), mất mạng thì dùng bản đã lưu
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return r;
        })
        .catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || caches.match(req))),
    );
    return;
  }

  // tài nguyên đã đóng gói (tên có mã hash, không đổi): ưu tiên cache
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok && url.pathname.includes('/assets/')) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return r;
        }),
    ),
  );
});
