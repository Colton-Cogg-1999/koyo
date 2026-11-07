# OmaReader

A local-first Linux reader for EPUB, PDF, Markdown, HTML, and plain text. Keep your books, highlights, notes, reading position, and generated audiobooks together on your own machine.

- Read reflowable books or original PDF pages, with search and chapter navigation.
- Highlight passages and keep notes mirrored to Markdown files.
- Ask questions about a book through your separately installed and authenticated Codex or Claude Code CLI.
- Generate narration locally with Kokoro through sherpa-onnx, with read-along highlighting and audiobook export.
- Follow the Omarchy desktop theme, with a standalone browser app window.

This is an early 0.1 release. Reading works offline after installation; AI questions require your provider connection, and narration needs a model download on first use. DRM-protected EPUBs are unsupported. Scanned PDFs require an existing text layer; OCR is not included.

## Build and run

Install Rust stable, Node.js 26 and npm, a C/C++ toolchain, and Linux runtime tools: Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdftohtml`), FFmpeg, and Chromium (or another Chromium-based browser). `xdg-open` is the fallback if no supported app-window browser is found.

```sh
./scripts/build
./target/release/omareader
```

The frontend must be built before Rust, because the release binary embeds `web/dist`. The scripts use the committed npm and Cargo lockfiles. Compilation of sherpa-onnx can require network access for its native runtime.

For an Arch package after building:

```sh
cd pkgbuild
makepkg -si
```

## Commands

```sh
omareader                    # open the desktop window
omareader serve 47821        # print a session URL and serve on loopback
omareader import book.epub notes.md
```

Treat the printed session URL as private: it authenticates access to your local library. The server binds to 127.0.0.1, checks Host and Origin, and uses an HttpOnly session cookie.

| Key | Action |
| --- | --- |
| `/` | Search |
| `1`–`6` | Switch workspaces |

## Data and privacy

The library is stored in `$XDG_DATA_HOME/omareader`, defaulting to `~/.local/share/omareader`. Set `OMAREADER_DATA_DIR` to use a separate library. Imported originals are copied into the library; notes are mirrored under `notes/`. Back up the entire directory while the application is stopped, including its SQLite database, books, notes, models, and audio.

AI requests send your question and relevant book passages to the selected provider through its CLI. Provider access and usage limits are separate from OmaReader. Local reading and narration do not require an AI subscription.

## Development and checks

```sh
cd web && npm ci && cd ..
./scripts/test
```

The suite covers ingestion, sanitization, retrieval, speech normalization, and Chromium-driven reader workflows. Set `CHROMIUM` if your browser binary is not `/usr/bin/chromium`. Browser tests use a temporary library and require an environment that permits local sockets and Chromium processes.

`src/` contains the Rust server and processing pipeline; `web/` contains the current React UI. Earlier prototypes and personal design references are intentionally excluded from the repository.

Licensed under MIT; see LICENSE. Third-party dependencies and downloaded voice models retain their own licenses.

## Publish your checkout

After signing into GitHub as `Colton-Cogg-1999`, run `./scripts/publish --private` (or `--public`). This creates a new `Colton-Cogg-1999/omareader` repository and pushes the committed branch. It refuses a different account, a dirty checkout, or an existing origin remote.
