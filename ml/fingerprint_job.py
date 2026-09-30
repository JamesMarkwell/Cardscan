"""Nightly fingerprint job.

Keeps each game's index pack complete. The pack — not the Worker's
"fingerprinted" flag — is the source of truth: the job downloads the newest pack
already in R2, lists every printing that has an image, embeds the ones the pack
lacks with CollectorVision's Milo model, and uploads the grown pack. Adding new
sets never needs retraining — only new fingerprints.

It works in chunks and uploads after each, so a run that times out (or a game
with tens of thousands of printings the first time) keeps its progress and the
next run carries on from where it stopped.

Runs on GitHub Actions rather than in a Worker: Workers have tight memory and
CPU limits and no practical way to run an image model.

    python fingerprint_job.py --game onepiece --version 20260921
"""

from __future__ import annotations

import argparse
import io
import logging
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import requests
from PIL import Image

from index_pack import IndexPack, append_rows, read_pack, write_pack

LOG = logging.getLogger("fingerprint")

EMBEDDER_SIZE = 448
REQUEST_TIMEOUT = 30
# Embed, then upload, this many images at a time: progress survives a timeout,
# and only one chunk of decoded images is in memory at once.
CHUNK_SIZE = 1000
# Be polite to the image hosts: a few requests at a time, with a descriptive agent.
DOWNLOAD_WORKERS = 4
PACK_KEY = re.compile(r"^games/(?P<game>[^/]+)/index-(?P<version>[^/]+)\.bin$")
USER_AGENT = "CardScan-fingerprint/0.1 (+https://github.com/JamesMarkwell/cardscan)"


@dataclass
class Pending:
    printing_id: str
    game_id: str
    image_url: str


def fetch_printings(worker_url: str, token: str, game: str, page_size: int = 2000) -> list[Pending]:
    """Every printing of a game that has an image, however it was fingerprinted before.

    The Worker's "fingerprinted" flag says a printing was embedded once, not that
    its row is still in the pack, so it is not what decides what to embed.
    """
    printings: list[Pending] = []
    offset = 0
    while True:
        response = requests.get(
            f"{worker_url.rstrip('/')}/admin/pending-fingerprints",
            params={"game": game, "all": 1, "limit": page_size, "offset": offset},
            headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        rows = response.json()["printings"]
        printings.extend(
            Pending(printing_id=row["id"], game_id=row["gameId"], image_url=row["imageUrl"]) for row in rows
        )
        if len(rows) < page_size:
            return printings
        offset += page_size


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


def r2_client():
    """The R2 client and bucket name, from the environment."""
    import boto3

    account = os.environ["R2_ACCOUNT_ID"]
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    return client, os.environ.get("R2_BUCKET", "cardscan-packs")


def upload_to_r2(local: Path, key: str) -> None:
    client, bucket = r2_client()
    client.upload_file(str(local), bucket, key)


def newest_pack_version(keys: list[str], game: str, at_most: str) -> str | None:
    """The newest index-pack version among `keys` for a game, no newer than `at_most`.

    Versions are YYYYMMDD strings, so they order correctly as text. Keys for other
    games and files that are not a pack's .bin are ignored.
    """
    versions = []
    for key in keys:
        match = PACK_KEY.match(key)
        if match and match.group("game") == game and match.group("version") <= at_most:
            versions.append(match.group("version"))
    return max(versions) if versions else None


def download_base_pack(game: str, version: str, pack_path: Path) -> IndexPack | None:
    """Fetch the newest pack already in R2 for this game, to add to rather than replace.

    Without this the job starts from an empty pack each night on a fresh runner,
    then uploads over the real one with only that night's rows — silently dropping
    every card fingerprinted before.
    """
    client, bucket = r2_client()
    keys: list[str] = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"games/{game}/index-"):
        keys.extend(item["Key"] for item in page.get("Contents", []))

    base = newest_pack_version(keys, game, version)
    if base is None:
        LOG.info("no existing pack for %s — starting a new one", game)
        return None

    key = f"games/{game}/index-{base}.bin"
    pack_path.parent.mkdir(parents=True, exist_ok=True)
    client.download_file(bucket, key, str(pack_path))
    client.download_file(bucket, key.replace(".bin", ".ids"), str(pack_path.with_suffix(".ids")))
    pack = read_pack(pack_path)
    LOG.info("starting from %s: %d rows", key, pack.matrix.shape[0])
    return pack


