# Asvanta — Diagnostic Platform Demo

**Live: <https://shivam30072.github.io/asvanta-demo/>** — works on desktop and mobile,
no sign-in needed beyond the demo codes below.

A **frontend-only prototype** for client walkthroughs. It shows the whole journey of a
study — authorization → registration → large-file upload → reporting → secure delivery to
the patient — with no backend, no network calls and no real data.

## Run it

Needs **Node 18 or newer** (this machine defaults to Node 14 via nvm, which Vite cannot run on):

```bash
nvm use 20     # or: nvm use   — picks up .nvmrc
npm install
npm run dev
```

Opens on <http://localhost:5173>.

To stop switching every time, make it the default once: `nvm alias default 20`.

## Deploying

The site is hosted free on GitHub Pages from the `gh-pages` branch of
[shivam30072/asvanta-demo](https://github.com/shivam30072/asvanta-demo); `main` holds the
source. To ship a change:

```bash
npm run deploy      # builds and pushes to gh-pages
```

Assets are served from `/asvanta-demo/`, so `npm run build` (root paths, for local preview
or any root-domain host) and `npm run build:pages` (Pages subpath) are separate builds.

## Two modes: demo and live (PACS)

Scanners now send studies **straight to the PACS**. Each machine is configured with the
PACS's AE title, IP address and port, and the web app reads studies back from the PACS.
There is no manual upload step.

- **Demo** (`npm run dev`, and the GitHub Pages site): everything runs in the browser.
  **Scanners** shows the address to type into each machine, the registered machines and
  incoming scans. *Simulate scan* shows a study arriving from a machine.
- **Live** (`VITE_API_URL=http://localhost:8000 npm run dev`): the app talks to the
  gateway in [`server/`](server/), which sits in front of an **Orthanc PACS**
  ([`pacs/`](pacs/), `docker compose up -d`). Scanners send by DICOM C-STORE to port 4242.
  The viewer loads real series over DICOMweb through the gateway. Staff send links by
  SMS, protected by OTP. Sign-in is checked by the server.
  `tools/send_test_study.py` plays the part of a scanner.

Design, API contract and commissioning notes: [docs/pacs-integration.md](docs/pacs-integration.md),
[pacs/README.md](pacs/README.md).

## Demo credentials

Everything is simulated; any password works.

| Prompt | Value |
| --- | --- |
| Sign-in OTP | `482913` (or press *Autofill demo code*) |
| Patient report OTP | `739104` |

## Walking a client through it

The dark strip at the top is the **demo control bar**. It switches between the three
people who touch a study, and resets everything back to the starting state.

1. **Sign in** — email + password, then an SMS OTP, then pick the centre. Shows that
   access is scoped to a centre and a user before anything else happens.
2. **Dashboard** — volumes, what's waiting, how much imaging is stored, and the
   five stages a study passes through.
3. **Scanners** — the PACS address to configure on each machine (AE title, IP, port), the
   registered machines with a *Test (C-ECHO)* button, and every scan received. Press
   *Simulate scan* on a machine to see a study arrive and join the radiologist's queue.
   **Send to mobile** on any study sends the images to any number straight away. The
   report can be added once it is signed. *Open as recipient* shows what the person sees:
   an OTP gate (`739104`), then the images, and the report if it was included. Every
   link can be withdrawn from the study's *Delivery* tab.
4. **Manual Upload** (fallback when a machine is not connected) — **New Study** registers the patient and the examination, then **pick the radiologist**
   who will report it. The picker suggests one from the examination (mammography goes to
   women's imaging, chest to the chest reader) and marks it *Suggested*; override it and
   the suggestion stops chasing your choice. On create, the assigned radiologist is
   emailed — the demo shows you the exact email they receive, then continues to upload.
5. **Upload Images** — drag a large file (or several) onto the drop zone.
   - The file is split into parts and the parts upload in parallel.
   - **One part is deliberately dropped** so you can show *Retry part 3* — only that
     part is re-sent, not the whole file.
   - When every part is confirmed, the study record is written and the study moves
     into the radiologist's queue.
6. **Studies** — every previous upload, searchable and filterable, each with its size,
   status and a countdown to the 365-day automatic deletion.
7. **Study detail** — image previews, the report, the full audit trail, and the
   delivery log for that study.
8. **Viewer** — *Open viewer* on any study opens a full diagnostic viewer: series rail,
   stack / zoom / pan / window-level / measure tools, window presets (soft tissue, brain,
   lung, bone), cine playback, 1×1 and 2×2 layouts, rotate and invert, and the usual
   corner overlays. Mouse wheel scrolls slices; press `?` for the shortcut list.
9. Switch to **Radiologist** — the worklist opens on *Assigned to me*, urgent first.
   Studies sent to another doctor appear only under *All unreported* / *All studies*,
   attributed to whoever owns them. Open a study, apply a
   report template, edit it, then *Sign & publish*. Signing does **not** reach the
   patient: it hands the report back to the centre.
10. Switch back to **Centre Staff** — the signed report now sits in *Ready to publish* on
   the dashboard, and the study page carries a green banner. Only the centre can release
   it. Press *Send report*, enter any mobile number, tick *Radiology report*, set how long
   the link lives and whether it needs an OTP. You see the exact SMS, and *Open as
   recipient* shows the link from the receiving end.
11. Switch to **Patient** — the WhatsApp message as the patient receives it, the OTP
    gate, the report, and a simple image viewer (no windowing or measurement).

### Advanced imaging: MPR, CPR and coronary calcium (radiologist only)

Use **Vikram Malhotra · STD-24818 · CT Cardiac (Calcium score + CTA)** from the
radiologist's worklist. Open the report, then *Open diagnostic viewer*. The **Mode** group
in the toolbar switches between **2D | MPR | CPR | CAC**. Centre staff see these tabs
locked, and patients never reach the viewer.

- **MPR**: axial, coronal, sagittal and a free oblique plane (angle and tilt sliders)
  through one crosshair. Use *Point* (key `6`) to move the crosshair, and scroll any
  plane to step through it. Thin slices or a 5, 10 or 20 mm MIP slab. MPR works on any
  CT or MRI series with 20 or more slices.
- **CPR**: choose LAD, LCX or RCA. Drag the centerline dots on the MIP overviews to
  correct the proposed path, and rotate the straightened vessel. Click along it to see
  the perpendicular cross-section, lumen diameter and the diameter profile. There is an
  LAD stenosis of about 45% to find. Then use *Mark verified*.
- **CAC**: the scan validation checklist comes first. *Ca Score 3mm* is ready, *CCTA* is
  refused because it is contrast-enhanced, and *Thorax 5mm* is allowed only as an
  explicitly acknowledged opportunistic estimate. Then *Run CAC analysis* and watch the
  pipeline stages. The algorithm scores about **279**, but it makes three planted
  mistakes for the radiologist to fix:
  1. A large LCX lesion is mitral annulus calcification. Delete it with that reason.
  2. The LM lesion is really proximal LAD. Change its vessel.
  3. A distal RCA plaque was excluded as "outside heart region". Restore it under
     *Excluded candidates* and assign it to RCA.

  Then *Accept all* and *Approve final score* (about **164**, CAC-DRS A2). The audit
  trail shows every change with its score delta. Back in the report, the CAC card
  offers *Insert into report*. Only an approved score can be inserted.

The design, the pipeline stages, the validation rules, the phase plan and the
open-source and regulatory notes are in [docs/advanced-imaging.md](docs/advanced-imaging.md).
A Python/FastAPI implementation of the same engine, for real DICOM, is in
[engine/](engine/README.md).

### Who can do what

| | Centre staff | Radiologist | Patient |
| --- | --- | --- | --- |
| Register a study, upload images | yes | — | — |
| Choose which radiologist reports it | yes | — | — |
| Read images in the diagnostic viewer | yes | yes | simple viewer only |
| Write and sign the report | — | yes | — |
| MPR, CPR, CAC analysis and approval | locked | yes | — |
| Register scanners, see incoming scans | yes | — | — |
| **Send images to any mobile number** | **yes** | no | — |
| **Send the signed report to any mobile number** | **yes** | no | — |

Signing and publishing are deliberately separate. The radiologist signs; the centre is
notified and decides when the patient sees it. A study is `Signed · to publish` in
between, and `Sent to patient` once released.

## What is real and what is not

Real: the drag-and-drop, the file names and sizes you drop, all navigation and state,
the audit trail, the search and filters, and the viewer — window/level, zoom, pan, cine
and measurement all operate on actual pixel data.

Simulated: upload progress, the dropped part, message delivery, the radiologist
assignment email, and OTPs.

Real in the advanced-imaging tools: volume reconstruction and reslicing, the Agatston
maths, scan validation, the review operations and the audit trail. These are covered by
`npm test`, which includes hand-computed reference cases that the Python engine also
passes. Two things come from the phantom model rather than a real algorithm: heart
localisation and vessel assignment. A segmentation model replaces them in production.

The cardiac study is not procedural 2D. It is an **analytic 3D phantom**
(`src/imaging/phantom.js`): heart chambers, coronary arteries with calcified plaques of
known peak HU, a soft LAD stenosis, and the high-density structures a calcium score
must ignore (spine, ribs, sternum, aortic valve, mitral annulus, aortic wall). Scanner
values are written as raw stored pixels and converted to HU through the rescale tags,
as a real DICOM loader does.

The images are **generated in the browser, not decoded from DICOM**. Each modality has a
procedural model (brain, chest, abdomen, lumbar spine, breast, ultrasound, radiograph,
joint) producing pseudo-Hounsfield pixel values, which the viewer then windows exactly as
it would real pixel data — so the window presets behave correctly and the images are
plausible, but they are not diagnostic and are labelled as such in the viewer. A real
deployment renders the actual DICOM series here.

Dropped files stay in your browser and are never sent anywhere.

## On a phone

The whole demo is usable on a phone. The sidebar becomes a bottom tab bar, and in the
viewer the series rail turns into a drawer (the **Series** button in the toolbar) so the
image gets the full width. Swipe up and down on the image to scroll slices; the toolbar
scrolls sideways for the layout, window and cine groups.

## Layout

```
src/
  App.jsx              routing between screens by role
  store.jsx            all app state (React context + reducer), no backend
  data/seed.js         patients, studies, reports, templates, notifications
  lib/format.js        bytes, dates, retention countdown
  components/          Shell (sidebar/topbar/demo bar), ShareModal, Icons, ui primitives
  screens/             Login, Dashboard, NewStudy, Upload, Studies, StudyDetail,
                       Worklist, ReportEditor, Deliveries, PatientPortal, Viewer
  viewer/              synth.js      procedural pixel data + window/level
                       series.js     series per study, window presets
                       Viewport.jsx  canvas rendering and mouse tools
                       SeriesThumb   series thumbnails
                       SimpleViewer  the cut-down viewer patients get
                       PlaneView     any resliced plane at true aspect + tools
                       MprView / CprView / CacView   the radiologist-only modes
  imaging/             phantom.js    analytic cardiac CT with ground truth
                       volume.js     series → 3D volume, reslice, CPR, lumen
                       cpr.js        diameter profile, stenosis estimate
  cac/                 agatston.js   deterministic Agatston engine
                       validation.js scan suitability
                       pipeline.js   the analysis stages
                       review.js     radiologist edits, approval, audit
reference/cac-cases.json   hand-computed cases both engines must pass
engine/                    Python/FastAPI CAC service (pydicom, NumPy, SciPy)
docs/advanced-imaging.md   design, phases, validation and regulatory notes
```

## Tests

```bash
npm test                          # browser engine, pipeline, review, CPR
cd engine && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest -q
```
