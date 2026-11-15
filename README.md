# collab-tex

A real-time collaborative LaTeX and Beamer editor. Open a link, share it, and
everyone edits the same document with a live PDF preview.

## Run it

Requires Node.js 24+ and a TeX distribution with `pdflatex` on the PATH
(without TeX, editing works but there is no preview).

```bash
npm install
npm run dev
```

Then open http://localhost:5173. On this machine Node.js is a portable copy in
`.tools/node`, so run `dev.cmd` instead, or put `.tools\node` on your PATH.

```bash
npm test          # server tests; the pdflatex ones skip if TeX is missing
npm run typecheck
```

## How it works

```
browser ── WebSocket /ws/:doc ──────────▶ Room (one per document)
  CodeMirror + Yjs replica                 Yjs replica, presence, sockets
                                             │ on change
browser ◀─ SSE /api/docs/:doc/events ──── Compiler ──▶ pdflatex
browser ── GET /api/docs/:doc/pdf ──────▶ latest PDF (kept in memory)
```

- **Sync.** Each browser and the server hold a replica of the document as a
  CRDT (Yjs). Edits are exchanged as small updates and merge without conflicts,
  including edits made offline. `server/src/room.ts` implements the sync and
  presence protocol directly on top of `ws`.
- **Projects.** A document is a project: `main.tex` plus any number of other
  text files (`.tex`, `.sty`, `.bib`, ...) in folders, each one a shared text
  inside the CRDT, and uploaded figures (PDF, PNG, JPEG), which are stored on
  disk by `server/src/assets.ts` and only listed in the CRDT. Add them with
  "Add files" or "Add folder" in the file list.
- **Untrusted file names.** File names come from browsers and become paths on
  the server, so `shared/project.ts` defines one strict rule for what a path
  may be (no `..`, absolute paths, hidden files or unknown types). It is
  checked at every point a name reaches the disk.
- **Persistence.** `server/src/store.ts` writes each document's state to
  `data/docs/` shortly after it changes, atomically (temp file, then rename).
  Rooms are loaded on demand and evicted when the last person leaves.
- **Compiling.** The server, not each browser, decides when to compile: one
  compile per pause in typing however many people are editing, skipped when the
  source has not changed, with a cap on concurrent TeX processes
  (`server/src/compiler.ts`). Results are pushed to every browser over
  Server-Sent Events.
- **Running TeX safely.** `server/src/latex.ts` runs `pdflatex` with a fixed
  argument list, shell escape disabled, and a timeout. This is not yet a full
  sandbox; see below.

## Not done yet

- **Sandboxing.** TeX can still read any file the server user can read.
  Compiles must run in a container before this is exposed to the internet.
- **Accounts and permissions.** Anyone with a document's link can edit it.
- **File management.** Files can be added and deleted but not renamed or
  moved, and figures cannot be previewed on their own.
- **Deployment.** `npm start` builds the web app and serves it from the API
  server, but nothing is hosted yet.
