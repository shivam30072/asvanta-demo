#!/usr/bin/env python3
"""Act as a scanner: build a CT study and C-STORE it to the PACS.

    python tools/send_test_study.py --host 127.0.0.1 --port 4242            # cardiac phantom
    python tools/send_test_study.py --kind random --calling-aet CT_ROOM2    # small generic CT
    python tools/send_test_study.py --echo-only                             # C-ECHO only

--kind cardiac renders the synthetic cardiac CT phantom from src/imaging/phantom.js
(via tools/export_phantom.mjs and Node >= 18) and writes three series (Ca score 3 mm
gated, CCTA 1 mm with contrast, thorax 5 mm non-gated) in one study.

Needs pydicom + pynetdicom + numpy (server/.venv has them).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, PYDICOM_IMPLEMENTATION_UID, generate_uid
from pynetdicom import AE
from pynetdicom.sop_class import Verification

REPO = Path(__file__).resolve().parent.parent


# ----------------------------------------------------------------- phantom export
def _node_cmd() -> list[str]:
    node = shutil.which("node")
    if node:
        try:
            major = int(subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v").split(".")[0])
            if major >= 18:
                return [node]
        except (ValueError, OSError):
            pass
    nvm = Path.home() / ".nvm" / "nvm.sh"
    if nvm.exists():
        return ["bash", "-c", f'source "{nvm}" >/dev/null && nvm use 20 >/dev/null && exec node "$@"', "node"]
    raise SystemExit("Node >= 18 is needed for --kind cardiac (or pass --phantom-dir with an existing export)")


def export_phantom(out: Path) -> dict:
    cmd = _node_cmd() + [str(REPO / "tools" / "export_phantom.mjs"), str(out)]
    subprocess.run(cmd, check=True, cwd=REPO)
    return json.loads((out / "manifest.json").read_text())


# ----------------------------------------------------------------- DICOM building
def _base(study: dict, series_uid: str, number: int, desc: str, instance: int) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    ds.StudyInstanceUID = study["uid"]
    ds.SeriesInstanceUID = series_uid
    ds.FrameOfReferenceUID = study["for_uid"]
    ds.Modality = "CT"
    ds.PatientName = study["patient_name"]
    ds.PatientID = study["patient_id"]
    ds.PatientBirthDate = study["birth_date"]
    ds.PatientSex = study["sex"]
    ds.PatientAge = study["age"]
    if study.get("phone"):
        ds.PatientTelephoneNumbers = study["phone"]
    ds.StudyDate = ds.SeriesDate = ds.ContentDate = study["date"]
    ds.StudyTime = ds.SeriesTime = ds.ContentTime = study["time"]
    ds.AccessionNumber = study["accession"]
    ds.StudyID = "1"
    ds.StudyDescription = study["description"]
    ds.ReferringPhysicianName = study["referring"]
    ds.InstitutionName = "Asvanta Diagnostics"
    ds.StationName = study["station"]
    ds.BodyPartExamined = study["body_part"]
    ds.SeriesNumber = number
    ds.SeriesDescription = desc
    ds.InstanceNumber = instance
    ds.PatientPosition = "HFS"
    return ds


def _pixels(ds: Dataset, arr: np.ndarray) -> None:
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = arr.shape
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = arr.astype("<u2").tobytes()


def cardiac_datasets(manifest_dir: Path, study: dict, only: list[str] | None) -> list[tuple[str, list[Dataset]]]:
    manifest = json.loads((manifest_dir / "manifest.json").read_text())
    out = []
    for number, s in enumerate(manifest["series"], start=1):
        if only and s["key"] not in only:
            continue
        rows, cols, n = s["rows"], s["columns"], s["slices"]
        raw = np.fromfile(manifest_dir / s["file"], dtype="<u2").reshape(n, rows, cols)
        tags = s["dicom"]
        series_uid = generate_uid()
        px = s["pixelSpacing"]
        items = []
        for k in range(n):
            z = float(s["positions"][k])
            ds = _base(study, series_uid, number, tags.get("SeriesDescription") or s["name"], k + 1)
            ds.Manufacturer = tags.get("Manufacturer") or ""
            ds.ManufacturerModelName = tags.get("ManufacturerModelName") or ""
            ds.ConvolutionKernel = tags.get("ConvolutionKernel") or ""
            ds.KVP = tags["KVP"]
            ds.SliceThickness = tags.get("SliceThickness", s["thickness"])
            ds.SpacingBetweenSlices = tags.get("SpacingBetweenSlices", s["increment"])
            ds.PixelSpacing = [float(v) for v in px]
            ds.ImageOrientationPatient = [float(v) for v in tags.get("ImageOrientationPatient", [1, 0, 0, 0, 1, 0])]
            # the phantom's z runs toward the feet; DICOM patient z runs toward the head, so negate it
            ds.ImagePositionPatient = [px[1] / 2, px[0] / 2, -z]
            ds.SliceLocation = -z
            ds.RescaleIntercept = tags["RescaleIntercept"]
            ds.RescaleSlope = tags["RescaleSlope"]
            ds.RescaleType = "HU"
            ds.WindowCenter, ds.WindowWidth = (300, 800) if s["contrast"] else (40, 400)
            if tags.get("ContrastBolusAgent"):
                ds.ContrastBolusAgent = tags["ContrastBolusAgent"]
            if tags.get("CardiacSynchronizationTechnique"):
                ds.CardiacSynchronizationTechnique = tags["CardiacSynchronizationTechnique"]
            if tags.get("NominalPercentageOfCardiacPhase") is not None:
                ds.NominalPercentageOfCardiacPhase = tags["NominalPercentageOfCardiacPhase"]
            if tags.get("HeartRate") is not None:
                ds.HeartRate = tags["HeartRate"]
            _pixels(ds, raw[k])
            items.append(ds)
        out.append((tags.get("SeriesDescription") or s["name"], items))
    return out


def random_datasets(study: dict, slices: int = 24, n: int = 256, seed: int = 7) -> list[tuple[str, list[Dataset]]]:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n]
    body = ((xx - n / 2) / (n * 0.42)) ** 2 + ((yy - n / 2) / (n * 0.34)) ** 2 <= 1
    series_uid = generate_uid()
    items = []
    for k in range(slices):
        hu = np.full((n, n), -1000.0)
        hu[body] = 40
        hu[(xx - n / 2) ** 2 + (yy - n * 0.72) ** 2 < (n * 0.05) ** 2] = 700  # "spine"
        hu += rng.normal(0, 15, hu.shape) * body
        ds = _base(study, series_uid, 1, "Test axial 3.0", k + 1)
        ds.Manufacturer = "Asvanta test scanner"
        ds.KVP = 120
        ds.SliceThickness = 3
        ds.PixelSpacing = [0.8, 0.8]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [0.4, 0.4, 3.0 * k]
        ds.SliceLocation = 3.0 * k
        ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1024, 1, "HU"
        ds.WindowCenter, ds.WindowWidth = 40, 400
        _pixels(ds, np.clip(np.round(hu + 1024), 0, 65535))
        items.append(ds)
    return [("Test axial 3.0", items)]


# ----------------------------------------------------------------- network
def echo(host: str, port: int, called: str, calling: str) -> bool:
    ae = AE(ae_title=calling)
    ae.add_requested_context(Verification)
    assoc = ae.associate(host, port, ae_title=called)
    if not assoc.is_established:
        print(f"C-ECHO: association {'rejected' if assoc.is_rejected else 'failed/aborted'} ({calling} -> {called}@{host}:{port})")
        return False
    status = assoc.send_c_echo()
    assoc.release()
    ok = bool(status) and status.Status == 0
    print(f"C-ECHO {calling} -> {called}@{host}:{port}: {'OK' if ok else status}")
    return ok


def store(host: str, port: int, called: str, calling: str, series: list[tuple[str, list[Dataset]]]) -> int:
    ae = AE(ae_title=calling)
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    ae.acse_timeout = ae.dimse_timeout = ae.network_timeout = 60
    assoc = ae.associate(host, port, ae_title=called)
    if not assoc.is_established:
        if assoc.is_rejected:
            print(f"Association REJECTED by {called}@{host}:{port} for calling AE {calling} "
                  "(scanner not registered, or wrong called AE)")
        else:
            print(f"Association failed/aborted to {called}@{host}:{port}")
        return 2
    accepted = [cx for cx in assoc.accepted_contexts]
    print(f"Association established {calling} -> {called}@{host}:{port}; accepted contexts: {len(accepted)}")
    failures = 0
    stored = 0
    total = sum(len(items) for _, items in series)
    for desc, items in series:
        ok = 0
        for ds in items:
            status = assoc.send_c_store(ds)
            if status and status.Status == 0x0000:
                ok += 1
                stored += 1
            else:
                failures += 1
                code = f"0x{status.Status:04X}" if status else ("association aborted by the PACS - calling AE not "
                                                                 "registered (or not allowed from this IP)?")
                print(f"  C-STORE failed for instance {ds.InstanceNumber} of '{desc}': {code}")
                if not status:
                    break
        print(f"  series '{desc}': {ok}/{len(items)} stored  (SeriesInstanceUID {items[0].SeriesInstanceUID})")
        if not assoc.is_established:
            break
    if assoc.is_established:
        assoc.release()
    print(f"Done: {stored}/{total} instances stored, {failures} failures")
    return 0 if stored == total else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4242)
    ap.add_argument("--called-aet", "--aet", default="ASVANTA", help="PACS AE title (default ASVANTA)")
    ap.add_argument("--calling-aet", default="CT_ROOM1", help="this scanner's AE title (default CT_ROOM1)")
    ap.add_argument("--kind", choices=["cardiac", "random"], default="cardiac")
    ap.add_argument("--series", nargs="*", choices=["cac", "cta", "survey"], help="cardiac: only these series")
    ap.add_argument("--phantom-dir", type=Path, help="reuse an export_phantom.mjs output directory")
    ap.add_argument("--patient-phone", help="PatientTelephoneNumbers, e.g. +919819033417")
    ap.add_argument("--study-uid", help="reuse a StudyInstanceUID (re-send / add series)")
    ap.add_argument("--save-dir", type=Path, help="also write the .dcm files here")
    ap.add_argument("--echo", action="store_true", help="C-ECHO before storing")
    ap.add_argument("--echo-only", action="store_true")
    args = ap.parse_args()

    if args.echo or args.echo_only:
        ok = echo(args.host, args.port, args.called_aet, args.calling_aet)
        if args.echo_only:
            return 0 if ok else 2

    today = date.today()
    d = today - timedelta(days=30)  # birthday ~a month ago -> age 58 today
    birth = date(d.year - 58, d.month, min(d.day, 28))
    study = dict(
        uid=args.study_uid or generate_uid(), for_uid=generate_uid(),
        date=today.strftime("%Y%m%d"), time=datetime.now().strftime("%H%M%S"),
        accession=f"ACC{datetime.now().strftime('%y%m%d%H%M%S')}", station=args.calling_aet,
        referring="PATEL^M^^Dr.", phone=args.patient_phone,
    )
    if args.kind == "cardiac":
        study.update(patient_name="MALHOTRA^VIKRAM", patient_id="PT-10251", birth_date=birth.strftime("%Y%m%d"),
                     sex="M", age="058Y", description="CT Cardiac (Calcium score + CTA)", body_part="HEART")
        tmp = None
        src = args.phantom_dir
        if src is None:
            tmp = tempfile.TemporaryDirectory(prefix="asvanta-phantom-")
            src = Path(tmp.name)
            print("Rendering the cardiac phantom with Node ...")
            export_phantom(src)
        series = cardiac_datasets(src, study, args.series)
        if tmp:
            tmp.cleanup()
    else:
        study.update(patient_name="TEST^RANDOM", patient_id="PT-TEST-01", birth_date="19800101", sex="O",
                     age=f"{today.year - 1980:03d}Y", description="CT Test series (random)", body_part="CHEST")
        series = random_datasets(study)

    n = sum(len(i) for _, i in series)
    print(f"Study {study['uid']}  patient {study['patient_name']} ({study['patient_id']})  "
          f"'{study['description']}': {len(series)} series, {n} instances")
    if args.save_dir:
        args.save_dir.mkdir(parents=True, exist_ok=True)
        for si, (_, items) in enumerate(series, start=1):
            for ds in items:
                ds.save_as(args.save_dir / f"s{si:02d}_{int(ds.InstanceNumber):04d}.dcm", enforce_file_format=True)
        print(f"Saved .dcm files to {args.save_dir}")
    return store(args.host, args.port, args.called_aet, args.calling_aet, series)


if __name__ == "__main__":
    sys.exit(main())
