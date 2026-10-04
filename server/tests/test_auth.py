from conftest import PASSWORD, login


def test_login_and_me(client):
    r = client.post("/api/auth/login", json={"email": "Priya@Asvanta.in", "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["token"] and len(body["token"]) > 30
    assert body["user"] == {
        "id": "usr_staff", "name": "Priya Sharma", "role": "staff", "title": "Front Desk / Technician",
        "initials": "PS", "email": "priya@asvanta.in", "phone": "+91 98200 41122", "radiologistId": None,
    }
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200 and me.json()["id"] == "usr_staff"


def test_radiologist_user_carries_rad_id(client):
    h = login(client, "dr.mehta@asvanta.in")
    me = client.get("/api/auth/me", headers=h).json()
    assert me["role"] == "radiologist" and me["id"] == "usr_rad" and me["radiologistId"] == "rad_mehta"


def test_bad_password_and_missing_token(client):
    assert client.post("/api/auth/login", json={"email": "priya@asvanta.in", "password": "nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "who@x.in", "password": PASSWORD}).status_code == 401
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401
    assert client.get("/api/studies").status_code == 401


def test_expired_session_rejected(client, app):
    h = login(client, "priya@asvanta.in")
    app.state.ctx.repo.x("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'")
    assert client.get("/api/auth/me", headers=h).status_code == 401


def test_password_is_scrypt_hashed(app):
    row = app.state.ctx.repo.user("usr_staff")
    assert row["password_hash"].startswith("scrypt$") and PASSWORD not in row["password_hash"]


def test_role_enforcement(client, staff, rad, ingested):
    sid = ingested
    # staff cannot write reports or run CAC
    assert client.put(f"/api/studies/{sid}/report", json={"findings": "x", "impression": "y"}, headers=staff).status_code == 403
    assert client.post(f"/api/studies/{sid}/report/sign", headers=staff).status_code == 403
    assert client.put(f"/api/studies/{sid}/cac", json={"approved": {"totals": {"total": 1}}}, headers=staff).status_code == 403
    # radiologists cannot share, patch, or manage scanners
    assert client.post(f"/api/studies/{sid}/shares", json={"mobile": "9876543210"}, headers=rad).status_code == 403
    assert client.patch(f"/api/studies/{sid}", json={"priority": "Urgent"}, headers=rad).status_code == 403
    assert client.post("/api/pacs/scanners", json={"name": "X", "aeTitle": "X", "host": "1.2.3.4", "port": 104}, headers=rad).status_code == 403
    # both can read
    assert client.get(f"/api/studies/{sid}", headers=staff).status_code == 200
    assert client.get(f"/api/studies/{sid}", headers=rad).status_code == 200
