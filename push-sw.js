self.addEventListener('push', function (event) {
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      let isFocused = false;
      for (let i = 0; i < clientList.length; i++) {
        if (clientList[i].focused) {
          isFocused = true;
          break;
        }
      }

      if (!isFocused && event.data) {
        try {
          const data = event.data.json();
          const options = {
            body: data.body || 'You have a new unacknowledged call waiting.',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            data: {
              url: data.url || '/#/staff'
            }
          };

          return self.registration.showNotification(data.title || 'New Service Request', options);
        } catch (e) {
          console.error('Error parsing push data', e);
        }
      }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      const urlToOpen = event.notification.data.url;
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url.includes(urlToOpen) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
