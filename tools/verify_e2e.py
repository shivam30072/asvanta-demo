#!/usr/bin/env python3
"""End-to-end check of a running stack, after tools/send_test_study.py has sent the
cardiac phantom:

    python tools/verify_e2e.py --gateway http://localhost:8000 [--password asvanta]

Login -> study with receivedFrom -> 3 series -> DICOMweb metadata + uncompressed
multipart frame through the proxy -> images-only share to 9876543210 -> OTP from the
dev outbox -> verify -> share-scoped study + frame -> other study UIDs / QIDO refused
-> CAC analysis on the Ca score series.
"""

from __future__ import annotations

import argparse
import sys

import httpx

FRAME_ACCEPT = 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1'


def frame_payload(resp: httpx.Response) -> bytes:
    """Body of the first part of a multipart/related response (boundaries differ per response)."""
    body = resp.content
    start = body.find(b"\r\n\r\n") + 4
    end = body.rfind(b"\r\n--")
    return body[start:end]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default="http://localhost:8000")
    ap.add_argument("--password", default="asvanta")
    ap.add_argument("--patient-id", default="PT-10251")
    a = ap.parse_args()
    c = httpx.Client(base_url=a.gateway + "/api", timeout=300)
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        ok &= bool(cond)
        print(f"[{'PASS' if cond else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))

    def login(email: str) -> dict:
        r = c.post("/auth/login", json={"email": email, "password": a.password})
        r.raise_for_status()
        return {"Authorization": f"Bearer {r.json()['token']}"}

    staff, rad = login("priya@asvanta.in"), login("dr.mehta@asvanta.in")
    check("login staff + radiologist", True)

    studies = [s for s in c.get("/studies", headers=staff).json() if s["patient"]["id"] == a.patient_id]
    check("study registered from the PACS", bool(studies), f"{len(studies)} matching")
    if not studies:
        return 1
    s = studies[0]
    check("receivedFrom", bool(s["receivedFrom"] and s["receivedFrom"]["aeTitle"]),
          f"{s['id']} {s['patient']['name']} age {s['patient']['age']} {s['modality']} '{s['bodyPart']}' "
          f"{s['images']} images {s['sizeBytes']} bytes from {s['receivedFrom']}")
    uid = s["studyInstanceUID"]

    series = c.get(f"/studies/{s['id']}/series", headers=staff).json()
    check("3 series", len(series) == 3, "; ".join(f"#{x['number']} {x['description']} ({x['count']}, {x['thickness']} mm)" for x in series))
    cac_series = next(x for x in series if x["description"].startswith("CaSc"))
    suid = cac_series["seriesInstanceUID"]

    meta = c.get(f"/dicomweb/studies/{uid}/series/{suid}/metadata", headers=staff)
    check("DICOMweb metadata via proxy", meta.status_code == 200 and len(meta.json()) == cac_series["count"],
          f"{meta.status_code} {meta.headers.get('content-type')} {len(meta.json()) if meta.status_code == 200 else ''} instances")
    iuid = meta.json()[0]["00080018"]["Value"][0]
    frame = c.get(f"/dicomweb/studies/{uid}/series/{suid}/instances/{iuid}/frames/1", headers={**staff, "Accept": FRAME_ACCEPT})
    check("uncompressed frame (multipart) via proxy",
          frame.status_code == 200 and frame.headers.get("content-type", "").startswith("multipart/related")
          and len(frame_payload(frame)) == 320 * 320 * 2,
          f"{frame.status_code} {frame.headers.get('content-type')}; part payload {len(frame_payload(frame))} bytes (= 320x320x2)")

    r = c.post(f"/studies/{s['id']}/shares", headers=staff,
               json={"mobile": "9876543210", "includeReport": False, "expiresHours": 72, "requireOtp": True})
    check("create images-only share", r.status_code == 201, r.text[:200] if r.status_code != 201 else "")
    created = r.json()
    share, message = created["share"], created["message"]
    print(f"       share {share['id']} to {share['to']} status {share['status']}; SMS ({len(message)} chars): {message}")
    rep_share = c.post(f"/studies/{s['id']}/shares", headers=staff, json={"mobile": "9876543210", "includeReport": True})
    check("includeReport refused while unsigned (409)", rep_share.status_code == 409)
    token = share["url"].rsplit("/#/s/", 1)[1]

    box = c.get("/dev/outbox").json()
    otp = next(m["otp"] for m in box if m["shareId"] == share["id"])
    check("OTP from dev outbox", bool(otp))
    info = c.get(f"/s/{token}").json()
    check("public link info", info["state"] == "active" and info["requiresOtp"], str(info))
    bad = c.post(f"/s/{token}/otp/verify", json={"otp": "000000" if otp != "000000" else "111111"})
    check("wrong OTP refused", bad.status_code == 401, str(bad.json()))
    v = c.post(f"/s/{token}/otp/verify", json={"otp": otp})
    check("OTP verify", v.status_code == 200)
    sh = {"Authorization": f"Bearer {v.json()['accessToken']}"}
    st = c.get(f"/s/{token}/study", headers=sh).json()
    check("share-scoped study", st["studyInstanceUID"] == uid and len(st["series"]) == 3 and st["report"] is None,
          f"{st['patientName']} {st['modality']} {len(st['series'])} series, report={st['report']}")
    f2 = c.get(f"/s/{token}/dicomweb/studies/{uid}/series/{suid}/instances/{iuid}/frames/1", headers={**sh, "Accept": FRAME_ACCEPT})
    check("share-scoped frame", f2.status_code == 200 and frame_payload(f2) == frame_payload(frame),
          f"{f2.status_code} {len(frame_payload(f2))} pixel bytes, identical to the staff proxy frame")
    for path in [f"studies/1.2.3.4.5/metadata", "studies", f"studies?StudyInstanceUID=1.2.3", f"series",
                 f"studies/{uid}/series/1.2.3.4/metadata", f"studies/{uid}/%2E%2E/1.2.3/metadata"]:
        r = c.get(f"/s/{token}/dicomweb/{path}", headers=sh)
        check(f"share-scoped rejects {path}", r.status_code in (400, 403), str(r.status_code))

    cac = c.post(f"/studies/{s['id']}/series/{suid}/cac-analysis", headers=rad, json={"allowOpportunistic": False})
    if cac.status_code == 200:
        b = cac.json()
        check("CAC analysis on Ca score series", True,
              f"kind={b['kind']} verdict={b['validation']['verdict']} totals={b['totals']} lesions={b['lesionCount']} "
              f"engine={b['engineVersion']}")
        for les in b["lesions"]:
            print(f"       lesion {les['id']}: score {les['score']} peak {les['peakHu']} HU area {les['areaMm2']} mm2 slices {les['slices']}")
    else:
        check("CAC analysis on Ca score series", False, cac.text[:400])
    cta = next(x for x in series if x["description"].startswith("CCTA"))
    r = c.post(f"/studies/{s['id']}/series/{cta['seriesInstanceUID']}/cac-analysis", headers=rad, json={})
    check("CAC on contrast CTA refused (422)", r.status_code == 422,
          "; ".join(r.json()["detail"]["validation"]["reasons"]) if r.status_code == 422 else r.text[:200])

    tl = c.get(f"/studies/{s['id']}", headers=staff).json()["timeline"]
    print("Timeline:")
    for e in tl:
        print(f"   {e['at']}  {e['actor']:<15} [{e['kind']}] {e['text']}")
    print("ALL PASS" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
