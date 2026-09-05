/* Sentinel PWA service worker v2: red primero para shell configurable, purga total de v1. */
var CACHE = "sentinel-v3";
var PRECACHE = ["./", "index.html", "styles.css", "manifest.webmanifest"];
var NETWORK_FIRST = ["./", "index.html", "app.js", "config.js", "sw.js"];
function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  var p = url.pathname;
  return NETWORK_FIRST.some(function (n) { return p.endsWith(n.replace("./", "/")) || (n === "./" && (p === "/" || p.endsWith("/sentinel-app/") || p.endsWith("/sentinel-app"))); });
}
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }).catch(function () {}));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (isShell(url)) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); }); }
        return res;
      }).catch(function () { return caches.match(e.request); })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); }); }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
