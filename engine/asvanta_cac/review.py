"""Radiologist review: edits on a working copy, approval, and an append-only audit trail.

The algorithm ``AnalysisResult`` is frozen and kept untouched; every edit happens on
working lesions. A score is only *final* once ``approve`` succeeds, after which the
review is locked.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

import numpy as np

from .agatston import VESSELS, decode_rle, encode_rle, score_volume, voxels_to_mask
from .dicom_io import Series
from .pipeline import AnalysisResult, RegionRecord, utcnow

LesionStatus = Literal["pending", "accepted"]
Origin = Literal["algorithm", "manual"]


class ReviewError(ValueError):
    """Invalid review operation (unknown lesion, bad seed, approval preconditions...)."""


class ReviewLockedError(ReviewError):
    """The review was approved and can no longer be edited."""


@dataclass
class WorkingLesion:
    id: str
    origin: Origin
    status: LesionStatus
    vessel: str | None
    voxels: np.ndarray = field(repr=False)  # (N, 3) int32 (z, y, x) of qualifying voxels
    score: float = 0.0
    peak_hu: float = 0.0
    area_mm2: float = 0.0
    volume_mm3: float = 0.0
    regions: tuple[RegionRecord, ...] = ()
    reason: str | None = None  # why it is excluded/deleted

    @property
    def voxel_count(self) -> int:
        return int(len(self.voxels))

    def snapshot(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "vessel": self.vessel,
            "score": self.score,
            "voxel_count": self.voxel_count,
            "reason": self.reason,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "origin": self.origin,
            **self.snapshot(),
            "peak_hu": self.peak_hu,
            "area_mm2": self.area_mm2,
            "volume_mm3": self.volume_mm3,
            "slices": sorted({r.z for r in self.regions}),
            "regions": [vars(r) for r in self.regions],
            "voxels_rle": encode_rle(self.voxels),
        }


class CacReview:
    """Working copy of an algorithm result plus audit trail for one radiologist review."""

    def __init__(self, result: AnalysisResult, series: Series) -> None:
        self._result = result
        self._series = series
        self.lesions: dict[str, WorkingLesion] = {}
        self.excluded: dict[str, WorkingLesion] = {}
        self.deleted: dict[str, WorkingLesion] = {}
        self.audit: list[dict[str, Any]] = []
        self.approved_by: str | None = None
        self.approved_at: str | None = None
        self._manual_seq = 0
        self._auto_cache = None
        for rec in result.lesions:
            self.lesions[rec.id] = self._from_record(rec, status="pending")
        for rec in result.excluded:
            self.excluded[rec.id] = self._from_record(rec, status="pending")

    # ------------------------------------------------------------------ helpers
    @property
    def algorithm_result(self) -> AnalysisResult:
        return self._result

    @property
    def locked(self) -> bool:
        return self.approved_at is not None

    @staticmethod
    def _from_record(rec, status: LesionStatus) -> WorkingLesion:
        return WorkingLesion(
            id=rec.id, origin="algorithm", status=status, vessel=rec.vessel,
            voxels=decode_rle(rec.voxels_rle), score=rec.score, peak_hu=rec.peak_hu,
            area_mm2=rec.area_mm2, volume_mm3=rec.volume_mm3, regions=rec.regions, reason=rec.excluded_reason,
        )

    def _log(self, action: str, user: str, at: str | None, lesion_id: str | None, before: Any, after: Any) -> None:
        self.audit.append(
            {"at": at or utcnow(), "user": user, "action": action, "lesion_id": lesion_id, "before": before, "after": after}
        )

    def _check_editable(self) -> None:
        if self.locked:
            raise ReviewLockedError(f"review approved by {self.approved_by} at {self.approved_at}; it is locked")

    def _get(self, lesion_id: str) -> WorkingLesion:
        try:
            return self.lesions[lesion_id]
        except KeyError:
            raise ReviewError(f"unknown active lesion {lesion_id!r}") from None

    def _rescore(self, lesion: WorkingLesion, voxels: np.ndarray) -> None:
        """Recompute a lesion from a voxel set using the engine rules (cropped to its bounding box)."""
        r = self._result
        if len(voxels) == 0:
            lesion.voxels, lesion.score, lesion.peak_hu, lesion.area_mm2, lesion.volume_mm3, lesion.regions = (
                np.zeros((0, 3), np.int32), 0.0, 0.0, 0.0, 0.0, ())
            return
        lo, hi = voxels.min(axis=0), voxels.max(axis=0) + 1
        sub = self._series.hu[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
        mask = voxels_to_mask(voxels - lo, sub.shape)
        res = score_volume(sub, r.spacing, threshold_hu=r.threshold_hu, min_area_mm2=r.min_area_mm2, mask=mask)
        kept = [les.voxels + lo for les in res.lesions]
        lesion.voxels = np.concatenate(kept).astype(np.int32) if kept else np.zeros((0, 3), np.int32)
        lesion.score = res.total
        lesion.peak_hu = max((reg.peak_hu for reg in res.regions), default=0.0)
        lesion.area_mm2 = sum(reg.area_mm2 for reg in res.regions)
        lesion.volume_mm3 = len(lesion.voxels) * float(np.prod(r.spacing))
        lesion.regions = tuple(
            RegionRecord(int(reg.z + lo[0]), reg.area_mm2, reg.peak_hu, reg.factor, reg.score) for reg in res.regions
        )

    def _active_mask(self) -> np.ndarray:
        mask = np.zeros(self._series.hu.shape, dtype=bool)
        for les in self.lesions.values():
            if len(les.voxels):
                mask |= voxels_to_mask(les.voxels, mask.shape)
        return mask

    @property
    def working_total(self) -> float:
        return sum(les.score for les in self.lesions.values())

    def _vessel_totals(self) -> tuple[dict[str, float], float]:
        totals = {v: 0.0 for v in VESSELS}
        unassigned = 0.0
        for les in self.lesions.values():
            if les.vessel in totals:
                totals[les.vessel] += les.score
            else:
                unassigned += les.score
        return totals, unassigned

    # --------------------------------------------------------------- operations
    def accept_lesion(self, lesion_id: str, *, user: str, at: str | None = None) -> None:
        """Mark an algorithm lesion as reviewed and kept."""
        self._check_editable()
        les = self._get(lesion_id)
        before = les.snapshot()
        les.status = "accepted"
        self._log("accept_lesion", user, at, lesion_id, before, les.snapshot())

    def delete_lesion(self, lesion_id: str, reason: str, *, user: str, at: str | None = None) -> None:
        """Remove a lesion from the working result (e.g. bone, valve, noise)."""
        self._check_editable()
        if not reason or not reason.strip():
            raise ReviewError("a reason is required to delete a lesion")
        les = self._get(lesion_id)
        before = les.snapshot()
        les.reason = reason
        self.deleted[lesion_id] = self.lesions.pop(lesion_id)
        self._log("delete_lesion", user, at, lesion_id, before, None)

    def restore_excluded(self, lesion_id: str, *, user: str, at: str | None = None) -> None:
        """Bring back a lesion excluded by the candidate filter or deleted earlier (marked accepted)."""
        self._check_editable()
        source = self.excluded if lesion_id in self.excluded else self.deleted if lesion_id in self.deleted else None
        if source is None:
            raise ReviewError(f"lesion {lesion_id!r} is neither excluded nor deleted")
        les = source[lesion_id]
        if len(les.voxels) and self._active_mask()[tuple(les.voxels.T)].any():
            raise ReviewError(f"lesion {lesion_id!r} overlaps an active lesion")
        before = les.snapshot()
        del source[lesion_id]
        les.status, les.reason = "accepted", None
        self.lesions[lesion_id] = les
        self._log("restore_lesion", user, at, lesion_id, before, les.snapshot())

    def add_lesion_from_seed(
        self, z: int, y: int, x: int, *, user: str, mode: Literal["2d", "3d"] = "3d", at: str | None = None
    ) -> str:
        """Grow a new lesion (>= threshold, same 8-connectivity/min-area/linking rules) from a seed voxel."""
        self._check_editable()
        hu, r = self._series.hu, self._result
        if not (0 <= z < hu.shape[0] and 0 <= y < hu.shape[1] and 0 <= x < hu.shape[2]):
            raise ReviewError(f"seed ({z}, {y}, {x}) outside volume {hu.shape}")
        if hu[z, y, x] < r.threshold_hu:
            raise ReviewError(f"seed HU {float(hu[z, y, x]):.0f} is below the {r.threshold_hu:g} HU threshold")
        active = self._active_mask()
        if active[z, y, x]:
            raise ReviewError("seed lies inside an existing lesion")

        if mode == "2d":
            res = score_volume(hu[z : z + 1], r.spacing, threshold_hu=r.threshold_hu, min_area_mm2=r.min_area_mm2)
            offset = np.array([z, 0, 0], dtype=np.int32)
        elif mode == "3d":
            if self._auto_cache is None:
                self._auto_cache = score_volume(hu, r.spacing, threshold_hu=r.threshold_hu, min_area_mm2=r.min_area_mm2)
            res, offset = self._auto_cache, np.zeros(3, dtype=np.int32)
        else:
            raise ReviewError(f"mode must be '2d' or '3d', got {mode!r}")

        target = np.array([z, y, x])
        grown = next((les.voxels + offset for les in res.lesions if ((les.voxels + offset) == target).all(1).any()), None)
        if grown is None:
            raise ReviewError(f"region at seed is smaller than the {r.min_area_mm2:g} mm2 minimum area")
        grown = grown[~active[tuple(grown.T)]]  # never double-count voxels of existing lesions

        self._manual_seq += 1
        lesion = WorkingLesion(id=f"M{self._manual_seq}", origin="manual", status="accepted", vessel=None, voxels=grown)
        self._rescore(lesion, grown)
        if lesion.score <= 0:
            raise ReviewError("grown region does not qualify after removing voxels of existing lesions")
        self.lesions[lesion.id] = lesion
        self._log("add_lesion_from_seed", user, at, lesion.id, {"seed": [z, y, x], "mode": mode}, lesion.snapshot())
        return lesion.id

    def set_vessel(self, lesion_id: str, vessel: str, *, user: str, at: str | None = None) -> None:
        self._check_editable()
        if vessel not in VESSELS:
            raise ReviewError(f"vessel must be one of {VESSELS}, got {vessel!r}")
        les = self._get(lesion_id)
        before = les.snapshot()
        les.vessel = vessel
        self._log("set_vessel", user, at, lesion_id, before, les.snapshot())

    def erase_voxels(
        self, lesion_id: str, voxels: Iterable[Sequence[int]], *, user: str, at: str | None = None
    ) -> None:
        """Remove voxels from a lesion and rescore it; a lesion left empty is deleted."""
        self._check_editable()
        les = self._get(lesion_id)
        erase = np.asarray(list(voxels), dtype=np.int32).reshape(-1, 3)
        before = les.snapshot()
        shape = np.array(self._series.hu.shape)
        erase = erase[((erase >= 0) & (erase < shape)).all(1)]
        if len(erase):
            erase_mask = voxels_to_mask(erase, self._series.hu.shape)
            self._rescore(les, les.voxels[~erase_mask[tuple(les.voxels.T)]])
        after = les.snapshot()
        self._log("erase_voxels", user, at, lesion_id, {**before, "erased": int(len(erase))}, after)
        if les.voxel_count == 0:
            les.reason = "all voxels erased"
            self.deleted[lesion_id] = self.lesions.pop(lesion_id)
            self._log("delete_lesion", user, at, lesion_id, after, None)

    def recalculate(self, *, user: str, at: str | None = None) -> float:
        """Rescore every active lesion from its voxels; returns the working total."""
        self._check_editable()
        before = self.working_total
        for les in self.lesions.values():
            self._rescore(les, les.voxels)
        self._log("recalculate", user, at, None, {"working_total": before}, {"working_total": self.working_total})
        return self.working_total

    def approve(self, user: str, at: str | None = None) -> dict[str, Any]:
        """Approve and lock. Requires every lesion reviewed (not pending) and vessel-assigned."""
        self._check_editable()
        pending = sorted(i for i, les in self.lesions.items() if les.status == "pending")
        no_vessel = sorted(i for i, les in self.lesions.items() if les.vessel not in VESSELS)
        problems = []
        if pending:
            problems.append(f"unreviewed lesions: {', '.join(pending)}")
        if no_vessel:
            problems.append(f"lesions without vessel: {', '.join(no_vessel)}")
        if problems:
            raise ReviewError("cannot approve - " + "; ".join(problems))
        at = at or utcnow()
        self._log("approve", user, at, None, None, {"final_total": self.working_total})
        self.approved_by, self.approved_at = user, at
        return self.summary()

    # ------------------------------------------------------------------ output
    def summary(self) -> dict[str, Any]:
        """Algorithm vs working/final totals. ``final_total`` is None until approved."""
        r = self._result
        working, working_unassigned = self._vessel_totals()
        return {
            "analysis_id": r.analysis_id,
            "engine_version": r.engine_version,
            "kind": r.kind,
            "status": "approved" if self.locked else "draft",
            "algorithm_total": r.total,
            "working_total": self.working_total,
            "final_total": self.working_total if self.locked else None,
            "delta": self.working_total - r.total,
            "vessel_totals": {
                "algorithm": dict(r.vessel_totals),
                "working": working,
                "final": working if self.locked else None,
            },
            "unassigned_total": {"algorithm": r.unassigned_total, "working": working_unassigned},
            "lesion_counts": {
                "active": len(self.lesions),
                "pending": sum(les.status == "pending" for les in self.lesions.values()),
                "deleted": len(self.deleted),
                "excluded": len(self.excluded),
            },
            "approved_by": self.approved_by,
            "approved_at": self.approved_at,
        }

    def state(self) -> dict[str, Any]:
        return {
            "summary": self.summary(),
            "lesions": [les.to_dict() for les in self.lesions.values()],
            "deleted": [les.to_dict() for les in self.deleted.values()],
            "excluded": [les.to_dict() for les in self.excluded.values()],
            "audit": list(self.audit),
        }
