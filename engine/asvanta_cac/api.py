"""FastAPI service for CAC jobs, radiologist review and the approved-score report feed.

Demo-only choices (documented, not production):
* auth: ``X-Role`` (radiologist | staff | patient) and ``X-User`` headers stand in for real
  authentication/authorisation (OIDC + RBAC);
* jobs: FastAPI ``BackgroundTasks`` in-process; production should use Celery/RQ + Redis;
* storage: in-memory dicts, lost on restart; production needs a database with the
  algorithm result, review edits, audit trail and approved result stored separately.
"""

from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import ENGINE_VERSION
from .dicom_io import DicomLoadError, load_series
from .pipeline import OPPORTUNISTIC_LABEL, UnsuitableSeriesError, run_analysis, utcnow
from .review import CacReview, ReviewError, ReviewLockedError

Role = Literal["radiologist", "staff", "patient"]
DATA_ROOT_ENV = "ASVANTA_CAC_DATA_ROOT"  # if set, series_dir must live under this directory

app = FastAPI(title="AsvantaTech CAC engine", version=ENGINE_VERSION)

_lock = threading.Lock()
JOBS: dict[str, dict[str, Any]] = {}
REVIEWS: dict[str, CacReview] = {}
APPROVED: dict[str, dict[str, Any]] = {}  # study_id -> approved report (separate from algorithm output)


# ----------------------------------------------------------------------- auth
class Principal(BaseModel):
    user: str
    role: Role


def principal(x_role: str = Header(...), x_user: str = Header(...)) -> Principal:
    if x_role not in ("radiologist", "staff", "patient"):
        raise HTTPException(401, f"unknown role {x_role!r}")
    return Principal(user=x_user, role=x_role)  # type: ignore[arg-type]


def require(*roles: Role):
    def dep(p: Principal = Depends(principal)) -> Principal:
        if p.role not in roles:
            raise HTTPException(403, f"role {p.role!r} may not access this resource")
        return p

    return dep


radiologist = require("radiologist")
report_reader = require("radiologist", "staff")


# --------------------------------------------------------------------- models
class JobRequest(BaseModel):
    series_dir: str
    allow_opportunistic: bool = False


class ReviewOp(BaseModel):
    op: Literal["accept", "delete", "restore", "add_seed", "set_vessel", "erase", "recalculate"]
    lesion_id: str | None = None
    reason: str | None = None
    vessel: Literal["LM", "LAD", "LCX", "RCA"] | None = None
    seed: tuple[int, int, int] | None = Field(default=None, description="(z, y, x)")
    mode: Literal["2d", "3d"] = "3d"
    voxels: list[tuple[int, int, int]] | None = Field(default=None, description="[(z, y, x), ...]")


# ------------------------------------------------------------------- helpers
def _resolve_series_dir(series_dir: str) -> Path:
    path = Path(series_dir).resolve()
    root = os.environ.get(DATA_ROOT_ENV)
    if root and not path.is_relative_to(Path(root).resolve()):
        raise HTTPException(400, f"series_dir must be inside {DATA_ROOT_ENV}")
    return path


def _run_job(job_id: str, series_dir: Path, allow_opportunistic: bool) -> None:
    job = JOBS[job_id]
    job.update(status="running", started_at=utcnow())
    try:
        series = load_series(series_dir)
        result = run_analysis(series, allow_opportunistic=allow_opportunistic)
    except UnsuitableSeriesError as exc:
        job.update(status="failed", error=str(exc), validation=exc.report.to_dict(), finished_at=utcnow())
        return
    except (DicomLoadError, OSError, ValueError) as exc:
        job.update(status="failed", error=str(exc), finished_at=utcnow())
        return
    with _lock:
        REVIEWS[job_id] = CacReview(result, series)
    job.update(status="done", result=result.to_dict(), finished_at=utcnow())


def _job(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


def _review(job_id: str) -> CacReview:
    job = _job(job_id)
    review = REVIEWS.get(job_id)
    if review is None:
        raise HTTPException(409, f"job is {job['status']}; nothing to review")
    return review


# ----------------------------------------------------------------- endpoints
@app.post("/studies/{study_id}/cac/jobs", status_code=202)
def create_job(study_id: str, body: JobRequest, tasks: BackgroundTasks, p: Principal = Depends(radiologist)) -> dict:
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "job_id": job_id, "study_id": study_id, "status": "queued", "requested_by": p.user,
        "requested_at": utcnow(), "allow_opportunistic": body.allow_opportunistic,
        "result": None, "error": None,
    }
    tasks.add_task(_run_job, job_id, _resolve_series_dir(body.series_dir), body.allow_opportunistic)
    return {"job_id": job_id, "status": "queued"}


@app.get("/cac/jobs/{job_id}")
def get_job(job_id: str, p: Principal = Depends(radiologist)) -> dict:
    job = dict(_job(job_id))
    review = REVIEWS.get(job_id)
    job["review"] = review.state() if review else None
    return job


@app.post("/cac/jobs/{job_id}/review")
def review_op(job_id: str, body: ReviewOp, p: Principal = Depends(radiologist)) -> dict:
    review = _review(job_id)

    def need(value: Any, name: str) -> Any:
        if value is None:
            raise HTTPException(422, f"'{name}' is required for op '{body.op}'")
        return value

    out: dict[str, Any] = {}
    try:
        with _lock:
            if body.op == "accept":
                review.accept_lesion(need(body.lesion_id, "lesion_id"), user=p.user)
            elif body.op == "delete":
                review.delete_lesion(need(body.lesion_id, "lesion_id"), need(body.reason, "reason"), user=p.user)
            elif body.op == "restore":
                review.restore_excluded(need(body.lesion_id, "lesion_id"), user=p.user)
            elif body.op == "add_seed":
                z, y, x = need(body.seed, "seed")
                out["lesion_id"] = review.add_lesion_from_seed(z, y, x, user=p.user, mode=body.mode)
            elif body.op == "set_vessel":
                review.set_vessel(need(body.lesion_id, "lesion_id"), need(body.vessel, "vessel"), user=p.user)
            elif body.op == "erase":
                review.erase_voxels(need(body.lesion_id, "lesion_id"), need(body.voxels, "voxels"), user=p.user)
            elif body.op == "recalculate":
                review.recalculate(user=p.user)
    except ReviewLockedError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ReviewError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**out, **review.state()}


@app.post("/cac/jobs/{job_id}/approve")
def approve(job_id: str, p: Principal = Depends(radiologist)) -> dict:
    review = _review(job_id)
    try:
        with _lock:
            summary = review.approve(p.user)
    except ReviewLockedError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ReviewError as exc:
        raise HTTPException(400, str(exc)) from exc
    job = JOBS[job_id]
    kind = summary["kind"]
    APPROVED[job["study_id"]] = {
        "study_id": job["study_id"],
        "job_id": job_id,
        "agatston_score": summary["final_total"],
        "vessel_scores": summary["vessel_totals"]["final"],
        "kind": kind,
        "label": "Agatston score" if kind == "standard" else OPPORTUNISTIC_LABEL,
        "approved_by": summary["approved_by"],
        "approved_at": summary["approved_at"],
        "engine_version": summary["engine_version"],
    }
    return summary


@app.get("/studies/{study_id}/report-cac")
def report_cac(study_id: str, p: Principal = Depends(report_reader)) -> dict:
    """The only feed the reporting system reads: the radiologist-approved final score."""
    report = APPROVED.get(study_id)
    if report is None:
        raise HTTPException(404, "no approved CAC result for this study")
    return report
