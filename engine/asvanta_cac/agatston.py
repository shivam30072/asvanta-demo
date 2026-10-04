"""Pure numpy/scipy Agatston scoring.

Semantics are shared with the browser engine (src/cac/agatston.js) and pinned by
reference/cac-cases.json:

* calcium voxel: HU >= threshold (inclusive, default 130)
* per axial slice, 2D connected components with 8-connectivity
* a region qualifies if area_mm2 >= min_area_mm2 (inclusive, default 1.0)
* density factor from the region's peak HU: 130-199 -> 1, 200-299 -> 2, 300-399 -> 3, >=400 -> 4
* region score = area_mm2 * factor * (slice_increment_mm / 3)
* qualifying regions on adjacent slices sharing >= 1 (x, y) pixel belong to the same 3D lesion

No rounding happens here; rounding is a display concern.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

import numpy as np
from scipy import ndimage

DEFAULT_THRESHOLD_HU = 130.0
DEFAULT_MIN_AREA_MM2 = 1.0
AREA_EPSILON = 1e-9
REFERENCE_SLICE_MM = 3.0
VESSELS: tuple[str, ...] = ("LM", "LAD", "LCX", "RCA")

_STRUCTURE_2D = np.ones((3, 3), dtype=bool)

Spacing = tuple[float, float, float]  # (sx, sy, sz) in mm; sz = slice increment


@dataclass(frozen=True)
class Region:
    """A qualifying 2D calcified region on one axial slice."""

    id: str
    z: int
    pixel_count: int
    area_mm2: float
    peak_hu: float
    factor: int
    score: float
    pixels: np.ndarray = field(repr=False, compare=False)  # (N, 2) int32 rows of (y, x)


@dataclass(frozen=True)
class Lesion:
    """A 3D lesion: qualifying regions linked across adjacent slices."""

    id: str
    regions: tuple[Region, ...]
    score: float
    peak_hu: float
    area_mm2: float
    voxel_count: int
    volume_mm3: float
    vessel: str | None = None

    @property
    def voxels(self) -> np.ndarray:
        """(N, 3) int32 array of (z, y, x) voxel indices."""
        parts = [np.column_stack([np.full(len(r.pixels), r.z, np.int32), r.pixels]) for r in self.regions]
        return np.concatenate(parts).astype(np.int32) if parts else np.zeros((0, 3), np.int32)

    @property
    def slices(self) -> tuple[int, ...]:
        return tuple(sorted({r.z for r in self.regions}))


@dataclass(frozen=True)
class AgatstonResult:
    regions: tuple[Region, ...]
    lesions: tuple[Lesion, ...]
    total: float
    spacing: Spacing
    threshold_hu: float
    min_area_mm2: float


def density_factor(peak_hu: float, threshold_hu: float = DEFAULT_THRESHOLD_HU) -> int:
    """Agatston density weighting from a region's peak HU (0 if below threshold)."""
    if peak_hu >= 400:
        return 4
    if peak_hu >= 300:
        return 3
    if peak_hu >= 200:
        return 2
    if peak_hu >= threshold_hu:
        return 1
    return 0


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, a: int) -> int:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def score_volume(
    hu: np.ndarray,
    spacing: Sequence[float],
    *,
    threshold_hu: float = DEFAULT_THRESHOLD_HU,
    min_area_mm2: float = DEFAULT_MIN_AREA_MM2,
    mask: np.ndarray | None = None,
) -> AgatstonResult:
    """Score a (nz, ny, nx) HU volume. ``mask`` optionally restricts which voxels may count."""
    if hu.ndim != 3:
        raise ValueError(f"expected a (nz, ny, nx) volume, got shape {hu.shape}")
    sx, sy, sz = (float(s) for s in spacing)
    pixel_area = sx * sy
    slice_weight = sz / REFERENCE_SLICE_MM
    calcium = hu >= threshold_hu
    if mask is not None:
        calcium &= mask.astype(bool)

    regions: list[Region] = []
    qualifying_labels: list[np.ndarray] = []  # per slice: label map holding region index + 1, 0 elsewhere
    for z in range(hu.shape[0]):
        qmap = np.zeros(hu.shape[1:], dtype=np.int32)
        labels, n = ndimage.label(calcium[z], structure=_STRUCTURE_2D)
        if n:
            idx = np.arange(1, n + 1)
            counts = np.bincount(labels.ravel(), minlength=n + 1)[1:]
            peaks = np.atleast_1d(ndimage.maximum(hu[z], labels, idx))
            for lab, count, peak in zip(idx, counts, peaks):
                area = float(count) * pixel_area
                if area + AREA_EPSILON < min_area_mm2:
                    continue
                factor = density_factor(float(peak), threshold_hu)
                pix = np.argwhere(labels == lab).astype(np.int32)
                regions.append(
                    Region(
                        id=f"R{len(regions) + 1}",
                        z=z,
                        pixel_count=int(count),
                        area_mm2=area,
                        peak_hu=float(peak),
                        factor=factor,
                        score=area * factor * slice_weight,
                        pixels=pix,
                    )
                )
                qmap[labels == lab] = len(regions)
        qualifying_labels.append(qmap)

    uf = _UnionFind(len(regions))
    for z in range(hu.shape[0] - 1):
        a, b = qualifying_labels[z], qualifying_labels[z + 1]
        both = (a > 0) & (b > 0)
        if both.any():
            for ra, rb in set(zip(a[both].tolist(), b[both].tolist())):
                uf.union(ra - 1, rb - 1)

    groups: dict[int, list[Region]] = {}
    for i, region in enumerate(regions):
        groups.setdefault(uf.find(i), []).append(region)

    voxel_volume = sx * sy * sz
    lesions = []
    for root in sorted(groups):  # roots are the smallest member index -> deterministic order
        members = tuple(groups[root])
        count = sum(r.pixel_count for r in members)
        lesions.append(
            Lesion(
                id=f"L{len(lesions) + 1}",
                regions=members,
                score=sum(r.score for r in members),
                peak_hu=max(r.peak_hu for r in members),
                area_mm2=sum(r.area_mm2 for r in members),
                voxel_count=count,
                volume_mm3=count * voxel_volume,
            )
        )

    return AgatstonResult(
        regions=tuple(regions),
        lesions=tuple(lesions),
        total=sum(les.score for les in lesions),
        spacing=(sx, sy, sz),
        threshold_hu=threshold_hu,
        min_area_mm2=min_area_mm2,
    )


