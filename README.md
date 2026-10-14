# MasterTest Web

Version 0.3.13 of MasterTest Web: [MasterTest Generator](https://github.com/mastertestcanada/examgenerator)
built to run entirely in a web browser (MasterTest.ca). Teachers choose a Canvas
quiz export (and a class list), set the options, and download a zip of exams,
answer cards, the answer key and attendance sheet for marking with the
MasterTest Marker app.

Nothing is uploaded or stored: the page runs the program inside the browser tab
with [Pyodide](https://pyodide.org) (Python compiled to WebAssembly), the chosen
files stay in the tab's memory, and they are cleared after each run and when the
tab closes. Everything the page needs is in this repository, so it makes no
requests to other sites.

## Hosting

This repository *is* the site: serve its root folder from any static web host
(university web space, Netlify, Cloudflare Pages, or GitHub Pages: Settings >
Pages > Deploy from a branch > `main` / root). It must be served over `http://`
or `https://`; opening `index.html` from disk does not work.

To try it locally:

    python -m http.server
    # then open http://localhost:8000/

The first visit downloads about 21 MB, which the browser then caches.

## Contents

| Path | What it is |
|---|---|
| `index.html`, `wizard.js` | The page: a two-step wizard. |
| `advanced.html`, `advanced.js` | "All options": every option of the program. |
| `worker.js`, `mastertest-logo.png` | Runs the program for both pages; the logo. |
| `app-<version>.zip` | MasterTest Generator itself, its answer-card instructions, images and the DejaVu Sans fallback font. |
| `pyodide/` | Pyodide (Python for the browser) with lxml, Pillow, cryptography and fontTools. |
| `wheels/` | reportlab, pypdf and segno from PyPI. |
| `fonts/` | Atkinson Hyperlegible for the page (SIL Open Font License). |
| `build.json` | What the page loads, and the versions. |
| `CHANGELOG.md` | Changes to MasterTest Generator and MasterTest Marker. |

## Updates

Do not edit these files here: they are built from the MasterTest Generator
repository with `tools/build_web.py`, and each version is committed here as one
commit ("MasterTest Web x.y.z"). The output is identical to the desktop
program's; the MasterTest Generator test suite checks it on every push.

Support: support@mastertest.ca

