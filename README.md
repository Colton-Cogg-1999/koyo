# Kōyō 紅葉

**I'm not going to tell you where to get your books. When you find some, read them here.**

That's the idea. Put your EPUBs and PDFs on a shelf, read them, scribble in the margins, and pick up where you left off. If a paragraph makes no sense, ask about it, and check the answer against the actual page.

I don't think access to information should depend on whether you have the right university email or another twenty dollars a month. A reader shouldn't become another toll booth. There is no Kōyō account, subscription, or premium tier. Your books stay on your machine. Your notes can leave with you.

This is an open-source project because I want something I can use, fix, and keep using. You should be able to do the same. It isn't finished, and I'm not going to pretend a chatbot with a citation button is automatically a research tool. The work is making reading, notes, and answers trustworthy enough to use every day.

AI is optional. Sometimes you just want to read a damn book.

*Kōyō (紅葉) is the turning of the autumn leaves, the season Japanese tradition sets aside for reading by lamplight. The mark is the rising sun: a red disc, and nothing else.*

## What it does

Three things, done carefully: **read**, **take notes**, and **ask questions of the page**.

Kōyō is a Linux desktop reader with a Rust backend and a React interface, opened in a dedicated Chromium app window. The backend serves only on your machine's loopback address.

| | What you get |
| --- | --- |
| Read | EPUB chapters, original PDF pages, Markdown, HTML, and plain text, with your place saved as you go |
| Notes | Four highlight colours, notes beside the passage, and Markdown mirrors you can take anywhere |
| Ask | Questions about the passage, the screen, the chapter, or the whole book, answered with citations through Claude Code or Codex CLI |
| Look | Day (warm paper) and night (steel), three typefaces, size and measure |

There is also import code for DOCX and FB2, and optional conversion through Calibre for formats including MOBI and AZW3. Those paths have less coverage than EPUB and PDF; report files that do not import correctly.

Offline narration (Kokoro text-to-speech and M4B export) still exists in the source, but it is no longer built by default; see [Narration](#narration).

## Run it

You need Rust stable, Node.js 26 with npm, a C/C++ build toolchain, Poppler, and a Chromium-based browser. On Arch:

```sh
sudo pacman -S --needed base-devel rust nodejs npm poppler chromium xdg-utils

git clone https://github.com/Colton-Cogg-1999/koyo.git
cd koyo
./scripts/build
./target/release/omareader
```

Check `node --version`: the frontend toolchain expects Node 26, also specified in `mise.toml`. The build installs locked JavaScript dependencies, builds the interface, then embeds it into the release binary. The command, package, and data directory are still named `omareader` while the rename settles.

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

On other Linux distributions, install equivalent build tools and runtime packages, then use `scripts/build`. Chromium, Chrome, Brave, and Edge are detected for app-window mode; `xdg-open` is the fallback.

## How it works

There are two places: the **shelf** and the **page**.

On the shelf, the book you are reading waits at the top. Click it to continue. Add books with the button or by dropping files anywhere. Each book's `⋯` menu downloads the original, exports its notes, or removes it.

On the page, select any passage and a small bar appears under it:

- **A colour** highlights it in one click.
- **Note** highlights it and opens the note beside it, already focused.
- **Ask Kōyō** attaches the passage to a question.

Click an existing highlight to recolour or remove it in place. Everything else lives in one card on the right with three tabs: **Ask**, **Notes** (passages you wrote about, and saved answers), and **Highlights** (every marked passage). The book icon opens contents and in-book search. The settings icon holds the theme, typeface, size, and width. The bar at the bottom shows the chapter and your progress; drag it to move through the book.

## Ask something useful

Open **Ask**, or select text and choose **Ask Kōyō**. The menu under the question box says what the answer may draw on:

- **From the passage**: just the text you selected.
- **From what's on screen**: the paragraphs in view (for PDFs, the current page's text layer).
- **From this chapter**: the chapter you are in. This is the default.
- **From the whole book**: retrieval across the book.

The empty card offers three starting points: summarize this chapter, explain its key idea, or quiz me. A question captures its scope and source locations when you send it, so later navigation can't change what it was about. Long chapters and whole-book questions may be sampled; partial coverage is disclosed under the answer. This isn't a claim that the model has read every word. Answers are instructed to stick to supplied evidence and say when it isn't enough. Only citation numbers backed by supplied excerpts are linked, and those links return to the passage. **Save to notes** keeps an answer with its source references.

Highlights store text locations rather than screen pixels for EPUBs, and page-relative rectangles for PDFs. EPUB quotation checks catch stale offsets; a unique match can recover a shifted passage. If a safe match isn't possible, the reader tells you instead of highlighting unrelated text. That is not automatic migration between different editions of a book.

## Keyboard

| Key | Action |
| --- | --- |
| `Space`, `PageDown`, `→` | Read forward |
| `Shift+Space`, `PageUp`, `←` | Read backward |
| `[` / `]` | Previous / next chapter |
| `c` | Contents |
| `/` or `Ctrl+F` | Search in this book (on the shelf, `/` finds a book) |
| `q` / `Ctrl+J` | Ask |
| `n` / `h` | Notes / Highlights |
| `d` | Day or night |
| `Esc` | Close the selection bar or the card |
| `Enter` / `Shift+Enter` | Send a question / new line |
| `Ctrl+Enter` | Finish a note |

