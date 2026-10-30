/* NEON DRIVE service worker.
 *
 * IMPORTANT RELEASE STEP: bump SW_VERSION whenever the cached game files
 * change. The old static cache is then deleted during activation, so an
 * installed app cannot get stuck serving a mixture of two releases.
 */
const SW_VERSION = 'v1';
const STATIC_CACHE = `neon-drive-static-${SW_VERSION}`;
const RUNTIME_CACHE = `neon-drive-runtime-${SW_VERSION}`;
const FIREBASE_SDK_CACHE = 'neon-drive-firebase-sdk-9.6.1';
const KEEP_CACHES = new Set([STATIC_CACHE, RUNTIME_CACHE, FIREBASE_SDK_CACHE]);

/* All URLs are relative to the service-worker scope. This deliberately
 * works both at a domain root and in a GitHub Pages project path such as
 * https://hasanpersonal.github.io/car/. */
const APP_SHELL = [
    './',
    './index.html',
    './offline.html',
    './manifest.webmanifest',
    './style.css',
    './script.js',
    './scene3d.js',
    './car3d.js',
    './pwa.js',
    './vendor/three.min.js',
    './icons/icon-144.png',
    './icons/icon-192.png',
    './icons/icon-256.png',
    './icons/icon-384.png',
    './icons/icon-512.png',
    './icons/icon-1024.png',
    './icons/maskable-192.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];

/* Multiplayer still needs the live Firebase database, but caching its SDK
 * lets the app shell boot cleanly offline (the game itself then offers
 * Solo Practice and explains that multiplayer needs a connection). */
const FIREBASE_SDK_URLS = [
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-database-compat.js'
];

const isCacheable = (response) =>
    response && (response.status === 200 || response.type === 'opaque');

async function cacheFirebaseSdk(cache) {
    await Promise.allSettled(FIREBASE_SDK_URLS.map(async (url) => {
        try {
            const response = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
            if (isCacheable(response)) await cache.put(url, response);
        } catch (_) {
            /* Optional offline enhancement only; never fail SW installation. */
        }
    }));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const staticCache = await caches.open(STATIC_CACHE);
        await staticCache.addAll(APP_SHELL);
        const firebaseCache = await caches.open(FIREBASE_SDK_CACHE);
        await cacheFirebaseSdk(firebaseCache);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter((name) => name.startsWith('neon-drive-') && !KEEP_CACHES.has(name))
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

async function staleWhileRevalidate(event, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(event.request);
    const network = fetch(event.request).then(async (response) => {
        if (isCacheable(response)) await cache.put(event.request, response.clone());
        return response;
    });
    event.waitUntil(network.catch(() => null));
    return cached || network;
}

async function networkFirstNavigation(event) {
    const cache = await caches.open(STATIC_CACHE);
    try {
        const response = await fetch(event.request);
        if (isCacheable(response)) {
            /* Keep one canonical offline copy, regardless of query strings
             * used by shortcuts or an installed-app launch URL. */
            await cache.put('./index.html', response.clone());
        }
        return response;
    } catch (_) {
        return (await cache.match('./index.html', { ignoreSearch: true })) ||
               (await cache.match('./offline.html', { ignoreSearch: true })) ||
               Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    let url;
    try { url = new URL(request.url); } catch (_) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    /* Live multiplayer/database traffic must never be cached. WebSocket
     * traffic is not fetch, but Firebase also uses HTTPS requests. */
    if (url.hostname.endsWith('.firebasedatabase.app') ||
        url.hostname.endsWith('.firebaseio.com') ||
        url.hostname.endsWith('.googleapis.com')) {
        return;
    }

    if (FIREBASE_SDK_URLS.includes(url.href)) {
        event.respondWith(staleWhileRevalidate(event, FIREBASE_SDK_CACHE));
        return;
    }

    /* Everything below is same-origin app content. Leave all other
     * cross-origin requests to the browser's normal network handling. */
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirstNavigation(event));
        return;
    }

    event.respondWith(staleWhileRevalidate(event, STATIC_CACHE));
});
