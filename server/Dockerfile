# Build context is the repository root (see pacs/docker-compose.yml) so the
# CAC engine in ../engine can be installed alongside the gateway.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY engine/pyproject.toml engine/README.md /app/engine/
COPY engine/asvanta_cac /app/engine/asvanta_cac
COPY server/pyproject.toml /app/server/
COPY server/asvanta_gateway /app/server/asvanta_gateway

RUN pip install /app/engine /app/server && useradd --system --uid 10001 gateway \
    && mkdir -p /data && chown gateway /data

USER gateway
ENV DB_PATH=/data/gateway.db
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "asvanta_gateway.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
