# NEON DRIVE PWA / PWABuilder guide

The repository is now prepared as an installable Progressive Web App.

## Included

- `manifest.webmanifest` — app identity, fullscreen landscape display,
  theme/background colours, categories and launcher icons.
- `icons/` — 144–1024px icons, dedicated Android maskable icons,
  a 180px Apple touch icon and a browser favicon.
- `service-worker.js` — caches the complete game shell after the first
  online load. Solo Practice therefore works offline.
- `offline.html` — branded offline fallback.
- `pwa.js` — service-worker registration/update checks and a lobby
  **Install App** button that only appears when the browser says the
  web version is installable.
- Firebase is now failure-tolerant at boot: if its SDK cannot load
  offline, the game still starts and multiplayer explains that it
  needs a connection.

> Multiplayer itself always needs the internet because rooms and
> matchmaking live in Firebase Realtime Database. Live database
> traffic is deliberately never cached by the service worker.

## 1. Publish the web game over HTTPS first

PWABuilder packages a **live HTTPS URL**, not a GitHub repository page.
Any static host works because all PWA paths are relative and there is
no build step. Examples: GitHub Pages, Firebase Hosting, Netlify or
Vercel.

For GitHub Pages on this repository, a typical URL would be:

```text
https://hasanpersonal.github.io/car/
```

Enable it from **Repository Settings → Pages → Deploy from branch →
main → /(root)** after this PWA work has been merged into `main`.
Wait until these URLs all open successfully under your chosen site:

```text
/
manifest.webmanifest
service-worker.js
pwa.js
offline.html
icons/icon-512.png
icons/maskable-512.png
```

## 2. Run it through PWABuilder

1. Open [PWABuilder](https://www.pwabuilder.com/).
2. Enter the live game URL (for example
   `https://hasanpersonal.github.io/car/`), not
   `https://github.com/hasanpersonal/car`.
3. Review the report, manifest and service-worker sections.
4. Choose **Package for stores → Android**.
5. Pick a permanent application/package ID before publishing. It
   cannot be changed later for the same Play Store listing. A possible
   shape is:

   ```text
   com.hasanpersonal.neondrive
   ```

6. Download the generated package and any `.aab`, `.apk`, source or
   signing files offered. Keep signing material and passwords private
   and backed up; never commit them to this repository.

## 3. Android Digital Asset Links (important TWA verification step)

PWABuilder generates/uses an Android signing key and gives you a
SHA-256 certificate fingerprint. A Trusted Web Activity proves that
the Android app and website belong together through a file served
from the **origin root**:

```text
https://YOUR-DOMAIN/.well-known/assetlinks.json
```

Create that file on the host with values from PWABuilder:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "YOUR.PERMANENT.PACKAGE.ID",
      "sha256_cert_fingerprints": [
        "PASTE_THE_SHA256_FINGERPRINT_FROM_PWABUILDER"
      ]
    }
  }
]
```

Notes:

- This cannot be completed in advance because the fingerprint belongs
  to the signing key created for your app.
- If the game is hosted as a GitHub **project** site at
  `hasanpersonal.github.io/car/`, `assetlinks.json` still has to be at
  `hasanpersonal.github.io/.well-known/...`. That may require the
  separate user-site repository or, more simply, hosting NEON DRIVE
  at a subdomain/custom-domain root.
- Serve it as JSON over HTTPS without an HTML redirect page.

## 4. Updating the installed app

The Android TWA opens the live website, so most game updates only
require a normal web deployment. Whenever any precached shell file
changes, bump this line in `service-worker.js` before deploying:

```js
const SW_VERSION = 'v1';
```

For example change it to `'v2'`. Old caches are deleted when the new
service worker activates.

Regenerate launcher icons after editing the artwork script:

```bash
python3 -m pip install pillow
python3 tools/generate_pwa_icons.py
```

## 5. Store-listing material still to capture

PWABuilder does not require screenshots inside this manifest, and no
fake screenshots have been added. For Google Play (and for a richer
browser install prompt), capture real screenshots from the running
game on a phone after deployment, then add them to the store listing.
