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
3. **New Study** — register the patient and the examination, then **pick the radiologist**
   who will report it. The picker suggests one from the examination (mammography goes to
   women's imaging, chest to the chest reader) and marks it *Suggested*; override it and
   the suggestion stops chasing your choice. On create, the assigned radiologist is
   emailed — the demo shows you the exact email they receive, then continues to upload.
4. **Upload Images** — drag a large file (or several) onto the drop zone.
   - The file is split into parts and the parts upload in parallel.
   - **One part is deliberately dropped** so you can show *Retry part 3* — only that
     part is re-sent, not the whole file.
   - When every part is confirmed, the study record is written and the study moves
     into the radiologist's queue.
5. **Studies** — every previous upload, searchable and filterable, each with its size,
   status and a countdown to the 365-day automatic deletion.
6. **Study detail** — image previews, the report, the full audit trail, and the
   delivery log for that study.
7. **Viewer** — *Open viewer* on any study opens a full diagnostic viewer: series rail,
   stack / zoom / pan / window-level / measure tools, window presets (soft tissue, brain,
   lung, bone), cine playback, 1×1 and 2×2 layouts, rotate and invert, and the usual
   corner overlays. Mouse wheel scrolls slices; press `?` for the shortcut list.
8. Switch to **Radiologist** — the worklist opens on *Assigned to me*, urgent first.
   Studies sent to another doctor appear only under *All unreported* / *All studies*,
   attributed to whoever owns them. Open a study, apply a
   report template, edit it, then *Sign & publish*. Signing does **not** reach the
   patient: it hands the report back to the centre.
9. Switch back to **Centre Staff** — the signed report now sits in *Ready to publish* on
   the dashboard, and the study page carries a green banner. Only the centre can release
   it. Press *Publish to patient*, pick WhatsApp / SMS / email, set how long the link
   lives and whether it needs an OTP. Live previews of each message.
10. Switch to **Patient** — the WhatsApp message as the patient receives it, the OTP
    gate, the report, and a simple image viewer (no windowing or measurement).

### Who can do what

| | Centre staff | Radiologist | Patient |
| --- | --- | --- | --- |
| Register a study, upload images | yes | — | — |
| Choose which radiologist reports it | yes | — | — |
| Read images in the diagnostic viewer | yes | yes | simple viewer only |
| Write and sign the report | — | yes | — |
| **Publish the report to the patient** | **yes** | no | — |

Signing and publishing are deliberately separate. The radiologist signs; the centre is
notified and decides when the patient sees it. A study is `Signed · to publish` in
between, and `Sent to patient` once released.

## What is real and what is not

Real: the drag-and-drop, the file names and sizes you drop, all navigation and state,
the audit trail, the search and filters, and the viewer — window/level, zoom, pan, cine
and measurement all operate on actual pixel data.

Simulated: upload progress, the dropped part, message delivery, the radiologist
assignment email, and OTPs.

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
```
