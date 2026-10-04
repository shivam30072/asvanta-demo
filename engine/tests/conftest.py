"""Shared fixtures: synthetic CT DICOM series written with pydicom."""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid


def write_series(
    directory: Path,
    hu: np.ndarray,
    *,
    pixel_spacing: tuple[float, float] = (0.5, 0.5),
    slice_increment: float = 3.0,
    z0: float = -100.0,
    positions: list[float] | None = None,
    series_uid: str | None = None,
    shuffle: bool = True,
    seed: int = 7,
    **overrides: Any,
) -> str:
    """Write ``hu`` (nz, ny, nx) as CT Image Storage files; returns the SeriesInstanceUID.

    Stored pixels are HU + 1024 with RescaleIntercept -1024. Files and InstanceNumbers
    are shuffled so loaders must sort by geometry. ``overrides`` set/remove (None) tags.
    """
    directory.mkdir(parents=True, exist_ok=True)
    nz, ny, nx = hu.shape
    series_uid = series_uid or generate_uid()
    study_uid = generate_uid()
    if positions is None:
        positions = [z0 + i * slice_increment for i in range(nz)]
    rng = random.Random(seed)
    instance_numbers = list(range(1, nz + 1))
    if shuffle:
        rng.shuffle(instance_numbers)

    for i in range(nz):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.Modality = "CT"
        ds.Manufacturer = "Synthetic"
        ds.ManufacturerModelName = "pytest"
        ds.SeriesDescription = "CaSc 3.0 synthetic"
        ds.InstanceNumber = instance_numbers[i]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [-nx * pixel_spacing[1] / 2, -ny * pixel_spacing[0] / 2, positions[i]]
        ds.PixelSpacing = list(pixel_spacing)
        ds.SliceThickness = slice_increment
        ds.KVP = 120
        ds.ConvolutionKernel = "Qr36"
        ds.TriggerTime = 400.0
        ds.Rows, ds.Columns = ny, nx
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = -1024
        ds.RescaleSlope = 1
        ds.RescaleType = "HU"
        ds.PixelData = (hu[i] + 1024).astype(np.uint16).tobytes()
        for key, value in overrides.items():
            if value is None:
                if key in ds:
                    delattr(ds, key)
            else:
                setattr(ds, key, value)
        ds.save_as(directory / f"img_{rng.randrange(10**8):08d}_{i}.dcm", enforce_file_format=True)
    return series_uid


def phantom(nz: int = 40, ny: int = 32, nx: int = 32) -> np.ndarray:
    """Soft-tissue background (40 HU) with two calcified lesions."""
    vol = np.full((nz, ny, nx), 40.0, dtype=np.float32)
    vol[10:12, 5:9, 5:9] = 250  # lesion A: 2 slices, factor 2
    vol[20, 20:24, 20:24] = 450  # lesion B: 1 slice, factor 4
    return vol


@pytest.fixture
def phantom_dir(tmp_path: Path) -> Path:
    d = tmp_path / "series"
    write_series(d, phantom())
    return d
