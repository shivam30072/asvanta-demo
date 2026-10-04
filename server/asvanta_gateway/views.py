"""JSON shapes the web app consumes (see docs/pacs-integration.md)."""

from __future__ import annotations

from typing import Any

from .db import Repo, now, parse_iso


def share_state(row) -> str:
    if row["revoked_at"]:
        return "revoked"
    if row["locked"]:
        return "locked"
    if parse_iso(row["expires_at"]) <= now():
        return "expired"
    return "active"


def share_json(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "channel": "sms",
        "to": row["mobile"],
        "at": row["created_at"],
        "status": row["status"],
        "includeReport": bool(row["include_report"]),
        "requireOtp": bool(row["require_otp"]),
        "expiresAt": row["expires_at"],
        "revoked": bool(row["revoked_at"]),
        "revokedAt": row["revoked_at"],
        "openedAt": row["opened_at"],
        "state": share_state(row),
        "createdBy": row["created_by"],
    }


def report_json(row) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "findings": row["findings"],
        "impression": row["impression"],
        "signedBy": row["signed_by"],
        "signedAt": row["signed_at"],
        "version": row["version"],
        "amended": (row["version"] or 1) > 1,
    }


def draft_json(row) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "findings": row["findings"],
        "impression": row["impression"],
        "updatedAt": row["updated_at"],
        "updatedBy": row["author_name"],
    }


def event_json(row) -> dict[str, Any]:
    return {"id": row["id"], "at": row["at"], "actor": row["actor"], "text": row["text"], "kind": row["kind"]}


def study_json(repo: Repo, row, viewer_role: str | None = None) -> dict[str, Any]:
    sid = row["id"]
    return {
        "id": sid,
        "studyInstanceUID": row["study_uid"],
        "source": "pacs",
        "patient": {
            "name": row["patient_name"] or "",
            "id": row["patient_id"] or "",
            "age": row["patient_age"],
            "gender": row["patient_gender"],
            "phone": row["patient_phone"],
            "email": row["patient_email"],
        },
        "modality": row["modality"] or "",
        "bodyPart": row["body_part"] or "",
        "studyDescription": row["study_description"] or "",
        "studyDate": row["study_date"],
        "referredBy": row["referred_by"] or "",
        "priority": row["priority"] or "Routine",
        "assignedTo": row["assigned_to"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "receivedFrom": {"aeTitle": row["received_aet"], "ip": row["received_ip"]} if row["received_aet"] or row["received_ip"] else None,
        "sizeBytes": row["size_bytes"] or 0,
        "images": row["images"] or 0,
        "seriesCount": row["series_count"] or 0,
        "files": [],
        "report": report_json(repo.signed_report(sid)),
        # drafts are the radiologist's working copy; staff never see them
        "draft": draft_json(repo.draft(sid)) if viewer_role == "radiologist" else None,
        "shares": [share_json(s) for s in repo.shares_for(sid)],
        "timeline": [event_json(e) for e in repo.events(sid)],
        "cac": repo.cac(sid),
    }
