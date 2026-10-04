"""Agatston engine vs the shared hand-computed reference file (also used by the JS engine)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from asvanta_cac.agatston import density_factor, score_volume

REFERENCE = Path(__file__).resolve().parents[2] / "reference" / "cac-cases.json"
CASES = json.loads(REFERENCE.read_text())["cases"]


def build_volume(case: dict) -> np.ndarray:
    """Build a (nz, ny, nx) HU volume from a reference case description."""
    nx, ny, nz = case["dims"]
    vol = np.full((nz, ny, nx), case["background"], dtype=np.float32)
    for b in case.get("boxes", []):
        vol[b["z"], b["y0"] : b["y1"] + 1, b["x0"] : b["x1"] + 1] = b["hu"]
    for p in case.get("pixels", []):
        vol[p["z"], p["y"], p["x"]] = p["hu"]
    return vol


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_reference_case(case: dict) -> None:
    result = score_volume(build_volume(case), tuple(case["spacing"]))
    exp = case["expected"]
    assert result.total == pytest.approx(exp["total"], abs=1e-6)
    assert len(result.regions) == exp["regions"]
    assert len(result.lesions) == exp["lesions"]
    assert sum(les.score for les in result.lesions) == pytest.approx(result.total, abs=1e-9)


def test_all_reference_cases_present() -> None:
    assert len(CASES) == 10


@pytest.mark.parametrize(
    "hu,factor", [(129, 0), (130, 1), (199, 1), (200, 2), (299, 2), (300, 3), (399, 3), (400, 4), (2000, 4)]
)
def test_density_factor(hu: float, factor: int) -> None:
    assert density_factor(hu) == factor


def test_lesion_volume_and_peak() -> None:
    case = next(c for c in CASES if c["name"].startswith("one-lesion-across-three"))
    result = score_volume(build_volume(case), tuple(case["spacing"]))
    (lesion,) = result.lesions
    assert lesion.peak_hu == 420
    voxels = 16 + 16 + 9
    assert lesion.voxel_count == voxels
    assert lesion.volume_mm3 == pytest.approx(voxels * 0.5 * 0.5 * 3.0)


def test_per_vessel_totals_exclude_unassigned() -> None:
    case = next(c for c in CASES if c["name"] == "density-factor-boundaries")
    result = score_volume(build_volume(case), tuple(case["spacing"]))
    labels = {}
    for i, les in enumerate(result.lesions):
        labels[les.id] = ["LAD", "RCA", "OTHER", None][i % 4]
    from asvanta_cac.agatston import vessel_totals

    totals, unassigned = vessel_totals(result.lesions, labels)
    assert set(totals) == {"LM", "LAD", "LCX", "RCA"}
    assert totals["LM"] == 0 and totals["LCX"] == 0
    assert len(unassigned) == 4
    assert sum(totals.values()) + sum(l.score for l in result.lesions if l.id in unassigned) == pytest.approx(
        result.total
    )


def test_exclude_bone_filter_drops_only_large_lesions():
    from types import SimpleNamespace

    from asvanta_cac.pipeline import MAX_CORONARY_VOLUME_MM3, exclude_bone

    assert exclude_bone(SimpleNamespace(volume_mm3=MAX_CORONARY_VOLUME_MM3 + 1), None)[0] is False
    assert exclude_bone(SimpleNamespace(volume_mm3=40.0), None) == (True, "")
