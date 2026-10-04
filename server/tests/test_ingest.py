from conftest import STUDY_UID, SERIES


def test_stable_study_is_registered(client, app, staff, ingested):
    s = client.get(f"/api/studies/{ingested}", headers=staff).json()
    assert s["id"] == "STD-30001"
    assert s["studyInstanceUID"] == STUDY_UID
    assert s["source"] == "pacs"
    assert s["patient"] == {"name": "Vikram Malhotra", "id": "PT-10251", "age": 58, "gender": "M",
                            "phone": "+919819033417", "email": None}
    assert s["modality"] == "CT"
    assert s["bodyPart"] == "Cardiac (Calcium score + CTA)"
    assert s["referredBy"] == "Dr. M Patel"
    assert s["status"] == "uploaded"
    assert s["receivedFrom"] == {"aeTitle": "CT_ROOM1", "ip": "10.0.0.21"}
    assert s["images"] == 5 and s["sizeBytes"] == 1048576
    assert s["studyDate"] == "2026-10-04"
    assert [e["text"] for e in s["timeline"]] == [
        "Received from CT_ROOM1 (10.0.0.21) — 5 images",
        "Queued for Dr. Farhan Qureshi (staff can reassign)",
    ]
    assert s["assignedTo"] == "rad_qureshi"
    assert s["timeline"][0]["kind"] == "receive" and s["timeline"][0]["id"]
    assert app.state.ctx.repo.get_meta("orthanc_last_change") == "41"


def test_ingest_is_idempotent_and_refreshes(client, app, fake_orthanc, staff, ingested):
    ing = app.state.ctx.ingestor
    assert client.portal.call(ing.poll_once) == 0  # nothing new
    # more images arrive -> a new StableStudy change refreshes the same study
    fake_orthanc.instance_count = 7
    fake_orthanc.changes.append({"ChangeType": "StableStudy", "ID": "st-1", "Seq": 60, "ResourceType": "Study"})
    assert client.portal.call(ing.poll_once) == 1
    studies = client.get("/api/studies", headers=staff).json()
    assert len(studies) == 1 and studies[0]["images"] == 7
    assert studies[0]["timeline"][-1]["text"].startswith("Study updated from CT_ROOM1 — now 7 images")


def test_second_study_gets_next_id(client, app, fake_orthanc, staff, ingested):
    import httpx

    other = fake_orthanc.study()
    other["ID"] = "st-2"
    other["MainDicomTags"] = {**other["MainDicomTags"], "StudyInstanceUID": "1.2.3.999", "StudyDescription": "MR Brain"}
    r = fake_orthanc.router
    r.get("/studies/st-2").respond(json=other)
    r.get("/studies/st-2/series").respond(json=[{"ID": "x", "Instances": ["i-x"], "MainDicomTags": {"Modality": "MR", "SeriesInstanceUID": "1.2.3.999.1"}}])
    r.get("/studies/st-2/statistics").respond(json={"CountInstances": 1, "DiskSize": "10"})
    fake_orthanc.changes.append({"ChangeType": "StableStudy", "ID": "st-2", "Seq": 70, "ResourceType": "Study"})
    client.portal.call(app.state.ctx.ingestor.poll_once)
    studies = client.get("/api/studies", headers=staff).json()
    ids = {s["id"]: s for s in studies}
    assert set(ids) == {"STD-30001", "STD-30002"}
    assert ids["STD-30002"]["modality"] == "MRI" and ids["STD-30002"]["bodyPart"] == "Brain"


def test_scanner_last_seen_and_pacs(client, staff, ingested):
    p = client.get("/api/pacs", headers=staff).json()
    assert p["aeTitle"] == "ASVANTA" and p["port"] == 4242 and p["online"] is True and p["host"] == "192.168.1.10"
    [sc] = p["scanners"]
    assert sc["name"] == "CT_ROOM1" and sc["aeTitle"] == "CT_ROOM1" and sc["host"] == "10.0.0.21" and sc["port"] == 104
    assert sc["lastSeen"]


def test_scanner_register_delete_echo(client, staff, fake_orthanc):
    r = client.post("/api/pacs/scanners", json={"name": "MR_1", "aeTitle": "MR_ROOM1", "host": "10.0.0.30", "port": 104}, headers=staff)
    assert r.status_code == 201 and r.json()["aeTitle"] == "MR_ROOM1"
    assert fake_orthanc.modalities["MR_1"] == {"AET": "MR_ROOM1", "Host": "10.0.0.30", "Port": 104}
    assert client.post("/api/pacs/scanners/CT_ROOM1/echo", headers=staff).json() == {"ok": True, "detail": "C-ECHO to CT_ROOM1 succeeded"}
    assert client.delete("/api/pacs/scanners/MR_1", headers=staff).status_code == 200
    assert "MR_1" not in fake_orthanc.modalities
    assert client.delete("/api/pacs/scanners/NOPE", headers=staff).status_code == 404
    bad = client.post("/api/pacs/scanners", json={"name": "bad name!", "aeTitle": "X", "host": "1.2.3.4", "port": 104}, headers=staff)
    assert bad.status_code == 422


def test_echo_failure_reported(client, staff, fake_orthanc):
    fake_orthanc.router.post(url__regex=r".*/modalities/DEAD/echo").respond(500, json={"Message": "timeout"})
    fake_orthanc.modalities["DEAD"] = {"AET": "DEAD", "Host": "10.9.9.9", "Port": 104}
    r = client.post("/api/pacs/scanners/DEAD/echo", headers=staff).json()
    assert r["ok"] is False and "C-ECHO failed" in r["detail"]


def test_series_listing(client, staff, ingested):
    series = client.get(f"/api/studies/{ingested}/series", headers=staff).json()
    assert series == [
        {"seriesInstanceUID": SERIES[0][1], "number": 1, "description": SERIES[0][3], "modality": "CT", "count": 3, "thickness": 3.0},
        {"seriesInstanceUID": SERIES[1][1], "number": 2, "description": SERIES[1][3], "modality": "CT", "count": 2, "thickness": 1.0},
    ]


def test_mapping_helpers():
    from asvanta_gateway.ingest import body_part, format_person_name, patient_age, study_modality

    assert format_person_name("MALHOTRA^VIKRAM") == "Vikram Malhotra"
    assert format_person_name("van der Berg^Anna") == "Anna van der Berg"
    assert format_person_name("") == ""
    assert patient_age({"PatientBirthDate": "19680905", "StudyDate": "20261004"}) == 58
    assert patient_age({"PatientBirthDate": "19681005", "StudyDate": "20261004"}) == 57
    assert patient_age({"PatientAge": "006M"}) == 0
    assert body_part({"StudyDescription": "MRI Brain plain"}) == "Brain plain"
    assert body_part({"BodyPartExamined": "KNEE"}) == "Knee"
    assert study_modality(["SR", "CT", "PT"]) == "PET-CT"
    assert study_modality(["DX"]) == "X-Ray"
    assert study_modality(["SR", "MR"]) == "MRI"


def test_suggest_radiologist_follows_the_demo_rules():
    from asvanta_gateway.ingest import suggest_radiologist

    assert suggest_radiologist("CT", "Cardiac (Calcium score + CTA) HEART") == "rad_qureshi"
    assert suggest_radiologist("MR", "Lumbar Spine") == "rad_reddy"
    assert suggest_radiologist("MG", "") == "rad_kulkarni"
    assert suggest_radiologist("CT", "Brain") == "rad_mehta"
