# Advanced imaging: MPR, CPR and CAC scoring

These are radiologist-only tools in the AsvantaTech viewer:

- **MPR**: multiplanar reconstruction.
- **CPR**: curved planar reconstruction (the spec calls it "curved NPR").
- **CAC**: coronary artery calcium scoring, using the Agatston method, with the radiologist in the loop.

This document maps the specification to what exists in this repository, what is deliberately stubbed, and what production needs.

> **Clinical safety.** Nothing here has been clinically validated. The CAC algorithm only assists the radiologist. A score reaches a report only after a radiologist has reviewed and approved it. The algorithm's own result is always stored separately from the approved one.

---

## 1. What is in the repo

| Piece | Where | Status |
|---|---|---|
| Deterministic Agatston engine (browser) | `src/cac/agatston.js` | Real. Tested against the shared reference cases. |
| Deterministic Agatston engine (server) | `engine/asvanta_cac/` | Real. pydicom → HU → validation → Agatston → review/approve → FastAPI. Tested with pytest. |
| Shared reference cases | `reference/cac-cases.json` | 10 hand-computed cases. Both engines must reproduce every one. |
| Scan validation | `src/cac/validation.js`, `engine/asvanta_cac/validation.py` | Real, rule-based, using DICOM tags and geometry. |
| CAC pipeline (stages as in spec §5) | `src/cac/pipeline.js` | Real except the anatomy steps, which are pluggable hooks (see §4). |
| Radiologist review, approval and audit | `src/cac/review.js`, `engine/asvanta_cac/review.py` | Real. The algorithm record is immutable and the review locks on approval. |
| 3D volume, MPR reslicing, CPR | `src/imaging/volume.js`, `src/imaging/cpr.js` | Real CPU implementation over the demo volumes. |
| Cardiac CT phantom | `src/imaging/phantom.js` | Synthetic. A 3D volume with known plaques, distractors and a soft stenosis. |
| Viewer UI | `src/viewer/MprView.jsx`, `CprView.jsx`, `CacView.jsx`, `PlaneView.jsx` | Demo UI over the above. |
| Report integration | `src/screens/ReportEditor.jsx` | Shows only an approved score and inserts it into the report. |

Run the tests:

```bash
npm test                                         # reference cases, pipeline on the phantom, review, CPR, DICOMweb decoding
cd engine && .venv/bin/pytest -q                 # same reference cases, DICOM I/O, validation, review, API
```

---

## 2. Access control

| | Centre staff | Radiologist | Patient |
|---|---|---|---|
| 2D diagnostic viewer | yes | yes | — (simple viewer only) |
| MPR / CPR / CAC modes | locked | yes | — |
| Run and review CAC analysis, approve score | — | yes | — |
| See the approved CAC score | in the study timeline / report | yes | in the published report only |

In the demo, the viewer locks the mode tabs for staff and patients never reach the viewer. The Python API enforces the same rules on the server. CAC endpoints require the radiologist role. `GET /studies/{id}/report-cac` returns only an approved score, and staff may read it. Patients get 403. The role headers are a stand-in for real authentication.

---

## 3. MPR and CPR

**MPR** (`MprView`) shows axial, coronal, sagittal and a free oblique plane (angle and tilt) through one shared crosshair. All four are resliced from a single 3D volume with trilinear sampling. It has a thin or MIP slab of 5, 10 or 20 mm. Zoom, pan, window/level and measurement in mm all work, at true physical aspect.

**CPR** (`CprView`) works on a contrast-enhanced series:

1. A centerline is proposed for each vessel (LM→LAD, LM→LCX, RCA).
2. The radiologist corrects it by dragging control points on axial and coronal MIP overviews.
3. A straightened CPR is built with rotation-minimising frames and can be rotated 0–179°.
4. A cross-section is shown perpendicular to the vessel, with lumen area and diameter.
5. A lumen-diameter profile along the vessel gives an automated diameter-stenosis hint. It compares each point with the median of the segments 4–12 mm on either side, so normal distal tapering does not count as disease.
6. **Mark verified** records who verified the centerline, the time, whether it was corrected and the stenosis estimate. Editing the centerline afterwards clears the verified state.

CPR is a visualisation tool and is kept separate from CAC scoring.

**Production:** use Cornerstone3D volume viewports (GPU, VTK.js), which provide orthographic and oblique MPR and slab MIP natively. Use the VTK image reslicing filters, or a Cornerstone3D CPR implementation, for curved reconstruction. Load the volume from the actual DICOM series over DICOMweb. For centerline proposals, use vessel segmentation plus skeletonisation (for example VMTK, or a coronary segmentation model), seeded from detected ostia.

