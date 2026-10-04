"""DICOMweb proxying to Orthanc and the share-scope path guard."""

from __future__ import annotations

import re

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .deps import Ctx
from .orthanc import OrthancError

UID_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")
FRAMES_RE = re.compile(r"^[0-9]+(,[0-9]+)*$")
LEAF = {"metadata", "rendered", "thumbnail"}
STAFF_ROOTS = {"studies", "series", "instances"}
STUDY_FILTER_KEYS = {"studyinstanceuid", "0020000d"}
PASS_HEADERS = ("content-type", "content-length", "content-disposition", "etag", "last-modified")


def _segments(path: str) -> list[str]:
    if "\\" in path or "\x00" in path or "%" in path:
        raise HTTPException(400, "invalid DICOMweb path")
    segs = path.split("/")
    if any(s in ("", ".", "..") for s in segs):
        raise HTTPException(400, "invalid DICOMweb path")
    return segs


def check_staff_path(path: str) -> str:
    segs = _segments(path)
    if segs[0] not in STAFF_ROOTS:
        raise HTTPException(404, "unsupported DICOMweb resource")
    return "/".join(segs)


def check_share_path(path: str, study_uid: str, series_uids: set[str]) -> str:
    """Allow only WADO-RS / QIDO-RS paths under ``studies/{study_uid}``.

    Grammar (anything else is rejected with 403):
      studies/{S}[/metadata|/rendered|/thumbnail|/series]
      studies/{S}/series/{SE}[/metadata|/rendered|/thumbnail|/instances]
      studies/{S}/series/{SE}/instances/{I}[/metadata|/rendered|/thumbnail|/frames/{n}[/rendered|/thumbnail]]
    where SE must be a series of the shared study.
    """
    segs = _segments(path)
    deny = HTTPException(403, "outside the shared study")
    if len(segs) < 2 or segs[0] != "studies" or segs[1] != study_uid:
        raise deny
    rest = segs[2:]
    if not rest or (len(rest) == 1 and (rest[0] in LEAF or rest[0] == "series")):
        return "/".join(segs)
    if rest[0] != "series" or len(rest) < 2 or rest[1] not in series_uids:
        raise deny
    rest = rest[2:]
    if not rest or (len(rest) == 1 and (rest[0] in LEAF or rest[0] == "instances")):
        return "/".join(segs)
    if rest[0] != "instances" or len(rest) < 2 or not UID_RE.match(rest[1]) or len(rest[1]) > 64:
        raise deny
    rest = rest[2:]
    if not rest or (len(rest) == 1 and rest[0] in LEAF):
        return "/".join(segs)
    if rest[0] == "frames" and len(rest) >= 2 and FRAMES_RE.match(rest[1]):
        if len(rest) == 2 or (len(rest) == 3 and rest[2] in ("rendered", "thumbnail")):
            return "/".join(segs)
    raise deny


def scoped_query(request: Request) -> list[tuple[str, str]]:
    """Query string minus any attempt to filter on another study UID."""
    return [(k, v) for k, v in request.query_params.multi_items() if k.lower() not in STUDY_FILTER_KEYS]


async def proxy(c: Ctx, path: str, request: Request, params: list[tuple[str, str]] | None = None) -> StreamingResponse:
    """Stream Orthanc's ``/dicom-web/{path}`` back unchanged (status, content-type, body)."""
    if params is None:
        params = list(request.query_params.multi_items())
    try:
        upstream = await c.orthanc.open_stream(f"/dicom-web/{path}", params, request.headers.get("accept"))
    except OrthancError as exc:
        raise HTTPException(502, str(exc)) from exc
    headers = {h: upstream.headers[h] for h in PASS_HEADERS if h in upstream.headers}
    headers["cache-control"] = "private, max-age=300"
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=headers,
        background=BackgroundTask(upstream.aclose),
    )


async def study_series(c: Ctx, study_row) -> list[dict]:
    """Series of a study (from Orthanc), sorted by SeriesNumber, in the contract's shape."""
    oid, images = study_row["orthanc_id"], study_row["images"]
    cached = c.series_cache.get(oid)
    if cached and cached[0] == images:
        return cached[1]
    try:
        raw = await c.orthanc.study_series(oid)
    except OrthancError as exc:
        raise HTTPException(502 if exc.status != 404 else 404, str(exc)) from exc
    out = []
    for s in raw:
        tags = s.get("MainDicomTags", {})
        thickness = None
        if s.get("Instances"):
            try:
                value = await c.orthanc.get(f"/instances/{s['Instances'][0]}/content/0018,0050")
                thickness = float(str(value).strip().strip("\x00")) if value not in (None, "") else None
            except (OrthancError, ValueError):
                thickness = None
        try:
            number = int(tags.get("SeriesNumber") or 0)
        except ValueError:
            number = 0
        out.append({
            "seriesInstanceUID": tags.get("SeriesInstanceUID"),
            "number": number,
            "description": tags.get("SeriesDescription") or "",
            "modality": tags.get("Modality") or "",
            "count": len(s.get("Instances", [])),
            "thickness": thickness,
            "orthancId": s.get("ID"),
        })
    out.sort(key=lambda x: (x["number"], x["description"]))
    c.series_cache[oid] = (images, out)
    return out


def public_series(series: list[dict]) -> list[dict]:
    return [{k: v for k, v in s.items() if k != "orthancId"} for s in series]
