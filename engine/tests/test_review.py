from __future__ import annotations

from pathlib import Path

import pytest

from asvanta_cac import ENGINE_VERSION
from asvanta_cac.dicom_io import load_series
from asvanta_cac.pipeline import UnsuitableSeriesError, run_analysis
from asvanta_cac.review import CacReview, ReviewError, ReviewLockedError
from conftest import phantom, write_series

U = "dr.rao"


@pytest.fixture
def series(phantom_dir: Path):
    return load_series(phantom_dir)


@pytest.fixture
def review(series) -> CacReview:
    return CacReview(run_analysis(series), series)


def lesion_at(review: CacReview, z: int) -> str:
    return next(les.id for les in review.lesions.values() if z in {r.z for r in les.regions})


def test_pipeline_result(series) -> None:
    result = run_analysis(series)
    assert result.kind == "standard"
    assert result.engine_version == ENGINE_VERSION
    assert result.total == pytest.approx(32.0)  # lesion A 2 x 8 + lesion B 16
    assert len(result.lesions) == 2
    assert all(les.vessel is None for les in result.lesions)
    assert result.unassigned_total == pytest.approx(32.0)
    assert any("Phase 5" in n for n in result.notes)


def test_pipeline_hooks(series) -> None:
    result = run_analysis(
        series,
        candidate_filter=lambda les, s: (les.peak_hu < 400, "outside heart (test)"),
        vessel_assigner=lambda les, s: "LAD",
    )
    assert len(result.lesions) == 1 and len(result.excluded) == 1
    assert result.excluded[0].excluded_reason == "outside heart (test)"
    assert result.vessel_totals["LAD"] == pytest.approx(16.0)
    assert result.total == pytest.approx(16.0)


def test_pipeline_refuses_contrast_unless_opportunistic(tmp_path: Path) -> None:
    write_series(tmp_path, phantom(), ContrastBolusAgent="Iodine")
    s = load_series(tmp_path)
    with pytest.raises(UnsuitableSeriesError):
        run_analysis(s)
    result = run_analysis(s, allow_opportunistic=True)
    assert result.kind == "opportunistic"
    assert "NOT a standard" in result.label


def test_pipeline_never_overrides_blocking(tmp_path: Path) -> None:
    write_series(tmp_path, phantom(), Modality="MR")
    with pytest.raises(UnsuitableSeriesError):
        run_analysis(load_series(tmp_path), allow_opportunistic=True)


def test_full_review_flow_and_algorithm_untouched(review: CacReview) -> None:
    algo_before = review.algorithm_result.to_dict()
    a, b = lesion_at(review, 10), lesion_at(review, 20)

    with pytest.raises(ReviewError, match="unreviewed"):
        review.approve(U)

    review.accept_lesion(a, user=U)
    review.set_vessel(a, "LAD", user=U)
    review.delete_lesion(b, "rib", user=U)
    assert review.summary()["final_total"] is None  # never final before approval
    summary = review.approve(U, at="2026-10-04T10:00:00Z")

    assert summary["status"] == "approved"
    assert summary["algorithm_total"] == pytest.approx(32.0)
    assert summary["final_total"] == pytest.approx(16.0)
    assert summary["delta"] == pytest.approx(-16.0)
    assert summary["vessel_totals"]["final"]["LAD"] == pytest.approx(16.0)
    assert summary["approved_by"] == U and summary["approved_at"] == "2026-10-04T10:00:00Z"
    assert summary["engine_version"] == ENGINE_VERSION
    assert review.algorithm_result.to_dict() == algo_before

    actions = [e["action"] for e in review.audit]
    assert actions == ["accept_lesion", "set_vessel", "delete_lesion", "approve"]
    assert all({"at", "user", "action", "lesion_id", "before", "after"} <= e.keys() for e in review.audit)

    with pytest.raises(ReviewLockedError):
        review.set_vessel(a, "RCA", user=U)
    with pytest.raises(ReviewLockedError):
        review.approve(U)


def test_approve_requires_vessel(review: CacReview) -> None:
    for lid in list(review.lesions):
        review.accept_lesion(lid, user=U)
    with pytest.raises(ReviewError, match="without vessel"):
        review.approve(U)


def test_delete_requires_reason_and_restore(review: CacReview) -> None:
    b = lesion_at(review, 20)
    with pytest.raises(ReviewError):
        review.delete_lesion(b, "  ", user=U)
    review.delete_lesion(b, "noise", user=U)
    assert review.working_total == pytest.approx(16.0)
    review.restore_excluded(b, user=U)
    assert review.lesions[b].status == "accepted"
    assert review.working_total == pytest.approx(32.0)


def test_restore_filter_excluded(series) -> None:
    result = run_analysis(series, candidate_filter=lambda les, s: (les.peak_hu < 400, "outside heart"))
    review = CacReview(result, series)
    excluded_id = result.excluded[0].id
    review.restore_excluded(excluded_id, user=U)
    assert review.working_total == pytest.approx(32.0)
    assert result.total == pytest.approx(16.0)


def test_add_lesion_from_seed_3d_and_2d(review: CacReview) -> None:
    a, b = lesion_at(review, 10), lesion_at(review, 20)
    with pytest.raises(ReviewError, match="inside an existing"):
        review.add_lesion_from_seed(20, 21, 21, user=U)
    with pytest.raises(ReviewError, match="below"):
        review.add_lesion_from_seed(0, 0, 0, user=U)

    review.delete_lesion(b, "test", user=U)
    m1 = review.add_lesion_from_seed(20, 21, 21, user=U)
    assert review.lesions[m1].score == pytest.approx(16.0)
    assert review.lesions[m1].origin == "manual"

    review.delete_lesion(a, "test", user=U)
    m2 = review.add_lesion_from_seed(10, 6, 6, user=U, mode="2d")
    assert review.lesions[m2].score == pytest.approx(8.0)  # one slice only
    m3 = review.add_lesion_from_seed(11, 6, 6, user=U, mode="3d")  # remaining slice, minus M2 voxels
    assert review.lesions[m3].score == pytest.approx(8.0)
    assert review.working_total == pytest.approx(32.0)


def test_erase_voxels_rescores(review: CacReview) -> None:
    b = lesion_at(review, 20)
    # lesion B is 4x4 px at 0.5 mm (4 mm2, factor 4 -> 16); erase 12 px -> 1 mm2 -> 4
    erase = [(20, y, x) for y in range(20, 24) for x in range(20, 24) if not (y < 22 and x < 22)]
    review.erase_voxels(b, erase, user=U)
    assert review.lesions[b].voxel_count == 4
    assert review.lesions[b].score == pytest.approx(4.0)
    # erasing one more drops below 1 mm2 -> lesion empties and is deleted
    review.erase_voxels(b, [(20, 20, 20)], user=U)
    assert b not in review.lesions and b in review.deleted
    assert review.recalculate(user=U) == pytest.approx(16.0)
    assert review.audit[-1]["action"] == "recalculate"