---

## 4. CAC pipeline

The stages follow spec §5 one to one (`STAGES` in `src/cac/pipeline.js`):

| Stage | Implementation |
|---|---|
| DICOM validation, series selection | Tag checks. Opportunistic series must be requested explicitly. |
| 3D volume, HU conversion | Stored values × RescaleSlope + RescaleIntercept. Absent tags are a hard fail. |
| Acquisition / image-quality validation | See §5. |
| Heart localisation | `anatomy.inHeart(x, y, z)` **hook**. |
| Candidate detection, segmentation | ≥130 HU, 8-connected regions per slice, area ≥1 mm², linked across slices. |
| Non-coronary filtering | Volume > 1500 mm³ is treated as bone. Outside the heart region → excluded. `anatomy.nonCoronary()` identifies valve/root calcium. |
| Vessel assignment | Nearest point on `anatomy.centerlines`, within 7 mm. Otherwise left unassigned. |
| Agatston calculation | Per-vessel and total, plus volume. CAC-DRS category (A0–A3). |

The anatomy provider is the extension point for Phases 3 and 5. In the demo it is the phantom's model, which is **deliberately imperfect** so that review has real work to do:

- The mitral annulus calcification sits in the AV groove beside the LCX, so it gets assigned to the LCX. That is a false positive.
- The atlas left main overshoots the bifurcation, so a proximal LAD plaque gets assigned to LM.
- Heart localisation misses the inferior wall, so a distal RCA plaque is excluded as "outside heart region".

On the phantom, the algorithm scores about **279**. After the three corrections the approved score is about **164** (LM 0, LAD 95, LCX 10, RCA 59, CAC-DRS A2). `src/cac/pipeline.test.js` asserts this scenario end to end.

### Agatston rules (both engines)

- Calcium voxel: HU ≥ 130.
- Regions: 8-connected per axial slice. A region counts if its area is ≥ 1 mm².
- Density factor from the region's peak HU: 130–199 → 1, 200–299 → 2, 300–399 → 3, ≥400 → 4.
- Region score = area × factor × (slice increment / 3 mm).
- Regions on adjacent slices that share a pixel belong to one lesion.
- Total = the sum over lesions. Lesions not yet assigned to a vessel are counted in the total and reported as "unassigned". Approval requires every lesion to have a vessel.
- Nothing is rounded inside the engine.

---

## 5. Scan validation

Each check returns pass, warn or fail. The overall verdict is:

- **ready**: a dedicated CAC study, so a standard Agatston score is valid.
- **opportunistic**: a score can be computed, but it is labelled throughout as a non-standard estimate and needs explicit acknowledgement.
- **unsuitable**: no score is computed.

| Check | Rule | Effect if not met |
|---|---|---|
| Modality | CT | fail |
| HU calibration | RescaleSlope and RescaleIntercept present | fail |
| Contrast | no ContrastBolusAgent | fail (iodine in the blood pool exceeds 130 HU) |
| ECG gating | CardiacSynchronizationTechnique present | warn → opportunistic |
| Slice thickness | 2.5–3.0 mm | warn |
| Contiguity | increment ≈ thickness | warn |
| Pixel spacing | ≤ 1.0 mm | warn |
| kVp | 120 | warn (the 130 HU threshold assumes 120 kVp) |
| Orientation | axial | fail |
| Coverage | ≥ 100 mm cranio-caudal | warn |
| Anatomy model | available for the series | info only. Without one, CAC runs in **manual mode**: only bone is filtered by size, and the radiologist assigns every lesion to a vessel |

The Python engine applies the same rules with slightly stricter geometry checks: duplicate positions, non-uniform spacing, slice normal more than 10° from the z-axis. It also reports image noise as information only. One difference: Python lets an explicitly requested opportunistic run override the contrast rule, while the browser engine never allows it. The demo cardiac study includes one series for each verdict: Ca Score 3 mm (ready), CCTA (unsuitable) and the 5 mm non-gated thorax series (opportunistic).

---

## 6. Review, approval, audit

The radiologist can:

- accept a lesion, or accept all
- delete a lesion, with a reason
- restore an excluded candidate
- add a missed lesion by clicking calcium (region growing under the same rules)
- erase part of a lesion's boundary with a brush
- change the vessel
- recalculate (re-score every lesion from its voxels)
- approve

