"""Index pack reader/writer.

The app memory-maps nothing and parses this by hand, so the format is kept
deliberately dull:

    magic   b"CVIX"          4 bytes
    version uint32           format version, currently 1
    dtype   uint32           0 = float32, 1 = float16
    rows    uint32
    dim     uint32
    matrix  rows * dim values, row-major, each row L2-normalised

Card ids live in a sibling ``.ids`` file, one per line, aligned by row. Keeping
them out of the binary means the ids can be inspected with ``head``.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"CVIX"
FORMAT_VERSION = 1
DTYPE_FLOAT32 = 0
DTYPE_FLOAT16 = 1
HEADER = struct.Struct("<4sIIII")


@dataclass
class IndexPack:
    matrix: np.ndarray
    ids: list[str]

    @property
    def dim(self) -> int:
        return int(self.matrix.shape[1])


def l2_normalise(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    # A zero row would otherwise become NaN and poison every search.
    norms[norms == 0] = 1.0
    return matrix / norms


def write_pack(path: Path, matrix: np.ndarray, ids: list[str], half: bool = True) -> None:
    if matrix.shape[0] != len(ids):
        raise ValueError(f"{matrix.shape[0]} rows but {len(ids)} ids")

    matrix = l2_normalise(np.asarray(matrix, dtype=np.float32))
    dtype = DTYPE_FLOAT16 if half else DTYPE_FLOAT32
    payload = matrix.astype(np.float16 if half else np.float32)

    rows, dim = payload.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(HEADER.pack(MAGIC, FORMAT_VERSION, dtype, rows, dim))
        handle.write(payload.astype(payload.dtype, copy=False).tobytes(order="C"))

    path.with_suffix(".ids").write_text("\n".join(ids), encoding="utf-8")


def read_pack(path: Path) -> IndexPack:
    raw = path.read_bytes()
    magic, version, dtype, rows, dim = HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError("not an index pack")
    if version != FORMAT_VERSION:
        raise ValueError(f"unsupported pack version {version}")

    np_dtype = np.float16 if dtype == DTYPE_FLOAT16 else np.float32
    matrix = np.frombuffer(raw, dtype=np_dtype, count=rows * dim, offset=HEADER.size)
    matrix = matrix.reshape(rows, dim).astype(np.float32)

    ids_path = path.with_suffix(".ids")
    ids = ids_path.read_text(encoding="utf-8").splitlines() if ids_path.exists() else []
    return IndexPack(matrix=matrix, ids=ids)


def append_rows(pack: IndexPack, matrix: np.ndarray, ids: list[str]) -> IndexPack:
    """Add new cards to an existing pack, replacing any id already present."""
    if pack.matrix.size == 0:
        return IndexPack(matrix=l2_normalise(np.asarray(matrix, dtype=np.float32)), ids=list(ids))

    keep = [index for index, card_id in enumerate(pack.ids) if card_id not in set(ids)]
    kept_matrix = pack.matrix[keep] if keep else np.empty((0, pack.dim), dtype=np.float32)
    kept_ids = [pack.ids[index] for index in keep]

    combined = np.vstack([kept_matrix, l2_normalise(np.asarray(matrix, dtype=np.float32))])
    return IndexPack(matrix=combined, ids=kept_ids + list(ids))
