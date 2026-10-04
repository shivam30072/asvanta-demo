# PACS integration

Scanners send studies straight to our PACS. The web app reads them back from the PACS. Technicians can send a study to any mobile number. Radiologists read the study, use the advanced tools (MPR, CPR, CAC), sign the report, and the report then becomes shareable.

```
 CT / MRI / X-ray / US ...                                 Browser (web app)
  scanner configured with                                    │  HTTPS, Bearer token
  AE title + IP + port                                       ▼
        │  DICOM C-STORE (TCP 4242)                ┌──────────────────────┐
        ▼                                          │  gateway (FastAPI)   │
 ┌──────────────────┐   REST + DICOMweb (8042)     │  auth · worklist     │
 │  Orthanc PACS    │ ◄─────────────────────────── │  reports · shares    │
 │  AE ASVANTA      │   internal network only      │  OTP/SMS · audit     │
 │  storage (disk/S3)│ ──── /changes (new study) ─► │  DICOMweb proxy      │
 └──────────────────┘                              │  CAC engine          │
                                                   └──────────────────────┘
                                                             │ SMS link + OTP
                                                             ▼
                                                    Recipient's phone → /s/{token}
```

Orthanc is never exposed to the browser. Every image request goes through the gateway, which checks who is asking. A share-link recipient can see only the one study shared with them.

## Scanner setup

On each scanner, add a DICOM storage destination ("Store SCP" / "Remote node"):

| Field | Value |
|---|---|
| AE title | `ASVANTA` (`ORTHANC_AET`) |
| Host / IP | the PACS server's IP address on the hospital LAN |
| Port | `4242` (`ORTHANC_DICOM_PORT`) |

Register the scanner in **Scanners**, or with `POST /api/pacs/scanners`, so the PACS accepts it. Use **Test (C-ECHO)** to check the connection. The PACS rejects devices that are not registered, unless `ORTHANC_ACCEPT_UNKNOWN=true` is set during commissioning.

## Running it

```bash
cd pacs
cp .env.example .env        # set passwords, SMS provider, public URL
docker compose up -d        # orthanc (4242 DICOM) + gateway (8000)
python ../tools/send_test_study.py --host 127.0.0.1 --port 4242   # acts as a scanner
```

Run the web app against it with `VITE_API_URL=http://localhost:8000 npm run dev`. If `VITE_API_URL` is not set, the app runs as the self-contained demo.

---

## Gateway API (contract between the web app and the gateway)

All endpoints are under `/api` and use JSON. Authenticated calls send `Authorization: Bearer <token>`. Roles are `staff` and `radiologist`. Share-link recipients use a separate, scoped token.

### Auth
| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/login` | `{email, password}` → `{token, expiresAt, user: {id, name, role, title, initials, email, phone, radiologistId}}`. Password only for now (replaces the demo's OTP sign-in); `radiologistId` is the `rad_*` id used by `assignedTo`. |
| GET | `/auth/me` | → `user` |

### PACS and scanners
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/pacs` | any | `{aeTitle, host, port, online, scanners: [{name, aeTitle, host, port, lastSeen}]}` |
| POST | `/pacs/scanners` | staff | `{name, aeTitle, host, port}`. Registers the scanner in Orthanc's modalities. |
| DELETE | `/pacs/scanners/{name}` | staff | |
| POST | `/pacs/scanners/{name}/echo` | staff | `{ok, detail}` (C-ECHO from the PACS to the scanner) |

### Studies (same shape the UI already uses)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/studies` | staff, radiologist | list, newest first |
| GET | `/studies/{id}` | staff, radiologist | |
| GET | `/studies/{id}/series` | staff, radiologist | `[{seriesInstanceUID, number, description, modality, count, thickness}]` |
| PATCH | `/studies/{id}` | staff | `{assignedTo?, priority?, phone?, referredBy?}` |
| PUT | `/studies/{id}/report` | radiologist | `{findings, impression}`. Saves a draft. |
| POST | `/studies/{id}/report/sign` | radiologist | status → `ready` |
| PUT | `/studies/{id}/cac` | radiologist | `{seriesId, approved: {..., totals: {total: number}}, review?: {...}}` (review may be large, ~5 MB). Stored as JSON and returned on the study as `cac: {seriesId, approved, review, approvedBy, approvedAt}`. 422 if `approved.totals.total` is not a number. |
| POST | `/studies/{id}/events` | staff, radiologist | `{text, kind}`. Appends to the timeline. |
| POST | `/studies/{id}/series/{seriesUid}/cac-analysis` | radiologist | `{allowOpportunistic?}` → `{analysisId, validation, kind, label, totals: {LM, LAD, LCX, RCA, unassigned, total}, perVessel: {LM, LAD, LCX, RCA}, lesionCount, lesions, notes, engineVersion}`. Runs the Python CAC engine on the series pulled from the PACS. Unsuitable series → 422 `{detail: {error: "unsuitable", message, validation}}`. Stored apart from the approved `PUT /cac` record. |