## Your library stays yours

Imported books are copied, so the source files are left alone. The library lives in `$XDG_DATA_HOME/omareader`, or `~/.local/share/omareader` by default. Set `OMAREADER_DATA_DIR` for a different location.

Import once, then reopen the book from the shelf whenever you want. Moving or deleting the source file does not remove the imported copy; **Download original** retrieves it. The data directory contains the SQLite database, imported originals, extracted assets, and Markdown notes.

Close Kōyō, then make a checked backup into a **new** directory:

```sh
omareader backup ~/koyo-backup
omareader restore ~/koyo-backup ~/Books/Koyo
OMAREADER_DATA_DIR=~/Books/Koyo omareader
```

Backups include books, notes, conversations, and reading positions, with checksums verified on restore. Browser profiles and session credentials are excluded. Restore refuses to overwrite an existing directory. Notes saved in the database get fresh Markdown mirrors in the restored library.

Notes save as you type. If a save fails, the draft stays in browser storage and stays visible in Notes until it saves, so a failed request does not discard your words. Markdown mirrors are exports: editing one externally does not write changes back.

```sh
omareader                  # open the desktop reader, once installed
omareader import book.epub  # copy a book into the library
omareader serve 47821       # serve locally and print a session link
```

The session link authenticates access to your library. Keep it private. The server checks Host and Origin, uses an HttpOnly cookie, and sandboxes extracted book assets. It is a local application, not a hosted multi-user library server.

### What goes online

- **Reading, searching, and notes:** local. No analytics service is included.
- **AI questions, only when you ask:** send the question, the quoted passages, and recent chat history through the selected provider's CLI. That provider's account, terms, network access, and usage limits apply. Kōyō requests tool-disabled sessions and does not store provider credentials.
- **Links you click in a book:** open in your normal browser.

AI answers can be wrong. Citations are navigation aids, not proof that an answer is correct. Reading and taking notes work without an AI account.

## A small footprint

The window is one local page, so the launcher switches off browser services it never uses (extensions, sync, component updates, background networking) and keeps one renderer process. PDF rendering loads only when you open a PDF. Two typefaces ship with the app, plus two small subsets for the 紅葉 mark.

Measured on the shelf page against the previous release (headless Chromium, PSS): the window dropped from about 387 MB in 12 processes to about 342 MB in 9, the server from 27 MB to 9 MB, and the binary from 46 MB to 18 MB.

## Narration

Offline narration links the ONNX runtime, which roughly triples the binary, so it is off by default while Kōyō focuses on reading, notes, and questions. The code is intact. To build it in:

```sh
cargo build --release --locked --features narration
```

That build needs FFmpeg and serves the narration API (Kokoro voices, read-along timing, resumable tracks, M4B export). The current interface has no audio controls, so narration is reachable through the API only until it returns to the UI.

## Honest limits

This is a working **0.1 application**, not a claim that every book on earth renders perfectly.

- DRM-protected books and password-protected PDFs are not supported.
- Scanned PDFs can display, but search, selection, notes, and questions need a text layer. OCR is not included.
- Complex EPUB styling and unusual document layouts may not survive conversion exactly.
- Bookmarks, collections, favorites, and the standalone notebook were removed from the interface to keep it focused. Their data and API endpoints remain.
- No built-in cloud sync, native mobile app, or collaborative editing. Narrow and portrait windows are browser-tested; Surface touch/pen and Nook compatibility still need testing on the actual devices.
- Third-party fonts, libraries, and provider CLIs retain their own licenses and requirements. Shippori Mincho is under the SIL Open Font License (`web/public/fonts/SHIPPORI-MINCHO-OFL.txt`).

## Tests that exercise the app

```sh
cd web && npm ci && cd ..
./scripts/test
```

The Rust tests cover ingestion, sanitization, retrieval, malformed input, note mirrors, and import failures. The browser suite starts a real server and drives Chromium through import, EPUB navigation, PDF rendering and resume, highlights and notes (including failed saves and anchor recovery), search, the Ask card's scopes and citations, appearance, narrow layouts, and deletion. Test books are generated from original text; no personal books are checked in. Python 3 generates the fixtures, and `CHROMIUM` can override the browser binary path.

Optional integration checks use actual external dependencies:

```sh
# Checks page, selection, chapter, PDF, and unanswerable questions through each signed-in CLI.
# Uses your provider account and its usage allowance.
cd web
OMAREADER_TEST_AI=1 npm test

# Needs a `--features narration` debug build. Downloads the voice model into a temporary
# library, generates speech, exports M4B, and verifies it with ffprobe.
OMAREADER_TEST_TTS=1 npm test
```

Routine CI leaves these opt-in network/account tests off. See [the readiness notes](docs/readiness.md) for the scope and limitations of the November 2026 review.

## Contribute without asking permission

Found a broken book, an inaccessible control, or a better way to keep notes portable? Open an issue or send a patch. A small reproducible example is more useful than a promise that something “should work.” Please use a shareable sample instead of uploading a private book or your library database.

The source is MIT licensed. Fork it. Fix it. Make it useful to someone who is being kept out. Keep the door open.
