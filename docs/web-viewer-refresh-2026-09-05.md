# Web viewer refresh, 2026-09-05

The web viewer now gives the viewport to the recording and session timeline. Actions, Requests, Logs and Info remain visible. Discussion and tags expand below the recording; rename, copy, AI prompt and transfer sit in an options menu. The library has a smaller header, fewer navigation items and no duplicate upload or search controls. Local ZIP review uses the same full-page layout.

## Loading changes

- `/evidences/:id/playback` replaces the artifact list, two signed-read requests and evidence-detail request with one authorized response. It checks membership, both view and download permissions, deletion and upload status. It signs only the chosen committed recording and archive, keeps the response private, and records access activity.
- Uploader profile lookup runs when Info opens. Comments and available tags load when discussion opens. AI tokens load on the explicit copy-prompt action.
- WebM and MP4 use the browser player with existing custom controls. Video.js remains a lazy fallback for adaptive streams. Settings, organization management and library routes load separately.
- Large timelines render visible rows plus a small margin. Search, scrolling, keyboard navigation and playback follow work across the complete session.

## Local measurements

The original production entry was saved before this change. The new measurement sums all JavaScript resources actually loaded by the production build for a WebM ZIP review, including shared and route chunks.

| Measurement | Before | After |
| --- | ---: | ---: |
| Loaded JavaScript, uncompressed | 2,027,301 bytes | 1,207,821 bytes |
| Same scripts, gzip per file | 583,815 bytes | 356,350 bytes |
| Evidence playback setup API calls | 4 | 1 |

JavaScript is 40.4% smaller uncompressed. The cloud fixture also makes its account-profile request, then downloads the archive and video. Those requests are separate from the playback setup count.

A generated 10,000-action archive with a real WebM rendered in 159 ms after local file selection, with 24 rows mounted initially. This is a local fixture result, not a production or network benchmark. Final keyboard and fullscreen checks mounted 25 rows.

## Verification

- `bun run typecheck` and `bun run build` passed.
- `bun run --cwd apps/backend lint` passed.
- `bun test` passed: 297 tests across 37 files. The affected viewer tests were also rerun after the final UI changes.
- Backend integration test covers committed artifact selection, both permission gates, missing membership, unauthenticated access, incomplete uploads, deleted evidence and private response headers.
- Chromium at 1440×900 and 390×844: recording playback, pause, speed, seek, active-row follow, search, last-row access, request details, fullscreen, keyboard navigation, options, deferred profile loading and return to library passed. No browser errors were observed. Mobile header and tab strip are each 56 px; document width stays at 390 px.
- Cloud UI verification used local API fixtures. It observed one playback request and no comments, tag-list or AI-token request before interaction. Backend authorization was tested separately against a migrated local database.

Screenshots and raw receipts are in the ignored `output/web-refactor/` directory: `cloud-desktop.png`, `cloud-mobile.png`, `library.png`, `browser-checks.txt`, `cloud-checks.txt`, `final-checks.txt` and `performance.json`.

## Delivery limits

Deploy the backend playback endpoint before or alongside the web build. No production loading measurement or deployment was performed. Live adaptive streams and Firefox/Safari were not exercised; the adaptive player and existing Firefox WebM buffering path remain available. Archive download and parsing still precede timeline display.
