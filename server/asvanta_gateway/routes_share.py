"""Sharing a study to a mobile number, and the public (no-login) share link."""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import dicomweb
from .db import iso, new_id, now, parse_iso
from .deps import Ctx, bearer, ctx, staff_only
from .phone import InvalidPhone, mask, normalise_mobile
from .security import new_otp, new_token, scrypt_hash, scrypt_verify, token_hash
from .sms import SmsMessage, share_message
from .views import report_json, share_json, share_state

router = APIRouter(prefix="/api")
OPEN_EVENT_DEDUP = timedelta(minutes=10)


def _link(c: Ctx, token: str) -> str:
    return f"{c.settings.public_base_url}/#/s/{token}"


def _sms_vars(c: Ctx, study, include_report: bool, link: str, otp: str | None, hours: int) -> dict[str, str]:
    """Variables for a DLT template (MSG91)."""
    return {"centre": c.settings.centre_name, "modality": study["modality"] or "", "bodypart": study["body_part"] or "",
            "what": "images and report" if include_report else "images", "link": link, "otp": otp or "", "hours": str(hours)}


# --------------------------------------------------------------------- staff side
class ShareBody(BaseModel):
    mobile: str
    includeReport: bool = False
    expiresHours: int = Field(default=72, ge=1, le=720)
    requireOtp: bool = True


