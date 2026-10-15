# Changelog

Versions are written Major.Minor.Patch. The patch level goes up by one every
time an application is changed and built; the major and minor numbers change
only when requested.

## MasterTest Builder

| Version | Date       | Changes |
|---------|------------|---------|
| 0.4.6   | 2026-10-15 | MasterTest Generator is now MasterTest Builder: `python mastertest_builder.py` in the `builder` folder (Python package `mtbuilder`); MasterTest Web keeps its name and shares the version. Continues from MasterTest Generator 0.4.3. New QR codes, MasterTest QR format 1: answer cards, single-page quizzes and merged sheets are schema 0x10 (kind, answer width and sheet number each in a byte of their own, in place of the five flag bits added over earlier versions), answer keys 0x11 (one format for every question type) and password-protected keys 0x18; they are read by MasterTest Marker 0.4.0 and later only, and exams printed by MasterTest Generator can no longer be marked. Padding always means "as many bubbles as the quiz's question with the most options", and merged-sheet bubbles always end at the right edge of the answer area. Removed: the option names of MasterTest Generator 0.3.4 and earlier and their messages, `--use-item-banks` and `--pad-options`, old page-size spellings (`Tabloid-Duplex-Landscape`, `letter-singlePage`, ...) and old page-option spellings, and MasterTest Web's unlinked "All options" page. README rewritten without version history. |
