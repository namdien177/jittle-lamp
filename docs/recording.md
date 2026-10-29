# Recording, archives and storage

## Extension workflow

1. Run `bun run build` or `bun run --cwd apps/extension build`.
2. Optional but recommended: run `bun run --cwd apps/desktop set-output "/absolute/path"` once.
3. Start the desktop companion with `bun run --cwd apps/desktop dev` so captured artifacts are handed to the app.
4. Load `apps/extension/dist` as an unpacked extension in Chromium.
5. Open an `http://` or `https://` tab and open the extension popup.
6. Press **Start** and grant site access when prompted so capture can survive normal navigations.
7. Interact with the page, then press **Stop**.
8. If the companion server is running, artifacts are handed to the desktop app. Otherwise Chromium prompts you to save the session artifacts:
   - `recording.webm`
   - `session.archive.json`

### Recorder architecture

- **popup**: start/stop/status UI
- **background**: canonical session controller, storage checkpointing, and debugger bridge
- **offscreen document**: `MediaRecorder`, chunk aggregation, and fallback browser download export
- **desktop companion server**: localhost intake route used by the extension to hand artifacts to the app
- **content script**: content-ready + interaction capture (`click`, `input`, `submit`, `navigation`)

The exported JSON is the shared session archive rather than a bare event array. The recorder intentionally avoids raw typed field values and strips query/hash fragments from captured page URLs. Network request URLs keep their query string, but sensitive parameters are masked, as are credentials and cookies (see below).

### Expanded network capture

When the Chrome debugger is attached, the recorder now exports richer per-request network events built from the existing CDP path:

- request headers and associated cookies
- request post data / body when CDP exposes it
- response headers plus parsed `set-cookie` headers/cookies
- response bodies captured after `Network.loadingFinished`, except static assets (images, fonts, media, CSS, scripts) and binary bodies, which keep only their size
- omission/truncation metadata when bodies are unavailable or too large to store in-session

Requests are captured from both CDP and an in-page probe; duplicates from the two sources are dropped.

### Session archive compaction

Every archive goes through `compactSessionArchive` (`packages/shared/src/archive-compaction.ts`) before it leaves the recorder. The extension, the e2e runner and the backend all use it:

- CORS preflight (`OPTIONS`) and analytics/beacon requests are removed; their count is written to the archive `notes`.
- Static assets keep URL, status, timing and size only; binary bodies are replaced by their byte length.
- Sensitive header values (`Authorization`, `Cookie`, `Set-Cookie`, API keys, CSRF tokens), cookie values, sensitive query parameters and body fields such as `password` or `token` are masked to `<first 4>****<last 4>`. Values shorter than 12 characters are masked entirely.
- Repeated console lines in a row collapse into one with a `(×N)` count; the console section is capped at 3000 lines, dropping the oldest debug/info lines first.
- Archives are written without indentation.

Older archives are compacted lazily: opening an evidence whose archive was compacted with an older `archiveCompactionVersion` (or never) queues a background job on the backend. It rewrites the stored object under the same key, in the schema version it was stored with, and updates `bytes` and `checksum` on every artifact row sharing it. Organisations in the middle of a migration or storage transfer are skipped until it finishes. When the rules change, bump `archiveCompactionVersion` so existing archives are compacted again.

## Evidence storage

- S3 storage gzips JSON artifacts of 1 KB or more and stores them with `Content-Encoding: gzip`. Browsers and `fetch()` decompress signed-URL downloads on their own, and `getObject` returns the original bytes. Checksums in the database are those of the uncompressed file.
- Uploads to the JittleLamp default storage are capped per organisation per UTC day: 100 MB for personal workspaces and 3 GB for organisations (`apps/backend/src/services/daily-upload-quota.ts`). Organisations writing to their own S3 storage are not limited. Over the limit, upload routes return `429 DAILY_UPLOAD_LIMIT_EXCEEDED`.

The popup still shows session status locally, but it now receives a typed active-session summary instead of the full live event draft so larger sessions do not obviously break the popup path.
