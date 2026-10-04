"""Auth, PACS/scanners, studies, reports, CAC and the staff DICOMweb proxy."""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import dicomweb
from .cac import Unsuitable, analyse_series
from .db import iso, new_id
from .deps import Ctx, any_user, ctx, current_user, radiologist_only, staff_only
from .orthanc import OrthancError
from .phone import InvalidPhone, normalise_mobile
from .security import RADIOLOGIST_IDS, new_token, public_user, scrypt_verify, token_hash
from .views import event_json, study_json

router = APIRouter(prefix="/api")

AET_RE = re.compile(r"^[A-Za-z0-9_\-. ]{1,16}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


# --------------------------------------------------------------------- health
@router.get("/health")
async def health(c: Ctx = Depends(ctx)) -> dict:
    return {"ok": True, "ingestError": getattr(c.ingestor, "last_error", None)}


# --------------------------------------------------------------------- auth
class LoginBody(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginBody, c: Ctx = Depends(ctx)) -> dict:
    user = c.repo.user_by_email(body.email)
    if user is None or not scrypt_verify(body.password, user["password_hash"]):
        raise HTTPException(401, "invalid email or password")
    token = new_token()
    expires = c.repo.add_session(token_hash(token), user["id"], c.settings.session_hours)
    return {"token": token, "expiresAt": expires, "user": public_user(user)}


@router.get("/auth/me")
def me(user=Depends(current_user)) -> dict:
    return public_user(user)


# --------------------------------------------------------------------- PACS
@router.get("/pacs")
async def pacs(c: Ctx = Depends(ctx), user=Depends(current_user)) -> dict:
    online = True
    modalities: dict = {}
    try:
        await c.orthanc.system()
        modalities = await c.orthanc.modalities()
    except OrthancError:
        online = False
    seen = c.repo.scanners_seen()
    scanners = []
    for name, m in sorted(modalities.items()):
        aet = m.get("AET")
        s = seen.get(aet)
        scanners.append({"name": name, "aeTitle": aet, "host": m.get("Host"), "port": m.get("Port"),
                         "lastSeen": s["last_seen"] if s else None})
    return {"aeTitle": c.settings.pacs_aet, "host": c.settings.pacs_host, "port": c.settings.pacs_port,
            "online": online, "scanners": scanners}


class ScannerBody(BaseModel):
    name: str
    aeTitle: str
    host: str
    port: int = Field(ge=1, le=65535)


@router.post("/pacs/scanners", status_code=201)
async def add_scanner(body: ScannerBody, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    if not NAME_RE.match(body.name):
        raise HTTPException(422, "name: letters, digits, '_' and '-' only")
    if not AET_RE.match(body.aeTitle.strip()):
        raise HTTPException(422, "aeTitle: 1-16 characters")
    if not re.match(r"^[A-Za-z0-9.\-:]{1,253}$", body.host.strip()):
        raise HTTPException(422, "host: IP address or hostname")
    try:
        await c.orthanc.put_modality(body.name, body.aeTitle.strip(), body.host.strip(), body.port)
    except OrthancError as exc:
        raise HTTPException(502, str(exc)) from exc
    seen = c.repo.scanners_seen().get(body.aeTitle.strip())
    return {"name": body.name, "aeTitle": body.aeTitle.strip(), "host": body.host.strip(), "port": body.port,
            "lastSeen": seen["last_seen"] if seen else None}


@router.delete("/pacs/scanners/{name}")
async def delete_scanner(name: str, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    try:
        await c.orthanc.delete_modality(name)
    except OrthancError as exc:
        raise HTTPException(404 if exc.status == 404 else 502, str(exc)) from exc
    return {"ok": True}


@router.post("/pacs/scanners/{name}/echo")
async def echo_scanner(name: str, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    try:
        await c.orthanc.echo(name)
    except OrthancError as exc:
        if exc.status == 404:
            raise HTTPException(404, f"unknown scanner {name}") from exc
        return {"ok": False, "detail": f"C-ECHO failed: {exc}"}
    return {"ok": True, "detail": f"C-ECHO to {name} succeeded"}


# --------------------------------------------------------------------- studies
def _study_or_404(c: Ctx, study_id: str):
    row = c.repo.study(study_id)
    if row is None:
        raise HTTPException(404, "study not found")
    return row


@router.get("/studies")
def list_studies(c: Ctx = Depends(ctx), user=Depends(any_user)) -> list[dict]:
    return [study_json(c.repo, r, user["role"]) for r in c.repo.studies()]


@router.get("/studies/{study_id}")
def get_study(study_id: str, c: Ctx = Depends(ctx), user=Depends(any_user)) -> dict:
    return study_json(c.repo, _study_or_404(c, study_id), user["role"])


@router.get("/studies/{study_id}/series")
async def get_series(study_id: str, c: Ctx = Depends(ctx), user=Depends(any_user)) -> list[dict]:
    return dicomweb.public_series(await dicomweb.study_series(c, _study_or_404(c, study_id)))


class PatchBody(BaseModel):
    model_config = {"extra": "forbid"}
    assignedTo: str | None = None
    priority: Literal["Routine", "Urgent"] | None = None
    phone: str | None = None
    referredBy: str | None = None


@router.patch("/studies/{study_id}")
def patch_study(study_id: str, body: PatchBody, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    row = _study_or_404(c, study_id)
    given = body.model_dump(exclude_unset=True)
    upd: dict[str, Any] = {}
    if "assignedTo" in given:
        rad = given["assignedTo"]
        if rad is not None and rad not in RADIOLOGIST_IDS:
            raise HTTPException(422, f"assignedTo must be one of {', '.join(RADIOLOGIST_IDS)} or null")
        if rad != row["assigned_to"]:
            upd["assigned_to"] = rad
            if rad:
                name = (c.repo.one("SELECT name FROM users WHERE radiologist_id = ?", (rad,)) or {"name": rad})["name"]
                c.repo.add_event(study_id, user["name"], f"Assigned to {name}", "assign")
            else:
                c.repo.add_event(study_id, user["name"], "Unassigned", "assign")
    if given.get("priority") and given["priority"] != row["priority"]:
        upd["priority"] = given["priority"]
        c.repo.add_event(study_id, user["name"], f"Priority set to {given['priority']}", "update")
    if "phone" in given:
        phone = given["phone"]
        if phone:
            try:
                phone = normalise_mobile(phone)
            except InvalidPhone as exc:
                raise HTTPException(422, str(exc)) from exc
        upd["patient_phone"] = phone or None
    if "referredBy" in given:
        upd["referred_by"] = given["referredBy"] or ""
    c.repo.update_study(study_id, **upd)
    return study_json(c.repo, c.repo.study(study_id), user["role"])


class ReportBody(BaseModel):
    findings: str = Field(max_length=50_000)
    impression: str = Field(max_length=20_000)


@router.put("/studies/{study_id}/report")
def save_draft(study_id: str, body: ReportBody, c: Ctx = Depends(ctx), user=Depends(radiologist_only)) -> dict:
    row = _study_or_404(c, study_id)
    ts = iso()
    draft = c.repo.draft(study_id)
    if draft is None:
        c.repo.x(
            "INSERT INTO reports(id, study_id, state, findings, impression, author_id, author_name, created_at, updated_at)"
            " VALUES(?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
            (new_id("rep"), study_id, body.findings, body.impression, user["id"], user["name"], ts, ts),
        )
        amend = c.repo.signed_report(study_id) is not None
        c.repo.add_event(study_id, user["name"], "Report amendment drafted" if amend else "Report drafted", "report")
    else:
        c.repo.x(
            "UPDATE reports SET findings = ?, impression = ?, author_id = ?, author_name = ?, updated_at = ? WHERE id = ?",
            (body.findings, body.impression, user["id"], user["name"], ts, draft["id"]),
        )
    if row["status"] == "uploaded":
        c.repo.update_study(study_id, status="reporting")
    return study_json(c.repo, c.repo.study(study_id), user["role"])


@router.post("/studies/{study_id}/report/sign")
def sign_report(study_id: str, c: Ctx = Depends(ctx), user=Depends(radiologist_only)) -> dict:
    row = _study_or_404(c, study_id)
    draft = c.repo.draft(study_id)
    if draft is None:
        raise HTTPException(409, "no draft report to sign; save one with PUT /report first")
    if not draft["findings"].strip() or not draft["impression"].strip():
        raise HTTPException(422, "findings and impression are required before signing")
    version = c.repo.signed_versions(study_id) + 1
    ts = iso()
    c.repo.x(
        "UPDATE reports SET state = 'signed', version = ?, signed_by = ?, signed_at = ?, updated_at = ? WHERE id = ?",
        (version, user["name"], ts, ts, draft["id"]),
    )
    text = "Report signed — released to the centre for publishing" if version == 1 else f"Amended report signed (version {version})"
    c.repo.add_event(study_id, user["name"], text, "sign")
    # An amendment of an already-shared study keeps it 'shared': existing links show the new version.
    if row["status"] != "shared":
        c.repo.update_study(study_id, status="ready")
    return study_json(c.repo, c.repo.study(study_id), user["role"])


class CacBody(BaseModel):
    seriesId: str | None = None
    approved: dict[str, Any]
    review: dict[str, Any] | list[Any] | None = None


@router.put("/studies/{study_id}/cac")
def put_cac(study_id: str, body: CacBody, c: Ctx = Depends(ctx), user=Depends(radiologist_only)) -> dict:
    """Stores the radiologist-approved CAC record (kept apart from algorithm runs in cac_analyses)."""
    _study_or_404(c, study_id)
    totals = body.approved.get("totals")
    total = totals.get("total") if isinstance(totals, dict) else None
    if isinstance(total, bool) or not isinstance(total, (int, float)):
        raise HTTPException(422, "approved.totals.total must be a number")
    payload = {"seriesId": body.seriesId, "approved": body.approved, "review": body.review,
               "approvedBy": user["name"], "approvedAt": iso()}
    c.repo.set_cac(study_id, payload, user["name"])
    c.repo.add_event(study_id, user["name"], f"CAC score approved — Agatston {round(float(total))}", "cac")
    return study_json(c.repo, c.repo.study(study_id), user["role"])


class EventBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    kind: str = Field(default="note", max_length=40)


@router.post("/studies/{study_id}/events", status_code=201)
def add_event(study_id: str, body: EventBody, c: Ctx = Depends(ctx), user=Depends(any_user)) -> dict:
    _study_or_404(c, study_id)
    ev = c.repo.add_event(study_id, user["name"], body.text, body.kind)
    return {k: ev[k] for k in ("id", "at", "actor", "text", "kind")}


class CacRunBody(BaseModel):
    allowOpportunistic: bool = False
    allow_opportunistic: bool | None = None


@router.post("/studies/{study_id}/series/{series_uid}/cac-analysis")
async def cac_analysis(study_id: str, series_uid: str, body: CacRunBody | None = None,
                       c: Ctx = Depends(ctx), user=Depends(radiologist_only)) -> dict:
    row = _study_or_404(c, study_id)
    body = body or CacRunBody()
    allow = body.allow_opportunistic if body.allow_opportunistic is not None else body.allowOpportunistic
    series = await dicomweb.study_series(c, row)
    match = next((s for s in series if s["seriesInstanceUID"] == series_uid), None)
    if match is None:
        raise HTTPException(404, "series not in this study")
    try:
        result, n = await analyse_series(c.orthanc, match["orthancId"], series_uid, allow)
    except Unsuitable as exc:
        c.repo.add_event(study_id, user["name"], f"CAC analysis refused for '{match['description']}': unsuitable series", "cac")
        raise HTTPException(422, {"error": "unsuitable", "message": str(exc), "validation": exc.validation}) from exc
    except OrthancError as exc:
        raise HTTPException(502, str(exc)) from exc
    except Exception as exc:  # DicomLoadError and friends
        raise HTTPException(422, {"error": "unreadable", "message": str(exc)}) from exc
    result.update(studyId=study_id, seriesInstanceUID=series_uid, seriesDescription=match["description"],
                  instances=n, runBy=user["name"], at=iso(), approved=False)
    c.repo.add_cac_analysis(study_id, series_uid, user["name"], result)
    c.repo.add_event(
        study_id, user["name"],
        f"CAC algorithm run on '{match['description']}' ({result['kind']}): Agatston {result['totals']['total']:.0f}, "
        f"{result['lesionCount']} candidate lesions — awaiting review", "cac",
    )
    return result


@router.get("/studies/{study_id}/cac-analyses")
def list_cac_analyses(study_id: str, c: Ctx = Depends(ctx), user=Depends(radiologist_only)) -> list[dict]:
    _study_or_404(c, study_id)
    return c.repo.cac_analyses(study_id)


# --------------------------------------------------------------------- DICOMweb (staff / radiologist)
@router.get("/dicomweb/{path:path}")
async def dicomweb_proxy(path: str, request: Request, c: Ctx = Depends(ctx), user=Depends(any_user)):
    return await dicomweb.proxy(c, dicomweb.check_staff_path(path), request)


# --------------------------------------------------------------------- dev outbox
@router.get("/dev/outbox")
def outbox(c: Ctx = Depends(ctx)) -> list[dict]:
    if c.settings.sms_provider != "console":
        raise HTTPException(404, "not found")
    return [{"id": r["id"], "at": r["at"], "to": r["to_number"], "body": r["body"], "shareId": r["share_id"], "otp": r["otp"]}
            for r in c.repo.outbox()]


__all__ = ["router", "event_json"]
