"""Gateway settings, read from the environment (see pacs/.env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _list(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return list(default)
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass
class Settings:
    db_path: str = "gateway.db"
    demo_password: str = "asvanta"
    session_hours: float = 12.0

    orthanc_url: str = "http://localhost:8042"
    orthanc_user: str = "gateway"
    orthanc_password: str = "gateway"
    orthanc_timeout: float = 60.0

    # What scanners are told to send to (shown by GET /api/pacs).
    pacs_aet: str = "ASVANTA"
    pacs_host: str = ""
    pacs_port: int = 4242

    ingest_enabled: bool = True
    ingest_interval: float = 3.0

    centre_name: str = "Asvanta Diagnostics"
    public_base_url: str = "http://localhost:5173"

    sms_provider: str = "console"  # console | msg91 | twilio
    msg91_auth_key: str = ""
    msg91_template_id: str = ""
    msg91_sender: str = ""
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from: str = ""

    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173", "http://localhost:5179"])

    # share policy
    share_default_hours: int = 72
    share_max_otp_attempts: int = 5
    share_resend_limit: int = 3
    share_resend_window_s: int = 600
    share_access_minutes: int = 30

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ.get
        d = cls()
        return cls(
            db_path=e("DB_PATH", d.db_path),
            demo_password=e("DEMO_PASSWORD", d.demo_password),
            session_hours=float(e("SESSION_HOURS", d.session_hours)),
            orthanc_url=e("ORTHANC_URL", d.orthanc_url).rstrip("/"),
            orthanc_user=e("ORTHANC_USER", d.orthanc_user),
            orthanc_password=e("ORTHANC_PASSWORD", d.orthanc_password),
            orthanc_timeout=float(e("ORTHANC_TIMEOUT", d.orthanc_timeout)),
            pacs_aet=e("ORTHANC_AET", d.pacs_aet),
            pacs_host=e("PACS_PUBLIC_HOST", d.pacs_host),
            pacs_port=int(e("ORTHANC_DICOM_PORT", d.pacs_port)),
            ingest_enabled=_bool(e("INGEST_ENABLED"), d.ingest_enabled),
            ingest_interval=float(e("INGEST_INTERVAL", d.ingest_interval)),
            centre_name=e("CENTRE_NAME", d.centre_name),
            public_base_url=e("PUBLIC_BASE_URL", d.public_base_url).rstrip("/"),
            sms_provider=e("SMS_PROVIDER", d.sms_provider).strip().lower(),
            msg91_auth_key=e("MSG91_AUTH_KEY", ""),
            msg91_template_id=e("MSG91_TEMPLATE_ID", ""),
            msg91_sender=e("MSG91_SENDER", ""),
            twilio_account_sid=e("TWILIO_ACCOUNT_SID", ""),
            twilio_auth_token=e("TWILIO_AUTH_TOKEN", ""),
            twilio_from=e("TWILIO_FROM", ""),
            cors_origins=_list(e("CORS_ORIGINS"), d.cors_origins),
        )