@router.post("/studies/{study_id}/shares", status_code=201)
async def create_share(study_id: str, body: ShareBody, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    study = c.repo.study(study_id)
    if study is None:
        raise HTTPException(404, "study not found")
    try:
        mobile = normalise_mobile(body.mobile)
    except InvalidPhone as exc:
        raise HTTPException(422, str(exc)) from exc
    if body.includeReport and c.repo.signed_report(study_id) is None:
        raise HTTPException(409, "the report is not signed yet; share images only, or wait for the radiologist to sign")

    token = new_token(24)
    otp = new_otp() if body.requireOtp else None
    share_id = new_id("shr")
    created = now()
    expires = iso(created + timedelta(hours=body.expiresHours))
    c.repo.x(
        """INSERT INTO shares(id, study_id, token_hash, mobile, include_report, require_otp, otp_hash, created_at,
           created_by, expires_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')""",
        (share_id, study_id, token_hash(token), mobile, int(body.includeReport), int(body.requireOtp),
         scrypt_hash(otp) if otp else None, iso(created), user["name"], expires),
    )
    link = _link(c, token)
    text = share_message(c.settings.centre_name, study["modality"] or "", study["body_part"] or "",
                         body.includeReport, link, otp, body.expiresHours)
    result = await c.sms.send(SmsMessage(mobile, text, _sms_vars(c, study, body.includeReport, link, otp, body.expiresHours),
                                         share_id, otp))
    c.repo.update_share(share_id, status="sent" if result.ok else "failed")
    what = "images and signed report" if body.includeReport else "images"
    c.repo.add_event(
        study_id, user["name"],
        f"Shared {what} with {mask(mobile)} by SMS{' (OTP protected)' if otp else ''}, valid {body.expiresHours} h"
        + ("" if result.ok else f" — SMS FAILED: {result.detail[:120]}"),
        "share",
    )
    if body.includeReport and result.ok:
        c.repo.update_study(study_id, status="shared")
    share = share_json(c.repo.share(share_id))
    share["url"] = link
    return {"share": share, "message": text}


@router.get("/studies/{study_id}/shares")
def list_shares(study_id: str, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> list[dict]:
    if c.repo.study(study_id) is None:
        raise HTTPException(404, "study not found")
    return [share_json(s) for s in c.repo.shares_for(study_id)]


@router.delete("/shares/{share_id}")
def revoke_share(share_id: str, c: Ctx = Depends(ctx), user=Depends(staff_only)) -> dict:
    share = c.repo.share(share_id)
    if share is None:
        raise HTTPException(404, "share not found")
    if not share["revoked_at"]:
        c.repo.update_share(share_id, revoked_at=iso(), revoked_by=user["name"])
        c.repo.x("DELETE FROM share_sessions WHERE share_id = ?", (share_id,))
        c.repo.add_event(share["study_id"], user["name"], f"Share link to {mask(share['mobile'])} revoked", "share_revoke")
    return share_json(c.repo.share(share_id))


# --------------------------------------------------------------------- public side
def _share_or_404(c: Ctx, token: str):
    share = c.repo.share_by_token_hash(token_hash(token))
    if share is None:
        raise HTTPException(404, "link not found")
    return share


def _require_active(share) -> None:
    state = share_state(share)
    if state == "revoked":
        raise HTTPException(410, {"error": "revoked", "message": "This link has been revoked."})
    if state == "expired":
        raise HTTPException(410, {"error": "expired", "message": "This link has expired."})
    if state == "locked":
        raise HTTPException(423, {"error": "locked", "message": "Too many wrong codes. Ask the centre for a new link."})


@router.get("/s/{token}")
def share_info(token: str, c: Ctx = Depends(ctx)) -> dict:
    share = _share_or_404(c, token)
    study = c.repo.study(share["study_id"])
    state = share_state(share)
    if state == "active":
        last = share["last_open_event_at"]
        if last is None or now() - parse_iso(last) > OPEN_EVENT_DEDUP:
            c.repo.update_share(share["id"], last_open_event_at=iso())
            c.repo.add_event(study["id"], "Recipient", f"Share link opened ({mask(share['mobile'])})", "share_open")
    return {
        "centre": c.settings.centre_name,
        "modality": study["modality"] or "",
        "bodyPart": study["body_part"] or "",
        "studyDate": study["study_date"],
        "mobileMasked": mask(share["mobile"]),
        "requiresOtp": bool(share["require_otp"]),
        "includeReport": bool(share["include_report"]),
        "expiresAt": share["expires_at"],
        "state": state,
    }


class OtpBody(BaseModel):
    otp: str | None = None


@router.post("/s/{token}/otp/verify")
def verify_otp(token: str, body: OtpBody | None = None, c: Ctx = Depends(ctx)) -> dict:
    body = body or OtpBody()
    s = c.settings
    with c.repo.tx():  # attempts counting must not race
        share = _share_or_404(c, token)
        _require_active(share)
        if share["require_otp"]:
            otp = (body.otp or "").strip()
            if not (otp.isdigit() and len(otp) == 6 and scrypt_verify(otp, share["otp_hash"])):
                attempts = share["otp_attempts"] + 1
                locked = attempts >= s.share_max_otp_attempts
                c.repo.update_share(share["id"], otp_attempts=attempts, locked=int(locked))
                if locked:
                    c.repo.x("DELETE FROM share_sessions WHERE share_id = ?", (share["id"],))
                    c.repo.add_event(share["study_id"], "System",
                                     f"Share link to {mask(share['mobile'])} locked after {attempts} wrong OTP attempts", "share_lock")
                    lock_error = True
                else:
                    c.repo.add_event(share["study_id"], "Recipient",
                                     f"Wrong OTP entered for link to {mask(share['mobile'])} (attempt {attempts} of {s.share_max_otp_attempts})",
                                     "share_verify_fail")
                    lock_error = False
                fail = (attempts, lock_error)
            else:
                fail = None
        else:
            fail = None
        if fail is None:
            access = new_token()
            expires = iso(now() + timedelta(minutes=s.share_access_minutes))
            c.repo.x("INSERT INTO share_sessions VALUES(?, ?, ?, ?)", (token_hash(access), share["id"], iso(), expires))
            c.repo.update_share(share["id"], status="opened", opened_at=share["opened_at"] or iso())
            c.repo.add_event(share["study_id"], "Recipient",
                             f"Share link verified — recipient {mask(share['mobile'])} viewing", "share_verify")
    if fail is not None:
        attempts, locked = fail
        if locked:
            raise HTTPException(423, {"error": "locked", "message": "Too many wrong codes. Ask the centre for a new link."})
        raise HTTPException(401, {"error": "otp_invalid", "attemptsLeft": s.share_max_otp_attempts - attempts})
    return {"accessToken": access, "expiresAt": expires}


@router.post("/s/{token}/otp/resend")
async def resend_otp(token: str, c: Ctx = Depends(ctx)) -> dict:
    s = c.settings
    share = _share_or_404(c, token)
    _require_active(share)
    if not share["require_otp"]:
        raise HTTPException(400, "this link does not use an OTP")
    cutoff = now() - timedelta(seconds=s.share_resend_window_s)
    recent = [t for t in json.loads(share["resends"]) if parse_iso(t) > cutoff]
    if len(recent) >= s.share_resend_limit:
        retry = int((parse_iso(min(recent)) + timedelta(seconds=s.share_resend_window_s) - now()).total_seconds()) + 1
        raise HTTPException(429, {"error": "rate_limited", "retryAfter": retry}, headers={"Retry-After": str(retry)})
    otp = new_otp()
    recent.append(iso())
    # A new code replaces the old one; the attempt counter is NOT reset (5 tries per link in total).
    c.repo.update_share(share["id"], otp_hash=scrypt_hash(otp), resends=json.dumps(recent))
    study = c.repo.study(share["study_id"])
    hours = max(1, round((parse_iso(share["expires_at"]) - now()).total_seconds() / 3600))
    link = _link(c, token)
    text = share_message(s.centre_name, study["modality"] or "", study["body_part"] or "",
                         bool(share["include_report"]), link, otp, hours)
    result = await c.sms.send(SmsMessage(share["mobile"], text, _sms_vars(c, study, bool(share["include_report"]), link, otp, hours),
                                         share["id"], otp))
    c.repo.add_event(study["id"], "Recipient", f"OTP resent to {mask(share['mobile'])}" + ("" if result.ok else " — SMS FAILED"), "share_resend")
    return {"ok": result.ok, "resendsLeft": s.share_resend_limit - len(recent)}


def _share_session(c: Ctx, token: str, authorization: str | None):
    share = _share_or_404(c, token)
    access = bearer(authorization)
    if not access:
        raise HTTPException(401, "missing access token", headers={"WWW-Authenticate": "Bearer"})
    row = c.repo.one("SELECT * FROM share_sessions WHERE token_hash = ?", (token_hash(access),))
    if row is None or row["share_id"] != share["id"] or parse_iso(row["expires_at"]) <= now():
        raise HTTPException(401, "invalid or expired access token", headers={"WWW-Authenticate": "Bearer"})
    _require_active(share)  # revocation / expiry take effect immediately
    return share


@router.get("/s/{token}/study")
async def shared_study(token: str, c: Ctx = Depends(ctx), authorization: str | None = Header(None)) -> dict:
    share = _share_session(c, token, authorization)
    study = c.repo.study(share["study_id"])
    series = dicomweb.public_series(await dicomweb.study_series(c, study))
    # always the latest signed version, so amendments reach existing links
    report = report_json(c.repo.signed_report(study["id"])) if share["include_report"] else None
    return {
        "patientName": study["patient_name"] or "",
        "studyInstanceUID": study["study_uid"],
        "modality": study["modality"] or "",
        "bodyPart": study["body_part"] or "",
        "studyDate": study["study_date"],
        "centre": c.settings.centre_name,
        "expiresAt": share["expires_at"],
        "series": series,
        "report": report,
    }


@router.get("/s/{token}/dicomweb/{path:path}")
async def shared_dicomweb(token: str, path: str, request: Request, c: Ctx = Depends(ctx),
                          authorization: str | None = Header(None)):
    share = _share_session(c, token, authorization)
    study = c.repo.study(share["study_id"])
    series = await dicomweb.study_series(c, study)
    safe = dicomweb.check_share_path(path, study["study_uid"], {s["seriesInstanceUID"] for s in series})
    return await dicomweb.proxy(c, safe, request, dicomweb.scoped_query(request))
