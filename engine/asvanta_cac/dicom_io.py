"""Load a CT series from a directory of DICOM files into an HU volume."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from pydicom.dataset import Dataset
from pydicom.multival import MultiValue

DUPLICATE_POSITION_TOL_MM = 1e-3
NONUNIFORM_SPACING_TOL = 0.01  # relative deviation from the median increment

METADATA_TAGS = (
    "Modality",
    "Manufacturer",
    "ManufacturerModelName",
    "SliceThickness",
    "SpacingBetweenSlices",
    "PixelSpacing",
    "KVP",
    "ContrastBolusAgent",
    "ConvolutionKernel",
    "ImageOrientationPatient",
    "SeriesDescription",
    "ProtocolName",
    "StudyInstanceUID",
    "SeriesInstanceUID",
    "BodyPartExamined",
)
GATING_TAGS = ("CardiacSynchronizationTechnique", "TriggerTime", "NominalPercentageOfCardiacPhase")


class DicomLoadError(Exception):
    """Raised when a directory does not contain a loadable image series."""


@dataclass
class Series:
    """A loaded series: HU volume (nz, ny, nx) float32, spacing (sx, sy, sz) mm, metadata."""

    hu: np.ndarray
    spacing: tuple[float, float, float]
    metadata: dict[str, Any] = field(default_factory=dict)
    slice_positions: list[float] = field(default_factory=list)
    geometry: dict[str, Any] = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(self.hu.shape)  # type: ignore[return-value]


def _jsonable(value: Any) -> Any:
    """Convert pydicom values to plain JSON-friendly Python types."""
    if value is None:
        return None
    if isinstance(value, (list, tuple, MultiValue)):
        return [_jsonable(v) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    return str(value)


def _get(ds: Dataset, name: str) -> Any:
    value = ds.get(name)
    if value is None or value == "":
        return None
    return _jsonable(value)


def list_series(directory: str | Path) -> dict[str, list[Dataset]]:
    """Read every .dcm file in ``directory`` (recursively) grouped by SeriesInstanceUID."""
    root = Path(directory)
    if not root.is_dir():
        raise DicomLoadError(f"not a directory: {root}")
    groups: dict[str, list[Dataset]] = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".dcm"):
        try:
            ds = pydicom.dcmread(path)
        except Exception as exc:  # unreadable file: skip, but never silently mix series
            raise DicomLoadError(f"cannot read {path.name}: {exc}") from exc
        if "PixelData" not in ds:
            continue
        groups.setdefault(str(ds.get("SeriesInstanceUID", "unknown")), []).append(ds)
    if not groups:
        raise DicomLoadError(f"no DICOM image files found in {root}")
    return groups


def _slice_normal(iop: list[float]) -> np.ndarray:
    row, col = np.asarray(iop[:3], float), np.asarray(iop[3:6], float)
    normal = np.cross(row, col)
    norm = np.linalg.norm(normal)
    return normal / norm if norm > 0 else normal


def load_series(directory: str | Path, series_uid: str | None = None) -> Series:
    """Load one series (default: the one with the most slices) as an HU volume.

    Slices are ordered by projecting ImagePositionPatient onto the slice normal,
    never by InstanceNumber.
    """
    groups = list_series(directory)
    if series_uid is None:
        series_uid = max(groups, key=lambda uid: len(groups[uid]))
    if series_uid not in groups:
        raise DicomLoadError(f"series {series_uid} not found; available: {sorted(groups)}")
    slices = groups[series_uid]
    first = slices[0]

    iop = first.get("ImageOrientationPatient")
    geometry: dict[str, Any] = {"orientation_present": iop is not None, "positions_present": True}
    if iop is not None:
        normal = _slice_normal([float(v) for v in iop])
        geometry["slice_normal"] = normal.tolist()
        geometry["consistent_orientation"] = all(
            s.get("ImageOrientationPatient") is not None
            and np.allclose([float(v) for v in s.ImageOrientationPatient], [float(v) for v in iop], atol=1e-4)
            for s in slices
        )
    else:
        normal = np.array([0.0, 0.0, 1.0])
        geometry["slice_normal"] = None
        geometry["consistent_orientation"] = False

    if all(s.get("ImagePositionPatient") is not None for s in slices):
        positions = [float(np.dot([float(v) for v in s.ImagePositionPatient], normal)) for s in slices]
    else:
        geometry["positions_present"] = False
        positions = [float(s.get("InstanceNumber", i)) for i, s in enumerate(slices)]
    order = np.argsort(positions, kind="stable")
    slices = [slices[i] for i in order]
    positions = [positions[i] for i in order]

    shapes = {(int(s.Rows), int(s.Columns)) for s in slices}
    if len(shapes) != 1:
        raise DicomLoadError(f"slices have differing matrix sizes: {sorted(shapes)}")

    slope_present = all("RescaleSlope" in s for s in slices)
    intercept_present = all("RescaleIntercept" in s for s in slices)
    hu = np.empty((len(slices), *shapes.pop()), dtype=np.float32)
    for i, s in enumerate(slices):
        slope = float(s.get("RescaleSlope", 1.0))
        intercept = float(s.get("RescaleIntercept", 0.0))
        hu[i] = s.pixel_array.astype(np.float32) * slope + intercept

    diffs = np.diff(positions) if len(positions) > 1 else np.array([])
    duplicates = int(np.sum(np.abs(diffs) < DUPLICATE_POSITION_TOL_MM))
    real = np.abs(diffs[np.abs(diffs) >= DUPLICATE_POSITION_TOL_MM])
    if len(real):
        increment = float(np.median(real))
        max_dev = float(np.max(np.abs(real - increment)) / increment)
    else:
        fallback = first.get("SpacingBetweenSlices") or first.get("SliceThickness") or 0.0
        increment = float(fallback)
        max_dev = 0.0
    geometry.update(
        slice_increment_mm=increment,
        increment_source="positions" if len(real) else "header",
        duplicate_positions=duplicates,
        max_increment_deviation=max_dev,
        uniform_spacing=max_dev <= NONUNIFORM_SPACING_TOL,
        z_coverage_mm=float(positions[-1] - positions[0]) + increment if positions else 0.0,
        num_slices=len(slices),
    )

    pixel_spacing = first.get("PixelSpacing")
    if pixel_spacing is not None:
        sy, sx = float(pixel_spacing[0]), float(pixel_spacing[1])  # (row spacing, column spacing)
    else:
        sx = sy = float("nan")

    metadata: dict[str, Any] = {tag: _get(first, tag) for tag in METADATA_TAGS}
    gating = {tag: first.get(tag) not in (None, "") for tag in GATING_TAGS}
    metadata["ecg_gating"] = {
        **{f"{tag}_present": present for tag, present in gating.items()},
        "CardiacSynchronizationTechnique": _get(first, "CardiacSynchronizationTechnique"),
        "evidence": any(gating.values()),
    }
    metadata["rescale"] = {
        "slope_present": slope_present,
        "intercept_present": intercept_present,
        "slope": _get(first, "RescaleSlope") if slope_present else 1.0,
        "intercept": _get(first, "RescaleIntercept") if intercept_present else 0.0,
        "defaults_applied": not (slope_present and intercept_present),
        "RescaleType": _get(first, "RescaleType"),
    }
    metadata["available_series"] = {uid: len(group) for uid, group in groups.items()}

    return Series(hu=hu, spacing=(sx, sy, increment), metadata=metadata, slice_positions=positions, geometry=geometry)
