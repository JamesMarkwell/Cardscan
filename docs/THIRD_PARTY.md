# Third-party code and licensing

## CollectorVision — AGPL-3.0

Card recognition is CollectorVision's, used unchanged.

| What | Where | Pinned at |
|---|---|---|
| `cornelius.onnx` (corner detector v2.12) | `app/assets/models/` | commit `2a122d00d25c8d112a90e47bf235a021e0c53b0c` |
| `milo.onnx` (embedder v1.0.0) | `app/assets/models/` | same commit |
| Dewarp / ordering / preprocessing logic | ported into `app/src/scan/geometry.ts` and `app/src/scan/image.ts` | same commit |
| Python embedder used by the nightly job | `ml/requirements.txt` | same commit |

The version is pinned deliberately: an upstream model change would silently
change what the app recognises, so upgrading is a decision, not a side effect.

### What the AGPL means here

CollectorVision is licensed AGPL-3.0, so:

- **CardScan is AGPL-3.0 too** (`LICENSE`), and the complete source stays
  publishable. The app links to the source from Settings → Open source.
- Any fine-tuned model derived from Milo or Cornelius (the Phase 5 work) is a
  modified CollectorVision work and is AGPL-3.0 as well.
- **Before any closed-source or paid app-store release, stop and check with
  James.** The choice is to publish the source or to buy a commercial licence
  from CollectorVision (`COMMERCIAL_LICENSE.md` upstream).

### Accuracy expectations

Upstream states that Magic: The Gathering is its primary, well-supported
catalog; Pokémon, One Piece, Yu-Gi-Oh! and Lorcana are experimental previews.
Expect lower accuracy on the priority games until Phase 5 fine-tuning. Phase 3's
test run against the labelled test set is what turns that into numbers.

## Data sources

| Source | Used for | Terms to respect |
|---|---|---|
| TCGCSV (tcgcsv.com) | TCGplayer catalog, groups and prices | Community project; rate-limited to ~1 req/sec with a descriptive User-Agent. Single point of failure — see Risks in `PLAN.md`. |
| Cardmarket price guide | UK/EU prices | Official daily files, account-scoped URL held as a secret. |
| Scryfall | Magic catalog and images | Attribution required. |
| TCGdex / Pokémon TCG API | Pokémon catalog and images | Free. |
| YGOPRODeck | Yu-Gi-Oh! catalog and images | Free, rate limited. |

**TCGplayer.com is never scraped** — their Terms of Service prohibit crawling
without permission, which is why TCGCSV exists.

Card artwork is owned by the publishers. Thumbnails are shown for
identification only; the app offers no bulk image download. Publisher names and
trademarks are kept out of the app name and icon.

## Other dependencies

Standard open-source libraries (Expo, React Native, ONNX Runtime, Hono) under
their own permissive licences; see each package's `LICENSE` in `node_modules`.
