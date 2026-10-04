"""Scan suitability checks for Agatston scoring.

Every check has a ``severity`` that decides how a non-pass result affects the verdict:

* ``blocking``    fail -> "unsuitable"; never overridable (not CT, no HU calibration, bad geometry)
* ``overridable`` fail -> "unsuitable" for standard Agatston, but the caller may explicitly
                  request an opportunistic run (contrast-enhanced scans)
* ``standard``    warn/fail -> "opportunistic": scoring possible, result must be labelled a
                  non-standard estimate (non-gated, non-3 mm, non-120 kVp, short coverage, ...)
* ``info``        reported only; does not change the verdict
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal

import numpy as np

from .dicom_io import Series

Status = Literal["pass", "warn", "fail"]
Severity = Literal["blocking", "overridable", "standard", "info"]
Verdict = Literal["ready", "opportunistic", "unsuitable"]

SLICE_THICKNESS_MIN_MM = 2.5
SLICE_THICKNESS_MAX_MM = 3.0
INCREMENT_THICKNESS_TOL = 0.10  # increment within +-10 % of thickness = contiguous
MAX_PIXEL_SPACING_MM = 1.0
AXIAL_TOLERANCE_DEG = 10.0
STANDARD_KVP = 120.0
MIN_Z_COVERAGE_MM = 100.0
NOISE_ROI_HU_RANGE = (-100.0, 200.0)
NOISE_ROI_MIN_VOXELS = 200
MAX_NOISE_SD_HU = 30.0
GATING_DESCRIPTION_HINTS = ("ecg", "gated", "casc", "calcium", "cardiac", "cac", "heart")


@dataclass(frozen=True)
class Check:
    id: str
    label: str
    status: Status
    detail: str
    severity: Severity


@dataclass(frozen=True)
class ValidationReport:
    checks: tuple[Check, ...]
    verdict: Verdict
    overridable: bool  # True if "unsuitable" only because of overridable checks
    reasons: tuple[str, ...] = field(default=())

    def to_dict(self) -> dict:
        return asdict(self)


def _num(value: object) -> float | None:
    try:
        return float(value[0] if isinstance(value, list) else value)  # type: ignore[index,arg-type]
    except (TypeError, ValueError, IndexError):
        return None


def _check_modality(meta: dict) -> Check:
    modality = meta.get("Modality")
    ok = modality == "CT"
    return Check("modality", "Modality is CT", "pass" if ok else "fail", f"Modality = {modality!r}", "blocking")


def _check_rescale(meta: dict) -> Check:
    rescale = meta.get("rescale", {})
    if rescale.get("defaults_applied", True):
        return Check(
            "hu_calibration", "HU calibration (rescale) present", "fail",
            "RescaleSlope/RescaleIntercept missing; pixel values cannot be trusted as HU", "blocking",
        )
    return Check(
        "hu_calibration", "HU calibration (rescale) present", "pass",
        f"slope {rescale.get('slope')}, intercept {rescale.get('intercept')}", "blocking",
    )


def _check_contrast(meta: dict) -> Check:
    agent = meta.get("ContrastBolusAgent")
    if agent:
        return Check(
            "contrast", "Non-contrast acquisition", "fail",
            f"ContrastBolusAgent = {agent!r}: iodine invalidates the 130 HU threshold; "
            "standard Agatston must not be reported", "overridable",
        )
    return Check(
        "contrast", "Non-contrast acquisition", "pass",
        "no ContrastBolusAgent recorded (header-based; verify visually)", "overridable",
    )


def _check_gating(meta: dict) -> Check:
    gating = meta.get("ecg_gating", {})
    label = "ECG-gated acquisition"
    if gating.get("evidence"):
        present = [k.removesuffix("_present") for k, v in gating.items() if k.endswith("_present") and v]
        return Check("ecg_gating", label, "pass", f"gating tags present: {', '.join(present)}", "standard")
    text = " ".join(str(meta.get(k) or "") for k in ("SeriesDescription", "ProtocolName")).lower()
    if any(h in text for h in GATING_DESCRIPTION_HINTS):
        return Check(
            "ecg_gating", label, "warn",
            "no DICOM gating tags; series description suggests a cardiac protocol - confirm gating", "standard",
        )
    return Check("ecg_gating", label, "fail", "no evidence of ECG gating (non-gated scan?)", "standard")


def _check_thickness(meta: dict) -> Check:
    thickness = _num(meta.get("SliceThickness"))
    label = f"Slice thickness {SLICE_THICKNESS_MIN_MM}-{SLICE_THICKNESS_MAX_MM} mm"
    if thickness is None:
        return Check("slice_thickness", label, "warn", "SliceThickness missing", "standard")
    ok = SLICE_THICKNESS_MIN_MM <= thickness <= SLICE_THICKNESS_MAX_MM
    return Check(
        "slice_thickness", label, "pass" if ok else "warn",
        f"{thickness:g} mm" + ("" if ok else " (Agatston is defined on 3 mm slices)"), "standard",
    )


def _check_geometry(series: Series) -> Check:
    geo = series.geometry
    label = "Consistent slice geometry"
    problems = []
    if not geo.get("orientation_present"):
        problems.append("ImageOrientationPatient missing")
    elif not geo.get("consistent_orientation"):
        problems.append("orientation differs between slices")
    if not geo.get("positions_present"):
        problems.append("ImagePositionPatient missing")
    if geo.get("duplicate_positions"):
        problems.append(f"{geo['duplicate_positions']} duplicate slice position(s)")
    if not geo.get("uniform_spacing", False):
        problems.append(f"non-uniform slice spacing (max deviation {geo.get('max_increment_deviation', 0):.1%})")
    if not geo.get("slice_increment_mm"):
        problems.append("slice increment unknown")
    sx, sy, _ = series.spacing
    if not (math.isfinite(sx) and math.isfinite(sy)):
        problems.append("PixelSpacing missing")
    if problems:
        return Check("geometry", label, "fail", "; ".join(problems), "blocking")
    return Check(
        "geometry", label, "pass",
        f"{geo['num_slices']} slices, uniform increment {geo['slice_increment_mm']:g} mm", "blocking",
    )


def _check_increment(series: Series) -> Check:
    label = "Contiguous slices (increment = thickness)"
    thickness = _num(series.metadata.get("SliceThickness"))
    increment = series.geometry.get("slice_increment_mm") or 0.0
    if thickness is None or not increment:
        return Check("slice_increment", label, "warn", "cannot compare increment with thickness", "standard")
    ratio = increment / thickness
    if ratio < 1 - INCREMENT_THICKNESS_TOL:
        return Check("slice_increment", label, "warn", f"overlapping: {increment:g} mm increment < {thickness:g} mm thickness", "standard")
    if ratio > 1 + INCREMENT_THICKNESS_TOL:
        return Check("slice_increment", label, "warn", f"gapped: {increment:g} mm increment > {thickness:g} mm thickness", "standard")
    return Check("slice_increment", label, "pass", f"{increment:g} mm increment, {thickness:g} mm thickness", "standard")


def _check_pixel_spacing(series: Series) -> Check:
    sx, sy, _ = series.spacing
    label = f"In-plane pixel spacing <= {MAX_PIXEL_SPACING_MM:g} mm"
    if not (math.isfinite(sx) and math.isfinite(sy)):
        return Check("pixel_spacing", label, "fail", "PixelSpacing missing", "standard")
    ok = max(sx, sy) <= MAX_PIXEL_SPACING_MM
    return Check("pixel_spacing", label, "pass" if ok else "warn", f"{sx:g} x {sy:g} mm", "standard")


def _check_axial(series: Series) -> Check:
    label = "Axial orientation"
    normal = series.geometry.get("slice_normal")
    if normal is None:
        return Check("axial", label, "fail", "orientation unknown", "blocking")
    angle = math.degrees(math.acos(min(1.0, abs(float(normal[2])))))
    ok = angle <= AXIAL_TOLERANCE_DEG
    return Check("axial", label, "pass" if ok else "fail", f"slice normal {angle:.1f} deg from patient z-axis", "blocking")


def _check_kvp(meta: dict) -> Check:
    kvp = _num(meta.get("KVP"))
    label = f"Tube voltage {STANDARD_KVP:g} kVp"
    if kvp is None:
        return Check("kvp", label, "warn", "KVP missing", "standard")
    ok = abs(kvp - STANDARD_KVP) < 0.5
    detail = f"{kvp:g} kVp" + ("" if ok else " (Agatston is defined at 120 kVp; scores are not directly comparable)")
    return Check("kvp", label, "pass" if ok else "warn", detail, "standard")


def _check_coverage(series: Series) -> Check:
    coverage = float(series.geometry.get("z_coverage_mm") or 0.0)
    label = f"z-coverage >= {MIN_Z_COVERAGE_MM:g} mm"
    ok = coverage >= MIN_Z_COVERAGE_MM
    detail = f"{coverage:.1f} mm (proxy for whole-heart coverage; heart segmentation not performed)"
    return Check("z_coverage", label, "pass" if ok else "warn", detail, "standard")


def _check_noise(series: Series) -> Check:
    """Image noise proxy: HU SD of soft-tissue voxels in the central quarter of the middle slice."""
    label = f"Image noise SD <= {MAX_NOISE_SD_HU:g} HU"
    nz, ny, nx = series.hu.shape
    roi = series.hu[nz // 2, ny * 3 // 8 : ny * 5 // 8 or 1, nx * 3 // 8 : nx * 5 // 8 or 1]
    lo, hi = NOISE_ROI_HU_RANGE
    tissue = roi[(roi >= lo) & (roi <= hi)]
    if tissue.size < NOISE_ROI_MIN_VOXELS:
        return Check("noise", label, "warn", "not assessable (too few soft-tissue voxels in ROI)", "info")
    sd = float(np.std(tissue))
    return Check("noise", label, "pass" if sd <= MAX_NOISE_SD_HU else "warn", f"SD {sd:.1f} HU in central soft tissue", "info")


def validate(series: Series) -> ValidationReport:
    """Run all suitability checks and derive the verdict (see module docstring)."""
    meta = series.metadata
    checks = (
        _check_modality(meta),
        _check_rescale(meta),
        _check_geometry(series),
        _check_axial(series),
        _check_contrast(meta),
        _check_gating(meta),
        _check_thickness(meta),
        _check_increment(series),
        _check_pixel_spacing(series),
        _check_kvp(meta),
        _check_coverage(series),
        _check_noise(series),
    )
    blocking = [c for c in checks if c.severity == "blocking" and c.status == "fail"]
    overridable = [c for c in checks if c.severity == "overridable" and c.status == "fail"]
    standard = [c for c in checks if c.severity == "standard" and c.status != "pass"]
    if blocking or overridable:
        verdict: Verdict = "unsuitable"
        reasons = blocking + overridable
    elif standard:
        verdict, reasons = "opportunistic", standard
    else:
        verdict, reasons = "ready", []
    return ValidationReport(
        checks=checks,
        verdict=verdict,
        overridable=bool(overridable) and not blocking,
        reasons=tuple(f"{c.label}: {c.detail}" for c in reasons),
    )
