// Keeps MasterTest Web's large, unchanging files (Python, its libraries, the app and fonts) in the
// browser after the first visit, so the page starts quickly next time. Everything else (the page,
// its scripts, build.json) is fetched from the site first, so updates show at once.
// Nothing here involves the user's files: they never leave the page.
"use strict";

const CORE = "mastertest-core-0.29.5";   // Python and its libraries: replaced with a new Pyodide
const APP = "mastertest-app";                   // app-<version>.zip and fonts: old app versions removed
const LONG_LIVED = /\/(pyodide|wheels)\/|\/fonts\/|\/app-[0-9.]+\.zip$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("mastertest-core-") && name !== CORE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !LONG_LIVED.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(/\/(pyodide|wheels)\//.test(url.pathname) ? CORE : APP);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok) {
      if (/\/app-[0-9.]+\.zip$/.test(url.pathname)) {     // only the current app version is kept
        for (const old of await cache.keys()) if (/\/app-[0-9.]+\.zip$/.test(old.url)) await cache.delete(old);
      }
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