A study object has the following fields:

```json
{ "id": "STD-30001", "studyInstanceUID": "1.2...", "source": "pacs",
  "patient": {"name": "", "id": "", "age": 58, "gender": "M", "phone": null, "email": null},
  "modality": "CT", "bodyPart": "Cardiac (Calcium score + CTA)", "referredBy": "", "priority": "Routine",
  "assignedTo": null, "status": "uploaded|reporting|ready|shared", "createdAt": "ISO",
  "receivedFrom": {"aeTitle": "CT_ROOM1", "ip": "10.0.0.21"},
  "sizeBytes": 0, "images": 0, "files": [], "report": null, "shares": [], "timeline": [], "cac": null }
```

### Sharing to a mobile number
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/studies/{id}/shares` | staff | `{mobile, includeReport, expiresHours, requireOtp}` → 201 `{share: {id, channel: "sms", to, at, status, includeReport, requireOtp, expiresAt, revoked, state, url}, message}`. `url` is the recipient link (`PUBLIC_BASE_URL + "/#/s/" + token`); `message` is the exact SMS text. Images can be shared at any time. `includeReport` is refused (409) until the report is signed. Invalid mobile → 422; `expiresHours` 1–720 (default 72). Shares in `study.shares` have the same fields without `url`. |
| GET | `/studies/{id}/shares` | staff | |
| DELETE | `/shares/{shareId}` | staff | revokes the link immediately |

Mobile numbers are normalised to E.164, with `+91` assumed when there is no country code. The SMS contains a link and, if required, a 6-digit OTP. The gateway stores only a hash of the OTP. A link locks after 5 wrong attempts. Every send, open, verification and revocation goes into the study timeline.

### Public share link (no login)
| Method | Path | Notes |
|---|---|---|
| GET | `/s/{token}` | `{centre, modality, bodyPart, studyDate, mobileMasked, requiresOtp, includeReport, expiresAt, state: active|expired|revoked|locked}` |
| POST | `/s/{token}/otp/verify` | `{otp}` → `{accessToken, expiresAt}` (valid 30 min). For a share created with `requireOtp=false` send `{"otp": null}`. With `requireOtp=true` a null or wrong OTP is a failed attempt: 401 `{detail: {error: "otp_invalid", attemptsLeft}}`, 423 once locked, 410 if expired or revoked. |
| POST | `/s/{token}/otp/resend` | → `{ok, resendsLeft}`. Sends a new code (the old one stops working); 3 per 10 min, then 429 with `Retry-After`. |
| GET | `/s/{token}/study` | Bearer accessToken → `{patientName, studyInstanceUID, modality, bodyPart, studyDate, series, report}`. `series` has the same shape as `GET /studies/{id}/series`. `report` is present only if the share includes it and the report is signed (always the latest signed version). |
| GET | `/s/{token}/dicomweb/{path}` | Bearer accessToken. DICOMweb limited to the shared study's UID. |

### DICOMweb (viewer)
`GET /dicomweb/{path}` (staff, radiologist) proxies to Orthanc `/dicom-web/{path}`. The viewer uses:

- `studies/{uid}/series/{suid}/metadata`: DICOM JSON for every instance (geometry and rescale tags).
- `studies/{uid}/series/{suid}/instances/{iuid}/frames/1` with `Accept: multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1`: uncompressed pixels, transcoded by Orthanc where needed.
- `.../rendered`: a JPEG for thumbnails.

### Development
`GET /dev/outbox` (only when `SMS_PROVIDER=console`) lists the SMS messages that would have been sent, so you can test OTP links without an SMS account.

## Status

The gateway (`server/`, package `asvanta_gateway`) and the Orthanc stack (`pacs/`) implement this contract. See `pacs/README.md` for commissioning and `pacs/VERIFY.md` for the end-to-end run.

Additions to the contract, none of which change existing fields:

- Study objects also carry `studyDescription`, `studyDate`, `seriesCount`, and `draft`. `draft` is `{findings, impression, updatedAt, updatedBy}` and is filled only for radiologists. `report` stays `null` until the report is signed, and then also carries `version` and `amended`.
- Share objects also carry `state` (`active|expired|revoked|locked`), `revokedAt`, `openedAt`, and `createdBy`. `status` is `sent`, `failed` or `opened`.
- `GET /studies/{id}/cac-analyses` (radiologist) lists the stored algorithm runs.
- `GET /api/health` is the unauthenticated liveness check.
- If a study already marked `shared` has an amended report signed, it stays `shared`. In every other case, signing sets the status to `ready`.
