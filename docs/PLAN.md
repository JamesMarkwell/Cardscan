# CardScan — Build Plan for Claude Code

A multi-game trading card scanner and collection tracker (Pokémon, One Piece, Magic, Yu-Gi-Oh!, Lorcana to start), matching the scanning accuracy of Collectr and TCGplayer. Card data and prices are hosted on Cloudflare and refreshed every day.

> **For Claude Code:** Work through the phases in order. Each phase ends with acceptance checks — do not start the next phase until they pass. Before any major change, security issue, or new feature not in this plan, stop and explain it to James in plain English first. Fix small bugs and typos without asking. When James needs to run commands, give exact step-by-step commands (which folder, what to type).

---

## 0. Plain-English summary (for James)

The "magic" in apps like TCGplayer and Collectr isn't one clever trick — it's a chain of five simple steps done well:

1. **Find the card** in the camera picture and flatten it (like a document scanner does).
2. **Turn the artwork into a fingerprint** — a list of numbers produced by a small AI model on the phone.
3. **Look up the closest fingerprints** in a pre-built index of every card (tens of thousands, searched in milliseconds).
4. **Read the small print** (set code and card number in the corner) to pick the exact printing when the same art was reprinted in several sets.
5. **Say how sure it is.** If it's not sure, show the top few guesses and let the user tap the right one.

Cloudflare does the boring daily job: download the latest card lists and prices, work out what's new, and publish small update files the app downloads overnight. Scanning itself happens on the phone, so it's fast, works offline, and costs nothing per scan.

---

## 1. What the research found

### TCGplayer
- Its scanner is powered by **Roca Vision**, the same computer vision used in its Roca card-sorting machines.
- Its distinguishing feature is that it **reports a confidence level for every match** (e.g. a "POOR" tier for matches it expects to be wrong), so users only double-check the doubtful ones. Every match links to one exact catalog item (a specific printing).
- Known weaknesses (from its own help pages): it doesn't always pick the right set when the same artwork was printed in multiple sets, and it can only identify non-English cards when an English card with the same artwork exists.
- Its scanning tips reveal what the model struggles with: busy backgrounds (a plain, contrasting surface works best), glare (they suggest tilting ~45° or using the flash), and off-centre sleeves.
- Recommended input for its bulk tool is small: minimum ~300×400 px; higher than ~100 DPI doesn't improve recognition. **Lesson: the matching works on a small, clean, flattened crop — resolution isn't the secret, clean framing is.**

