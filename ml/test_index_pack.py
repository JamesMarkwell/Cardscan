"""Round-trip tests for the pack format the app parses."""

from pathlib import Path

import numpy as np
import pytest

from index_pack import IndexPack, append_rows, l2_normalise, read_pack, write_pack


def test_round_trip_float32(tmp_path: Path) -> None:
    matrix = np.random.default_rng(0).normal(size=(5, 8)).astype(np.float32)
    path = tmp_path / "index.bin"
    write_pack(path, matrix, [f"card-{i}" for i in range(5)], half=False)

    pack = read_pack(path)
    assert pack.ids == [f"card-{i}" for i in range(5)]
    np.testing.assert_allclose(pack.matrix, l2_normalise(matrix), rtol=1e-6, atol=1e-6)


def test_round_trip_float16_is_close_enough(tmp_path: Path) -> None:
    matrix = np.random.default_rng(1).normal(size=(4, 16)).astype(np.float32)
    path = tmp_path / "index.bin"
    write_pack(path, matrix, [f"c{i}" for i in range(4)], half=True)

    pack = read_pack(path)
    # Half precision is fine for cosine search but not exact.
    np.testing.assert_allclose(pack.matrix, l2_normalise(matrix), rtol=2e-3, atol=2e-3)


def test_rows_are_normalised(tmp_path: Path) -> None:
    matrix = np.full((3, 4), 2.0, dtype=np.float32)
    path = tmp_path / "index.bin"
    write_pack(path, matrix, ["a", "b", "c"], half=False)

    norms = np.linalg.norm(read_pack(path).matrix, axis=1)
    np.testing.assert_allclose(norms, np.ones(3), rtol=1e-6)


def test_zero_row_does_not_become_nan() -> None:
    normalised = l2_normalise(np.zeros((2, 3), dtype=np.float32))
    assert not np.isnan(normalised).any()


def test_id_count_must_match_rows(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        write_pack(tmp_path / "index.bin", np.zeros((2, 3), dtype=np.float32), ["only-one"])


def test_append_replaces_existing_ids() -> None:
    pack = IndexPack(matrix=l2_normalise(np.eye(3, dtype=np.float32)), ids=["a", "b", "c"])
    replacement = np.array([[0.0, 0.0, 5.0]], dtype=np.float32)

    updated = append_rows(pack, replacement, ["b"])

    assert updated.ids == ["a", "c", "b"]
    assert updated.matrix.shape == (3, 3)
    np.testing.assert_allclose(updated.matrix[-1], np.array([0.0, 0.0, 1.0]), atol=1e-6)


def test_append_to_empty_pack() -> None:
    empty = IndexPack(matrix=np.empty((0, 3), dtype=np.float32), ids=[])
    updated = append_rows(empty, np.eye(3, dtype=np.float32), ["a", "b", "c"])
    assert updated.ids == ["a", "b", "c"]