def select_missing(printings: list[Pending], have: set[str], limit: int) -> list[Pending]:
    """The printings whose rows the pack lacks, at most `limit` of them (0 = no limit)."""
    missing = [item for item in printings if item.printing_id not in have]
    return missing[:limit] if limit > 0 else missing


def download_chunk(
    chunk: list[Pending],
    download: Callable[[str], Image.Image] = download_image,
    workers: int = DOWNLOAD_WORKERS,
) -> tuple[list[Image.Image], list[str]]:
    """Download a chunk's images a few at a time; the images and ids that came back, aligned.

    A single bad image must not fail the night, so failures are logged and skipped.
    """

    def fetch(item: Pending) -> Image.Image | None:
        try:
            return download(item.image_url)
        except Exception as error:
            LOG.warning("skipping %s: %s", item.printing_id, error)
            return None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        fetched = list(pool.map(fetch, chunk))

    images = [image for image in fetched if image is not None]
    ids = [item.printing_id for item, image in zip(chunk, fetched) if image is not None]
    return images, ids


def fingerprint_missing(
    missing: list[Pending],
    pack: IndexPack,
    *,
    chunk_size: int = CHUNK_SIZE,
    download: Callable[[str], Image.Image] = download_image,
    embed: Callable[[list[Image.Image]], np.ndarray] = embed_images,
    on_chunk: Callable[[IndexPack, list[str]], None] | None = None,
) -> IndexPack:
    """Embed the missing printings chunk by chunk, growing `pack`.

    `on_chunk(pack, ids)` runs after each chunk with the whole pack so far, which
    is where it is saved and uploaded: a run that dies part-way keeps what it did.
    """
    for start in range(0, len(missing), chunk_size):
        chunk = missing[start : start + chunk_size]
        images, ids = download_chunk(chunk, download)
        LOG.info("chunk %d-%d: %d of %d images fetched", start, start + len(chunk), len(images), len(chunk))
        if not images:
            continue
        pack = append_rows(pack, embed(images), ids)
        if on_chunk is not None:
            on_chunk(pack, ids)
    return pack


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
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="embed at most this many missing printings this run (0 = all of them)",
    )
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
        # A game the Worker has not imported yet is not a failure: there is simply
        # nothing to fingerprint. Failing here would also stop the games after it.
        LOG.info("no catalog version published for %s yet — nothing to do", args.game)
        return 0

    pack_path = args.work_dir / f"{args.game}-{version}.bin"
    pack = load_existing(pack_path)
    if not args.dry_run:
        # The pack in R2 is what the app downloads, so it is what we grow.
        pack = download_base_pack(args.game, version, pack_path) or pack

    printings = fetch_printings(worker_url, token, args.game)
    missing = select_missing(printings, set(pack.ids), args.limit)
    LOG.info(
        "%d printings with images, %d already in the pack, %d to embed",
        len(printings),
        len(pack.ids),
        len(missing),
    )
    if not missing:
        return 0

    key = f"games/{args.game}/index-{version}.bin"

    def save(grown: IndexPack, ids: list[str]) -> None:
        write_pack(pack_path, grown.matrix, grown.ids, half=True)
        LOG.info("pack now holds %d rows", grown.matrix.shape[0])
        if args.dry_run:
            return
        upload_to_r2(pack_path, key)
        upload_to_r2(pack_path.with_suffix(".ids"), key.replace(".bin", ".ids"))
        report_done(worker_url, token, args.game, version, ids, key)

    final = fingerprint_missing(missing, pack, on_chunk=save)
    if final is pack:
        # Every image was unavailable (the CDN refuses some permanently with a 403).
        LOG.info("no fetchable images among %d missing — nothing to do", len(missing))
    LOG.info("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
