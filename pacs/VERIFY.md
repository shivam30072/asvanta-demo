# End-to-end verification (2026-10-04)

Host: Linux, Docker, Python 3.12, Node 20. The stack ran fully dockerised: `orthancteam/orthanc:24.10.3` plus the gateway image built from `server/Dockerfile`. The host venv was used only for the tools.

## Commands

```bash
# 0. stack
cd pacs
cp .env.example .env && sed -i 's/^ORTHANC_PASSWORD=.*/ORTHANC_PASSWORD=<choose-a-password>/' .env
docker compose down -v                 # start from empty volumes
docker compose up -d --build
docker compose ps                      # orthanc: healthy  0.0.0.0:4242, 127.0.0.1:8042 / gateway: healthy 0.0.0.0:8000
docker network inspect asvanta-pacs_pacs -f '{{(index .IPAM.Config 0).Gateway}}'   # 172.20.0.1 = how Orthanc sees the host
cd ..

# 1. an unregistered calling AE is refused (ORTHANC_ACCEPT_UNKNOWN=false)
server/.venv/bin/python tools/send_test_study.py --kind random --calling-aet CT_UNKNOWN
#   C-STORE failed for instance 1 ...: association aborted by the PACS ...
#   Done: 0/24 instances stored, 1 failures
docker compose -f pacs/docker-compose.yml logs orthanc | grep -i rejected
#   DICOM authorization rejected  for AET CT_UNKNOWN on IP 172.20.0.1: This AET is not listed in configuration option "DicomModalities"
#   Rejected Store request from remote DICOM modality with AET "CT_UNKNOWN" and hostname "172.20.0.1"

# 2. register the scanner (staff) and C-ECHO it.
#    A tiny pynetdicom Verification SCP (AE CT_ROOM1, port 11112) ran on the host to stand in for the scanner's listener.
TOKEN=$(curl -s -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"priya@asvanta.in","password":"asvanta"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -X POST localhost:8000/api/pacs/scanners -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"CT_ROOM1","aeTitle":"CT_ROOM1","host":"172.20.0.1","port":11112}'
#   {"name":"CT_ROOM1","aeTitle":"CT_ROOM1","host":"172.20.0.1","port":11112,"lastSeen":null}
curl -s -X POST localhost:8000/api/pacs/scanners/CT_ROOM1/echo -H "authorization: Bearer $TOKEN"
#   {"ok":true,"detail":"C-ECHO to CT_ROOM1 succeeded"}

# 3. send the cardiac phantom as CT_ROOM1
server/.venv/bin/python tools/send_test_study.py --host 127.0.0.1 --port 4242 --calling-aet CT_ROOM1 --echo \
  --patient-phone "+91 98190 33417"
#   C-ECHO CT_ROOM1 -> ASVANTA@127.0.0.1:4242: OK
#   Study 1.2.826...  patient MALHOTRA^VIKRAM (PT-10251)  'CT Cardiac (Calcium score + CTA)': 3 series, 176 instances
#   series 'CaSc 3.0 Qr36 75%': 40/40 stored
#   series 'CCTA 1.0 Bv40 75%': 110/110 stored
#   series 'Thorax 5.0 Br40': 26/26 stored
#   Done: 176/176 instances stored, 0 failures      (about 13 s including rendering the phantom)

# 4. after StableAge (~10 s) + one ingest poll
curl -s localhost:8000/api/studies -H "authorization: Bearer $TOKEN"
curl -s localhost:8000/api/studies/STD-30001/series -H "authorization: Bearer $TOKEN"
curl -s localhost:8000/api/pacs -H "authorization: Bearer $TOKEN"

# 5. the rest of the chain
server/.venv/bin/python tools/verify_e2e.py --gateway http://localhost:8000
```

## Results

**Study.** The study registered as `STD-30001`:

| Field | Value |
|---|---|
| Patient | Vikram Malhotra, PT-10251, age 58, M, phone `+919819033417` |
| Modality | `CT` |
| bodyPart | `Cardiac (Calcium score + CTA)` |
| referredBy | `Dr. M Patel` |
| status | `uploaded` |
| images | 176 |
| sizeBytes | 36,335,448 |
| receivedFrom | `{"aeTitle":"CT_ROOM1","ip":"172.20.0.1"}` |

The timeline shows `Received from CT_ROOM1 (172.20.0.1) — 176 images`. `GET /api/pacs` shows CT_ROOM1 with `lastSeen` set.

**Series.** `/series` returned 3 series:

