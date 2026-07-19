self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const notificationUrl = typeof event.notification.data?.url === "string"
      ? event.notification.data.url
      : "/";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existingWindow = windows.find((client) => client.url === notificationUrl)
      ?? windows.find((client) => "focus" in client);
    if (existingWindow) return existingWindow.focus();
    return self.clients.openWindow(notificationUrl);
  })());
});
