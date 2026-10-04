"""Thin async client for Orthanc's REST API and DICOMweb plugin."""

from __future__ import annotations

from typing import Any

import httpx


class OrthancError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class Orthanc:
    def __init__(self, base_url: str, user: str, password: str, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            auth=httpx.BasicAuth(user, password) if user else None,
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers={"Accept-Encoding": "identity"},
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _json(self, method: str, path: str, **kw: Any) -> Any:
        try:
            resp = await self.client.request(method, path, **kw)
        except httpx.HTTPError as exc:
            raise OrthancError(f"Orthanc unreachable: {exc}") from exc
        if resp.status_code >= 400:
            raise OrthancError(f"Orthanc {method} {path} -> {resp.status_code}: {resp.text[:300]}", resp.status_code)
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    async def get(self, path: str, **params: Any) -> Any:
        return await self._json("GET", path, params=params or None)

    async def post(self, path: str, body: Any = None, **kw: Any) -> Any:
        if isinstance(body, (dict, list)):
            return await self._json("POST", path, json=body, **kw)
        return await self._json("POST", path, content=body if body is not None else b"", **kw)

    async def put(self, path: str, body: Any) -> Any:
        return await self._json("PUT", path, json=body)

    async def delete(self, path: str) -> Any:
        return await self._json("DELETE", path)

    # ------------------------------------------------------------------ helpers
    async def system(self) -> dict:
        return await self.get("/system")

    async def changes(self, since: int, limit: int = 100) -> dict:
        return await self.get("/changes", since=since, limit=limit)

    async def study(self, orthanc_id: str) -> dict:
        return await self.get(f"/studies/{orthanc_id}")

    async def study_series(self, orthanc_id: str) -> list[dict]:
        return await self.get(f"/studies/{orthanc_id}/series")

    async def study_statistics(self, orthanc_id: str) -> dict:
        return await self.get(f"/studies/{orthanc_id}/statistics")

    async def instance_tags(self, instance_id: str) -> dict:
        return await self.get(f"/instances/{instance_id}/simplified-tags")

    async def instance_metadata(self, instance_id: str) -> dict:
        return await self.get(f"/instances/{instance_id}/metadata", expand="")

    async def modalities(self) -> dict:
        return await self.get("/modalities", expand="")

    async def put_modality(self, name: str, aet: str, host: str, port: int) -> Any:
        return await self.put(f"/modalities/{name}", {"AET": aet, "Host": host, "Port": port})

    async def delete_modality(self, name: str) -> Any:
        return await self.delete(f"/modalities/{name}")

    async def echo(self, name: str, timeout: int = 5) -> Any:
        return await self.post(f"/modalities/{name}/echo", {"Timeout": timeout})

    async def download(self, path: str, dest) -> int:
        """Stream a binary resource (e.g. ``/series/{id}/archive``) to a file-like object."""
        return await self.download_with_accept(path, dest, None)

    async def download_with_accept(self, path: str, dest, accept: str | None) -> int:
        total = 0
        headers = {"Accept": accept} if accept else None
        try:
            async with self.client.stream("GET", path, headers=headers) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    raise OrthancError(f"Orthanc GET {path} -> {resp.status_code}: {resp.text[:300]}", resp.status_code)
                async for chunk in resp.aiter_bytes():
                    dest.write(chunk)
                    total += len(chunk)
        except httpx.HTTPError as exc:
            raise OrthancError(f"Orthanc unreachable: {exc}") from exc
        return total

    async def open_stream(self, path: str, params: list[tuple[str, str]], accept: str | None) -> httpx.Response:
        """Open a streamed GET; the caller must ``aclose()`` the response."""
        headers = {"Accept": accept} if accept else {}
        req = self.client.build_request("GET", path, params=params, headers=headers)
        try:
            return await self.client.send(req, stream=True)
        except httpx.HTTPError as exc:
            raise OrthancError(f"Orthanc unreachable: {exc}") from exc
