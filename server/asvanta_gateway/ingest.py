"""Ingest: follow Orthanc's ``/changes`` feed and register stable studies."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date

from .db import Repo, iso
from .orthanc import Orthanc, OrthancError
from .phone import InvalidPhone, normalise_mobile

log = logging.getLogger("asvanta.ingest")

LAST_SEQ_KEY = "orthanc_last_change"

# DICOM modality -> the labels the UI uses (src/data/seed.js MODALITIES)
MODALITY_LABELS = {
    "CT": "CT", "MR": "MRI", "CR": "X-Ray", "DX": "X-Ray", "DR": "X-Ray", "RF": "X-Ray", "XA": "X-Ray",
    "US": "Ultrasound", "MG": "Mammography", "PT": "PET-CT", "NM": "NM", "OT": "Other",
}
NON_IMAGE = {"SR", "PR", "KO", "DOC", "REG", "SEG", "RTSTRUCT", "RTPLAN"}
_DESC_PREFIX = re.compile(r"^\s*(CT|MRI|MR|XR|X-RAY|DX|CR|US|USG|MG|PET[- ]?CT|PT|NM)\b[\s:\-]*", re.I)



# who reads what by default; mirrors suggestRadiologist() in src/data/seed.js
RADIOLOGIST_NAMES = {
    "rad_mehta": "Dr. Anil Mehta",
    "rad_reddy": "Dr. Kavya Reddy",
    "rad_qureshi": "Dr. Farhan Qureshi",
    "rad_kulkarni": "Dr. Sneha Kulkarni",
}


def suggest_radiologist(modality: str, body_part: str) -> str:
    """Default assignee for a newly received study, from modality and body part."""
    b = (body_part or "").lower()
    if modality in ("MG", "US", "Mammography", "Ultrasound"):
        return "rad_kulkarni"
    if any(k in b for k in ("chest", "lung", "thorax", "cardiac", "heart", "coronary")):
        return "rad_qureshi"
    if any(k in b for k in ("spine", "knee", "shoulder")):
        return "rad_reddy"
    return "rad_mehta"

def format_person_name(pn: str | None) -> str:
    """'MALHOTRA^VIKRAM' -> 'Vikram Malhotra' (title-cased only if the source is all caps)."""
    if not pn:
        return ""
    parts = [p.strip() for p in pn.split("=")[0].split("^")]
    family = parts[0] if parts else ""
    given = " ".join(p for p in parts[1:3] if p)
    prefix = parts[3] if len(parts) > 3 else ""
    words = " ".join(p for p in (prefix, given, family) if p).split()
    return " ".join(w.title() if w.isupper() and len(w) > 1 else w for w in words)


def _dicom_date(value: str | None) -> date | None:
    if not value or len(value) < 8 or not value[:8].isdigit():
        return None
    try:
        return date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def patient_age(tags: dict) -> int | None:
    age = (tags.get("PatientAge") or "").strip().upper()
    m = re.fullmatch(r"(\d{1,3})([YMWD])", age)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return n if unit == "Y" else 0
    born = _dicom_date(tags.get("PatientBirthDate"))
    if born is None:
        return None
    ref = _dicom_date(tags.get("StudyDate")) or date.today()
    return ref.year - born.year - ((ref.month, ref.day) < (born.month, born.day))


def body_part(tags: dict) -> str:
    desc = (tags.get("StudyDescription") or "").strip()
    if desc:
        stripped = _DESC_PREFIX.sub("", desc).strip()
        return stripped or desc
    bp = (tags.get("BodyPartExamined") or "").strip()
    if bp:
        return bp.replace("_", " ").title()
    return (tags.get("SeriesDescription") or "").strip()


def study_modality(series_modalities: list[str]) -> str:
    mods = [m for m in series_modalities if m and m not in NON_IMAGE]
    if "PT" in mods:
        return "PET-CT"
    for m in mods:
        if m in MODALITY_LABELS:
            return MODALITY_LABELS[m]
    return mods[0] if mods else (series_modalities[0] if series_modalities else "")


def iso_date(value: str | None) -> str | None:
    d = _dicom_date(value)
    return d.isoformat() if d else None


def patient_phone(tags: dict) -> str | None:
    raw = (tags.get("PatientTelephoneNumbers") or "").split("\\")[0].strip()
    if not raw:
        return None
    try:
        return normalise_mobile(raw)
    except InvalidPhone:
        return raw


def _count(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


async def register_study(repo: Repo, orthanc: Orthanc, orthanc_id: str) -> str:
    """Create or refresh the gateway study for an Orthanc study. Returns the gateway id."""
    study = await orthanc.study(orthanc_id)
    series = await orthanc.study_series(orthanc_id)
    stats = await orthanc.study_statistics(orthanc_id)
    first_instance = next((s["Instances"][0] for s in series if s.get("Instances")), None)
    tags: dict = await orthanc.instance_tags(first_instance) if first_instance else {}
    meta: dict = await orthanc.instance_metadata(first_instance) if first_instance else {}

    main = {**study.get("PatientMainDicomTags", {}), **study.get("MainDicomTags", {})}
    merged = {**tags, **{k: v for k, v in main.items() if v}}
    uid = merged.get("StudyInstanceUID") or tags.get("StudyInstanceUID")
    images = _count(stats.get("CountInstances"))
    size = _count(stats.get("DiskSize"))
    aet = (meta.get("RemoteAET") or "").strip() or None
    ip = (meta.get("RemoteIP") or meta.get("RemoteIp") or "").strip() or None
    fields = dict(
        patient_name=format_person_name(merged.get("PatientName")),
        patient_id=merged.get("PatientID") or "",
        patient_age=patient_age(merged),
        patient_gender=(merged.get("PatientSex") or "").strip().upper()[:1] or None,
        modality=study_modality([s.get("MainDicomTags", {}).get("Modality", "") for s in series]),
        body_part=body_part(merged),
        study_description=merged.get("StudyDescription") or "",
        study_date=iso_date(merged.get("StudyDate")),
        size_bytes=size,
        images=images,
        series_count=len(series),
    )
    phone = patient_phone(merged)
    referred = format_person_name(merged.get("ReferringPhysicianName"))

    existing = repo.study_by_uid(uid) or repo.study_by_orthanc(orthanc_id)
    assignee = suggest_radiologist(fields["modality"], f'{fields["body_part"]} {fields["study_description"]}')
    if existing is None:
        with repo.tx():
            sid, seq = repo.next_study_id()
            ts = iso()
            repo.conn.execute(
                """INSERT INTO studies(id, seq, study_uid, orthanc_id, patient_name, patient_id, patient_age,
                   patient_gender, patient_phone, modality, body_part, study_description, study_date, referred_by,
                   status, created_at, updated_at, received_aet, received_ip, size_bytes, images, series_count, assigned_to)
                   VALUES(:id, :seq, :uid, :oid, :patient_name, :patient_id, :patient_age, :patient_gender, :phone,
                   :modality, :body_part, :study_description, :study_date, :referred, 'uploaded', :ts, :ts,
                   :aet, :ip, :size_bytes, :images, :series_count, :assignee)""",
                {**fields, "id": sid, "seq": seq, "uid": uid, "oid": orthanc_id, "phone": phone,
                 "referred": referred, "ts": ts, "aet": aet, "ip": ip, "assignee": assignee},
            )
        source = f"{aet or 'unknown AE'} ({ip or 'unknown IP'})"
        repo.add_event(sid, "PACS", f"Received from {source} — {images} images", "receive")
        repo.add_event(sid, "System", f"Queued for {RADIOLOGIST_NAMES[assignee]} (staff can reassign)", "assign")
        log.info("registered %s (%s) from %s: %d images", sid, uid, source, images)
    else:
        sid = existing["id"]
        update = dict(fields)
        if existing["orthanc_id"] != orthanc_id:
            update["orthanc_id"] = orthanc_id
        if phone and not existing["patient_phone"]:
            update["patient_phone"] = phone
        if referred and not existing["referred_by"]:
            update["referred_by"] = referred
        if aet and not existing["received_aet"]:
            update.update(received_aet=aet, received_ip=ip)
        repo.update_study(sid, **update)
        if images != existing["images"]:
            repo.add_event(sid, "PACS", f"Study updated from {aet or 'PACS'} — now {images} images", "receive")
    if aet:
        repo.touch_scanner(aet, ip, new_study=existing is None)
    return sid


class Ingestor:
    def __init__(self, repo: Repo, orthanc: Orthanc, interval: float = 3.0) -> None:
        self.repo, self.orthanc, self.interval = repo, orthanc, interval
        self._checked_reset = False
        self.last_error: str | None = None

    async def poll_once(self) -> int:
        """Process every pending change. Returns the number of studies (re)registered."""
        since = int(self.repo.get_meta(LAST_SEQ_KEY, "0") or 0)
        if not self._checked_reset and since > 0:
            last = (await self.orthanc.get("/changes", last="")).get("Last", 0)
            if last < since:  # Orthanc storage was reset: start over
                log.warning("Orthanc change feed went backwards (%s < %s); rescanning", last, since)
                since = 0
                self.repo.set_meta(LAST_SEQ_KEY, "0")
        self._checked_reset = True
        registered = 0
        while True:
            data = await self.orthanc.changes(since)
            for ch in data.get("Changes", []):
                if ch.get("ChangeType") == "StableStudy":
                    try:
                        await register_study(self.repo, self.orthanc, ch["ID"])
                        registered += 1
                    except OrthancError as exc:
                        if exc.status != 404:  # 404: deleted meanwhile -> skip; anything else: retry later
                            raise
                since = int(ch.get("Seq", since))
                self.repo.set_meta(LAST_SEQ_KEY, str(since))
            since = max(since, int(data.get("Last", since)))
            self.repo.set_meta(LAST_SEQ_KEY, str(since))
            if data.get("Done", True) or not data.get("Changes"):
                return registered

    async def run_forever(self) -> None:
        while True:
            try:
                await self.poll_once()
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # keep polling; Orthanc may be starting up
                if str(exc) != self.last_error:
                    log.warning("ingest: %s", exc)
                self.last_error = str(exc)
            await asyncio.sleep(self.interval)
