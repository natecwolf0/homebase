// Minimal service worker so the browser offers "Install app". It deliberately
// caches nothing — the app needs the live database anyway, and this guarantees
// you never see a stale version after a redeploy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
