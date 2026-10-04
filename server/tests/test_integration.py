"""Against a live Orthanc. Skipped unless ORTHANC_URL is set and reachable.

    ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_USER=gateway ORTHANC_PASSWORD=... \
    ORTHANC_DICOM_HOST=127.0.0.1 ORTHANC_DICOM_PORT=4242 .venv/bin/pytest -m integration
"""

import importlib.util
import os
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from asvanta_gateway.app import create_app
from asvanta_gateway.config import Settings

URL = os.environ.get("ORTHANC_URL")
USER = os.environ.get("ORTHANC_USER", "gateway")
PW = os.environ.get("ORTHANC_PASSWORD", "")


def _reachable() -> bool:
    if not URL:
        return False
    try:
        return httpx.get(f"{URL}/system", auth=(USER, PW), timeout=3).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = [pytest.mark.integration, pytest.mark.skipif(not _reachable(), reason="needs a live Orthanc (ORTHANC_URL)")]


def _tool():
    path = Path(__file__).resolve().parents[2] / "tools" / "send_test_study.py"
    spec = importlib.util.spec_from_file_location("send_test_study", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_store_ingest_and_proxy(tmp_path):
    settings = Settings(db_path=str(tmp_path / "it.db"), orthanc_url=URL, orthanc_user=USER, orthanc_password=PW,
                        ingest_enabled=False, demo_password="it-pw")
    app = create_app(settings)
    tool = _tool()
    host = os.environ.get("ORTHANC_DICOM_HOST", "127.0.0.1")
    port = int(os.environ.get("ORTHANC_DICOM_PORT", "4242"))
    with TestClient(app) as client:
        token = client.post("/api/auth/login", json={"email": "priya@asvanta.in", "password": "it-pw"}).json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/pacs/scanners", json={"name": "IT_TEST", "aeTitle": "IT_TEST", "host": "127.0.0.1", "port": 11112},
                           headers=h).status_code == 201
        try:
            study = dict(uid=tool.generate_uid(), for_uid=tool.generate_uid(), date="20261004", time="120000",
                         accession="IT1", station="IT_TEST", referring="", phone=None, patient_name="IT^PATIENT",
                         patient_id="IT-1", birth_date="19700101", sex="F", age="056Y",
                         description="CT Integration", body_part="CHEST")
            series = tool.random_datasets(study, slices=4, n=64)
            assert tool.store(host, port, "ASVANTA", "IT_TEST", series) == 0
            deadline = time.time() + 60  # StableAge is ~10 s
            found = None
            while time.time() < deadline and not found:
                client.portal.call(app.state.ctx.ingestor.poll_once)
                found = next((s for s in client.get("/api/studies", headers=h).json() if s["studyInstanceUID"] == study["uid"]), None)
                if not found:
                    time.sleep(2)
            assert found, "study not ingested"
            assert found["receivedFrom"]["aeTitle"] == "IT_TEST" and found["images"] == 4
            [se] = client.get(f"/api/studies/{found['id']}/series", headers=h).json()
            meta = client.get(f"/api/dicomweb/studies/{study['uid']}/series/{se['seriesInstanceUID']}/metadata", headers=h)
            assert meta.status_code == 200 and len(meta.json()) == 4
        finally:
            client.delete("/api/pacs/scanners/IT_TEST", headers=h)
