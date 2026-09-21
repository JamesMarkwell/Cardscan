# Bundled CollectorVision models

These two ONNX files are copied unchanged from
[CollectorVision](https://github.com/HanClinto/CollectorVision), pinned at the
commit recorded in `../../../docs/THIRD_PARTY.md`.

| File | Model | Input | Output |
|---|---|---|---|
| `cornelius.onnx` | Cornelius v2.12 corner detector (MobileViT-XXS + SimCC) | `(1, 3, 384, 384)` float32, ImageNet-normalised | `corners (1, 8)` normalised TL/TR/BR/BL, `presence (1,)` logit, `sharpness (1,)` in `[0, 1]` |
| `milo.onnx` | Milo v1.0.0 embedder (MobileViT-XXS + ArcFace) | `(1, 3, 448, 448)` float32, ImageNet-normalised | `embedding (1, 128)` float32, L2-normalised |

CollectorVision is licensed AGPL-3.0 (`LICENSE.CollectorVision`). That licence
is why CardScan is AGPL-3.0 too — see `docs/THIRD_PARTY.md` before any
closed-source or paid release.

Magic: The Gathering is CollectorVision's primary catalog. Pokémon, One Piece,
Yu-Gi-Oh! and Lorcana are experimental previews upstream, so expect lower
accuracy on those until the Phase 5 fine-tune.
