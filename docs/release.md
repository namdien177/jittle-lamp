# Releasing Jittle Lamp

## Automated release flow

This repo now includes GitHub Actions automation for stable releases.

- pushing a tag that matches `vX.Y.Z`
- on the current `main` branch HEAD
- with all workspace versions already synced to `X.Y.Z`

triggers a release workflow that:

1. runs `bun install`, `bun run release:check-version`, `bun run typecheck`, `bun test`, and `bun run build`
2. packages the Chromium extension into a release ZIP
3. builds a macOS desktop distribution artifact on `macos-14`
4. creates a GitHub Release with GitHub-generated release notes

The release notes/changelog are generated automatically by GitHub when the release is created. There is no manual changelog editing step in the normal tag flow.

## 1. Prepare a release version

Use the root version as the release source of truth. The extension manifest and workspace `package.json` files are checked for sync.

To bump versions before a release:

```bash
bun run release:set-version 0.1.1
bun install
```

Then commit the version bump, merge it to `main`, and create the release tag:

```bash
git tag v0.1.1
git push origin main --tags
```

`origin` is the GitLab repository, but the release workflow runs on GitHub. Until the migration
finishes, push the same `main` and tag to GitHub as well:

```bash
git push git@github.com:namdien177/jittle-lamp.git main refs/tags/v0.1.1
```

Push `main` before the tag: the workflow rejects a tag that is not the current GitHub `main` HEAD.

## 2. Chromium extension release asset

The release workflow builds the extension from `apps/extension/dist` and publishes:

- `jittle-lamp-extension-vX.Y.Z.zip`

The same tag workflow also submits that ZIP to the Chrome Web Store after the desktop artifact build succeeds. Configure these GitHub Actions environment variables in the `production` environment before tagging a release:

- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`

Also configure these `production` environment variables:

- `CHROME_WORKLOAD_IDENTITY_PROVIDER`: full Google Workload Identity Provider resource name.
- `CHROME_SERVICE_ACCOUNT`: email of the service account linked under Settings → Management → Service account in the Chrome Web Store Developer Dashboard.

The provider must trust only this repository's release workflow on release tags in the `production` environment. Grant that identity `roles/iam.workloadIdentityUser` on the publishing service account. Enable the Chrome Web Store, IAM, Security Token Service, and IAM Service Account Credentials APIs in its Google Cloud project.

GitHub OIDC generates a short-lived token with the `https://www.googleapis.com/auth/chromewebstore` scope immediately before publishing. No client secret, service account key, or refresh token is needed. Local publishing requires a fresh `CHROME_ACCESS_TOKEN` with that scope, plus the publisher and extension IDs.

See [Chrome Web Store publishing](docs/chrome-webstore-publishing.md) for this repository's Google project, provider condition, and verification steps.

The workflow uses the Chrome Web Store v2 publish API. `CHROME_PUBLISH_TYPE` may be set to `STAGED_PUBLISH`; otherwise the workflow uses `DEFAULT_PUBLISH`. `CHROME_DEPLOY_PERCENTAGE` may be set to an integer from `0` to `100` when you want a staged rollout percentage.

Local build commands remain:

```bash
bun run build
# or only the extension
bun run --cwd apps/extension build
```

That build generates the unpacked extension directory containing:

- `manifest.json`
- `background.js`
- `content.js`
- `offscreen.js`
- `popup.js`
- `popup.html`
- `popup.css`
- `offscreen.html`

To install the released extension ZIP:

1. Download `jittle-lamp-extension-vX.Y.Z.zip` from the GitHub Release.
2. Extract it.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder.

To install from a local build instead:

1. Open `chrome://extensions` or the equivalent extensions page in your Chromium-based browser.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `apps/extension/dist`.

## 3. macOS desktop release asset

The release workflow builds a macOS desktop artifact on a macOS runner and publishes a filename that explicitly states whether it is signed:

- `jittle-lamp-desktop-vX.Y.Z-macos-arm64-signed.dmg`
- or `jittle-lamp-desktop-vX.Y.Z-macos-arm64-unsigned.dmg`

The current workflow always produces an **arm64** macOS artifact. It does not claim Intel/universal support.

### Unsigned releases

If Apple signing credentials are not configured in GitHub Actions, the workflow still builds an unsigned DMG. CI explicitly applies and verifies an ad-hoc signature so the app bundle is internally consistent, but that is **not** the same thing as Apple Developer ID signing and notarization.

