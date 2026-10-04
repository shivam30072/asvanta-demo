import pytest

from conftest import STUDY_UID, sign_report


def share(client, staff, sid, **kw):
    body = {"mobile": "9876543210", "includeReport": False, "expiresHours": 72, "requireOtp": True, **kw}
    return client.post(f"/api/studies/{sid}/shares", json=body, headers=staff)


def outbox(client):
    r = client.get("/api/dev/outbox")
    assert r.status_code == 200
    return r.json()


def token_of(url: str) -> str:
    return url.rsplit("/#/s/", 1)[1]


@pytest.mark.parametrize("raw,e164", [
    ("9876543210", "+919876543210"),
    ("98765 43210", "+919876543210"),
    ("+91 98765-43210", "+919876543210"),
    ("09876543210", "+919876543210"),
    ("919876543210", "+919876543210"),
    ("+447700900123", "+447700900123"),
    ("0044 7700 900123", "+447700900123"),
])
def test_normalisation(raw, e164):
    from asvanta_gateway.phone import normalise_mobile

    assert normalise_mobile(raw) == e164


@pytest.mark.parametrize("raw", ["12345", "abcdefghij", "5876543210", "+91 12345 67890", "98765432101234", "+", "", "98765x3210"])
def test_garbage_numbers_rejected(client, staff, ingested, raw):
    assert share(client, staff, ingested, mobile=raw).status_code == 422


def test_create_images_only_share(client, staff, ingested):
    r = share(client, staff, ingested)
    assert r.status_code == 201, r.text
    body = r.json()
    sh = body["share"]
    assert sh["channel"] == "sms" and sh["to"] == "+919876543210" and sh["status"] == "sent"
    assert sh["includeReport"] is False and sh["requireOtp"] is True and sh["revoked"] is False and sh["expiresAt"]
    assert sh["url"].startswith("https://app.test/#/s/")
    token = token_of(sh["url"])
    assert len(token) == 32  # token_urlsafe(24)
    [msg] = outbox(client)
    assert msg["to"] == "+919876543210" and msg["body"] == body["message"]
    assert msg["body"] == (f"Asvanta Diagnostics: your CT Cardiac (Calcium score + CTA) images are ready. "
                           f"View: https://app.test/#/s/{token} OTP {msg['otp']}. Valid 72 h.")
    assert len(msg["body"]) <= 160
    s = client.get(f"/api/studies/{ingested}", headers=staff).json()
    assert s["status"] == "uploaded", "images-only shares keep the status"
    assert s["shares"][0]["id"] == sh["id"]
    assert s["timeline"][-1]["kind"] == "share" and "+91 ******3210" in s["timeline"][-1]["text"]
    listed = client.get(f"/api/studies/{ingested}/shares", headers=staff).json()
    assert [x["id"] for x in listed] == [sh["id"]]
    # OTP stored only as a hash
    row = client.app.state.ctx.repo.share(sh["id"])
    assert msg["otp"] not in (row["otp_hash"] or "") and row["otp_hash"].startswith("scrypt$")
    assert token not in str(dict(row))


def test_include_report_requires_signed_report(client, staff, rad, ingested):
    assert share(client, staff, ingested, includeReport=True).status_code == 409
    client.put(f"/api/studies/{ingested}/report", json={"findings": "f", "impression": "i"}, headers=rad)
    assert share(client, staff, ingested, includeReport=True).status_code == 409, "a draft is not enough"
    client.post(f"/api/studies/{ingested}/report/sign", headers=rad)
    r = share(client, staff, ingested, includeReport=True)
    assert r.status_code == 201
    assert "images and report are ready" in r.json()["message"]
    assert client.get(f"/api/studies/{ingested}", headers=staff).json()["status"] == "shared"


def test_expiry_bounds(client, staff, ingested):
    assert share(client, staff, ingested, expiresHours=0).status_code == 422
    assert share(client, staff, ingested, expiresHours=721).status_code == 422
    assert share(client, staff, ingested, expiresHours=720).status_code == 201


