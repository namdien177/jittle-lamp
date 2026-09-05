# Repository audit, 5 September 2026

Reviewed baseline `cf17ab2`, with changes in this worktree. Inspection focused on extension capture, finalization, upload, recovery and controls; backend upload storage and completion; desktop sync; manual web uploads; and shared session contracts. The full test suite also covers viewer, network, authorization and migration behavior. This is a source and local-runtime audit, not proof of a particular production incident.

## Fixed

| Severity | Finding and trigger | Change |
| --- | --- | --- |
| High | Upload failure detail was hidden inside the collapsed overlay. Polling replaced an action error with generic ready text. The overlay had no retry action; the popup used an undiscoverable clickable status badge. | Persistent visible errors and explicit Retry / Save locally buttons in both interfaces. |
| High | Finalized blobs existed only in offscreen memory. Closing that context or starting another session could destroy the only recoverable recording. | Retain finalized blobs and archive in extension-origin IndexedDB before upload; reload them for retry/export. Starting a new recording requires saving, successful upload or explicit discard of the failed session. |
| High | The byte budget discarded the over-limit chunk and subsequent final flush, risking truncated WebM output. | Preserve every chunk and request stop once. Reject cloud uploads above the server's 60 MiB video / 100 MiB archive limits before checksumming or upload; offer local export. |
| High | The offscreen local fallback clicked a hidden anchor and assumed success without observing the download. | Route blob URLs to the background downloads API. Wait for completion, report interruption/cancellation, and retain recovery data until both files complete. Only the extension's offscreen document may request this operation. |
| Medium | Upload start responses were trusted by type assertion. Missing artifact sessions, including an empty array, could be treated as successful upload. | Validate that the response supplies exactly one recording session and one archive session. |
| Medium | Copy URL could extract a URL from an error message. | Enable the overlay's Copy URL only for a completed session. |

Chrome only exposes the runtime extension API to offscreen documents, which is why download completion belongs in the background. [Chrome offscreen documentation](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

Changed implementations: [background](../apps/extension/src/background.ts), [offscreen](../apps/extension/src/offscreen.ts), [recovery storage](../apps/extension/src/pending-recording.ts), [download completion](../apps/extension/src/local-download.ts), [capture budget](../apps/extension/src/recording-capture-policy.ts), [recording bar](../apps/extension/src/content.ts), [popup](../apps/extension/src/popup.ts).

## Open findings

1. **High: interrupted desktop re-sync can remove a previously usable cloud recording.** The sync-start handler deletes the old artifact rows and stored objects before the client uploads replacements. Reproduce by syncing an existing evidence ID, then disconnecting before PUT. The evidence now points only to unfinished artifacts. See `apps/backend/src/routes/evidence-uploads.ts:771` and `:843`; the existing `replaces cloud artifacts when resyncing a desktop session` test verifies that replacement rows are still `uploading` after start. Stage replacement artifacts and switch the active set only after every upload completes. This backend transaction change is not included here.

2. **Medium: a lost upload-start response can produce duplicate pending evidence.** The backend only reuses evidence when the client supplies `replaceEvidenceId`. If the initial POST commits but its response is lost, the extension does not know that ID; retry inserts another evidence row and changes the desktop-session mapping. See `apps/backend/src/routes/evidence-uploads.ts:694`, `:749`, and the extension's upload-start request. Make upload start idempotent for the authenticated organization/session, including concurrent requests. This is not included here.

## Recording bar

The normal bar is one row, 48px high. It keeps Start or Pause/Resume and Stop, Move, Copy URL and Close. The capture-target toggle remains available before recording. Account details, expansion, sound settings and the active-recording abort button were removed from the overlay. Existing popup settings remain available.

Opacity is 55% without hover or focus, and 100% during interaction or an error. Failure text adds a bounded message area; measured failure height was 84px at both 1280px and 390px viewports. Move supports pointer dragging and arrow keys.

## Verification

- `bun run typecheck`: passed.
- `bun run build`: passed for the workspace. The extension was rebuilt after final UI refinements.
- `bun test`: 295 passed, 0 failed across 35 files.
- Focused regression checks cover preservation after failed upload, rejected replacement recording, canceled local save, confirmed save, rejecting page-origin download requests, completion-event races and preserving final recorder chunks.
- Real Chromium exercised the compiled bar using simulated extension messages. Checked recording controls, persistent HTTP 413 error, retry, local save, copy, drag, keyboard movement and close.
- Real Chromium exercised the compiled offscreen recovery code with real IndexedDB and a generated 14,654-byte WebM. Reload retained both artifacts. Canceling local save retained the recovery record; successful save cleared it. A synthetic 61 MiB payload was rejected before any upload request and then exported with all 63,963,136 bytes. A simulated cloud retry uploaded and completed both artifacts while retaining the existing evidence ID.
- `git diff --check`: passed.

Local browser receipts and screenshots are in `output/playwright/`. The browser fixtures simulate cloud HTTP and download responses; the background download completion checks use the Chrome API contract in unit tests. Native Save As dialogs, a loaded extension recording a live tab, production connectivity and deployment were not verified.

Recovery starts after recording finalization. It does not recover an active recording lost in a browser crash, or recordings already lost by an older extension. If browser storage rejects the recovery copy, the in-memory copy remains available and the error asks the user to keep the browser open and save locally.
