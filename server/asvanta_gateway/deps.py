"""Shared application context and FastAPI dependencies (auth, roles)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, Header, HTTPException, Request

from .config import Settings
from .db import Repo
from .orthanc import Orthanc
from .security import token_hash
from .sms import SmsProvider


@dataclass
class Ctx:
    settings: Settings
    repo: Repo
    orthanc: Orthanc
    sms: SmsProvider
    ingestor: Any = None
    # orthanc study id -> (images, series list); refreshed when the image count changes
    series_cache: dict[str, tuple[int, list[dict]]] = field(default_factory=dict)


def ctx(request: Request) -> Ctx:
    return request.app.state.ctx


def bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def current_user(c: Ctx = Depends(ctx), authorization: str | None = Header(None)):
    token = bearer(authorization)
    if not token:
        raise HTTPException(401, "missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    user = c.repo.session_user(token_hash(token))
    if user is None:
        raise HTTPException(401, "invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    return user


def require(*roles: str):
    def dep(user=Depends(current_user)):
        if user["role"] not in roles:
            raise HTTPException(403, f"requires role: {' or '.join(roles)}")
        return user

    return dep


any_user = require("staff", "radiologist")
staff_only = require("staff")
radiologist_only = require("radiologist")