Approval is blocked until every lesion is accepted and has a vessel. Once approved, the record holds:

- the final total and per-vessel scores, and the CAC-DRS category
- the lesion list (without voxel payloads)
- the algorithm total and the adjustment
- the standard/opportunistic label
- who approved it and when
- the engine version

Every operation appends to the audit trail with its score delta. The study timeline records the analysis run, the approval and CPR verifications. The approved review is locked.

The report editor shows **only** an approved score. An unapproved analysis shows "Awaiting approval" with a link to the review, and the sign-off dialog warns that no score will be included.

---

## 7. Production architecture

```
DICOM storage (S3 + DICOMweb, e.g. Orthanc)
   │
Radiologist viewer (Cornerstone3D: 2D │ MPR │ CPR │ CAC)
   │  POST /studies/{id}/cac/jobs
FastAPI CAC service ──► queue (Celery or RQ + Redis) ──► worker
   │                                              pydicom · SimpleITK · NumPy · scikit-image
   │                                              PyTorch / MONAI / nnU-Net (Phases 3–5)
   ▼
Postgres: analyses (immutable algorithm result) · reviews · audit · approved scores
   │
Reporting reads GET /studies/{id}/report-cac (approved only)
```

What `engine/` still needs before this works:

- Persistent storage instead of in-memory.
- A real job queue (it currently uses BackgroundTasks).
- Real authentication and authorisation.
- Multi-frame (enhanced) CT support.
- Lesion masks returned as DICOM SEG, or as run-length JSON for the viewer.
- The heart, valve and coronary model behind the `candidate_filter` / `vessel_assigner` hooks.

---

## 8. Phases

| Phase | Spec | Status |
|---|---|---|
| 1 | Deterministic Agatston engine | **Done**: both engines, shared reference cases, reproducibility test |
| 2 | Calcium visualisation | **Done** (demo): vessel-coloured masks, ≥130 HU overlay, lesion details |
| 3 | Heart / anatomical localisation | Hook in place. Demo uses a phantom model. Next: TotalSegmentator-style heart, aorta and valve segmentation |
| 4 | Automatic calcium detection (AI) | Not started. MONAI / nnU-Net trained on COCA |
| 5 | Vessel assignment | Hook in place (nearest centerline). Next: coronary segmentation/centerlines, or a lesion-level classifier |
| 6 | Radiologist review | **Done** (demo and engine) |
| 7 | Reporting and audit | **Done** (demo). Engine exposes approved-only endpoint |

---

## 9. Open-source research to evaluate

Do not copy these into production. For each one, record its licence, its dataset requirements, whether model weights are available and under what licence, the reported accuracy and how it was validated, how actively it is maintained, and any **commercial-use restrictions**. Many medical datasets and model weights are research-only.

- **Stanford COCA** (Coronary Calcium and chest CT, via Stanford AIMI). Gated CAC CTs with calcium annotations, plus non-gated chest CTs with reference scores. Use it for development and benchmarking. Check the data use agreement for commercial use before training a production model on it.
- **CalciumScoring.jl**: Julia implementations of Agatston, volume, mass and integrated scoring. Useful as an independent cross-check of our maths.
- **3D Slicer** calcium-scoring extensions: a reference workflow and UI, useful for comparing results.
- **Automatic-CaScoring-From-Chest-CT**, **PrediCT-GSoC**: research pipelines for opportunistic scoring. Evaluate their code quality and licence.
- **MONAI**, **nnU-Net**, **TotalSegmentator**: segmentation frameworks and pretrained anatomy models for Phases 3–5. Check the weight licences.

---

## 10. Validation plan (before any clinical claim)

Compare against reference reads, using COCA plus a local multi-vendor set:

- Agreement on total and per-vessel scores, measured with ICC, Bland–Altman and agreement on CAC-DRS category.
- Lesion-level sensitivity and precision, with false positive and false negative counts.
- Inter-reader agreement with and without the tool.
- Stratification by vendor, scanner, kernel, slice thickness, BMI, heart rate, calcium burden (zero, minimal, severe) and motion artefact.

Regulatory work comes before any commercial clinical use. CAC scoring software is generally regulated as a medical device (SaMD). Investigate:

- India: CDSCO under the Medical Device Rules 2017, including classification and licensing.
- Quality and software lifecycle: ISO 13485, ISO 14971, IEC 62304.
- Export markets: FDA 510(k) (cleared predicate CAC products exist) and EU MDR / CE.
