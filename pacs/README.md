# Asvanta PACS: commissioning guide

The stack has two services:

- **orthanc** (`orthancteam/orthanc:24.10.3`). Receives studies from the scanners by DICOM C-STORE and stores them. It is the PACS.
- **gateway** (FastAPI, `server/`). The only thing the web app talks to. It handles login, the worklist, reports, OTP-protected SMS sharing, the DICOMweb proxy and the CAC engine.

The API contract is in `docs/pacs-integration.md`.

| Port | Service | Exposure |
|---|---|---|
| 4242/tcp | Orthanc DICOM (C-STORE, C-ECHO) | Hospital LAN. Open it **only from the modality VLAN**. |
| 8042/tcp | Orthanc REST and DICOMweb | Bound to `127.0.0.1` on the host, for debugging only. The gateway reaches it on the internal docker network. Never expose it. |
| 8000/tcp | Gateway API | Put TLS termination in front of it (see Production hardening). |

## 1. Start

```bash
cd pacs
cp .env.example .env          # set ORTHANC_PASSWORD, DEMO_PASSWORD, PUBLIC_BASE_URL, PACS_PUBLIC_HOST, SMS_*
docker compose up -d --build
docker compose ps             # both services should show "healthy"
curl -s localhost:8000/api/health
```

Every variable is described in `.env.example`. Orthanc settings are passed as `ORTHANC__*` environment variables, which the orthancteam image turns into `orthanc.json`. The settings used are:

| Setting | Value |
|---|---|
| `DicomAet` | `ASVANTA` |
| `DicomCheckCalledAet` | true |
| `DicomAlwaysAllowStore` | `ORTHANC_ACCEPT_UNKNOWN` (default false) |
| `DicomModalitiesInDatabase` | true, so scanners registered through the API survive restarts |
| `StableAge` | 10 s |
| `OverwriteInstances` | true |
| `StorageCompression` | false |
| `AuthenticationEnabled` | true, with one REST user (`ORTHANC_USER` / `ORTHANC_PASSWORD`) that only the gateway uses |
| DICOMweb plugin | `/dicom-web/` |

**Gateway without Docker** (development):

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -e ../engine -e '.[dev]'
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_PASSWORD=... DB_PATH=./gateway.db \
  .venv/bin/uvicorn asvanta_gateway.app:app --port 8000
.venv/bin/pytest -q                                   # unit tests (fake Orthanc)
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_PASSWORD=... .venv/bin/pytest -q -m integration   # live Orthanc
```

**Demo users.** All of them use the password `DEMO_PASSWORD` (default `asvanta`):

| User | Role |
|---|---|
| `priya@asvanta.in` | staff |
| `dr.mehta@asvanta.in` | radiologist (`rad_mehta`) |
| `dr.reddy@` / `dr.qureshi@` / `dr.kulkarni@asvanta.in` | radiologists |

The gateway uses email and password sign-in for now. This replaces the demo's OTP sign-in. Bearer tokens are opaque, random, stored hashed, and expire after `SESSION_HOURS`.

## 2. Configure each scanner

On the CT, MRI, X-ray or ultrasound console, add a DICOM storage destination. It may be called "Store SCP", "Remote node" or "Archive".

| Field on the scanner | Value |
|---|---|
| Remote AE title (called AE) | `ASVANTA` (`ORTHANC_AET`) |
| Remote host / IP | the PACS server's LAN IP (`PACS_PUBLIC_HOST`, for example `192.168.10.5`) |
| Remote port | `4242` (`ORTHANC_DICOM_PORT`) |
| Local AE title (calling AE) | the scanner's own AE, for example `CT_ROOM1`. It must be unique per device. |
| Transfer syntax | any. Orthanc accepts compressed and uncompressed data and transcodes for the viewer. |

## 3. Register the scanner with the PACS

Orthanc accepts C-STORE only from registered AEs, unless `ORTHANC_ACCEPT_UNKNOWN=true`. Register each scanner in the web app (**Scanners**) or with the API:

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"priya@asvanta.in","password":"asvanta"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -X POST localhost:8000/api/pacs/scanners -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"CT_ROOM1","aeTitle":"CT_ROOM1","host":"192.168.20.21","port":104}'
curl -s localhost:8000/api/pacs -H "authorization: Bearer $TOKEN"        # lists scanners with lastSeen
```

`host` and `port` are the scanner's own DICOM listener. Orthanc uses them for C-ECHO and for any C-MOVE back to the scanner. By default (`ORTHANC_CHECK_MODALITY_HOST=false`) a registered AE may send from any IP. Set it to `true` once the scanner IPs are fixed, so that a spoofed AE title from another IP is refused.

During commissioning you can set `ORTHANC_ACCEPT_UNKNOWN=true` and run `docker compose up -d` to accept any calling AE. Turn it off again afterwards.