This means a no-cost Apple account is enough for local development, but it is not enough for a frictionless public macOS installer. Public distribution that opens normally on other Macs requires the paid Apple Developer Program so CI can sign with a Developer ID Application certificate and notarize the DMG/app.

Unsigned macOS releases may still be blocked by Gatekeeper after browser download. For internal installs, use the terminal installer so the DMG is downloaded and copied to `/Applications` without browser quarantine metadata:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash
```

To install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | JITTLE_LAMP_VERSION=vX.Y.Z bash
```

The same terminal installer can be rerun later to replace an existing app with the latest release. The packaged app's Settings screen uses this same installer path for upgrades: it checks GitHub for the latest release, starts the macOS installer in the background, quits the running app, replaces `/Applications/Jittle Lamp.app`, removes the temporary DMG download, and reopens the app. The app does not use Squirrel/ShipIt installation for ad-hoc upgrades.

If the app was already downloaded through a browser and macOS blocks it, remove quarantine manually after installing the app:

```bash
xattr -cr "/Applications/Jittle Lamp.app"
```

After clearing quarantine, open the app from Finder once. Users may still need to right-click **Open** on the first launch depending on their macOS security settings.

### Signed and notarized releases

If the required Apple credentials are available in GitHub Actions, the desktop build enables Electron Builder code signing + notarization automatically and the published DMG filename switches to `signed`.

The workflow supports these secrets:

- `MACOS_CSC_LINK` + `MACOS_CSC_KEY_PASSWORD`
- either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
- or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`

The API-key path is preferred for CI when App Store Connect API credentials are available.

Desktop packaging is split by environment:

```bash
bun run --cwd apps/desktop package:local
bun run --cwd apps/desktop package:ci
```

Use `package:local` on a developer machine; it loads the workspace `.env` before invoking Electron Builder so local signing/notarization credentials are available. Use `package:ci` in CI/CD; it only uses the environment variables injected by the workflow.

The desktop renderer receives auth/API configuration at build time. Release builds require these GitHub Actions environment secrets in the `production` environment before the tag workflow runs:

- `CLERK_PUBLISHABLE_KEY`
- `JITTLE_LAMP_API_ORIGIN`
- optional: `JITTLE_LAMP_WEB_ORIGIN`

Setting these only in the backend/deployment host is not enough for the macOS desktop artifact, because the packaged app cannot read that server environment after it has been built.

With the checked-in config, Electron Builder writes build output into:

- `apps/desktop/artifacts/`

The release workflow collects the install-oriented DMG from `apps/desktop/artifacts/`.

In-app desktop update checks read the latest GitHub release and hand installation to `scripts/release/install-macos-desktop.sh`. The macOS job also publishes `latest-mac.yml`, ZIP, and blockmap artifacts so older installed versions that still use Electron Builder's updater can discover the release and prompt users onto the installer-backed path. Updates are available only from packaged builds, not from `bun run --cwd apps/desktop dev`.

## 4. Release notes specific to this repo

- The release workflow only accepts stable tags that match `vX.Y.Z`.
- The tag must point at the current `main` HEAD.
- `bun run release:check-version` fails if any workspace package version drifts from the root release version.
- The extension companion integration assumes the desktop companion intake server runs on `http://127.0.0.1:48115`.
- The desktop companion output folder can be changed through the desktop UI or the CLI helper:

```bash
bun run --cwd apps/desktop set-output "/absolute/path"
```

For the desktop app specifically:

- `bun run --cwd apps/desktop dev` builds and starts the Electron desktop app with the companion intake server on `http://127.0.0.1:48115`.
- `bun run --cwd apps/desktop set-output "/absolute/path"` changes the folder where the companion writes sessions.
- `bun run --cwd apps/desktop package:local` attempts a local Electron Builder package build with workspace `.env` loaded.
- `bun run --cwd apps/desktop package:ci` attempts a CI Electron Builder package build using only environment-provided secrets.
- `bun run --cwd apps/desktop build` performs the repository's lightweight desktop shell build validation used by the workspace root.

The companion only accepts artifact writes from `chrome-extension://` origins and rejects normal web origins. It does not currently pin a single extension ID. Output-folder changes happen through the desktop app or CLI, not over HTTP.
