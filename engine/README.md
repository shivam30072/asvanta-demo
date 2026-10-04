# asvanta-cac: deterministic Agatston engine (Phase 1)

This is the Python service behind the AsvantaTech radiologist-in-the-loop coronary artery calcium (CAC) module. The flow is:

DICOM series -> suitability checks -> HU volume -> 130 HU threshold -> lesions -> Agatston score -> radiologist review -> approval -> report.

The algorithm only proposes a result. A radiologist reviews it, edits it if needed, and approves it. The algorithm result and the approved result are stored separately, and every edit goes into an audit trail.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q                                   # includes all 10 cases in ../reference/cac-cases.json
.venv/bin/uvicorn asvanta_cac.api:app --reload        # http://127.0.0.1:8000/docs
```

## Modules

| module | role |
|---|---|
| `agatston.py` | Pure numpy/scipy scoring. Returns `Region` / `Lesion` / `AgatstonResult` dataclasses with no rounding. |
| `dicom_io.py` | Loads `.dcm` files, groups them by SeriesInstanceUID and sorts slices by position along the slice normal (not by InstanceNumber). Computes HU from the rescale tags and the slice increment, and flags non-uniform or duplicate slices. |
| `validation.py` | Suitability checks that produce a verdict of `ready`, `opportunistic` or `unsuitable`. |
| `pipeline.py` | `run_analysis()` returns an immutable `AnalysisResult`. It has hooks for `candidate_filter` and `vessel_assigner`. |
| `review.py` | `CacReview`: accept, delete (with a reason), restore, add from seed, set vessel, erase voxels, recalculate, approve and lock. Every operation is audited. |
| `api.py` | FastAPI jobs, review and approval endpoints, plus `GET /studies/{id}/report-cac`. |

## Agatston rules

These match `src/cac/agatston.js` and are pinned by `reference/cac-cases.json`.

- A calcium voxel has HU >= 130 (inclusive).
- Regions are 2D components on each axial slice, using 8-connectivity.
- A region counts if its area is >= 1.0 mm² (inclusive).
- Density factor from the region's peak HU: 130-199 = 1, 200-299 = 2, 300-399 = 3, >= 400 = 4.
- Region score = area_mm² × factor × (slice increment / 3 mm).
- Qualifying regions on adjacent slices that share at least one (x, y) pixel belong to the same 3D lesion. Each lesion reports its score, peak HU and volume.
- Per-vessel totals cover LM, LAD, LCX and RCA. Lesions with no vessel are listed and counted in the total, but not in any vessel's total.

## Validation verdicts

Each check has a severity:

- **blocking**: a failure makes the series `unsuitable` and cannot be overridden. Covers: not CT, missing RescaleSlope/Intercept, missing or inconsistent orientation or positions, duplicate or non-uniform slice spacing, non-axial slices.
- **overridable**: a contrast agent in the header makes the series `unsuitable` for standard Agatston. The caller can still ask for an explicitly labelled opportunistic run with `allow_opportunistic=true`.
- **standard**: anything other than a pass makes the series `opportunistic`. The score is still computed, but it is labelled *"Opportunistic estimate - NOT a standard Agatston score"*. Covers: no DICOM ECG-gating tags, slice thickness outside 2.5-3.0 mm, overlapping or gapped slices, pixel spacing > 1.0 mm, kVp other than 120, z-coverage < 100 mm.
- **info**: reported but does not change the verdict. Covers: noise SD > 30 HU in a central soft-tissue ROI.

All thresholds are named constants at the top of `validation.py`.

## API

The API uses demo auth. The `X-Role` (`radiologist` | `staff` | `patient`) and `X-User` headers stand in for real authentication and RBAC.

| endpoint | roles |
|---|---|
| `POST /studies/{study_id}/cac/jobs` `{series_dir, allow_opportunistic}` returns `job_id` | radiologist |
| `GET /cac/jobs/{job_id}` returns status (queued/running/done/failed), the algorithm result, the review state and the audit | radiologist |
| `POST /cac/jobs/{job_id}/review` `{op: accept\|delete\|restore\|add_seed\|set_vessel\|erase\|recalculate, ...}` | radiologist |
| `POST /cac/jobs/{job_id}/approve` (rejected while lesions are unreviewed or have no vessel) | radiologist |
| `GET /studies/{study_id}/report-cac` returns the approved final score only, or 404 if nothing is approved | radiologist, staff |

Patients get 403 on every endpoint.

Demo shortcuts:
- Jobs run in-process through FastAPI `BackgroundTasks`. Production should use Celery or RQ with Redis.
- Storage is in memory and is lost on restart. Production needs a database holding the algorithm result, review edits, audit trail and approved result as separate records.
- `series_dir` is a server path. Set `ASVANTA_CAC_DATA_ROOT` to confine it. Production should resolve series from the PACS store instead.

## Not done yet

- **Heart segmentation / localisation (Phase 3).** There is no default `candidate_filter`. Bone, valve and aortic calcium will appear as candidates, and z-coverage is only a rough stand-in for heart coverage.
- **Vessel assignment model (Phase 5).** There is no default `vessel_assigner`, so the radiologist assigns every lesion.
- **Celery/Redis workers, persistent storage, real authentication, DICOM SR/PDF output.**
- **Contrast detection from the image itself.** Only the header tag is checked.

## Clinical safety

This is a decision-support prototype and is not a cleared medical device. A score is final only after a radiologist approves it. Until then, `summary()["final_total"]` is `None` and `report-cac` returns 404. After approval the review is locked. The algorithm output is never changed, and both totals plus their difference are kept. An opportunistic result is always labelled as non-standard, including after approval.
