# Offline-first test scenarios

This document captures the automated gates that protect local/offline behavior while enabling additive remote loading strategies.

## Required scenarios

1. **Web local ZIP import works with network disabled**
   - Automated in `tests/session-strategies.test.ts`
   - Test: `local ZIP strategy works offline with fetch disabled`
   - Guard: local strategy must never depend on `fetch` or network availability.

2. **Desktop local session loading does not require auth**
   - Automated in the native app's `jl-core` crate (`bun run --cwd apps/desktop test`)
   - Tests: `library::tests::load_session_mirrors_archive_and_seeds_notes`, `library::tests::load_folder_reads_ad_hoc_folders`
   - Guard: the local library loads sessions from disk without tokens or remote credentials.

3. **Remote mode remains additive**
   - Automated in `tests/session-strategies.test.ts`
   - Tests:
     - `remote ZIP strategy is additive and can load without auth`
     - `remote ZIP strategy forwards bearer auth when provided`
   - Guard: remote strategy uses optional auth and reuses shared ZIP parsing behavior; it does not replace local flow.

## CI command

Run the full suite:

```bash
bun test
```

Or run only strategy gates:

```bash
bun test tests/session-strategies.test.ts
```
