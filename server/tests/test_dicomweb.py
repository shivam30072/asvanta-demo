import httpx
import pytest

from conftest import ORTHANC, OTHER_STUDY_UID, SERIES, STUDY_UID

FRAME_CT = 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1; boundary=abc123'
FRAME_BODY = b"--abc123\r\nContent-Type: application/octet-stream\r\n\r\n" + bytes(range(256)) * 4 + b"\r\n--abc123--\r\n"
ACCEPT = 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1'
SE = SERIES[0][1]
FRAME_PATH = f"studies/{STUDY_UID}/series/{SE}/instances/1.2.3.4.5/frames/1"


@pytest.fixture
def dw(fake_orthanc):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/frames/1"):
            return httpx.Response(200, headers={"content-type": FRAME_CT}, content=FRAME_BODY)
        return httpx.Response(200, json=[{"0020000D": {"vr": "UI", "Value": [STUDY_UID]}}],
                              headers={"content-type": "application/dicom+json"})

    fake_orthanc.router.get(url__regex=rf"{ORTHANC}/dicom-web/.*").mock(side_effect=handler)
    return seen


def test_staff_proxy_passes_multipart_untouched(client, staff, ingested, dw):
    r = client.get(f"/api/dicomweb/{FRAME_PATH}", headers={**staff, "Accept": ACCEPT})
    assert r.status_code == 200
    assert r.headers["content-type"] == FRAME_CT
    assert r.content == FRAME_BODY
    assert dw[-1].headers["accept"] == ACCEPT
    assert dw[-1].url.path == f"/dicom-web/{FRAME_PATH}"


def test_staff_proxy_forwards_query(client, rad, ingested, dw):
    r = client.get(f"/api/dicomweb/studies?PatientID=PT-10251&limit=5&includefield=00081030", headers=rad)
    assert r.status_code == 200 and r.headers["content-type"] == "application/dicom+json"
    assert dw[-1].url.params.get("PatientID") == "PT-10251" and dw[-1].url.params.get("limit") == "5"


def test_staff_proxy_needs_auth_and_blocks_escape(client, staff, ingested, dw):
    assert client.get(f"/api/dicomweb/{FRAME_PATH}").status_code == 401
    assert client.get("/api/dicomweb/studies/%2E%2E/%2E%2E/system", headers=staff).status_code == 400
    assert client.get("/api/dicomweb/servers/remote/studies", headers=staff).status_code == 404
    assert not dw


def test_upstream_error_status_passes_through(client, staff, ingested, fake_orthanc):
    fake_orthanc.router.get(url__regex=rf"{ORTHANC}/dicom-web/studies/9\.9.*").respond(404, json={"Message": "nope"})
    assert client.get("/api/dicomweb/studies/9.9/metadata", headers=staff).status_code == 404


@pytest.fixture
def share_access(client, staff, ingested):
    sh = client.post(f"/api/studies/{ingested}/shares", json={"mobile": "9876543210"}, headers=staff).json()["share"]
    token = sh["url"].rsplit("/#/s/", 1)[1]
    otp = client.get("/api/dev/outbox").json()[0]["otp"]
    access = client.post(f"/api/s/{token}/otp/verify", json={"otp": otp}).json()["accessToken"]
    return token, {"Authorization": f"Bearer {access}"}


@pytest.mark.parametrize("path", [
    f"studies/{STUDY_UID}/metadata",
    f"studies/{STUDY_UID}/series",
    f"studies/{STUDY_UID}/series/{SE}/metadata",
    f"studies/{STUDY_UID}/series/{SE}/instances",
    f"studies/{STUDY_UID}/series/{SE}/instances/1.2.3.4.5/rendered",
    f"studies/{STUDY_UID}/series/{SE}/instances/1.2.3.4.5/frames/1",
])
def test_share_proxy_allows_shared_study(client, share_access, dw, path):
    token, h = share_access
    r = client.get(f"/api/s/{token}/dicomweb/{path}", headers={**h, "Accept": ACCEPT})
    assert r.status_code == 200, r.text
    assert dw[-1].url.path == f"/dicom-web/{path}"
    if path.endswith("frames/1"):
        assert r.headers["content-type"] == FRAME_CT and r.content == FRAME_BODY


@pytest.mark.parametrize("path,code", [
    (f"studies/{OTHER_STUDY_UID}/metadata", 403),                                   # another study
    (f"studies/{OTHER_STUDY_UID}/series/{SE}/metadata", 403),
    ("studies", 403),                                                              # QIDO across all studies
    ("series", 403),
    ("instances", 403),
    (f"studies/{STUDY_UID}.1/metadata", 403),                                      # prefix trick
    (f"studies/{STUDY_UID}/series/{OTHER_STUDY_UID}.1/metadata", 403),             # series not in the study
    # dot segments: the HTTP client may normalise them before sending, so either guard may fire
    (f"studies/{STUDY_UID}/series/{SE}/instances/1.2.3/frames/1/../../../../../{OTHER_STUDY_UID}", (400, 403)),
    (f"studies/{STUDY_UID}/%2E%2E/{OTHER_STUDY_UID}/metadata", (400, 403)),        # encoded dot-dot
    (f"studies/{STUDY_UID}/series/{SE}/instances/x;rm/frames/1", 403),
    (f"studies/{STUDY_UID}//metadata", 400),
    (f"studies/{STUDY_UID}/bulk/whatever", 403),
    (f"studies/{STUDY_UID}/series/{SE}/instances/1.2.3/frames/1/extra", 403),
])
def test_share_proxy_rejects_everything_else(client, share_access, dw, path, code):
    token, h = share_access
    got = client.get(f"/api/s/{token}/dicomweb/{path}", headers=h).status_code
    assert got in (code if isinstance(code, tuple) else (code,))
    assert not dw, "nothing may reach Orthanc"


@pytest.mark.parametrize("path", [
    f"studies/{STUDY_UID}/../{OTHER_STUDY_UID}",
    f"studies/{STUDY_UID}/series/{SE}/./metadata",
    f"studies/{STUDY_UID}/series/{SE}/instances/1.2/frames/1/..",
    f"studies/{STUDY_UID}\\..\\{OTHER_STUDY_UID}",
    f"studies/{STUDY_UID}/series/%2e%2e",
])
def test_share_path_guard_rejects_dot_segments(path):
    from fastapi import HTTPException

    from asvanta_gateway.dicomweb import check_share_path

    with pytest.raises(HTTPException) as exc:
        check_share_path(path, STUDY_UID, {SE})
    assert exc.value.status_code in (400, 403)


def test_share_proxy_strips_study_filters(client, share_access, dw):
    token, h = share_access
    r = client.get(f"/api/s/{token}/dicomweb/studies/{STUDY_UID}/series?StudyInstanceUID={OTHER_STUDY_UID}"
                   f"&0020000D={OTHER_STUDY_UID}&Modality=CT", headers=h)
    assert r.status_code == 200
    params = dw[-1].url.params
    assert "StudyInstanceUID" not in params and "0020000D" not in params and params["Modality"] == "CT"


def test_share_proxy_requires_access_token(client, share_access, dw, staff):
    token, _ = share_access
    assert client.get(f"/api/s/{token}/dicomweb/studies/{STUDY_UID}/metadata").status_code == 401
    assert client.get(f"/api/s/{token}/dicomweb/studies/{STUDY_UID}/metadata", headers=staff).status_code == 401
    assert not dw
