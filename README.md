# CardScan

A multi-game trading card scanner and collection tracker — Pokémon, One Piece,
Magic, Yu-Gi-Oh! and Lorcana. Point the camera at a card and it identifies the
exact printing, tells you how sure it is, and adds it to your collection.

Scanning happens **on the phone**: it is fast, works in airplane mode, and costs
nothing per scan. Cloudflare only does the boring daily job of refreshing card
lists and prices.

> The full build plan, phase by phase, is in [`docs/PLAN.md`](docs/PLAN.md).

## How a scan works

1. **Find the card.** CollectorVision's Cornelius model returns the four corners.
2. **Gate.** Hold the frame until the quad is steady, sharp, and fills enough of
   the view — the on-screen text says which of those is missing.
3. **Flatten.** A perspective dewarp turns the quad into a 448×448 crop.
4. **Fingerprint.** CollectorVision's Milo model turns the crop into 128 numbers.
   The 180°-rotated crop is embedded too and the stronger match wins.
5. **Search.** Cosine similarity against every card's fingerprint, on device.
6. **Pick the printing.** When one artwork was printed in several sets, the set
   code and collector number in the bottom strip decide between them.
7. **Say how sure it is.** High / Check / Low. Low shows the top candidates to
   tap instead of guessing.

## Layout

| Path | What |
|---|---|
| `app/` | The Expo / React Native app (Android and iOS from one codebase) |
| `worker/` | Cloudflare Worker, D1 schema, daily refresh |
| `ml/` | Nightly fingerprint job and the index pack format |
| `docs/` | Build plan, third-party notes |
| `testset/` | Labelled phone photos for the accuracy harness |

## Building the Android app

The APK is built in CI — see [`.github/workflows/android.yml`](.github/workflows/android.yml).
Every push builds a debug APK and attaches it to the run as an artifact, and
**Actions → Android → Run workflow** can build a release variant.

To build locally you need the Android SDK (via Android Studio) and JDK 17:

```bash
cd app
npm ci
npx expo prebuild --platform android   # regenerates android/ from app.json
cd android && ./gradlew assembleDebug
# APK: app/android/app/build/outputs/apk/debug/app-debug.apk
```

`android/` is not committed: it is generated from `app.json`, so configuration
changes go in `app.json`, not in the native project.

To run on a plugged-in phone with live reload:

```bash
cd app && npx expo run:android
```

## Checks

```bash
cd app    && npm run typecheck && npm test   # pipeline logic, 57 tests
cd worker && npm run typecheck && npm test   # catalog normalisation
cd ml     && python -m pytest -q             # index pack format
```

The index pack is written by Python and read by TypeScript, so
`app/src/__tests__/indexPack.test.ts` parses real fixtures produced by
`ml/index_pack.py`. A format change on either side fails there rather than on a
phone.

## Backend setup

```bash
cd worker
npx wrangler d1 create cardscan          # put the id in wrangler.toml
npx wrangler r2 bucket create cardscan-packs
npm run migrate:remote
npx wrangler secret put WORKER_ADMIN_TOKEN
npm run deploy
```

Then put the deployed URL into the app under **Settings → Catalog URL** and tap
**Sync catalog now**.

## Licence

AGPL-3.0 — see [`LICENSE`](LICENSE). Card recognition uses
[CollectorVision](https://github.com/HanClinto/CollectorVision), which is AGPL,
and that licence carries over. Read [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md)
before any closed-source or paid release.