def vessel_totals(
    lesions: Iterable[Lesion], labels: Mapping[str, str | None] | None = None
) -> tuple[dict[str, float], list[str]]:
    """Per-vessel totals (LM/LAD/LCX/RCA) and the ids of lesions without a valid vessel label.

    Labels come from ``labels[lesion.id]`` if given, else from ``lesion.vessel``.
    """
    totals = {v: 0.0 for v in VESSELS}
    unassigned: list[str] = []
    for les in lesions:
        vessel = labels.get(les.id) if labels is not None else les.vessel
        if vessel in totals:
            totals[vessel] += les.score
        else:
            unassigned.append(les.id)
    return totals, unassigned


def voxels_to_mask(voxels: np.ndarray, shape: tuple[int, int, int]) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    if len(voxels):
        v = np.asarray(voxels, dtype=np.int64)
        mask[v[:, 0], v[:, 1], v[:, 2]] = True
    return mask


def encode_rle(voxels: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Run-length encode (z, y, x) voxels as (z, y, x_start, length) runs along x."""
    if len(voxels) == 0:
        return []
    v = np.unique(np.asarray(voxels, dtype=np.int64), axis=0)  # sorted lexicographically by z, y, x
    runs: list[tuple[int, int, int, int]] = []
    z0, y0, x0 = (int(c) for c in v[0])
    length = 1
    for z, y, x in v[1:].tolist():
        if z == z0 and y == y0 and x == x0 + length:
            length += 1
        else:
            runs.append((z0, y0, x0, length))
            z0, y0, x0, length = z, y, x, 1
    runs.append((z0, y0, x0, length))
    return runs


def decode_rle(runs: Iterable[Sequence[int]]) -> np.ndarray:
    """Inverse of :func:`encode_rle`; returns an (N, 3) int32 array."""
    rows = [(z, y, x0 + i) for z, y, x0, n in runs for i in range(n)]
    return np.array(rows, dtype=np.int32).reshape(-1, 3)
