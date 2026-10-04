"""SMS providers. Only the console provider is used in development/tests.

MSG91 and Twilio are implemented against their public HTTP APIs with httpx (no
SDKs). For Indian traffic MSG91 must use a DLT-registered template whose
variables are the ``vars`` passed to :meth:`SmsProvider.send`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Settings
from .db import Repo


@dataclass
class SmsResult:
    ok: bool
    provider: str
    message_id: str | None = None
    detail: str = ""


@dataclass
class SmsMessage:
    to: str  # E.164
    body: str
    vars: dict[str, str] = field(default_factory=dict)
    share_id: str | None = None
    otp: str | None = None  # only the console provider keeps it (dev outbox)


class SmsProvider:
    name = "base"

    async def send(self, msg: SmsMessage) -> SmsResult:  # pragma: no cover - interface
        raise NotImplementedError


class ConsoleSmsProvider(SmsProvider):
    """Writes messages to the outbox table and the log; nothing leaves the machine."""

    name = "console"

    def __init__(self, repo: Repo) -> None:
        self.repo = repo

    async def send(self, msg: SmsMessage) -> SmsResult:
        row = self.repo.add_outbox(self.name, msg.to, msg.body, msg.share_id, msg.otp)
        print(f"[sms:console] to {msg.to}: {msg.body}", flush=True)
        return SmsResult(True, self.name, row["id"], "stored in dev outbox")


class Msg91Provider(SmsProvider):
    """MSG91 Flow API (v5): POST /api/v5/flow with a DLT template id."""

    name = "msg91"
    URL = "https://control.msg91.com/api/v5/flow"

    def __init__(self, auth_key: str, template_id: str, sender: str = "", client: httpx.AsyncClient | None = None) -> None:
        if not auth_key or not template_id:
            raise ValueError("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required for SMS_PROVIDER=msg91")
        self.auth_key, self.template_id, self.sender = auth_key, template_id, sender
        self.client = client

    def build_request(self, msg: SmsMessage) -> httpx.Request:
        recipient: dict[str, Any] = {"mobiles": msg.to.lstrip("+"), **msg.vars}
        body: dict[str, Any] = {"template_id": self.template_id, "short_url": "0", "recipients": [recipient]}
        if self.sender:
            body["sender"] = self.sender
        return httpx.Request(
            "POST", self.URL, json=body,
            headers={"authkey": self.auth_key, "accept": "application/json", "content-type": "application/json"},
        )

    async def send(self, msg: SmsMessage) -> SmsResult:
        client = self.client or httpx.AsyncClient(timeout=15)
        try:
            resp = await client.send(self.build_request(msg))
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            ok = resp.status_code < 300 and data.get("type") != "error"
            return SmsResult(ok, self.name, data.get("message") if ok else None, resp.text[:300])
        except httpx.HTTPError as exc:
            return SmsResult(False, self.name, None, str(exc))
        finally:
            if self.client is None:
                await client.aclose()


class TwilioProvider(SmsProvider):
    """Twilio Programmable Messaging: POST /2010-04-01/Accounts/{sid}/Messages.json."""

    name = "twilio"

    def __init__(self, account_sid: str, auth_token: str, sender: str, client: httpx.AsyncClient | None = None) -> None:
        if not (account_sid and auth_token and sender):
            raise ValueError("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required for SMS_PROVIDER=twilio")
        self.sid, self.token, self.sender = account_sid, auth_token, sender
        self.client = client

    def build_request(self, msg: SmsMessage) -> httpx.Request:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.sid}/Messages.json"
        req = httpx.Request("POST", url, data={"To": msg.to, "From": self.sender, "Body": msg.body})
        auth = httpx.BasicAuth(self.sid, self.token)
        return next(auth.auth_flow(req))

    async def send(self, msg: SmsMessage) -> SmsResult:
        client = self.client or httpx.AsyncClient(timeout=15)
        try:
            resp = await client.send(self.build_request(msg))
            data = resp.json() if "json" in resp.headers.get("content-type", "") else {}
            ok = resp.status_code < 300
            return SmsResult(ok, self.name, data.get("sid"), "" if ok else resp.text[:300])
        except httpx.HTTPError as exc:
            return SmsResult(False, self.name, None, str(exc))
        finally:
            if self.client is None:
                await client.aclose()


def make_provider(settings: Settings, repo: Repo) -> SmsProvider:
    if settings.sms_provider == "console":
        return ConsoleSmsProvider(repo)
    if settings.sms_provider == "msg91":
        return Msg91Provider(settings.msg91_auth_key, settings.msg91_template_id, settings.msg91_sender)
    if settings.sms_provider == "twilio":
        return TwilioProvider(settings.twilio_account_sid, settings.twilio_auth_token, settings.twilio_from)
    raise ValueError(f"unknown SMS_PROVIDER {settings.sms_provider!r} (console | msg91 | twilio)")


def share_message(centre: str, modality: str, body_part: str, include_report: bool, link: str, otp: str | None, hours: int) -> str:
    """<Centre>: your <modality> <bodyPart> images[ and report] are ready. View: <link> OTP <otp>. Valid <n> h."""

    def build(part: str) -> str:
        what = " ".join(p for p in (modality, part) if p)
        text = f"{centre}: your {what} images{' and report' if include_report else ''} are ready. View: {link}"
        if otp:
            text += f" OTP {otp}."
        return text + f" Valid {hours} h."

    text = build(body_part)
    if len(text) > 160 and body_part:
        text = build("")  # keep it in one SMS segment where possible
    return text
