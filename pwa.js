/* NEON DRIVE PWA registration and install prompt.
 *
 * Gameplay stays in script.js. This small classic script only registers
 * the root service worker and exposes Chrome's deferred install prompt
 * through the (initially hidden) lobby button when the browser offers it.
 */
(() => {
    'use strict';

    const installButton = document.getElementById('install-app-btn');
    const isStandalone =
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', async () => {
            try {
                const registration = await navigator.serviceWorker.register(
                    './service-worker.js',
                    { scope: './', updateViaCache: 'none' }
                );
                /* Ask for a fresh worker on each launch; activation deletes
                 * old NEON DRIVE caches when SW_VERSION changes. */
                if (registration.update) registration.update().catch(() => {});
            } catch (error) {
                console.warn('NEON DRIVE service worker registration failed:', error);
            }
        }, { once: true });
    }

    let deferredInstallPrompt = null;

    window.addEventListener('beforeinstallprompt', (event) => {
        /* Keep the browser mini-infobar out of the lobby; the button is
         * the one clear, user-controlled install action. */
        event.preventDefault();
        if (isStandalone) return;
        deferredInstallPrompt = event;
        if (installButton) installButton.hidden = false;
    });

    if (installButton) {
        installButton.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            installButton.hidden = true;
            try {
                await deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
            } catch (_) {
                /* The prompt can only be used once; Chrome may offer it again. */
            } finally {
                deferredInstallPrompt = null;
            }
        });
    }

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        if (installButton) installButton.hidden = true;
    });
})();
