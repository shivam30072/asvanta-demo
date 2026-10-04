"""CAC endpoint: series pulled from (fake) Orthanc as real DICOM, scored by asvanta_cac."""

import io

import httpx
import numpy as np
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

from conftest import ORTHANC, SERIES, STUDY_UID

SE_OID, SE_UID = SERIES[0][0], SERIES[0][1]
N_SLICES, N = 40, 96


def _slice(k: int, contrast: bool) -> bytes:
    rng = np.random.default_rng(k)
    hu = np.full((N, N), 40.0) + rng.normal(0, 8, (N, N))
    if 18 <= k <= 20:  # one calcified lesion, 3 slices, peak > 400 HU
        hu[40:45, 50:55] = 450
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = STUDY_UID, SE_UID
    ds.Modality, ds.KVP, ds.SliceThickness = "CT", 120, 3
    ds.SeriesDescription = "CaSc 3.0"
    ds.CardiacSynchronizationTechnique = "PROSPECTIVE"
    if contrast:
        ds.ContrastBolusAgent = "Iohexol 350"
    ds.PixelSpacing = [0.8, 0.8]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [0, 0, 3.0 * k]
    ds.InstanceNumber = k + 1
    ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.Rows = ds.Columns = N
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.PixelData = np.clip(np.round(hu + 1024), 0, 65535).astype("<u2").tobytes()
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def serve(fake_orthanc, contrast=False):
    files = {f"cac-{k}": _slice(k, contrast) for k in range(N_SLICES)}
    seen_accept = []
    fake_orthanc.router.get(f"/series/{SE_OID}").respond(json={"ID": SE_OID, "Instances": list(files)})

    def file(request: httpx.Request) -> httpx.Response:
        seen_accept.append(request.headers.get("accept"))
        iid = request.url.path.split("/")[2]
        return httpx.Response(200, content=files[iid], headers={"content-type": "application/dicom"})

    fake_orthanc.router.get(url__regex=rf"{ORTHANC}/instances/cac-\d+/file").mock(side_effect=file)
    return seen_accept


def test_cac_analysis_scores_series(client, rad, staff, ingested, fake_orthanc):
    accepts = serve(fake_orthanc)
    r = client.post(f"/api/studies/{ingested}/series/{SE_UID}/cac-analysis", json={"allowOpportunistic": False}, headers=rad)
    assert r.status_code == 200, r.text
    body = r.json()
    assert {"validation", "kind", "totals", "perVessel", "lesionCount", "engineVersion"} <= set(body)
    assert body["engineVersion"].startswith("cac-engine-")
    assert body["lesionCount"] == 1
    assert body["totals"]["total"] > 0 and body["totals"]["unassigned"] == body["totals"]["total"]
    assert set(body["perVessel"]) == {"LM", "LAD", "LCX", "RCA"}
    assert body["validation"]["verdict"] in ("ready", "opportunistic")
    assert body["instances"] == N_SLICES
    assert all(a and "transfer-syntax=1.2.840.10008.1.2.1" in a for a in accepts)
    # algorithm output is stored apart from the approved record
    assert client.get(f"/api/studies/{ingested}", headers=staff).json()["cac"] is None
    runs = client.get(f"/api/studies/{ingested}/cac-analyses", headers=rad).json()
    assert len(runs) == 1 and runs[0]["analysisId"] == body["analysisId"]


def test_cac_contrast_series_unsuitable_unless_opportunistic(client, rad, ingested, fake_orthanc):
    serve(fake_orthanc, contrast=True)
    url = f"/api/studies/{ingested}/series/{SE_UID}/cac-analysis"
    r = client.post(url, json={}, headers=rad)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["error"] == "unsuitable" and detail["validation"]["verdict"] == "unsuitable"
    assert detail["validation"]["overridable"] is True
    r = client.post(url, json={"allowOpportunistic": True}, headers=rad)
    assert r.status_code == 200 and r.json()["kind"] == "opportunistic"


def test_cac_unknown_series_and_roles(client, rad, staff, ingested):
    assert client.post(f"/api/studies/{ingested}/series/9.9.9/cac-analysis", json={}, headers=rad).status_code == 404
    assert client.post(f"/api/studies/{ingested}/series/{SE_UID}/cac-analysis", json={}, headers=staff).status_code == 403