def test_public_info_and_verify(client, staff, rad, ingested):
    sign_report(client, rad, ingested)
    sh = share(client, staff, ingested, includeReport=True).json()["share"]
    token = token_of(sh["url"])
    info = client.get(f"/api/s/{token}").json()
    assert info == {"centre": "Asvanta Diagnostics", "modality": "CT", "bodyPart": "Cardiac (Calcium score + CTA)",
                    "studyDate": "2026-10-04", "mobileMasked": "+91 ******3210", "requiresOtp": True,
                    "includeReport": True, "expiresAt": sh["expiresAt"], "state": "active"}
    otp = outbox(client)[0]["otp"]
    # study needs an access token
    assert client.get(f"/api/s/{token}/study").status_code == 401
    r = client.post(f"/api/s/{token}/otp/verify", json={"otp": otp})
    assert r.status_code == 200
    access = r.json()["accessToken"]
    h = {"Authorization": f"Bearer {access}"}
    st = client.get(f"/api/s/{token}/study", headers=h).json()
    assert st["patientName"] == "Vikram Malhotra" and st["studyInstanceUID"] == STUDY_UID
    assert st["modality"] == "CT" and st["studyDate"] == "2026-10-04"
    assert [x["number"] for x in st["series"]] == [1, 2]
    assert set(st["series"][0]) == {"seriesInstanceUID", "number", "description", "modality", "count", "thickness"}
    assert st["report"]["findings"].startswith("Calcified")
    # an amended report reaches the existing link
    sign_report(client, rad, ingested, findings="Amended findings.")
    assert client.get(f"/api/s/{token}/study", headers=h).json()["report"]["findings"] == "Amended findings."
    # a staff bearer token is not a share token
    assert client.get(f"/api/s/{token}/study", headers=staff).status_code == 401
    s = client.get(f"/api/studies/{ingested}", headers=staff).json()
    kinds = [e["kind"] for e in s["timeline"]]
    assert "share_open" in kinds and "share_verify" in kinds
    assert s["shares"][0]["status"] == "opened"


def test_images_only_share_hides_report(client, staff, rad, ingested):
    sign_report(client, rad, ingested)
    token = token_of(share(client, staff, ingested).json()["share"]["url"])
    access = client.post(f"/api/s/{token}/otp/verify", json={"otp": outbox(client)[0]["otp"]}).json()["accessToken"]
    assert client.get(f"/api/s/{token}/study", headers={"Authorization": f"Bearer {access}"}).json()["report"] is None


def test_access_token_scoped_to_its_share(client, staff, ingested):
    t1 = token_of(share(client, staff, ingested).json()["share"]["url"])
    t2 = token_of(share(client, staff, ingested, mobile="9123456780").json()["share"]["url"])
    otp1 = [m for m in outbox(client) if m["to"] == "+919876543210"][0]["otp"]
    a1 = client.post(f"/api/s/{t1}/otp/verify", json={"otp": otp1}).json()["accessToken"]
    assert client.get(f"/api/s/{t2}/study", headers={"Authorization": f"Bearer {a1}"}).status_code == 401


def test_wrong_otp_then_lock(client, staff, ingested):
    token = token_of(share(client, staff, ingested).json()["share"]["url"])
    otp = outbox(client)[0]["otp"]
    wrong = "000000" if otp != "000000" else "111111"
    for i in range(4):
        r = client.post(f"/api/s/{token}/otp/verify", json={"otp": wrong})
        assert r.status_code == 401
        assert r.json()["detail"]["attemptsLeft"] == 4 - i
    r = client.post(f"/api/s/{token}/otp/verify", json={"otp": None})  # null counts as an attempt
    assert r.status_code == 423
    assert client.post(f"/api/s/{token}/otp/verify", json={"otp": otp}).status_code == 423, "locked even with the right code"
    assert client.get(f"/api/s/{token}").json()["state"] == "locked"
    tl = client.get(f"/api/studies/{ingested}", headers=staff).json()["timeline"]
    kinds = [e["kind"] for e in tl]
    assert kinds.count("share_verify_fail") == 4 and kinds.count("share_lock") == 1
    assert client.get(f"/api/studies/{ingested}", headers=staff).json()["shares"][0]["state"] == "locked"


