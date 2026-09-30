"""The fingerprint job's pack handling.

The bug these guard against: the job started every night from an empty pack (it
looked for the previous one on the runner's own disk), appended only that night's
rows and uploaded over the real pack, so each run silently dropped every card
fingerprinted before while the Worker still marked them all as done.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from fingerprint_job import (
    Pending,
    download_chunk,
    fingerprint_missing,
    newest_pack_version,
    select_missing,
)
from index_pack import IndexPack, read_pack, write_pack


def pending(*ids: str) -> list[Pending]:
    return [Pending(printing_id=id_, game_id="onepiece", image_url=f"https://img/{id_}.jpg") for id_ in ids]


def blank(_url: str) -> Image.Image:
    return Image.new("RGB", (8, 8))


def fake_embed(images: list[Image.Image]) -> np.ndarray:
    """A distinct unit vector per image, so rows can be told apart."""
    rows = np.zeros((len(images), 4), dtype=np.float32)
    for index in range(len(images)):
        rows[index, index % 4] = 1.0
    return rows


def empty() -> IndexPack:
    return IndexPack(matrix=np.empty((0, 4), dtype=np.float32), ids=[])


# --- which pack to start from ---------------------------------------------------


def test_newest_pack_version_picks_the_latest_at_or_before_the_target() -> None:
    keys = [
        "games/onepiece/index-20260901.bin",
        "games/onepiece/index-20260925.bin",
        "games/onepiece/index-20261010.bin",
    ]
    assert newest_pack_version(keys, "onepiece", "20260930") == "20260925"
    assert newest_pack_version(keys, "onepiece", "20261010") == "20261010"


def test_newest_pack_version_ignores_other_games_and_other_files() -> None:
    keys = [
        "games/pokemon/index-20260930.bin",
        "games/onepiece/index-20260901.ids",  # an ids file, not the pack
        "games/onepiece/catalog-20260930.json",
        "games/onepiece/index-20260901.bin",
    ]
    assert newest_pack_version(keys, "onepiece", "20260930") == "20260901"


def test_newest_pack_version_is_none_when_there_is_no_pack_yet() -> None:
    assert newest_pack_version([], "onepiece", "20260930") is None
    assert newest_pack_version(["games/onepiece/index-20261001.bin"], "onepiece", "20260930") is None


# --- what to embed --------------------------------------------------------------


def test_select_missing_skips_what_the_pack_already_has() -> None:
    printings = pending("a", "b", "c", "d")
    assert [p.printing_id for p in select_missing(printings, {"a", "c"}, 0)] == ["b", "d"]


def test_select_missing_honours_the_limit_and_zero_means_no_limit() -> None:
    printings = pending("a", "b", "c", "d")
    assert [p.printing_id for p in select_missing(printings, set(), 2)] == ["a", "b"]
    assert len(select_missing(printings, set(), 0)) == 4


# --- downloading ----------------------------------------------------------------


def test_download_chunk_skips_failures_and_keeps_ids_aligned() -> None:
    def flaky(url: str) -> Image.Image:
        if "b.jpg" in url:
            raise RuntimeError("403 Forbidden")
        return blank(url)

    images, ids = download_chunk(pending("a", "b", "c"), flaky)
    assert ids == ["a", "c"]
    assert len(images) == 2


def test_download_chunk_returns_nothing_when_every_image_is_blocked() -> None:
    def blocked(_url: str) -> Image.Image:
        raise RuntimeError("403 Forbidden")

    assert download_chunk(pending("a", "b"), blocked) == ([], [])


# --- growing the pack -----------------------------------------------------------


def test_fingerprint_missing_adds_to_the_pack_it_is_given() -> None:
    base = IndexPack(matrix=np.eye(4, dtype=np.float32)[:2], ids=["old-1", "old-2"])

    grown = fingerprint_missing(pending("new-1", "new-2"), base, download=blank, embed=fake_embed)

    assert grown.ids == ["old-1", "old-2", "new-1", "new-2"]
    assert grown.matrix.shape == (4, 4)
    # The old rows are untouched.
    assert np.allclose(grown.matrix[:2], base.matrix)


def test_a_second_run_keeps_what_the_first_run_embedded(tmp_path) -> None:
    """The regression: run two must start from run one's pack, not an empty one."""
    path = tmp_path / "onepiece-20260930.bin"

    first = fingerprint_missing(pending("a", "b"), empty(), download=blank, embed=fake_embed)
    write_pack(path, first.matrix, first.ids)

    # The next night's runner has nothing on disk; it must load the pack from R2
    # (here, the file run one wrote) and add only what it lacks.
    reloaded = read_pack(path)
    missing = select_missing(pending("a", "b", "c"), set(reloaded.ids), 0)
    assert [p.printing_id for p in missing] == ["c"]

    second = fingerprint_missing(missing, reloaded, download=blank, embed=fake_embed)
    assert sorted(second.ids) == ["a", "b", "c"]


def test_on_chunk_runs_per_chunk_with_the_whole_pack_so_far() -> None:
    seen: list[tuple[int, list[str]]] = []

    fingerprint_missing(
        pending("a", "b", "c", "d", "e"),
        empty(),
        chunk_size=2,
        download=blank,
        embed=fake_embed,
        on_chunk=lambda pack, ids: seen.append((pack.matrix.shape[0], ids)),
    )

    # Three chunks (2, 2, 1): the pack grows each time, and each call names only its own ids.
    assert seen == [(2, ["a", "b"]), (4, ["c", "d"]), (5, ["e"])]


def test_a_chunk_of_blocked_images_is_skipped_without_stopping_the_run() -> None:
    def blocked_first_chunk(url: str) -> Image.Image:
        if url.endswith(("a.jpg", "b.jpg")):
            raise RuntimeError("403 Forbidden")
        return blank(url)

    seen: list[list[str]] = []
    grown = fingerprint_missing(
        pending("a", "b", "c", "d"),
        empty(),
        chunk_size=2,
        download=blocked_first_chunk,
        embed=fake_embed,
        on_chunk=lambda pack, ids: seen.append(ids),
    )

    assert grown.ids == ["c", "d"]
    assert seen == [["c", "d"]]


def test_nothing_fetchable_returns_the_pack_unchanged() -> None:
    def blocked(_url: str) -> Image.Image:
        raise RuntimeError("403 Forbidden")

    base = empty()
    assert fingerprint_missing(pending("a"), base, download=blocked, embed=fake_embed) is base
