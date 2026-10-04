"""CAC analysis on a series pulled from the PACS (reuses the ``asvanta_cac`` engine)."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from .orthanc import Orthanc

# Uncompressed explicit VR little endian, so pydicom needs no extra codecs.
FILE_ACCEPT = "application/dicom; transfer-syntax=1.2.840.10008.1.2.1"


class Unsuitable(Exception):
    def __init__(self, message: str, validation: dict) -> None:
        super().__init__(message)
        self.validation = validation


async def download_series(orthanc: Orthanc, series_orthanc_id: str, dest: Path, concurrency: int = 8) -> int:
    info = await orthanc.get(f"/series/{series_orthanc_id}")
    instances = info.get("Instances", [])
    sem = asyncio.Semaphore(concurrency)

    async def one(i: int, iid: str) -> None:
        async with sem:
            with open(dest / f"{i:05d}.dcm", "wb") as fh:
                await orthanc.download_with_accept(f"/instances/{iid}/file", fh, FILE_ACCEPT)

    await asyncio.gather(*(one(i, iid) for i, iid in enumerate(instances)))
    return len(instances)


def _analyse(directory: Path, series_uid: str, allow_opportunistic: bool) -> dict:
    from asvanta_cac.dicom_io import load_series
    from asvanta_cac.pipeline import UnsuitableSeriesError, exclude_bone, run_analysis
    from asvanta_cac.validation import validate

    series = load_series(directory, series_uid)
    report = validate(series)
    if report.verdict == "unsuitable" and not (allow_opportunistic and report.overridable):
        hint = " (allowOpportunistic=true gives a labelled opportunistic estimate)" if report.overridable else ""
        raise Unsuitable("Series unsuitable for CAC scoring: " + "; ".join(report.reasons) + hint, report.to_dict())
    try:
        # no anatomy model yet: drop bone by size, leave every other candidate unassigned for the radiologist
        result = run_analysis(series, allow_opportunistic=allow_opportunistic, candidate_filter=exclude_bone)
    except UnsuitableSeriesError as exc:  # pragma: no cover - validate() above catches it first
        raise Unsuitable(str(exc), exc.report.to_dict()) from exc

    r2 = lambda v: round(float(v), 2)  # noqa: E731
    per_vessel = {k: r2(v) for k, v in result.vessel_totals.items()}
    return {
        "analysisId": result.analysis_id,
        "engineVersion": result.engine_version,
        "kind": result.kind,
        "label": result.label,
        "validation": result.validation.to_dict(),
        "totals": {**per_vessel, "unassigned": r2(result.unassigned_total), "total": r2(result.total)},
        "perVessel": per_vessel,
        "lesionCount": len(result.lesions),
        "lesions": [
            {
                "id": les.id, "score": r2(les.score), "peakHu": r2(les.peak_hu), "areaMm2": r2(les.area_mm2),
                "volumeMm3": r2(les.volume_mm3), "voxelCount": les.voxel_count, "slices": list(les.slices),
                "vessel": les.vessel,
            }
            for les in result.lesions
        ],
        "notes": list(result.notes),
        "spacing": list(result.spacing),
        "shape": list(result.shape),
        "startedAt": result.started_at,
        "finishedAt": result.finished_at,
    }


async def analyse_series(orthanc: Orthanc, series_orthanc_id: str, series_uid: str, allow_opportunistic: bool) -> tuple[dict, int]:
    with tempfile.TemporaryDirectory(prefix="asvanta-cac-") as tmp:
        n = await download_series(orthanc, series_orthanc_id, Path(tmp))
        result = await asyncio.to_thread(_analyse, Path(tmp), series_uid, allow_opportunistic)
    return result, n