| # | Description | Images | Thickness |
|---|---|---|---|
| 1 | CaSc 3.0 Qr36 75% | 40 | 3.0 mm |
| 2 | CCTA 1.0 Bv40 75% | 110 | 1.0 mm |
| 3 | Thorax 5.0 Br40 | 26 | 5.0 mm |

**`tools/verify_e2e.py`.** Every check printed `ALL PASS`:

```
[PASS] DICOMweb metadata via proxy — 200 application/dicom+json 40 instances
[PASS] uncompressed frame (multipart) via proxy — 200 multipart/related; type="application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"; boundary=...; part payload 204800 bytes (= 320x320x2)
[PASS] create images-only share
       share shr_... to +919876543210 status sent; SMS (135 chars): Asvanta Diagnostics: your CT images are ready. View: http://localhost:5173/#/s/<32-char token> OTP <6 digits>. Valid 72 h.
[PASS] includeReport refused while unsigned (409)
[PASS] OTP from dev outbox
[PASS] public link info — {... 'mobileMasked': '+91 ******3210', 'requiresOtp': True, 'includeReport': False, 'state': 'active'}
[PASS] wrong OTP refused — {'detail': {'error': 'otp_invalid', 'attemptsLeft': 4}}
[PASS] OTP verify
[PASS] share-scoped study — Vikram Malhotra CT 3 series, report=None
[PASS] share-scoped frame — 200 204800 pixel bytes, identical to the staff proxy frame
[PASS] share-scoped rejects studies/1.2.3.4.5/metadata — 403
[PASS] share-scoped rejects studies — 403
[PASS] share-scoped rejects studies?StudyInstanceUID=1.2.3 — 403
[PASS] share-scoped rejects series — 403
[PASS] share-scoped rejects studies/<shared uid>/series/1.2.3.4/metadata — 403
[PASS] share-scoped rejects studies/<shared uid>/%2E%2E/1.2.3/metadata — 400
[PASS] CAC analysis on Ca score series — kind=standard verdict=ready totals={'LM': 0.0, 'LAD': 0.0, 'LCX': 0.0, 'RCA': 0.0, 'unassigned': 505791.63, 'total': 505791.63} lesions=17 engine=cac-engine-1.0.0
[PASS] CAC on contrast CTA refused (422) — Non-contrast acquisition: ContrastBolusAgent = 'Iohexol 350': iodine invalidates the 130 HU threshold; standard Agatston must not be reported
```

The timeline then contained these events, in order:

1. receive
2. share
3. share_open
4. share_verify_fail
5. share_verify
6. cac (algorithm run)
7. cac (CTA refused)

**About the CAC totals.** The engine has no heart localisation or vessel assignment yet: these are the Phase 3 and Phase 5 hooks described in `engine/README.md`. So spine, ribs, sternum, aortic wall and valve calcium are all counted as candidates, and every lesion is "unassigned".

The 17 candidates split as follows:

- 6 large bone or aorta structures account for about 505,160 of the total.
- 11 small coronary-sized candidates (L7 to L17, peaks 194 to 521 HU) add up to about 630.

To check that the PACS round trip is lossless, the same Ca score series was written straight to `.dcm` and scored without Orthanc. It gave the identical total: 505,791.63 with 17 lesions.

**Other checks:**

- CORS preflight from `http://localhost:5173` returned `access-control-allow-origin: http://localhost:5173`.
- Orthanc REST on 127.0.0.1:8042 without credentials returned 401.
- QIDO through the proxy (`studies/{uid}/series`) returned 200 `application/dicom+json`.

**Tests:**

- `server/.venv/bin/pytest -q`: `89 passed, 1 skipped`. The skipped test is the integration test, which needs `ORTHANC_URL`.
- `ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_PASSWORD=<choose-a-password> server/.venv/bin/pytest -q -m integration`: `1 passed`. This was run against the dockerised Orthanc before the volumes were reset for the run above.

**Orthanc metadata names** (from `GET /instances/{id}/metadata?expand` on 24.10.3, Orthanc 1.12.4):

- `RemoteAET`
- `RemoteIP`
- `CalledAET`
- `Origin` (`DicomProtocol`)
- `ReceptionDate`
- `TransferSyntax`
- `SopClassUid`
- `IndexInSeries`
- `PixelDataOffset`
- `MainDicomTagsSignature`

## Left running

| Service | Address |
|---|---|
| Gateway | http://localhost:8000 (API under `/api`) |
| Orthanc DICOM | 0.0.0.0:4242, AE `ASVANTA` |
| Orthanc REST | 127.0.0.1:8042, user `gateway`, password from `pacs/.env` |

Scanner `CT_ROOM1` is registered. Study `STD-30001` is loaded with 2 images-only shares and 1 CAC run.
