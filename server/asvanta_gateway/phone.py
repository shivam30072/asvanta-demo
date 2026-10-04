"""Mobile number normalisation to E.164 (+91 assumed when no country code)."""

from __future__ import annotations

import re

_SEPARATORS = re.compile(r"[\s\-().]")
_INDIAN_MOBILE = re.compile(r"^[6-9]\d{9}$")


class InvalidPhone(ValueError):
    pass


def normalise_mobile(raw: str, default_cc: str = "91") -> str:
    if not isinstance(raw, str):
        raise InvalidPhone("mobile must be a string")
    s = _SEPARATORS.sub("", raw.strip())
    if s.startswith("00"):
        s = "+" + s[2:]
    if s.startswith("+"):
        digits = s[1:]
        if not digits.isdigit() or not 8 <= len(digits) <= 15 or digits.startswith("0"):
            raise InvalidPhone(f"not a valid international number: {raw!r}")
        if digits.startswith("91") and not _INDIAN_MOBILE.match(digits[2:]):
            raise InvalidPhone(f"not a valid Indian mobile number: {raw!r}")
        return "+" + digits
    if not s.isdigit():
        raise InvalidPhone(f"not a phone number: {raw!r}")
    if len(s) == 11 and s.startswith("0"):  # trunk prefix: 09876543210
        s = s[1:]
    elif len(s) == 12 and s.startswith(default_cc):  # 919876543210
        s = s[2:]
    if not _INDIAN_MOBILE.match(s):
        raise InvalidPhone(f"expected a 10-digit Indian mobile number (starting 6-9) or +<country code>: {raw!r}")
    return f"+{default_cc}{s}"


def mask(e164: str) -> str:
    """+919876543210 -> +91 ******3210"""
    if e164.startswith("+91") and len(e164) == 13:
        return "+91 ******" + e164[-4:]
    return e164[:3] + "*" * max(0, len(e164) - 7) + e164[-4:]
