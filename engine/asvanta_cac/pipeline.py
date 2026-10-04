"""DICOM series -> validation -> Agatston -> AnalysisResult.

Heart localisation (candidate filtering) and vessel assignment are pluggable hooks
(Phase 3 / Phase 5). By default no candidate is filtered and every lesion is left
unassigned, so bone and other non-coronary calcium WILL appear as candidates; the
radiologist review step is mandatory.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Callable, Literal

import numpy as np

from . import ENGINE_VERSION
from .agatston import (
    DEFAULT_MIN_AREA_MM2,
    DEFAULT_THRESHOLD_HU,
    VESSELS,
    Lesion,
    encode_rle,
    score_volume,
)
from .dicom_io import Series
from .validation import ValidationReport, validate

Kind = Literal["standard", "opportunistic"]
CandidateFilter = Callable[[Lesion, Series], "tuple[bool, str]"]
VesselAssigner = Callable[[Lesion, Series], "str | None"]

HOOK_NOTES = (
    "Heart localisation not performed (Phase 3 hook): non-coronary calcium (bone, valves, aorta) may be listed.",
    "Vessel assignment not performed (Phase 5 hook): every lesion must be assigned by the radiologist.",
)
OPPORTUNISTIC_LABEL = "Opportunistic estimate - NOT a standard Agatston score"


MAX_CORONARY_VOLUME_MM3 = 1500.0


def exclude_bone(lesion: Lesion, series: Series) -> "tuple[bool, str]":
    """Default filter without an anatomy model: anything larger than any coronary
    plaque (spine, ribs, sternum) is bone. Same rule as src/cac/pipeline.js."""
    if lesion.volume_mm3 > MAX_CORONARY_VOLUME_MM3:
        return False, "Bone (too large for coronary calcium)"
    return True, ""


class UnsuitableSeriesError(Exception):
    """The series must not be scored (see ``report``)."""

    def __init__(self, message: str, report: ValidationReport) -> None:
        super().__init__(message)
        self.report = report


@dataclass(frozen=True)
class RegionRecord:
    z: int
    area_mm2: float
    peak_hu: float
    factor: int
    score: float


@dataclass(frozen=True)
class LesionRecord:
    """Serializable lesion; ``voxels_rle`` holds (z, y, x_start, length) runs."""

    id: str
    score: float
    peak_hu: float
    area_mm2: float
    volume_mm3: float
    voxel_count: int
    slices: tuple[int, ...]
    vessel: str | None
    regions: tuple[RegionRecord, ...]
    voxels_rle: tuple[tuple[int, int, int, int], ...]
    excluded_reason: str | None = None


@dataclass(frozen=True)
class AnalysisResult:
    """Immutable algorithm output. Never edited; review works on a copy."""

    analysis_id: str
    engine_version: str
    kind: Kind
    label: str
    validation: ValidationReport
    spacing: tuple[float, float, float]
    shape: tuple[int, int, int]
    threshold_hu: float
    min_area_mm2: float
    lesions: tuple[LesionRecord, ...]
    excluded: tuple[LesionRecord, ...]
    total: float
    vessel_totals: dict[str, float]
    unassigned_total: float
    series_uid: str | None
    started_at: str
    finished_at: str
    notes: tuple[str, ...] = field(default=())

    def to_dict(self) -> dict:
        return asdict(self)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def lesion_record(lesion: Lesion, vessel: str | None = None, excluded_reason: str | None = None) -> LesionRecord:
    return LesionRecord(
        id=lesion.id,
        score=lesion.score,
        peak_hu=lesion.peak_hu,
        area_mm2=lesion.area_mm2,
        volume_mm3=lesion.volume_mm3,
        voxel_count=lesion.voxel_count,
        slices=lesion.slices,
        vessel=vessel,
        regions=tuple(RegionRecord(r.z, r.area_mm2, r.peak_hu, r.factor, r.score) for r in lesion.regions),
        voxels_rle=tuple(encode_rle(lesion.voxels)),
        excluded_reason=excluded_reason,
    )


def totals_by_vessel(lesions: tuple[LesionRecord, ...] | list[LesionRecord]) -> tuple[dict[str, float], float]:
    """Per-vessel totals and the summed score of lesions without a valid vessel."""
    totals = {v: 0.0 for v in VESSELS}
    unassigned = 0.0
    for les in lesions:
        if les.vessel in totals:
            totals[les.vessel] += les.score
        else:
            unassigned += les.score
    return totals, unassigned


def run_analysis(
    series: Series,
    *,
    allow_opportunistic: bool = False,
    vessel_assigner: VesselAssigner | None = None,
    candidate_filter: CandidateFilter | None = None,
    threshold_hu: float = DEFAULT_THRESHOLD_HU,
    min_area_mm2: float = DEFAULT_MIN_AREA_MM2,
) -> AnalysisResult:
    """Validate and score a series.

    * verdict "ready" -> kind "standard"
    * verdict "opportunistic" -> kind "opportunistic" (labelled non-standard)
    * verdict "unsuitable" -> raises, unless only overridable checks failed (contrast)
      and ``allow_opportunistic`` is True, in which case kind is "opportunistic".
    Blocking failures (not CT, no HU calibration, bad geometry) are never overridable.
    """
    started = utcnow()
    report = validate(series)
    if report.verdict == "unsuitable":
        if not (allow_opportunistic and report.overridable):
            hint = " (pass allow_opportunistic=True for a labelled opportunistic estimate)" if report.overridable else ""
            raise UnsuitableSeriesError("Series unsuitable for CAC scoring: " + "; ".join(report.reasons) + hint, report)
    kind: Kind = "standard" if report.verdict == "ready" else "opportunistic"

    agatston = score_volume(series.hu, series.spacing, threshold_hu=threshold_hu, min_area_mm2=min_area_mm2)
    kept: list[LesionRecord] = []
    excluded: list[LesionRecord] = []
    for lesion in agatston.lesions:
        if candidate_filter is not None:
            keep, reason = candidate_filter(lesion, series)
            if not keep:
                excluded.append(lesion_record(lesion, excluded_reason=reason or "excluded by candidate filter"))
                continue
        vessel = vessel_assigner(lesion, series) if vessel_assigner is not None else None
        if vessel is not None and vessel not in VESSELS:
            vessel = None
        kept.append(lesion_record(lesion, vessel=vessel))

    vessel_totals, unassigned = totals_by_vessel(kept)
    notes = []
    if candidate_filter is None:
        notes.append(HOOK_NOTES[0])
    if vessel_assigner is None:
        notes.append(HOOK_NOTES[1])
    if kind == "opportunistic":
        notes.insert(0, OPPORTUNISTIC_LABEL + ": " + "; ".join(report.reasons))
    return AnalysisResult(
        analysis_id=str(uuid.uuid4()),
        engine_version=ENGINE_VERSION,
        kind=kind,
        label="Agatston score (algorithm, unapproved)" if kind == "standard" else OPPORTUNISTIC_LABEL + " (algorithm, unapproved)",
        validation=report,
        spacing=tuple(float(s) for s in series.spacing),  # type: ignore[arg-type]
        shape=tuple(int(n) for n in np.shape(series.hu)),  # type: ignore[arg-type]
        threshold_hu=threshold_hu,
        min_area_mm2=min_area_mm2,
        lesions=tuple(kept),
        excluded=tuple(excluded),
        total=sum(les.score for les in kept),
        vessel_totals=vessel_totals,
        unassigned_total=unassigned,
        series_uid=series.metadata.get("SeriesInstanceUID"),
        started_at=started,
        finished_at=utcnow(),
        notes=tuple(notes),
    )
