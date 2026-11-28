// Shows push notifications while Nikki is closed, and tells the server each one arrived (that is how the app learns
// that closed-app notifications really work on this device).
//
// Payloads come in Nikki's own shape ({ title, body, tag, url, badge }) and, when the server knows its public
// address, also carry Declarative Web Push fields ({ web_push: 8030, notification: {...}, app_badge }). Both are
// handled here; Safari can also show the declarative form by itself if this worker isn't running.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/** Only paths inside Nikki are opened from a notification. */
function safePath(u) {
  try {
    const url = new URL(u || "/", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "Nikki", body: event.data ? event.data.text() : "" };
  }
  const n = d.notification || {};
  const title = d.title || n.title || "Nikki";
  const body = d.body || n.body || "";
  const url = safePath(d.url || n.navigate);
  const badge = typeof d.badge === "number" ? d.badge : d.app_badge;
  const tasks = [
    self.registration.showNotification(title, { body, tag: d.tag || n.tag || "nikki", data: { ...d, url }, icon: "/nikki/icon-192.png" }),
    fetch("/api/push/ack", { method: "POST", credentials: "same-origin" }).catch(() => {}),
  ];
  if (typeof badge === "number" && self.navigator && "setAppBadge" in self.navigator) tasks.push(self.navigator.setAppBadge(badge).catch(() => {}));
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if ("navigate" in c && url !== "/") return c.navigate(url).then((w) => (w || c).focus());
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
