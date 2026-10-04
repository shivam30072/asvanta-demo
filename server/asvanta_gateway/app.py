"""FastAPI application factory. ``uvicorn asvanta_gateway.app:app``."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import routes_core, routes_share
from .config import Settings
from .db import Repo
from .deps import Ctx
from .ingest import Ingestor
from .orthanc import Orthanc
from .security import seed_users
from .sms import SmsProvider, make_provider

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(settings: Settings | None = None, sms: SmsProvider | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    repo = Repo(settings.db_path)
    seed_users(repo, settings.demo_password)
    orthanc = Orthanc(settings.orthanc_url, settings.orthanc_user, settings.orthanc_password, settings.orthanc_timeout)
    c = Ctx(settings=settings, repo=repo, orthanc=orthanc, sms=sms or make_provider(settings, repo))
    c.ingestor = Ingestor(repo, orthanc, settings.ingest_interval)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(c.ingestor.run_forever()) if settings.ingest_enabled else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await orthanc.aclose()

    app = FastAPI(title="Asvanta PACS gateway", version="0.1.0", lifespan=lifespan)
    app.state.ctx = c
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
        expose_headers=["Content-Type", "Content-Length", "Retry-After"],
        max_age=600,
    )
    app.include_router(routes_core.router)
    app.include_router(routes_share.router)
    return app


def __getattr__(name: str):
    # Lazily build the module-level app so importing the package (tests) has no side effects.
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
