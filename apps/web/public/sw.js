/* Frames of Me Upload service worker: exists only so the uploader is installable as an app.
 * It caches nothing (uploads must never go through a cache) and does not intercept fetches. */
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
