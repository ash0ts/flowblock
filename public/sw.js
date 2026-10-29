const CACHE = "flowblock-shell-v3";
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const shell = await fetch("/");
      if (!shell.ok) throw new Error("The app shell could not be cached");
      await cache.put("/", shell.clone());
      const html = await shell.text();
      const assets = [
        ...html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"<>]+)"/g),
      ]
        .map(
          (match) =>
            new URL(match[1].replaceAll("&amp;", "&"), self.location.origin),
        )
        .filter(
          (url) =>
            url.origin === self.location.origin &&
            url.pathname.startsWith("/_next/static/"),
        )
        .map((url) => url.href);
      await cache.addAll([
        ...new Set(["/icon.svg", "/manifest.webmanifest", ...assets]),
      ]);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("flowblock-shell-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/share") ||
    url.search
  )
    return;
  if (
    !(
      url.pathname === "/" ||
      url.pathname.startsWith("/_next/static/") ||
      ["/icon.svg", "/manifest.webmanifest"].includes(url.pathname)
    )
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(event.request, copy)),
          );
        }
        return response;
      })
      .catch(
        async () =>
          (await (await caches.open(CACHE)).match(event.request)) ||
          Response.error(),
      ),
  );
});
