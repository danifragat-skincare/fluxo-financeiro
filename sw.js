// Service worker simples: guarda o "esqueleto" do app em cache para abrir
// mais rápido e funcionar offline para visualização. Os dados em si vêm
// sempre da rede quando disponível (GitHub API ou data.json).

const CACHE = "meu-fluxo-v2";
const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/sync.js",
  "./js/storage.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // não mexe em chamadas pra api.github.com

  if (url.pathname.endsWith("data.json")) {
    // dados: tenta rede primeiro, cai pro cache se offline
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // esqueleto do app: tenta sempre a rede primeiro (pra nunca travar numa
  // versão antiga), e só usa o cache se estiver offline
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