### Collectr
- ("Countr" didn't turn up in searches — this plan assumes Collectr, the leading multi-game tracker. Tell James if it was a different app.)
- Identifies the exact **set, number and variant** (Normal / Foil / Reverse Foil) and lets you add quantity per variant. Scans in real time from the live camera (no shutter press).
- Covers 25+ games; portfolio valued daily from real sales data; trade analyser; raw and graded price history; social showcases. Freemium — PRO unlocks unlimited scans.

### How the good scanners work under the hood (open-source equivalents confirm the recipe)
- **Detect corners → dewarp → small embedding → nearest-neighbour search.** CollectorVision (open source) does exactly this: 4 corners, flatten to a 448×448 crop, 128-number fingerprint, matched against ~108k reference cards in under 100 ms on a laptop CPU.
- A free on-device tracker (collect_them_all) uses a custom-trained EfficientNet-B0 producing a 512-number fingerprint, compared against ~170,000 cards by cosine similarity, running entirely on the phone. Adding newly released cards only needs new fingerprints — **no retraining**.
- Layered fallbacks work well: perceptual hash for exact art → embeddings for close matches → OCR + lookup as last resort.
- The collector number and set symbol live in the bottom 10–15% of modern Pokémon cards — the right place to OCR for printing disambiguation.

### Data sources (important constraints)
| Source | What it gives | Notes |
|---|---|---|
| **TCGCSV** (tcgcsv.com) | TCGplayer categories, sets, products, prices for 89+ games, updated daily ~20:00 UTC; price archive back to Feb 2024 | Community hobby project. **TCGplayer's official API is closed to new developers**, which is why this exists. Treat as a dependency risk (see §8). |
| **Cardmarket downloads** | Official daily price guide + product catalogue for all games | Made public to all users in 2024. **Best source for UK/EU prices** (EUR → convert to GBP). |
| **Scryfall bulk data** | Full Magic catalog + images | Free, well-documented; attribution required. |
| **TCGdex / Pokémon TCG API** | Pokémon catalog + images (EN + JP) | Free. |
| **YGOPRODeck** | Yu-Gi-Oh! catalog + images | Free, has rate limits. |

**Do not scrape TCGplayer.com** — its Terms of Service prohibit crawling/scraping without permission.

---

## 2. Feature list ("best of both")

**Scanning**
- Live auto-scan: no shutter button; captures automatically when the card is steady and sharp. Haptic + sound on success.
- Exact printing: set, number, variant (normal/foil/reverse/1st edition), language.
- Confidence tiers (High / Check / Low). Low → show top-5 candidates with images to tap.
- Bulk mode: keep scanning a stack; results pile up in a review tray; fix any wrong ones, then add all at once.
- Works offline (catalog + index on device).
- Sleeved cards and moderate glare supported.

**Collection**
- Multiple portfolios/binders; quantity per variant and condition.
- Daily portfolio value chart; cost basis and gain/loss.
- Set completion tracker ("you have 142/210 of OP-07").
- Wishlist + price alerts.
- Trade analyser (both sides' value, fairness meter).
- Search/browse without scanning.
- Currency: **GBP default** (James is UK-based), USD/EUR selectable. Show both Cardmarket and TCGplayer prices.
- Export CSV in TCGplayer, Cardmarket, ManaBox and Moxfield formats.

**Later (not MVP):** accounts + cloud sync, AI condition/centering estimate, graded prices, social sharing.

---

## 3. Architecture

```
┌──────────────── Cloudflare ────────────────┐
│ Cron Trigger (daily 21:00 UTC)             │
│   → Workflow "daily-refresh" (steps):      │
│      1 fetch catalogs (TCGCSV, Scryfall,   │
│        TCGdex, YGOPRODeck, Cardmarket)     │
│      2 normalise → D1 (cards, printings)   │
│      3 prices → D1 (latest) + R2 snapshot  │
│      4 list new printings → queue for      │
│        fingerprinting                      │
│      5 publish manifest + delta packs → R2 │
│ Worker API: /manifest /search /card/:id    │
│ R2: images (thumbs), index packs, history  │
│ D1: catalog, latest prices, users (later)  │
└────────────────────────────────────────────┘
          ▲ new images           │ daily deltas
          │                      ▼
┌── Fingerprint job ──┐   ┌──── Phone app ────────────┐
│ GitHub Action runs  │   │ Camera → detect → dewarp  │
│ CollectorVision     │   │ → embed (CollectorVision  │
│ embedder on new     │   │   ONNX) → nearest match → │
│ card images,        │   │   OCR corner →            │
│ uploads to R2       │   │   confidence → result     │
└─────────────────────┘   │ Local SQLite: catalog,    │
                          │ prices, collection        │
                          └───────────────────────────┘
```

**Why fingerprinting isn't in a Worker:** Workers are great for fetching and reshaping data but have tight memory/CPU limits and no easy way to run an image model. A handful of new cards a day is trivial for a GitHub Action (Python + CollectorVision + ONNX Runtime CPU). **Decided: GitHub Actions.**

### Tech stack (decided)
- **App:** React Native + Expo (dev build, not Expo Go), TypeScript. Same approach as TradeSnap, one codebase for Android + iOS.
  - Camera: `react-native-vision-camera` with frame processors.
  - On-device model: **ONNX Runtime React Native** (`onnxruntime-react-native`) running CollectorVision's ONNX corner detector and embedder as-is. Use the NNAPI/XNNPACK execution providers on Android, CoreML on iOS, with CPU fallback. CollectorVision's JavaScript web scanner (`examples/web_scanner`) is the reference for pre-processing — port its logic rather than reinventing it.
  - OCR: Google ML Kit text recognition (on-device, free) via a VisionCamera plugin.
  - Local DB: `expo-sqlite`. Vector search: brute-force cosine over a Float16/int8 matrix in native code — 200k × 128 is fast enough; no vector DB needed.
- **Backend:** Cloudflare Workers (TypeScript, Hono), Workflows, Cron Triggers, D1, R2, Queues.
- **Recognition library:** CollectorVision (upstream repo `HanClinto/CollectorVision`, not a fork) — corner detection, dewarp to 448×448, 128-number fingerprint, nearest-neighbour search.
- **Nightly jobs:** GitHub Actions (Python 3.10+, `collectorvision` + `onnxruntime` CPU).
- **ML fine-tuning (only if needed, Phase 5):** Python, PyTorch, exported to ONNX.

> **Decisions made by James:** React Native, CollectorVision for recognition, GitHub Actions for the nightly fingerprint job.

---

## 4. Data model (D1)

```
games(id, name, tcgcsv_category_id, cardmarket_game_id)
sets(id, game_id, code, name, release_date, tcgcsv_group_id, cardmarket_expansion_id)
cards(id, game_id, name, art_id)                 -- one per distinct artwork
printings(id, card_id, set_id, number, rarity, variant, language,
          tcgplayer_product_id, cardmarket_product_id, scryfall_id, image_key,
          updated_at)
prices_latest(printing_id, source, currency, market, low, trend, avg7, avg30, as_of)
catalog_versions(version, created_at, printings_count, index_pack_key)
```

- `art_id` groups reprints with identical artwork — this is what the fingerprint matches; `printings` is what the OCR step picks between.
- Cross-source matching (TCGplayer ↔ Cardmarket ↔ Scryfall) by set code + collector number + name; log unmatched rows to a review table rather than guessing.
- Price history: daily compressed snapshot to R2 (`prices/YYYY-MM-DD.json.gz`); D1 keeps only the latest. App fetches history per card on demand via Worker.

### Update files the app downloads (R2)
- `manifest.json` — current version, per-game pack URLs, checksums.
- `games/{game}/catalog-{version}.sqlite.gz` — full catalog (first install).
- `games/{game}/delta-{from}-{to}.json.gz` — daily changes (new printings, price updates).
- `games/{game}/index-{version}.bin` — fingerprint matrix + `index-{version}.ids`.
- Thumbnails: `img/{printing_id}.webp` served via Worker with caching.

---

## 5. The scanning pipeline (the core — most effort goes here)

1. **Detect** (every frame, ~15 fps): CollectorVision's `NeuralCornerDetector` ONNX model finds the four card corners.
2. **Gate**: only continue when the quad is stable for ~5 frames, sharpness (Laplacian variance) above threshold, and card fills ≥40% of frame. Show a live outline; green when locked.
3. **Dewarp** to CollectorVision's 448×448 canonical crop. Also embed the 180°-rotated crop and keep the stronger result — CollectorVision notes its embeddings can be sensitive to upside-down cards and its own scanner does this by default.
4. **Embed** with CollectorVision's `NeuralEmbedder` → 128-number fingerprint.
5. **Search** local index → top-10 `art_id` candidates with cosine scores.
6. **Disambiguate printings**: OCR the bottom strip (set code, collector number, language marker). Match against the candidates' printings. Game-specific regions configured per game (Pokémon bottom-left/right, One Piece bottom-right, MTG bottom-left, YGO under art).
7. **Variant hints**: foil/holo detection from brightness variance across frames is unreliable — default to "Normal", pre-select "Foil" only when the matched printing is foil-only, and make switching one tap.
8. **Confidence** = combine (top-1 score, gap to top-2, OCR agreement, multi-frame agreement). Use CollectorVision's multi-frame method: embed 3 recent frames, sum each candidate's scores across frames, then rank.
   - High: auto-add in bulk mode. Check: add but flag in review tray. Low: show picker.
9. **Learn**: when a user corrects a match, log (with consent) the crop fingerprint + correct id for future model tuning.

### Model plan
- **MVP (Phase 3):** use CollectorVision's published models unchanged. Measure accuracy per game straight away.
- **Important:** CollectorVision says Magic is its primary, well-supported catalog; Pokémon, One Piece, Yu-Gi-Oh!, Lorcana etc. are **experimental previews**. Expect lower accuracy on James's priority games at first — the Phase 3 test tells us how much.
- **Index:** CollectorVision publishes ready-made catalogs (`pokemon`, `onepiece`, `yugioh`, `lorcana`, `mtg` and more) keyed by **TCGplayer product IDs** for non-Magic games — the same IDs TCGCSV uses, so they join straight onto our D1 data. Plan: build **our own** index nightly with CollectorVision's embedder over our catalog images (so new cards appear the same day and IDs always match), and use their published catalogs as a cross-check.
- **Phase 5 (only if accuracy falls short):** fine-tune CollectorVision's embedder on the weak games with metric learning (ArcFace/triplet loss) on official card images with heavy augmentation: perspective, blur, glare spots, sleeve reflections, colour/white-balance shifts, JPEG noise, random backgrounds, partial occlusion by fingers. Export to ONNX (quantise to int8 if speed needs it). Any fine-tuned model is a modified CollectorVision work and falls under its AGPL licence.
- Adding new sets never needs retraining — just fingerprint the new images.

### Licensing (decided: use CollectorVision)
CollectorVision is **AGPL-3.0**, with commercial licences available. Consequences Claude Code must respect:
- Keep this repo's licence **AGPL-3.0-compatible** and keep the full source publishable. Add a `LICENSE` file and an in-app "Open-source licences / source code" link.
- Keep all CollectorVision code and models in clearly marked folders with their original licence notices.
- **Before any closed-source or paid app-store release, stop and flag James** — he'll need either to publish the source or buy a commercial licence.

---

## 6. Build phases

### Phase 1 — Cloudflare data pipeline (no app yet)
- Wrangler project: Worker + D1 + R2 + Workflow + Cron.
- Import One Piece and Pokémon first (James's priority games), then MTG, YGO, Lorcana.
- Fetch TCGCSV + Cardmarket price guide; normalise; cross-match; write D1; snapshot to R2.
- Publish manifest + catalog packs.
- Politeness: ≤1 request/sec to community sources, cache aggressively, set a descriptive User-Agent.
- **Accept when:** a manual trigger completes; D1 has all One Piece + Pokémon printings with TCGplayer and Cardmarket prices; unmatched-row report exists; a second run produces a small delta, not a full reload.

### Phase 2 — Fingerprint job (GitHub Actions)
- Python script in `/ml`: ask the Worker for printings added since the last run, download their images, embed with CollectorVision (`Catalog`/`NeuralEmbedder`, CPU), append to the index pack, upload to R2, update manifest.
- Workflow file `.github/workflows/fingerprint.yml`: scheduled 1 hour after the Cloudflare refresh (21:00 UTC refresh → 22:00 UTC job), plus a manual "Run workflow" button. Cache the CollectorVision models and pip packages between runs.
- Secrets stored in GitHub (Settings → Secrets and variables → Actions): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `WORKER_ADMIN_TOKEN`. Give James click-by-click steps for adding them. Never commit keys.
- First run is a one-off full build (can be triggered manually; may take a while). Nightly runs only touch new cards.
- **Accept when:** full One Piece + Pokémon index built; nightly run only processes new cards; job failure sends an alert (GitHub email is fine).

### Phase 3 — App MVP: scan one card
- Expo dev build, camera screen, detection outline, auto-capture, embedding, local search, result sheet with image + GBP price.
- First-launch download of catalog + index; nightly delta sync (background fetch) on Wi-Fi.
- **Accept when:** on James's Android phone, top-1 accuracy ≥90% on the test set (§7), result shown in <1 second, works in airplane mode.
- If One Piece or Pokémon is well below 90% because of CollectorVision's preview catalogs, report the numbers to James and propose bringing Phase 5 fine-tuning forward.

### Phase 4 — Exact printing + confidence
- OCR corner step, per-game regions, confidence tiers, top-5 picker, multi-frame voting.
- **Accept when:** exact-printing accuracy ≥95% on test set, including reprinted artwork cases.

### Phase 5 — Accuracy push
- Fine-tuned model, augmentation, sleeved/glare test cases.
- **Accept when:** ≥97% top-1 art, ≥95% exact printing, <3% of scans "Low".

### Phase 6 — Collection features
- Portfolios, quantities by variant/condition, value chart, cost basis, set completion, wishlist, search, CSV export.

### Phase 7 — Bulk mode + alerts + trade analyser

### Phase 8 — Accounts & sync (optional)
- Magic-link email login (Resend is already connected), collections stored in D1, per-user access checks.
- **Security review required** before launch — flag to James.

---

## 7. Accuracy test harness (build in Phase 3, run every phase)
- James photographs ~200 real cards per game with his phone: varied lighting, sleeved/unsleeved, tilted, on desk/playmat/hand. Include deliberate hard cases (reprints with same art, alt-arts, foils).
- File names = correct printing id. A script runs the full pipeline and reports top-1, top-5, exact-printing accuracy, confidence calibration, and average time.
- Results saved per commit so regressions are obvious.

---

## 8. Risks & things to flag to James
1. **TCGCSV dependency** — a single volunteer-run mirror. Mitigate: Cardmarket official files as a second price source, cache last good data, alert if a refresh fails.
2. **Card image rights** — card art is owned by the publishers. Show thumbnails for identification only; don't offer bulk image downloads; check each source's terms before app-store release.
3. **App store names/trademarks** — don't use "Pokémon", "TCGplayer" etc. in the app name or icon.
4. **Price accuracy** — label source and date on every price; "market price" is not a guaranteed sale price.
5. **CollectorVision maturity** — non-Magic catalogs are previews; see Phase 3 fallback. Pin a specific CollectorVision version so updates can't silently change results.
6. **GitHub Actions minutes** — free and unlimited for public repos (fits the AGPL route); private repos have a monthly allowance that nightly delta runs should fit within.
7. **Running costs** — Cloudflare free/paid tiers should cover this cheaply since scanning is on-device; the paid Workers plan (~$5/month) is likely needed for longer-running Workflows.

---

## 9. Repo layout
```
/app            Expo React Native app
/worker         Cloudflare Worker, Workflow, D1 migrations
/ml             Python: scraping images, training, export, fingerprint job
/testset        James's labelled phone photos (git-lfs or R2)
/docs           this plan, data-source notes, decisions log
```
