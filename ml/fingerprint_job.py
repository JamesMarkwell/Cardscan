"""Nightly fingerprint job.

Asks the Worker which printings have no fingerprint yet, downloads their card
images, embeds them with CollectorVision's Milo model, appends the rows to that
game's index pack and uploads it to R2. Adding new sets never needs retraining —
only new fingerprints.

Runs on GitHub Actions rather than in a Worker: Workers have tight memory and
CPU limits and no practical way to run an image model, while a handful of new
cards a day is nothing for a CPU runner.

    python fingerprint_job.py --game onepiece --version 20260921
"""

from __future__ import annotations

import argparse
import io
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from index_pack import IndexPack, append_rows, read_pack, write_pack

LOG = logging.getLogger("fingerprint")

EMBEDDER_SIZE = 448
REQUEST_TIMEOUT = 30
# Be polite to the image hosts: one at a time, with a descriptive agent.
USER_AGENT = "CardScan-fingerprint/0.1 (+https://github.com/JamesMarkwell/cardscan)"


@dataclass
class Pending:
    printing_id: str
    game_id: str
    image_url: str


def fetch_pending(worker_url: str, token: str, game: str, limit: int) -> list[Pending]:
    response = requests.get(
        f"{worker_url.rstrip('/')}/admin/pending-fingerprints",
        params={"game": game, "limit": limit},
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return [
        Pending(printing_id=row["id"], game_id=row["gameId"], image_url=row["imageUrl"])
        for row in response.json()["printings"]
    ]


def current_version(worker_url: str, game: str) -> str | None:
    """The version the Worker is currently publishing for this game."""
    response = requests.get(
        f"{worker_url.rstrip('/')}/manifest.json",
        headers={"User-Agent": USER_AGENT},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    for entry in response.json().get("games", []):
        if entry.get("game") == game:
            return entry.get("version")
    return None


def download_image(url: str) -> Image.Image:
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return Image.open(io.BytesIO(response.content)).convert("RGB")


def embed_images(images: list[Image.Image]) -> np.ndarray:
    """Embed official card images with CollectorVision's published embedder.

    Official art is already flat and square-on, so the corner detector is not
    needed here — only a resize to the canonical crop size.
    """
    import collector_vision as cvg  # imported late so --help works without the model

    embedder = cvg.NeuralEmbedder(provider="cpu")
    vectors = [
        np.asarray(embedder.embed(image.resize((EMBEDDER_SIZE, EMBEDDER_SIZE), Image.LANCZOS)), dtype=np.float32)
        for image in images
    ]
    return np.vstack(vectors) if vectors else np.empty((0, 128), dtype=np.float32)


def load_existing(path: Path) -> IndexPack:
    if path.exists():
        return read_pack(path)
    return IndexPack(matrix=np.empty((0, 128), dtype=np.float32), ids=[])


def upload_to_r2(local: Path, key: str) -> None:
    import boto3

    account = os.environ["R2_ACCOUNT_ID"]
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    client.upload_file(str(local), os.environ.get("R2_BUCKET", "cardscan-packs"), key)


def report_done(worker_url: str, token: str, game: str, version: str, ids: list[str], key: str) -> None:
    response = requests.post(
        f"{worker_url.rstrip('/')}/admin/fingerprints-done",
        json={"game": game, "version": version, "printingIds": ids, "indexPackKey": key},
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", required=True)
    parser.add_argument(
        "--version",
        default=None,
        help="catalog version this index belongs to; taken from the manifest when omitted",
    )
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--work-dir", type=Path, default=Path("build"))
    parser.add_argument("--dry-run", action="store_true", help="skip the upload and the callback")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    worker_url = os.environ.get("WORKER_URL")
    token = os.environ.get("WORKER_ADMIN_TOKEN")
    if not worker_url or not token:
        LOG.error("WORKER_URL and WORKER_ADMIN_TOKEN must be set")
        return 2

    version = args.version or current_version(worker_url, args.game)
    if not version:
        LOG.error("no catalog version published for %s yet", args.game)
        return 1

    pending = fetch_pending(worker_url, token, args.game, args.limit)
    LOG.info("%d printings need a fingerprint", len(pending))
    if not pending:
        return 0

    images: list[Image.Image] = []
    ids: list[str] = []
    for item in pending:
        try:
            images.append(download_image(item.image_url))
            ids.append(item.printing_id)
        except Exception as error:  # a single bad image must not fail the night
            LOG.warning("skipping %s: %s", item.printing_id, error)

    if not images:
        LOG.error("no images could be downloaded")
        return 1

    LOG.info("embedding %d images", len(images))
    vectors = embed_images(images)

    pack_path = args.work_dir / f"{args.game}-{version}.bin"
    updated = append_rows(load_existing(pack_path), vectors, ids)
    write_pack(pack_path, updated.matrix, updated.ids, half=True)
    LOG.info("pack now holds %d rows", updated.matrix.shape[0])

    if args.dry_run:
        LOG.info("dry run: not uploading")
        return 0

    key = f"games/{args.game}/index-{version}.bin"
    upload_to_r2(pack_path, key)
    upload_to_r2(pack_path.with_suffix(".ids"), f"games/{args.game}/index-{version}.ids")
    report_done(worker_url, token, args.game, version, ids, key)
    LOG.info("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
