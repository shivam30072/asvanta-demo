"""SQLite storage (stdlib ``sqlite3``) behind a small repository.

One connection, serialised with a lock: the gateway is a single process and every
statement is short. JSON columns hold the few nested structures (CAC payloads).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    title TEXT,
    initials TEXT,
    phone TEXT,
    radiologist_id TEXT,
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studies (
    id TEXT PRIMARY KEY,
    seq INTEGER UNIQUE NOT NULL,
    study_uid TEXT UNIQUE NOT NULL,
    orthanc_id TEXT UNIQUE NOT NULL,
    patient_name TEXT, patient_id TEXT, patient_age INTEGER, patient_gender TEXT,
    patient_phone TEXT, patient_email TEXT,
    modality TEXT, body_part TEXT, study_description TEXT, study_date TEXT,
    referred_by TEXT DEFAULT '', priority TEXT DEFAULT 'Routine', assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    received_aet TEXT, received_ip TEXT,
    size_bytes INTEGER DEFAULT 0, images INTEGER DEFAULT 0, series_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id),
    state TEXT NOT NULL,              -- draft | signed
    version INTEGER,
    findings TEXT NOT NULL, impression TEXT NOT NULL,
    author_id TEXT, author_name TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    signed_by TEXT, signed_at TEXT
);
CREATE INDEX IF NOT EXISTS reports_study ON reports(study_id, state);
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id),
    token_hash TEXT UNIQUE NOT NULL,
    mobile TEXT NOT NULL,
    include_report INTEGER NOT NULL,
    require_otp INTEGER NOT NULL,
    otp_hash TEXT,
    otp_attempts INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, created_by TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT, revoked_by TEXT,
    status TEXT NOT NULL,             -- sent | failed | opened
    opened_at TEXT, last_open_event_at TEXT,
    resends TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS shares_study ON shares(study_id);
CREATE TABLE IF NOT EXISTS share_sessions (
    token_hash TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id),
    at TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_study ON events(study_id, at);
CREATE TABLE IF NOT EXISTS scanners_seen (
    aet TEXT PRIMARY KEY,
    ip TEXT, last_seen TEXT NOT NULL, studies INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cac (
    study_id TEXT PRIMARY KEY REFERENCES studies(id),
    payload TEXT NOT NULL,
    approved_by TEXT, approved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cac_analyses (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id),
    series_uid TEXT NOT NULL,
    run_by TEXT, at TEXT NOT NULL,
    verdict TEXT, kind TEXT,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL, provider TEXT NOT NULL,
    to_number TEXT NOT NULL, body TEXT NOT NULL,
    share_id TEXT, otp TEXT
);
"""


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _params(args):
    return args if isinstance(args, dict) else tuple(args)


