"""Password / OTP hashing, opaque tokens and the seeded demo users."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from .db import Repo

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1


def scrypt_hash(secret: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(secret.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def scrypt_verify(secret: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(secret.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


def token_hash(token: str) -> str:
    """Bearer / share tokens are high-entropy, so a plain SHA-256 is enough at rest."""
    return hashlib.sha256(token.encode()).hexdigest()


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def new_otp() -> str:
    return f"{secrets.randbelow(10**6):06d}"


# Mirrors src/data/seed.js (USERS + RADIOLOGISTS). `radiologistId` is the rad_* id
# that `assignedTo` uses.
DEMO_USERS = [
    dict(id="usr_staff", email="priya@asvanta.in", name="Priya Sharma", role="staff",
         title="Front Desk / Technician", initials="PS", phone="+91 98200 41122", radiologist_id=None),
    dict(id="usr_rad", email="dr.mehta@asvanta.in", name="Dr. Anil Mehta", role="radiologist",
         title="Consultant Radiologist, MD", initials="AM", phone="+91 98700 55221", radiologist_id="rad_mehta"),
    dict(id="rad_reddy", email="dr.reddy@asvanta.in", name="Dr. Kavya Reddy", role="radiologist",
         title="Consultant Radiologist, MD, DNB", initials="KR", phone=None, radiologist_id="rad_reddy"),
    dict(id="rad_qureshi", email="dr.qureshi@asvanta.in", name="Dr. Farhan Qureshi", role="radiologist",
         title="Consultant Radiologist, MD, FRCR", initials="FQ", phone=None, radiologist_id="rad_qureshi"),
    dict(id="rad_kulkarni", email="dr.kulkarni@asvanta.in", name="Dr. Sneha Kulkarni", role="radiologist",
         title="Consultant Radiologist, MD", initials="SK", phone=None, radiologist_id="rad_kulkarni"),
]
RADIOLOGIST_IDS = ("rad_mehta", "rad_reddy", "rad_qureshi", "rad_kulkarni")


def seed_users(repo: Repo, password: str) -> None:
    """(Re)seed the demo users; the password always follows DEMO_PASSWORD."""
    for u in DEMO_USERS:
        row = repo.user(u["id"])
        if row is not None and scrypt_verify(password, row["password_hash"]):
            pw = row["password_hash"]  # unchanged: skip the expensive re-hash
        else:
            pw = scrypt_hash(password)
        repo.upsert_user({**u, "password_hash": pw})


def public_user(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "title": row["title"],
        "initials": row["initials"],
        "email": row["email"],
        "phone": row["phone"],
        "radiologistId": row["radiologist_id"],
    }
