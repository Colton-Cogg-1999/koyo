# OmaReader

**I'm not going to tell you where to get your books. When you find some, read them here.**

That's the idea. Put your EPUBs and PDFs in a library, read them, scribble in the margins, and pick up where you left off. If you'd rather listen, let your computer read them to you. If a paragraph makes no sense, ask about it—and check the answer against the actual page.

I don't think access to information should depend on whether you have the right university email or another twenty dollars a month. A reader shouldn't become another toll booth. There is no OmaReader account, subscription, or premium tier. Your books stay on your machine. Your notes can leave with you.

This is an open-source project because I want something I can use, fix, and keep using. You should be able to do the same. It isn't finished, and I'm not going to pretend a chatbot with a citation button is automatically a research tool. The work is making reading, notes, listening, and answers trustworthy enough to use every day.

AI is optional. Sometimes you just want to read a damn book.

## What it does

OmaReader is a Linux desktop reader with a Rust backend and a React interface, opened in a dedicated Chromium app window. The backend serves only on your machine's loopback address.

| Feature | What you get |
| --- | --- |
| Reading | EPUB chapters, original PDF pages, Markdown, HTML, and plain text |
| Library | Search, favorites, collections, duplicate detection, and saved reading position |
| Annotations | Colored highlights, bookmarks, passage notes, and a Markdown notebook |
| Portable notes | SQLite storage plus Markdown mirrors and per-book Markdown downloads |
| Narration | Local Kokoro speech generation, sentence timing for read-along, resumable tracks, and chaptered M4B export |
| Optional AI | Ask from the library, or scope questions to visible passages, selected text, or a chosen chapter; Claude Code or Codex CLI supplies the answers |
| Appearance | Reading fonts, paper colors, focus mode, and optional live Omarchy theme integration |

There is also import code for DOCX and FB2, and optional conversion through Calibre for formats including MOBI and AZW3. Those paths have less coverage than EPUB and PDF; report files that do not import correctly.

## Run it

You need Rust stable, Node.js 26 with npm, a C/C++ build toolchain, Poppler, FFmpeg, and a browser. On Arch/Omarchy:

```sh
sudo pacman -S --needed base-devel rust nodejs npm poppler ffmpeg chromium xdg-utils

git clone https://github.com/Colton-Cogg-1999/omareader.git
cd omareader
./scripts/build
./target/release/omareader
```

Check `node --version`: the frontend toolchain expects Node 26, also specified in `mise.toml`. The build installs locked JavaScript dependencies, builds the interface, then embeds it into the release binary. Initial compilation may download the sherpa-onnx native runtime.

Import a book using the library's file picker or drag and drop. Open it from the library. Select text to highlight it or add a note. The **Audio** tab offers a one-time voice download of several hundred megabytes; after that, speech generation runs locally.

For a per-user install with a desktop launcher (no sudo):

```sh
./scripts/install-user
```

This installs the built release under `~/.local`. Ensure `~/.local/bin` is in your desktop session's `PATH`. Run the build and install commands again after updating.

Alternatively, for an Arch package and desktop launcher:

```sh
cd pkgbuild
makepkg -si
```

On other Linux distributions, install equivalent build tools and runtime packages, then use `scripts/build`. Chromium, Chrome, Brave, and Edge are detected for app-window mode; `xdg-open` is the fallback. No Omarchy installation is required.

## Ask something useful

Select a book in the library and choose **Ask this book**. You don't have to open it or lose your reading position. Choose **Search this book** for a specific question, or **A chapter** and pick the chapter you mean.

While reading, **Visible passages** uses the paragraphs intersecting the reading viewport; for PDFs, **Current page** uses that PDF page's text layer. Select text and click **Ask Oma** to ask about just that selection. The scope stays visible above the question box. `/summarize` and `/quiz` use the chosen chapter (the current chapter by default); `/ideas` uses a sampled book overview.

Long chapters and book overviews may be sampled. Chapter questions also retrieve matching passages from within that chapter. This isn't a claim that the model has read every word. Answers are instructed to stick to supplied evidence and say when it isn't enough. Follow the numbered citations to check, and save useful answers to your notebook with their source references.

Highlights store text locations rather than screen pixels for EPUBs, and page-relative rectangles for PDFs. EPUB quotation checks catch stale offsets; a unique match can recover a shifted passage. If a safe match isn't possible, the reader tells you instead of highlighting unrelated text. That is not automatic migration between different editions of a book.

## A quieter reading layout

The book gets the main reading surface, with notes at the top right and chat below. Library, marks, audio, notebooks, and settings live in the top tabs. Audiobook controls only appear in **Audio**; switching back to **Read** returns to your book.

Use **− / percentage / +** in the reader toolbar to zoom. EPUBs enlarge the text and reflow; PDFs enlarge the original page. Click the percentage to reset. The setting is saved, and the existing text menu still offers fonts, line spacing, and paper colors. On narrow screens, the side-panes button opens notes and chat when needed.

## Keyboard controls