class Repo:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        if path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self.lock = threading.RLock()
        with self.lock:
            self.conn.executescript(SCHEMA)

    # ------------------------------------------------------------ primitives
    def q(self, sql: str, args: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, _params(args)).fetchall()

    def one(self, sql: str, args: Iterable[Any] = ()) -> sqlite3.Row | None:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: Iterable[Any] = ()) -> int:
        with self.lock:
            return self.conn.execute(sql, _params(args)).rowcount

    def tx(self):
        """``with repo.tx():`` runs the block as one transaction."""
        repo = self

        class _Tx:
            def __enter__(self):
                repo.lock.acquire()
                repo.conn.execute("BEGIN IMMEDIATE")

            def __exit__(self, exc_type, *_):
                try:
                    repo.conn.execute("ROLLBACK" if exc_type else "COMMIT")
                finally:
                    repo.lock.release()

        return _Tx()

    def close(self) -> None:
        with self.lock:
            self.conn.close()

    # ------------------------------------------------------------ meta
    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.one("SELECT value FROM meta WHERE key = ?", (key,))
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.x("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    # ------------------------------------------------------------ users / sessions
    def upsert_user(self, u: dict[str, Any]) -> None:
        self.x(
            """INSERT INTO users(id, email, name, role, title, initials, phone, radiologist_id, password_hash)
               VALUES(:id, :email, :name, :role, :title, :initials, :phone, :radiologist_id, :password_hash)
               ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role,
                 title=excluded.title, initials=excluded.initials, phone=excluded.phone,
                 radiologist_id=excluded.radiologist_id, password_hash=excluded.password_hash""",
            u,
        )

    def user_by_email(self, email: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE lower(email) = lower(?)", (email.strip(),))

    def user(self, user_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE id = ?", (user_id,))

    def add_session(self, token_hash: str, user_id: str, hours: float) -> str:
        expires = iso(now() + timedelta(hours=hours))
        self.x("INSERT INTO sessions VALUES(?, ?, ?, ?)", (token_hash, user_id, iso(), expires))
        return expires

    def session_user(self, token_hash: str) -> sqlite3.Row | None:
        row = self.one(
            "SELECT u.* , s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
            (token_hash,),
        )
        if row is None or parse_iso(row["session_expires"]) <= now():
            return None
        return row

    # ------------------------------------------------------------ studies
    def next_study_id(self) -> tuple[str, int]:
        row = self.one("SELECT MAX(seq) AS m FROM studies")
        seq = (row["m"] or 30000) + 1
        return f"STD-{seq}", seq

    def study(self, study_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM studies WHERE id = ?", (study_id,))

    def study_by_uid(self, uid: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM studies WHERE study_uid = ?", (uid,))

    def study_by_orthanc(self, orthanc_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM studies WHERE orthanc_id = ?", (orthanc_id,))

    def studies(self) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM studies ORDER BY created_at DESC, seq DESC")

    def update_study(self, study_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields["updated_at"] = iso()
        cols = ", ".join(f"{k} = :{k}" for k in fields)
        self.x(f"UPDATE studies SET {cols} WHERE id = :_id", {**fields, "_id": study_id})

    # ------------------------------------------------------------ events
    def add_event(self, study_id: str, actor: str, text: str, kind: str, at: str | None = None) -> dict:
        ev = {"id": new_id("ev"), "study_id": study_id, "at": at or iso(), "actor": actor, "text": text, "kind": kind}
        self.x("INSERT INTO events VALUES(:id, :study_id, :at, :actor, :text, :kind)", ev)
        return ev

    def events(self, study_id: str) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM events WHERE study_id = ? ORDER BY at, rowid", (study_id,))

    # ------------------------------------------------------------ reports
    def draft(self, study_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM reports WHERE study_id = ? AND state = 'draft'", (study_id,))

    def signed_report(self, study_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM reports WHERE study_id = ? AND state = 'signed' ORDER BY version DESC LIMIT 1", (study_id,))

    def signed_versions(self, study_id: str) -> int:
        row = self.one("SELECT COUNT(*) AS n FROM reports WHERE study_id = ? AND state = 'signed'", (study_id,))
        return int(row["n"])

    # ------------------------------------------------------------ shares
    def shares_for(self, study_id: str) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM shares WHERE study_id = ? ORDER BY created_at DESC, rowid DESC", (study_id,))

    def share(self, share_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM shares WHERE id = ?", (share_id,))

    def share_by_token_hash(self, token_hash: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM shares WHERE token_hash = ?", (token_hash,))

    def update_share(self, share_id: str, **fields: Any) -> None:
        cols = ", ".join(f"{k} = :{k}" for k in fields)
        self.x(f"UPDATE shares SET {cols} WHERE id = :_id", {**fields, "_id": share_id})

    # ------------------------------------------------------------ scanners seen
    def touch_scanner(self, aet: str, ip: str | None, new_study: bool) -> None:
        self.x(
            """INSERT INTO scanners_seen(aet, ip, last_seen, studies) VALUES(?, ?, ?, ?)
               ON CONFLICT(aet) DO UPDATE SET ip = COALESCE(excluded.ip, ip), last_seen = excluded.last_seen,
               studies = studies + excluded.studies""",
            (aet, ip, iso(), 1 if new_study else 0),
        )

    def scanners_seen(self) -> dict[str, sqlite3.Row]:
        return {r["aet"]: r for r in self.q("SELECT * FROM scanners_seen")}

    # ------------------------------------------------------------ CAC
    def set_cac(self, study_id: str, payload: dict, user: str) -> None:
        self.x(
            """INSERT INTO cac(study_id, payload, approved_by, approved_at) VALUES(?, ?, ?, ?)
               ON CONFLICT(study_id) DO UPDATE SET payload = excluded.payload, approved_by = excluded.approved_by,
               approved_at = excluded.approved_at""",
            (study_id, json.dumps(payload), user, iso()),
        )

    def cac(self, study_id: str) -> dict | None:
        row = self.one("SELECT payload FROM cac WHERE study_id = ?", (study_id,))
        return json.loads(row["payload"]) if row else None

    def add_cac_analysis(self, study_id: str, series_uid: str, user: str, payload: dict) -> str:
        aid = payload.get("analysisId") or new_id("cacrun")
        self.x(
            "INSERT INTO cac_analyses VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (aid, study_id, series_uid, user, iso(), payload["validation"]["verdict"], payload.get("kind"), json.dumps(payload)),
        )
        return aid

    def cac_analyses(self, study_id: str) -> list[dict]:
        return [json.loads(r["payload"]) for r in self.q("SELECT payload FROM cac_analyses WHERE study_id = ? ORDER BY at", (study_id,))]

    # ------------------------------------------------------------ outbox
    def add_outbox(self, provider: str, to: str, body: str, share_id: str | None, otp: str | None) -> dict:
        msg = {"id": new_id("sms"), "at": iso(), "provider": provider, "to_number": to, "body": body, "share_id": share_id, "otp": otp}
        self.x("INSERT INTO outbox VALUES(:id, :at, :provider, :to_number, :body, :share_id, :otp)", msg)
        return msg

    def outbox(self) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM outbox ORDER BY at DESC, rowid DESC")
