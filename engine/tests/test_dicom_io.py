from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from asvanta_cac.dicom_io import DicomLoadError, load_series
from conftest import write_series


def ramp_volume(nz: int = 5) -> np.ndarray:
    """Each slice has a distinct constant HU so ordering is easy to check."""
    vol = np.zeros((nz, 8, 10), dtype=np.float32)
    for z in range(nz):
        vol[z] = -1000 + 300 * z
    vol[2, 3, 4] = 777
    return vol


def test_orders_by_position_and_converts_hu(tmp_path: Path) -> None:
    vol = ramp_volume()
    write_series(tmp_path, vol, pixel_spacing=(0.6, 0.4), slice_increment=2.5, shuffle=True)
    series = load_series(tmp_path)
    assert series.hu.dtype == np.float32
    assert series.hu.shape == (5, 8, 10)
    np.testing.assert_array_equal(series.hu, vol)
    assert series.spacing == pytest.approx((0.4, 0.6, 2.5))
    assert series.geometry["uniform_spacing"] is True
    assert series.geometry["duplicate_positions"] == 0
    assert series.metadata["rescale"]["intercept"] == -1024
    assert series.metadata["rescale"]["defaults_applied"] is False
    assert series.metadata["Modality"] == "CT"
    assert series.metadata["KVP"] == 120
    assert series.metadata["ecg_gating"]["TriggerTime_present"] is True
    assert series.metadata["ecg_gating"]["evidence"] is True


def test_reversed_positions_are_sorted_ascending(tmp_path: Path) -> None:
    vol = ramp_volume(4)
    write_series(tmp_path, vol, positions=[30.0, 27.0, 24.0, 21.0])
    series = load_series(tmp_path)
    np.testing.assert_array_equal(series.hu, vol[::-1])
    assert series.slice_positions == [21.0, 24.0, 27.0, 30.0]


def test_nonuniform_and_duplicate_positions_flagged(tmp_path: Path) -> None:
    write_series(tmp_path / "a", ramp_volume(4), positions=[0.0, 3.0, 6.0, 10.0])
    geo = load_series(tmp_path / "a").geometry
    assert geo["uniform_spacing"] is False

    write_series(tmp_path / "b", ramp_volume(4), positions=[0.0, 3.0, 3.0, 6.0])
    geo = load_series(tmp_path / "b").geometry
    assert geo["duplicate_positions"] == 1
    assert geo["slice_increment_mm"] == pytest.approx(3.0)


def test_missing_rescale_is_recorded(tmp_path: Path) -> None:
    vol = np.full((2, 4, 4), 100, dtype=np.float32)
    write_series(tmp_path, vol, RescaleIntercept=None, RescaleSlope=None)
    series = load_series(tmp_path)
    assert series.metadata["rescale"]["defaults_applied"] is True
    assert float(series.hu[0, 0, 0]) == 1124.0  # raw stored values, no intercept applied


def test_groups_by_series_and_selects(tmp_path: Path) -> None:
    write_series(tmp_path, ramp_volume(3), series_uid="1.2.3.1")
    write_series(tmp_path, ramp_volume(6), series_uid="1.2.3.2")
    assert load_series(tmp_path).hu.shape[0] == 6  # default: largest series
    assert load_series(tmp_path, "1.2.3.1").hu.shape[0] == 3
    with pytest.raises(DicomLoadError):
        load_series(tmp_path, "9.9")


def test_empty_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(DicomLoadError):
        load_series(tmp_path)