## 4. Test the connection

- **Scanner to PACS.** Use the scanner's "Verify" / "Echo" button. Orthanc answers C-ECHO from any AE (`DicomAlwaysAllowEcho`).
- **PACS to scanner.** Use **Test (C-ECHO)** in Scanners, or `POST /api/pacs/scanners/CT_ROOM1/echo`, which returns `{ok, detail}`.
- **Without a scanner.** `tools/send_test_study.py` acts as a modality:

  ```bash
  server/.venv/bin/python tools/send_test_study.py --host <pacs-ip> --port 4242 --calling-aet CT_ROOM1 --echo
  server/.venv/bin/python tools/send_test_study.py --kind random --calling-aet CT_ROOM2
  ```

  `--kind cardiac` (the default) renders the synthetic cardiac CT phantom with Node 18 or later, using `tools/export_phantom.mjs`, as 3 CT series with 176 images in total. About 10 s after the last image (`StableAge`), the study appears in `GET /api/studies` with `receivedFrom`. `tools/verify_e2e.py` then checks the whole chain.

If a C-STORE is refused, `docker compose logs orthanc` shows the reason, for example `DICOM authorization rejected for AET X on IP Y`.

## 5. Firewall

- Allow inbound **TCP 4242 only from the modality VLAN or subnet**. For example, with ufw: `ufw allow from 192.168.20.0/24 to any port 4242 proto tcp`. Docker publishes ports through its own iptables chain, which can bypass ufw. Either put the rule in the `DOCKER-USER` chain, or set `ORTHANC_DICOM_BIND=<LAN-IP>`.
- Never open TCP 8042. Compose binds it to 127.0.0.1.
- Allow TCP 443 to the reverse proxy in front of the gateway. Do not expose 8000 directly in production.
- If scanners must C-ECHO or C-MOVE back, allow outbound traffic from the PACS to the scanners' DICOM ports.

## 6. Backups

- **Orthanc storage.** Back up the docker volume `asvanta-pacs_orthanc-storage`, which holds the DICOM files and the SQLite index. Either stop Orthanc first or snapshot the volume:
  `docker run --rm -v asvanta-pacs_orthanc-storage:/src -v $PWD:/dst alpine tar czf /dst/orthanc-$(date +%F).tgz -C /src .`
- **Gateway DB.** Back up the volume `asvanta-pacs_gateway-data` (`gateway.db`). It holds users, reports, shares, the audit timeline and CAC. It is SQLite in WAL mode, so use `sqlite3 gateway.db ".backup out.db"` for a hot copy.
- Test restores regularly. Keep at least one copy off-site, and encrypt it, because it contains patient data.

## 7. Production hardening

- **TLS.** Put Caddy, nginx or Traefik in front of the gateway with HTTPS and HSTS. Set `PUBLIC_BASE_URL=https://...` and restrict `CORS_ORIGINS` to the real web origin. Uvicorn runs with `--proxy-headers`.
- **Secrets.** Use strong unique values for `ORTHANC_PASSWORD` and `DEMO_PASSWORD`, then replace the demo users with real accounts (and SSO or MFA). Keep `.env` out of git.
- **Object storage.** Use the Orthanc S3 / Azure / GCS object-storage plugin (`orthancteam/orthanc` ships it: `ORTHANC__AWS_S3_STORAGE__...`) so images are not tied to one disk. Turn on bucket versioning, encryption and lifecycle rules.
- **Index database.** Use the PostgreSQL index plugin (`ORTHANC__POSTGRESQL__*`) instead of SQLite once you have more than about 100k instances or several Orthanc replicas. Back it up with the rest of the database estate.
- **Real SMS.** Set `SMS_PROVIDER=msg91` (India) or `twilio`. `GET /api/dev/outbox` is disabled automatically.
- **DLT registration (India).** TRAI rules require every transactional SMS to use a registered entity (PE ID), header (sender ID, `MSG91_SENDER`) and content template. Register a template such as:
  `##centre##: your ##modality## ##bodypart## ##what## are ready. View: ##link## OTP ##otp##. Valid ##hours## h.`
  Put its id in `MSG91_TEMPLATE_ID`. The gateway sends exactly these variables. Unregistered content is dropped by the operators.
- **Gateway storage.** SQLite suits a single gateway instance. Move to Postgres before running replicas.
- **CAC jobs.** CAC currently runs in-request (a 40-slice series takes about 1 s). Move it to a worker queue for large series.
- **Network.** Set `ORTHANC_CHECK_MODALITY_HOST=true` and keep the modality VLAN isolated. Monitor `docker compose logs orthanc` for rejected associations.
- **Retention and audit.** Every share send, open, OTP failure, lock and revoke is in the study timeline. Ship logs to central storage.
