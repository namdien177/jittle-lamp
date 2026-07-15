# Local recording test

This test records a real local page and checks both saved assets.

## Start

Use three terminals.

```bash
# Terminal 1: page with motion, actions, logs, and network calls
bun run dev:recording-fixture

# Terminal 2: save artifacts under the repo
JITTLE_LAMP_OUTPUT_DIR="$PWD/output/recording-test/sessions" bun run dev:recording-companion

# Terminal 3: build the unpacked extension
bun run --cwd apps/extension build
```

Load `apps/extension/dist` from `chrome://extensions`.

Open:

```text
http://127.0.0.1:4399/?run=full-assets#start
```

## Record

1. Click **Enable test audio**.
2. Start an active-tab recording.
3. Type `Local recording test` in **Name**.
4. Select **Full assets**.
5. Check **Confirm**.
6. Click **Run full asset test**.
7. Click **Submit form**.
8. Click **Test navigation**.
9. Wait two seconds.
10. Finish the recording.

## Validate

```bash
bun run test:recording-assets -- output/recording-test/sessions --fixture
```

The command fails unless it finds:

- A real, non-empty WebM file with duration.
- A valid schema v3 `session.archive.json`.
- Exact file sizes in both artifact records.
- Matching action and request summary counts.
- Click, input, keyboard, submit, and navigation events.
- Info, warning, and error console events.
- CSS, JavaScript, SVG, fetch, XHR, POST, and error network calls.
