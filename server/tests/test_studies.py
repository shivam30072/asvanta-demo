from conftest import sign_report

CONTRACT_KEYS = {"id", "studyInstanceUID", "source", "patient", "modality", "bodyPart", "referredBy", "priority",
                 "assignedTo", "status", "createdAt", "receivedFrom", "sizeBytes", "images", "files", "report",
                 "shares", "timeline", "cac"}


def test_list_shape(client, staff, ingested):
    r = client.get("/api/studies", headers=staff)
    assert r.status_code == 200
    [s] = r.json()
    assert CONTRACT_KEYS <= set(s)
    assert set(s["patient"]) == {"name", "id", "age", "gender", "phone", "email"}
    assert s["files"] == [] and s["report"] is None and s["shares"] == [] and s["cac"] is None
    assert s["priority"] == "Routine" and s["assignedTo"] == "rad_qureshi"
    assert s["createdAt"].endswith("Z")


def test_unknown_study(client, staff):
    assert client.get("/api/studies/STD-99999", headers=staff).status_code == 404


def test_patch(client, staff, ingested):
    sid = ingested
    r = client.patch(f"/api/studies/{sid}", json={"assignedTo": "rad_qureshi", "priority": "Urgent",
                                                   "phone": "98190 33417", "referredBy": "Dr. M. Patel (Physician)"}, headers=staff)
    assert r.status_code == 200
    s = r.json()
    assert s["assignedTo"] == "rad_qureshi" and s["priority"] == "Urgent"
    assert s["patient"]["phone"] == "+919819033417" and s["referredBy"] == "Dr. M. Patel (Physician)"
    assert any(e["kind"] == "assign" and "Dr. Farhan Qureshi" in e["text"] for e in s["timeline"])
    assert client.patch(f"/api/studies/{sid}", json={"assignedTo": "rad_nobody"}, headers=staff).status_code == 422
    assert client.patch(f"/api/studies/{sid}", json={"priority": "Whenever"}, headers=staff).status_code == 422
    assert client.patch(f"/api/studies/{sid}", json={"phone": "hello"}, headers=staff).status_code == 422
    assert client.patch(f"/api/studies/{sid}", json={"assignedTo": None}, headers=staff).json()["assignedTo"] is None


def test_report_draft_and_sign(client, staff, rad, ingested):
    sid = ingested
    r = client.put(f"/api/studies/{sid}/report", json={"findings": "F1", "impression": "I1"}, headers=rad)
    assert r.status_code == 200
    s = r.json()
    assert s["report"] is None, "drafts must not be exposed as the report"
    assert s["draft"]["findings"] == "F1" and s["draft"]["updatedBy"] == "Dr. Anil Mehta"
    assert s["status"] == "reporting"
    # staff never see the draft
    st = client.get(f"/api/studies/{sid}", headers=staff).json()
    assert st["draft"] is None and st["report"] is None

    s = client.post(f"/api/studies/{sid}/report/sign", headers=rad).json()
    assert s["status"] == "ready"
    assert s["report"]["findings"] == "F1" and s["report"]["impression"] == "I1"
    assert s["report"]["signedBy"] == "Dr. Anil Mehta" and s["report"]["signedAt"]
    assert s["draft"] is None
    assert [e["kind"] for e in s["timeline"]][-2:] == ["report", "sign"]
    # nothing left to sign
    assert client.post(f"/api/studies/{sid}/report/sign", headers=rad).status_code == 409

    # amendment: the signed v1 stays visible until v2 is signed
    s = client.put(f"/api/studies/{sid}/report", json={"findings": "F2", "impression": "I2"}, headers=rad).json()
    assert s["report"]["findings"] == "F1" and s["draft"]["findings"] == "F2"
    s = client.post(f"/api/studies/{sid}/report/sign", headers=rad).json()
    assert s["report"]["findings"] == "F2" and s["report"]["version"] == 2 and s["report"]["amended"] is True


def test_sign_requires_content(client, rad, ingested):
    client.put(f"/api/studies/{ingested}/report", json={"findings": " ", "impression": ""}, headers=rad)
    assert client.post(f"/api/studies/{ingested}/report/sign", headers=rad).status_code == 422


def test_events(client, staff, ingested):
    r = client.post(f"/api/studies/{ingested}/events", json={"text": "Patient called", "kind": "note"}, headers=staff)
    assert r.status_code == 201
    ev = r.json()
    assert ev["actor"] == "Priya Sharma" and ev["text"] == "Patient called" and ev["kind"] == "note" and ev["id"] and ev["at"]
    tl = client.get(f"/api/studies/{ingested}", headers=staff).json()["timeline"]
    assert tl[-1]["text"] == "Patient called"


def test_put_cac_roundtrip(client, rad, staff, ingested):
    body = {"seriesId": "1.2.3.1", "approved": {"totals": {"total": 412.5, "LAD": 300}}, "review": {"ops": list(range(1000))}}
    r = client.put(f"/api/studies/{ingested}/cac", json=body, headers=rad)
    assert r.status_code == 200
    cac = r.json()["cac"]
    assert cac["seriesId"] == "1.2.3.1" and cac["approved"] == body["approved"] and cac["review"] == body["review"]
    assert cac["approvedBy"] == "Dr. Anil Mehta"
    assert client.get(f"/api/studies/{ingested}", headers=staff).json()["cac"]["approved"]["totals"]["total"] == 412.5
    bad = client.put(f"/api/studies/{ingested}/cac", json={"approved": {"totals": {"total": "lots"}}}, headers=rad)
    assert bad.status_code == 422
    assert client.put(f"/api/studies/{ingested}/cac", json={"approved": {}}, headers=rad).status_code == 422


def test_signed_report_status_after_share(client, staff, rad, ingested):
    sign_report(client, rad, ingested)
    assert client.get(f"/api/studies/{ingested}", headers=staff).json()["status"] == "ready"
