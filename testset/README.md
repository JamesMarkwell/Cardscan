# Accuracy test set

Photos here drive the harness that every phase is measured against.

## Taking them

Around 200 real cards per game, shot on the phone that will run the app:

- varied lighting, including one set under a lamp with visible glare
- sleeved and unsleeved
- straight-on and tilted
- on a desk, on a playmat, and held in hand
- deliberate hard cases: reprints sharing artwork, alt-arts, foils, and at least
  a few non-English cards

## Naming

The file name is the answer: `<printing-id>.jpg`, e.g.

```
onepiece:OP07:119:normal:en.jpg
onepiece:OP07:119:normal:en__sleeved-glare.jpg
```

Anything after `__` is a free-text note and is ignored by the scorer.

## Where they live

Photos are **not committed** (`testset/photos/` is gitignored) — a few hundred
phone photos per game would bloat the repository. Keep them in the R2 bucket
under `testset/`, or locally; the harness takes a directory.

## Scoring

The harness reports top-1 artwork accuracy, top-5, exact-printing accuracy,
confidence calibration and average time per scan, and saves a JSON report per
commit so a regression is obvious.

Targets, per `docs/PLAN.md`:

| Phase | Top-1 artwork | Exact printing | "Low" tier |
|---|---|---|---|
| 3 | ≥ 90% | — | — |
| 4 | — | ≥ 95% | — |
| 5 | ≥ 97% | ≥ 95% | < 3% |
