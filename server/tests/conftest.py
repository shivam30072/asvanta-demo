"""Fixtures: a gateway app wired to a fake Orthanc (respx) and a temp SQLite DB."""

from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from asvanta_gateway.app import create_app
from asvanta_gateway.config import Settings

ORTHANC = "http://orthanc.test"
STUDY_UID = "1.2.826.0.1.3680043.8.498.100"
OTHER_STUDY_UID = "1.2.826.0.1.3680043.8.498.999"
SERIES = [
    # (orthanc id, SeriesInstanceUID, number, description, instance ids, thickness)
    ("se-cac", STUDY_UID + ".1", 1, "CaSc 3.0 Qr36 75%", ["i-cac-1", "i-cac-2", "i-cac-3"], "3"),
    ("se-cta", STUDY_UID + ".2", 2, "CCTA 1.0 Bv40 75%", ["i-cta-1", "i-cta-2"], "1"),
]
PASSWORD = "test-pw"


class FakeOrthanc:
    """The handful of Orthanc REST routes the gateway uses, backed by respx."""

    def __init__(self, router: respx.MockRouter) -> None:
        self.router = router
        self.changes = [
            {"ChangeType": "NewStudy", "ID": "st-1", "Seq": 3, "ResourceType": "Study"},
            {"ChangeType": "StableStudy", "ID": "st-1", "Seq": 41, "ResourceType": "Study"},
        ]
        self.modalities: dict[str, dict] = {"CT_ROOM1": {"AET": "CT_ROOM1", "Host": "10.0.0.21", "Port": 104}}
        self.instance_count = sum(len(s[4]) for s in SERIES)
        r = router
        r.get("/system").respond(json={"Name": "fake", "DicomAet": "ASVANTA"})
        r.get("/changes").mock(side_effect=self._changes)
        r.get("/studies/st-1").mock(side_effect=lambda req: httpx.Response(200, json=self.study()))
        r.get("/studies/st-1/series").mock(side_effect=lambda req: httpx.Response(200, json=self.series()))
        r.get("/studies/st-1/statistics").mock(
            side_effect=lambda req: httpx.Response(200, json={"CountInstances": self.instance_count, "CountSeries": 2,
                                                              "DiskSize": "1048576", "DiskSizeMB": 1}))
        r.get(url__regex=rf"{ORTHANC}/instances/[^/]+/simplified-tags").respond(json={
            "PatientName": "MALHOTRA^VIKRAM", "PatientID": "PT-10251", "PatientBirthDate": "19680901",
            "PatientSex": "M", "PatientAge": "058Y", "PatientTelephoneNumbers": "98190 33417",
            "StudyDescription": "CT Cardiac (Calcium score + CTA)", "BodyPartExamined": "HEART",
            "StudyDate": "20261004", "StudyInstanceUID": STUDY_UID, "ReferringPhysicianName": "PATEL^M^^Dr.",
            "Modality": "CT",
        })
        r.get(url__regex=rf"{ORTHANC}/instances/[^/]+/metadata").respond(json={
            "RemoteAET": "CT_ROOM1", "RemoteIP": "10.0.0.21", "CalledAET": "ASVANTA", "Origin": "DicomProtocol",
        })
        r.get(url__regex=rf"{ORTHANC}/instances/i-cac-1/content/0018,0050").respond(text="3 ")
        r.get(url__regex=rf"{ORTHANC}/instances/i-cta-1/content/0018,0050").respond(text="1 ")
        r.get("/modalities").mock(side_effect=lambda req: httpx.Response(200, json=self.modalities))
        r.put(url__regex=rf"{ORTHANC}/modalities/[^/]+$").mock(side_effect=self._put_modality)
        r.delete(url__regex=rf"{ORTHANC}/modalities/[^/]+$").mock(side_effect=self._delete_modality)
        r.post(url__regex=rf"{ORTHANC}/modalities/CT_ROOM1/echo").respond(json={})

    def study(self) -> dict:
        return {
            "ID": "st-1", "Type": "Study", "Series": [s[0] for s in SERIES],
            "MainDicomTags": {"StudyInstanceUID": STUDY_UID, "StudyDate": "20261004",
                              "StudyDescription": "CT Cardiac (Calcium score + CTA)", "ReferringPhysicianName": "PATEL^M^^Dr."},
            "PatientMainDicomTags": {"PatientName": "MALHOTRA^VIKRAM", "PatientID": "PT-10251",
                                     "PatientBirthDate": "19680901", "PatientSex": "M"},
        }

    def series(self) -> list[dict]:
        return [
            {"ID": oid, "Instances": inst, "MainDicomTags": {"SeriesInstanceUID": uid, "SeriesNumber": str(n),
                                                             "SeriesDescription": d, "Modality": "CT"}}
            for oid, uid, n, d, inst, _ in SERIES
        ]

    def _changes(self, request: httpx.Request) -> httpx.Response:
        if "last" in request.url.params:
            return httpx.Response(200, json={"Changes": [], "Last": self.changes[-1]["Seq"] if self.changes else 0})
        since = int(request.url.params.get("since", 0))
        pending = [c for c in self.changes if c["Seq"] > since]
        last = self.changes[-1]["Seq"] if self.changes else 0
        return httpx.Response(200, json={"Changes": pending, "Done": True, "Last": last})

    def _put_modality(self, request: httpx.Request) -> httpx.Response:
        import json

        name = request.url.path.rsplit("/", 1)[1]
        self.modalities[name] = json.loads(request.content)
        return httpx.Response(200, json={})

    def _delete_modality(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[1]
        if name not in self.modalities:
            return httpx.Response(404, json={"Message": "Unknown resource"})
        del self.modalities[name]
        return httpx.Response(200, json={})


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(db_path=str(tmp_path / "gateway.db"), orthanc_url=ORTHANC, ingest_enabled=False,
                    demo_password=PASSWORD, public_base_url="https://app.test", centre_name="Asvanta Diagnostics",
                    pacs_host="192.168.1.10")


@pytest.fixture
def fake_orthanc():
    with respx.mock(base_url=ORTHANC, assert_all_called=False, assert_all_mocked=True) as router:
        yield FakeOrthanc(router)


@pytest.fixture
def app(settings, fake_orthanc):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


def login(client: TestClient, email: str) -> dict:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def staff(client) -> dict:
    return login(client, "priya@asvanta.in")


@pytest.fixture
def rad(client) -> dict:
    return login(client, "dr.mehta@asvanta.in")


@pytest.fixture
def ingested(client, app) -> str:
    """Run one ingest pass; returns the gateway study id."""
    n = client.portal.call(app.state.ctx.ingestor.poll_once)
    assert n == 1
    return "STD-30001"


def sign_report(client, rad, study_id: str, findings: str = "Calcified plaque in proximal LAD.", impression: str = "CAC present.") -> None:
    assert client.put(f"/api/studies/{study_id}/report", json={"findings": findings, "impression": impression}, headers=rad).status_code == 200
    assert client.post(f"/api/studies/{study_id}/report/sign", headers=rad).status_code == 200
