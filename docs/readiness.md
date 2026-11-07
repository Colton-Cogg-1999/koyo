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
