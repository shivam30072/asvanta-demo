from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from asvanta_cac import api
from conftest import phantom, write_series

RAD = {"X-Role": "radiologist", "X-User": "dr.rao"}
STAFF = {"X-Role": "staff", "X-User": "front.desk"}
PATIENT = {"X-Role": "patient", "X-User": "p123"}


@pytest.fixture
def client() -> TestClient:
    for store in (api.JOBS, api.REVIEWS, api.APPROVED):
        store.clear()
    return TestClient(api.app)


def start_job(client: TestClient, series_dir: Path, study: str = "S1", **body) -> str:
    resp = client.post(f"/studies/{study}/cac/jobs", json={"series_dir": str(series_dir), **body}, headers=RAD)
    assert resp.status_code == 202
    return resp.json()["job_id"]


def test_patient_and_missing_headers_rejected(client: TestClient, phantom_dir: Path) -> None:
    body = {"series_dir": str(phantom_dir)}
    assert client.post("/studies/S1/cac/jobs", json=body, headers=PATIENT).status_code == 403
    assert client.post("/studies/S1/cac/jobs", json=body, headers=STAFF).status_code == 403
    assert client.get("/studies/S1/report-cac", headers=PATIENT).status_code == 403
    assert client.post("/studies/S1/cac/jobs", json=body).status_code == 422


def test_job_review_approve_report(client: TestClient, phantom_dir: Path) -> None:
    job_id = start_job(client, phantom_dir)
    job = client.get(f"/cac/jobs/{job_id}", headers=RAD).json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["kind"] == "standard"
    assert job["result"]["total"] == pytest.approx(32.0)
    lesions = job["review"]["lesions"]
    assert len(lesions) == 2
    assert client.get(f"/cac/jobs/{job_id}", headers=PATIENT).status_code == 403

    # nothing reported before approval
    assert client.get("/studies/S1/report-cac", headers=STAFF).status_code == 404
    assert client.post(f"/cac/jobs/{job_id}/approve", headers=RAD).status_code == 400

    keep, drop = (l["id"] for l in sorted(lesions, key=lambda l: l["slices"][0]))
    ops = [
        {"op": "delete", "lesion_id": drop, "reason": "sternal wire"},
        {"op": "accept", "lesion_id": keep},
        {"op": "set_vessel", "lesion_id": keep, "vessel": "RCA"},
    ]
    for op in ops:
        resp = client.post(f"/cac/jobs/{job_id}/review", json=op, headers=RAD)
        assert resp.status_code == 200, resp.text
    assert resp.json()["summary"]["final_total"] is None
    assert client.post(f"/cac/jobs/{job_id}/review", json={"op": "delete", "lesion_id": keep}, headers=RAD).status_code == 422
    assert client.post(f"/cac/jobs/{job_id}/review", json={"op": "accept", "lesion_id": "nope"}, headers=RAD).status_code == 400

    summary = client.post(f"/cac/jobs/{job_id}/approve", headers=RAD).json()
    assert summary["final_total"] == pytest.approx(16.0)
    assert summary["algorithm_total"] == pytest.approx(32.0)

    report = client.get("/studies/S1/report-cac", headers=STAFF)
    assert report.status_code == 200
    data = report.json()
    assert data["agatston_score"] == pytest.approx(16.0)
    assert data["vessel_scores"]["RCA"] == pytest.approx(16.0)
    assert data["approved_by"] == "dr.rao"
    assert "algorithm_total" not in data and "lesions" not in data

    # locked after approval; algorithm result still intact
    locked = client.post(f"/cac/jobs/{job_id}/review", json={"op": "recalculate"}, headers=RAD)
    assert locked.status_code == 409
    job = client.get(f"/cac/jobs/{job_id}", headers=RAD).json()
    assert job["result"]["total"] == pytest.approx(32.0)
    assert [e["action"] for e in job["review"]["audit"]][-1] == "approve"


def test_unsuitable_job_fails_and_opportunistic_override(client: TestClient, tmp_path: Path) -> None:
    write_series(tmp_path, phantom(), ContrastBolusAgent="Iodine")
    job = client.get(f"/cac/jobs/{start_job(client, tmp_path)}", headers=RAD).json()
    assert job["status"] == "failed"
    assert job["validation"]["verdict"] == "unsuitable"
    assert job["review"] is None

    job = client.get(f"/cac/jobs/{start_job(client, tmp_path, allow_opportunistic=True)}", headers=RAD).json()
    assert job["status"] == "done"
    assert job["result"]["kind"] == "opportunistic"


def test_unknown_job_404(client: TestClient) -> None:
    assert client.get("/cac/jobs/does-not-exist", headers=RAD).status_code == 404
