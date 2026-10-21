// Shows push notifications while Nikki is closed, and tells the server each one arrived (that is how the app learns
// that closed-app notifications really work on this device).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "Nikki", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || "Nikki", { body: d.body || "", tag: d.tag || "nikki", data: d, icon: "/nikki/icon-192.png" }),
      fetch("/api/push/ack", { method: "POST", credentials: "same-origin" }).catch(() => {}),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    }),
  );
});
