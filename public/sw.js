// 책콕 서비스 워커: 휴대폰 알림(Web Push)만 처리한다. 화면 캐시는 하지 않는다(항상 최신 화면).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_e) {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || '책콕 새 소식'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '새로운 책 소식이 있어요',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'chaekkok',
      data: { url: data.url || '/#/alerts' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/#/alerts', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) {
          c.navigate(target)
          return c.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
