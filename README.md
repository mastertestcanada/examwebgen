# MasterTest Web

Version 0.5.5 of MasterTest Web: [MasterTest Builder](https://github.com/mastertestcanada/examgenerator)
built to run entirely in a web browser (MasterTest.ca). Teachers choose a Canvas
quiz export or a Word document written for Akindi's importer (and a class list), set the options, and download a zip of exams,
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
| `index.html`, `i18n.js`, `wizard.js` | The page: a two-step wizard. |
| `worker.js`, `mastertest-logo.png` | Runs the program for both pages; the logo. |
| `app-<version>.zip` | MasterTest Builder itself, its answer-card instructions, images and fonts (DejaVu Sans, Open Sans, Source Code Pro, MasterTest Enclosed). |
| `pyodide/` | Pyodide (Python for the browser) with lxml, Pillow, cryptography and fontTools. |
| `wheels/` | reportlab, pypdf and segno from PyPI. |
| `fonts/` | Atkinson Hyperlegible for the page, and MasterTest Enclosed for its examples of the option letters (SIL Open Font License). |
| `fonts/cjk/` | Noto Sans CJK for Simplified and Traditional Chinese, Japanese and Korean (SIL Open Font License, `fonts/cjk/OFL.txt`), converted to TrueType; the page downloads one only when a quiz has text in those languages. |
| `build.json` | What the page loads, and the versions. |
| `CHANGELOG.md` | Changes to MasterTest Builder and MasterTest Web. |

## Updates

Do not edit these files here: they are built from the MasterTest Builder
repository with `tools/build_web.py`, and each version is committed here as one
commit ("MasterTest Web x.y.z"). The output is identical to the desktop
program's; the MasterTest Builder test suite checks it on every push.

Support: support@mastertest.ca

