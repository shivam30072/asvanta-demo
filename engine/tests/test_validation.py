from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from asvanta_cac.dicom_io import Series, load_series
from asvanta_cac.validation import validate
from conftest import phantom, write_series


def good_series(nz: int = 40) -> Series:
    rng = np.random.default_rng(0)
    hu = (40 + rng.normal(0, 10, size=(nz, 64, 64))).astype(np.float32)
    meta = {
        "Modality": "CT",
        "SliceThickness": 3.0,
        "PixelSpacing": [0.5, 0.5],
        "KVP": 120,
        "ContrastBolusAgent": None,
        "SeriesDescription": "CaSc",
        "ecg_gating": {"TriggerTime_present": True, "evidence": True},
        "rescale": {"slope": 1.0, "intercept": -1024.0, "defaults_applied": False},
    }
    geometry = {
        "orientation_present": True,
        "consistent_orientation": True,
        "positions_present": True,
        "slice_normal": [0.0, 0.0, 1.0],
        "slice_increment_mm": 3.0,
        "duplicate_positions": 0,
        "max_increment_deviation": 0.0,
        "uniform_spacing": True,
        "z_coverage_mm": nz * 3.0,
        "num_slices": nz,
    }
    return Series(hu=hu, spacing=(0.5, 0.5, 3.0), metadata=meta, geometry=geometry)


def status(report, check_id: str) -> str:
    return next(c.status for c in report.checks if c.id == check_id)


def modified(**changes) -> Series:
    s = good_series()
    s = Series(s.hu, s.spacing, copy.deepcopy(s.metadata), [], copy.deepcopy(s.geometry))
    for key, value in changes.items():
        target, name = key.split("__")
        getattr(s, target)[name] = value
    return s


def test_good_series_is_ready() -> None:
    report = validate(good_series())
    assert report.verdict == "ready", report.reasons
    assert all(c.status == "pass" for c in report.checks)


@pytest.mark.parametrize(
    "changes,check_id",
    [
        ({"metadata__Modality": "MR"}, "modality"),
        ({"metadata__rescale": {"defaults_applied": True}}, "hu_calibration"),
        ({"geometry__uniform_spacing": False}, "geometry"),
        ({"geometry__duplicate_positions": 2}, "geometry"),
        ({"geometry__slice_normal": [0.0, 0.7071, 0.7071]}, "axial"),
    ],
)
def test_blocking_failures_are_unsuitable_and_not_overridable(changes: dict, check_id: str) -> None:
    report = validate(modified(**changes))
    assert status(report, check_id) == "fail"
    assert report.verdict == "unsuitable"
    assert report.overridable is False


def test_contrast_is_unsuitable_but_overridable() -> None:
    report = validate(modified(metadata__ContrastBolusAgent="Omnipaque"))
    assert report.verdict == "unsuitable"
    assert report.overridable is True


@pytest.mark.parametrize(
    "changes,check_id",
    [
        ({"metadata__ecg_gating": {"evidence": False}, "metadata__SeriesDescription": "Chest"}, "ecg_gating"),
        ({"metadata__ecg_gating": {"evidence": False}}, "ecg_gating"),  # description hint -> warn
        ({"metadata__SliceThickness": 1.0, "geometry__slice_increment_mm": 1.0}, "slice_thickness"),
        ({"geometry__slice_increment_mm": 1.5}, "slice_increment"),
        ({"metadata__KVP": 100}, "kvp"),
        ({"geometry__z_coverage_mm": 60.0}, "z_coverage"),
    ],
)
def test_standard_deviations_make_opportunistic(changes: dict, check_id: str) -> None:
    report = validate(modified(**changes))
    assert status(report, check_id) in ("warn", "fail")
    assert report.verdict == "opportunistic"


def test_pixel_spacing_over_1mm_is_opportunistic() -> None:
    s = good_series()
    s.spacing = (1.2, 1.2, 3.0)
    report = validate(s)
    assert status(report, "pixel_spacing") == "warn"
    assert report.verdict == "opportunistic"


def test_noise_is_info_only() -> None:
    s = good_series()
    s.hu = (40 + np.random.default_rng(1).normal(0, 60, size=s.hu.shape)).astype(np.float32)
    report = validate(s)
    assert status(report, "noise") == "warn"
    assert report.verdict == "ready"


def test_validate_loaded_dicom(tmp_path: Path) -> None:
    write_series(tmp_path, phantom())
    report = validate(load_series(tmp_path))
    assert report.verdict == "ready", report.reasons
    write_series(tmp_path / "c", phantom(), ContrastBolusAgent="Iodine")
    assert validate(load_series(tmp_path / "c")).verdict == "unsuitable"