def test_no_otp_share(client, staff, ingested):
    r = share(client, staff, ingested, requireOtp=False)
    token = token_of(r.json()["share"]["url"])
    assert "OTP" not in r.json()["message"]
    assert client.get(f"/api/s/{token}").json()["requiresOtp"] is False
    v = client.post(f"/api/s/{token}/otp/verify", json={"otp": None})
    assert v.status_code == 200 and v.json()["accessToken"]
    assert client.post(f"/api/s/{token}/otp/resend").status_code == 400


def test_expired_share(client, staff, ingested):
    sh = share(client, staff, ingested).json()["share"]
    token = token_of(sh["url"])
    otp = outbox(client)[0]["otp"]
    access = client.post(f"/api/s/{token}/otp/verify", json={"otp": otp}).json()["accessToken"]
    client.app.state.ctx.repo.update_share(sh["id"], expires_at="2001-01-01T00:00:00Z")
    assert client.get(f"/api/s/{token}").json()["state"] == "expired"
    r = client.post(f"/api/s/{token}/otp/verify", json={"otp": otp})
    assert r.status_code == 410 and r.json()["detail"]["error"] == "expired"
    assert client.get(f"/api/s/{token}/study", headers={"Authorization": f"Bearer {access}"}).status_code == 410


def test_revoke(client, staff, ingested):
    sh = share(client, staff, ingested).json()["share"]
    token = token_of(sh["url"])
    access = client.post(f"/api/s/{token}/otp/verify", json={"otp": outbox(client)[0]["otp"]}).json()["accessToken"]
    h = {"Authorization": f"Bearer {access}"}
    assert client.get(f"/api/s/{token}/study", headers=h).status_code == 200
    r = client.delete(f"/api/shares/{sh['id']}", headers=staff)
    assert r.status_code == 200 and r.json()["revoked"] is True and r.json()["state"] == "revoked"
    assert client.get(f"/api/s/{token}/study", headers=h).status_code in (401, 410)
    assert client.get(f"/api/s/{token}/dicomweb/studies/{STUDY_UID}/metadata", headers=h).status_code in (401, 410)
    assert client.get(f"/api/s/{token}").json()["state"] == "revoked"
    assert client.post(f"/api/s/{token}/otp/verify", json={"otp": "123456"}).status_code == 410
    assert client.delete("/api/shares/shr_nope", headers=staff).status_code == 404
    assert any(e["kind"] == "share_revoke" for e in client.get(f"/api/studies/{ingested}", headers=staff).json()["timeline"])


def test_resend_rate_limit_and_new_code(client, staff, ingested):
    token = token_of(share(client, staff, ingested).json()["share"]["url"])
    first = outbox(client)[0]["otp"]
    for i in range(3):
        r = client.post(f"/api/s/{token}/otp/resend")
        assert r.status_code == 200 and r.json()["resendsLeft"] == 2 - i
    r = client.post(f"/api/s/{token}/otp/resend")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0
    latest = outbox(client)[0]["otp"]
    assert len(outbox(client)) == 4
    if latest != first:
        assert client.post(f"/api/s/{token}/otp/verify", json={"otp": first}).status_code == 401, "old code replaced"
    assert client.post(f"/api/s/{token}/otp/verify", json={"otp": latest}).status_code == 200


def test_unknown_token(client):
    assert client.get("/api/s/not-a-token").status_code == 404
    assert client.post("/api/s/not-a-token/otp/verify", json={"otp": "123456"}).status_code == 404


def test_outbox_only_with_console(client, app):
    app.state.ctx.settings.sms_provider = "msg91"
    assert client.get("/api/dev/outbox").status_code == 404