| Key | Action |
| --- | --- |
| `1`–`5` | Library, Read, Marks, Audio, Settings |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+F` / `Ctrl+L` | Search / Library |
| `Ctrl+D` / `Ctrl+B` | Bookmark / sidebar |
| `Ctrl+J` | Focus question input |
| `/` | Search |
| `Space`, `PageDown`, `→` | Read forward |
| `Shift+Space`, `PageUp`, `←` | Read backward |
| `[` / `]` | Previous / next chapter |
| `f` | Focus mode |
| `t` / `m` / `n` | Chapter index / margin notes / book notebook |
| `b` | Toggle a bookmark |
| `l` | Play or pause loaded audio |
| `i` | Focus the optional AI question field |

## Your library stays yours

Imported books are copied, so the source files are left alone. The library lives in `$XDG_DATA_HOME/omareader`, or `~/.local/share/omareader` by default. Set `OMAREADER_DATA_DIR` for a different location.

OmaReader manages a persistent library: import once, then reopen the book from the app whenever you want. Moving or deleting the source file does not remove the imported copy. Export original retrieves it; Manage storage opens the storage details in Settings. The data directory contains the SQLite database, imported originals, extracted assets, Markdown notes, voice model, and generated audio.

Close OmaReader, then make a checked backup into a **new** directory:

```sh
omareader backup ~/omareader-backup
omareader restore ~/omareader-backup ~/Books/OmaReader
OMAREADER_DATA_DIR=~/Books/OmaReader omareader
```

Backups include books, notes, conversations, reading positions, and generated audio, with checksums verified on restore. Voice models can be downloaded again; browser profiles and session credentials are excluded. Restore refuses to overwrite an existing directory. Notes saved in the database get fresh Markdown mirrors in the restored library. Close older versions too: the backup lock only coordinates versions that implement it.

Unsaved notebook drafts are also kept in browser storage until a successful save, so a failed request does not discard your edits. Markdown mirrors are exports: editing one externally does not write changes back into the notebook database.

```sh
omareader                  # open the desktop reader, once installed
omareader import book.epub  # copy a book into the library
omareader serve 47821       # serve locally and print a session link
```

The session link authenticates access to your library. Keep it private. The server checks Host and Origin, uses an HttpOnly cookie, and sandboxes extracted book assets. It is a local application, not a hosted multi-user library server.

### What goes online

- **Reading, searching, notes, and speech generation:** local after installation. No analytics service is included.
- **Voice installation:** downloads the Kokoro model from the sherpa-onnx project on GitHub. It does not upload your book.
- **AI questions, only when you ask:** send the question, retrieved passages, and recent chat history through the selected provider's CLI. That provider's account, terms, network access, and usage limits apply. OmaReader requests tool-disabled sessions and does not store provider credentials.
- **Links you click in a book:** open in your normal browser.

AI answers can be wrong. Citations are navigation aids, not proof that an answer is correct. Reading, taking notes, and listening work without an AI account.

## Honest limits

This is a working **0.1 application**, not a claim that every book on earth renders perfectly.

- DRM-protected books and password-protected PDFs are not supported.
- Scanned PDFs can display, but search, selection, and narration need a text layer. OCR is not included.
- The exposed narration voices and text normalization are English-focused.
- Complex EPUB styling and unusual document layouts may not survive conversion exactly.
- No built-in cloud sync, native mobile app, podcast generator, or collaborative editing. Portrait layouts are browser-tested; Surface touch/pen and Nook compatibility still need testing on the actual devices.
- Third-party voice models, fonts, libraries, and provider CLIs retain their own licenses and requirements.

## Tests that exercise the app

```sh
cd web && npm ci && cd ..
./scripts/test
```

The Rust tests cover ingestion, sanitization, retrieval, malformed input, note mirrors, and import failures. The browser suite starts a real server and drives Chromium through import, EPUB navigation, PDF rendering and resume, annotations, notebook saves and failures, search, collections, and deletion. Test books are generated from original text; no personal books are checked in. Python 3 generates the fixtures, and `CHROMIUM` can override the browser binary path.

Optional integration checks use actual external dependencies:

```sh
# Downloads the model into a temporary library, generates speech, exports M4B,
# and verifies the result with ffprobe. Allow disk space for download/unpacking.
cd web
OMAREADER_TEST_TTS=1 npm test

# Checks page, selection, chapter, PDF, and unanswerable questions through each signed-in CLI.
# Uses your provider account and its usage allowance.
OMAREADER_TEST_AI=1 npm test
```

Both narration/export and live Claude Code/Codex answers were exercised during the November 2026 readiness review. Routine CI leaves these opt-in network/account tests off. See [the readiness notes](docs/readiness.md) for the scope and limitations of that review.

## Contribute without asking permission

Found a broken book, an inaccessible control, or a better way to keep notes portable? Open an issue or send a patch. A small reproducible example is more useful than a promise that something “should work.” Please use a shareable sample instead of uploading a private book or your library database.

The source is MIT licensed. Fork it. Fix it. Make it useful to someone who is being kept out. Keep the door open.

## A quieter place to read

The five workspaces are Library, Read, Marks, Audio, and Settings. Reading starts with Literata, a comfortable column, and warm dark surfaces. IBM Plex Mono handles the controls. Text and page settings live behind the small typography button; the footer uses document locations for EPUBs and real page numbers for PDFs.

Drag the sidebar divider or use its arrow keys to resize it. Notes and chat can each collapse, and their dimensions are remembered. A narrow window puts the sidebar over the book with a Back to reading action. The command palette is available with Ctrl+Shift+P.

Select a passage to Highlight, Note, or Ask. Notes beside the chapter and the Marks archive use the same annotation records. Marks searches quotations, commentary, book titles, and chapter names; Markdown export includes bookmarks too. Existing standalone notebooks are under Saved writing so older work stays accessible.

Ask attaches a passage without sending anything. The default conversation scope is the current chapter; you can also choose selected text, visible passages, a particular chapter, or retrieval across the book. The request captures its scope and source locations when sent. Later navigation cannot change it. Long chapters and book-wide retrieval disclose partial coverage. Only citation numbers backed by supplied excerpts are linked, and those links return to stable block locations. A citation is still something to check, not a guarantee of the model's interpretation.

Panel preferences and unsent drafts use local browser storage; saved books, marks, settings, conversation context, and citations use the existing local database. Browser drafts are not included in library backups. PDF page questions cover the current physical page, and paragraph boundaries determine visible EPUB context. There is no optional Vim mode or paginated EPUB layout yet.
