# Readiness review — November 7, 2026

This review exercised the application rather than treating compilation as proof of functionality.

## Verified locally

- Locked frontend build and Rust test suite.
- Real-server Chromium workflows: Markdown import, highlighting and note persistence, search, workspace switching, EPUB chapter links and reading-position restore, mixed portrait/landscape PDF pages, blank-page resume, notebook navigation/autosave and failed-save recovery, favorites, collections, duplicate import, and book deletion.
- Local HTTP guard checks, invalid book-path rejection, and preservation of the restrictive CSP on extracted assets.
- Download of the real Kokoro model; speech generation with sentence marks; M4B export; duration verified with ffprobe.
- Live answers through both installed, authenticated Claude Code and Codex CLIs, including persisted answers and retrieved citations. This used generated test text, not personal books.
- Tracked-file review and a credential-pattern scan found no account tokens, library database, personal books, or reference images. This is not a comprehensive security audit.
- npm's production-dependency audit reported zero known vulnerabilities at review time. That does not guarantee future advisories or cover all native dependencies.

## Corrected during review

- Unsafe byte slicing when decoding malformed Unicode percent sequences.
- A general CSP header overwriting the sandbox policy intended for book assets.
- Book identifiers being accepted as filesystem path components without format validation.
- Temporary import copies left behind after unsupported-file rejection.
- Non-atomic loose-note mirrors and incorrectly escaped multiline metadata.
- Notebook exit/save failure behavior, plus reading-position flush on navigation.
- PDF layout and position calculations assuming every page had the first page's dimensions.
- Concurrent voice-install requests sharing the same temporary files, and incomplete models appearing installed.
- The automatically selected AI provider differing from the server's default provider.
- Replaced the Omarchy wordmark with an original OmaReader mark and removed the one-use repository publishing helper.

## Still outside this review's guarantees

Large-library stress testing, crash recovery during every possible write, all EPUB/CSS variants, every PDF layout, DOCX/FB2/Calibre conversion coverage, and cross-distribution installation testing are not complete. Provider CLI changes can affect AI integrations. No OCR or DRM removal is implemented. Markdown mirroring is one-way; a complete backup includes the database.

Use the README's opt-in commands to reproduce narration and provider checks. Standard CI intentionally does not download voice models or use an AI account. The browser suite uses synthetic test books; its fixture screenshots are not product documentation.

## Library and study workflow follow-up

The combined local run `OMAREADER_TEST_AI=1 OMAREADER_TEST_TTS=1 ./scripts/test` passed **19 Rust tests and 32 browser/integration checks, with no skips**. The installed optimized release also passed an isolated CLI import → backup → restore check, including byte-for-byte original preservation and refusal to overwrite the restored directory.

New coverage:

- Visible book-storage location, original-file download, and library conversations that leave the saved reading position unchanged.
- Browser request wiring for visible passage bounds, exact selected text, and a chosen chapter independent of the current reading location.
- Both live providers answered EPUB-style passage, selected-text, chosen-chapter, PDF-page, and PDF-selection questions correctly in original fixtures. Tests checked expected facts, excluded conflicting facts, and checked cited excerpts. Both providers declined an unsupported birth-year question. These are a small regression set, not a general guarantee of model accuracy.
- Long chapter retrieval finds a relevant passage buried beyond the initial context budget, without drawing evidence from another chapter. Excerpts are bounded; broad summaries can still omit material.
- EPUB highlights identify the same quotation after font, size, line-spacing, width, viewport, and reload changes. Shifted offsets recover when the original quotation has one safe match; changed text produces a visible warning. Passage-note save failures retain a local draft through reload.
- PDF highlights preserve normalized geometry across zoom and reopening. Rotation, different editions, and arbitrary parser migrations are not covered by this guarantee.
- Real Kokoro installation, synthesis, sentence marks, M4B export, measurable non-silent audio, multi-track generation pause/resume, and preservation of completed tracks and listening position. This does not replace listening-based pronunciation/quality review or a long battery test on a Surface.
- Checked backup/restore preserves books, notes, annotations, and positions; detects changed file contents; refuses symlinks, nested backups, and overwrite attempts; and uses an exclusive library lock. Old binaries without the lock must also be closed. Unsaved browser drafts are not part of an offline backup.
- An 820×1180 browser viewport retains library actions, chapter questions, reading space, and closable audio/side panels. Actual Surface hardware, touch selection, pen input, suspend/resume, and Nook execution remain unverified.

The README stays text-only. Generated fixtures and their screenshots are test material, not application marketing. Podcasts, multi-book conversations, local-model adapters, automatic synchronization, and a graphical library-migration wizard are still future work.
