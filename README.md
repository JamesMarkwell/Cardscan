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
Every push builds a **release** APK for `arm64-v8a` and attaches it to the run;
**Actions → Android → Run workflow** can build debug instead, or a wider set of
architectures.

Release, not debug, because React Native skips bundling the JavaScript into
debuggable variants: a debug APK has no JS inside it and expects `npx expo start`
to be running and reachable. Installed on its own it opens and closes again
immediately. Use debug only alongside a dev server; install release to just run
the app.

APKs are split per ABI, so each one carries native libraries for a single
architecture instead of all four. **Any phone from the last decade wants
`arm64-v8a`.** ONNX Runtime's libraries dominate the download, so this is the
difference between ~122 MB and something far smaller; release builds are
shrunk further by R8 and resource shrinking.

The splits, the shrinking and the R8 keep rules that ONNX Runtime needs live in
[`app/plugins/withAndroidReleaseSize.js`](app/plugins/withAndroidReleaseSize.js).
They are a config plugin rather than an edit to `android/` because that folder is
generated — `expo prebuild` would discard a hand edit.

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
cd app    && npm run typecheck && npm test   # scan pipeline, 57 tests
cd worker && npm run typecheck && npm test   # catalog import, 35 tests
cd ml     && python -m pytest -q             # index pack format, 7 tests
```

The worker tests need **Node 22.5 or newer** (`node:sqlite`). They run the real
import — migrations, upserts, the price join, the
published pack and the delta — against an actual SQLite database
(`worker/test/support/localD1.ts` puts `node:sqlite` behind the D1 interface),
with recorded TCGCSV responses standing in for the network. That is the code the
cron trigger runs to build the card database, so it is worth exercising for real
rather than mocking.

The index pack is written by Python and read by TypeScript, so
`app/src/__tests__/indexPack.test.ts` parses real fixtures produced by
`ml/index_pack.py`. A format change on either side fails there rather than on a
phone.

## Backend setup

One command, once:

```bash
cd worker && ./scripts/bootstrap.sh
```

It creates the D1 database and the R2 bucket, writes the database id into
`wrangler.toml` (commit that), applies the migrations, generates and stores an
admin token, and deploys. Log in first with `npx wrangler login`.

It prints the worker URL and the admin token at the end. Keep the token.

### Building the card database

Either from the machine you bootstrapped on:

```bash
curl -X POST "<worker-url>/admin/refresh?game=onepiece" \
  -H "Authorization: Bearer <admin-token>"
```

…or from GitHub: **Actions → Deploy worker → Run workflow**, which deploys and
then imports. That needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
`WORKER_ADMIN_TOKEN` as repository secrets.

The first import walks every set in the game at one request per second, so it
takes a while. After that the daily cron only fetches what changed.

Finally, in the app: **Settings → Catalog URL** → paste the worker URL → **Sync
catalog now**. Until a catalog is synced the scanner has nothing to match
against and says so.

## Licence

AGPL-3.0 — see [`LICENSE`](LICENSE). Card recognition uses
[CollectorVision](https://github.com/HanClinto/CollectorVision), which is AGPL,
and that licence carries over. Read [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md)
before any closed-source or paid release.
