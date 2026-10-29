# Releasing Jittle Lamp

## Automated release flow

This repo now includes GitHub Actions automation for stable releases.

- pushing a tag that matches `vX.Y.Z`
- on the current `main` branch HEAD
- with all workspace versions already synced to `X.Y.Z`

triggers a release workflow that:

1. runs `bun install`, `bun run release:check-version`, `bun run typecheck`, `bun test`, and `bun run build`
2. packages the Chromium extension into a release ZIP
3. builds, signs and packages the native macOS desktop app as a DMG on `macos-15`
4. creates a GitHub Release with GitHub-generated release notes

The release notes/changelog are generated automatically by GitHub when the release is created. There is no manual changelog editing step in the normal tag flow.

## 1. Prepare a release version

Use the root version as the release source of truth. The extension manifest, workspace `package.json` files and the desktop app's `apps/desktop/Cargo.toml` (`[workspace.package] version`) are checked for sync; `release:set-version` updates all of them and `apps/desktop/Cargo.lock`.

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

The desktop app is the native macOS app in `apps/desktop` (Rust + GPUI, macOS 15+). The `build-desktop` job runs on `macos-15`, installs Rust stable with rustup, and runs `bun run release:package-desktop` (`scripts/release/package-macos-desktop.sh`). That script:

1. runs `apps/desktop/scripts/bundle.sh`, which builds a static libvpx for macOS 15, builds the release binary and signs `apps/desktop/target/bundle/Jittle Lamp.app` (hardened runtime);
2. when signing, notarizes the app with `xcrun notarytool` and staples the ticket;
3. wraps the app in `apps/desktop/target/bundle/jittle-lamp-desktop-X.Y.Z-macos-arm64.dmg` with `hdiutil`, then signs, notarizes and staples the DMG when signing.

`bun run release:collect-desktop` copies that DMG to `release-artifacts/` under the release asset name.

### Unsigned releases

If Apple signing credentials are not configured in GitHub Actions, the workflow still builds an unsigned DMG. The app gets an ad-hoc signature, which CI verifies, so the bundle is internally consistent, but that is **not** the same thing as Apple Developer ID signing and notarization.

This means a no-cost Apple account is enough for local development, but it is not enough for a frictionless public macOS installer. Public distribution that opens normally on other Macs requires the paid Apple Developer Program so CI can sign with a Developer ID Application certificate and notarize the DMG/app.

Unsigned macOS releases may still be blocked by Gatekeeper after browser download. For internal installs, use the terminal installer so the DMG is downloaded and copied to `/Applications` without browser quarantine metadata:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash
```

To install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | JITTLE_LAMP_VERSION=vX.Y.Z bash
```

The app has no in-app updater yet; rerun the installer to replace an existing app with the latest release. Releases no longer publish `latest-mac.yml` or ZIP/blockmap updater files, so Electron builds installed before the native app do not see new releases; reinstall those with the installer.

If the app was already downloaded through a browser and macOS blocks it, remove quarantine manually after installing the app:

```bash
xattr -cr "/Applications/Jittle Lamp.app"
```

After clearing quarantine, open the app from Finder once. Users may still need to right-click **Open** on the first launch depending on their macOS security settings.

### Signing with the LittleLives Apple team

The mobile apps (aion-mobile) sign with team `8A9LJ95YH5` through fastlane match and ship through
App Store uploads. A Mac app published outside the App Store needs two more things from the same
team; nothing in the mobile setup provides them yet:

1. **A Developer ID Application certificate.** Only the team's Account Holder can create one
   (developer.apple.com → Certificates → Developer ID Application). It can live in the same match
   repo: `fastlane match developer_id --app_identifier dev.jittlelamp.desktop --team_id 8A9LJ95YH5`
   (writable once, `--readonly` afterwards). Export it as a `.p12` for CI.
2. **Notarization credentials.** The App Store Connect API key the mobile lanes already use works
   for `notarytool` (Developer role or higher). `package-macos-desktop.sh` reads aion-mobile's
   variable names directly: `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_PATH` or `ASC_KEY_CONTENT`.

Locally, with the certificate in your login keychain:

```bash
security find-identity -v -p codesigning        # note the "Developer ID Application: …" name
JL_SIGN_IDENTITY="Developer ID Application: <Team name> (8A9LJ95YH5)" \
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=~/keys/AuthKey_….p8 \
bun run release:package-desktop
```

In GitHub Actions set `MACOS_CSC_LINK` (base64 `.p12`), `MACOS_CSC_KEY_PASSWORD` and the
`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` secrets (the same key's values).

### Signed and notarized releases

If the required Apple credentials are available in GitHub Actions, the job imports the certificate into a temporary keychain, signs with its Developer ID Application identity (`JL_SIGN_IDENTITY`), notarizes and staples the app and the DMG, and the published DMG filename switches to `signed`.

The workflow supports these secrets:

- `MACOS_CSC_LINK` (base64-encoded `.p12` with the Developer ID Application certificate and key) + `MACOS_CSC_KEY_PASSWORD`
- either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
- or `APPLE_API_KEY` (contents of the `.p8` key) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`

The API-key path is used when both are configured.

To package on a developer machine:

```bash
bun run --cwd apps/desktop bundle      # ad-hoc signed app; JL_SIGN_IDENTITY="Developer ID Application: …" to sign
JL_SIGN_IDENTITY="Developer ID Application: …" APPLE_API_KEY=~/AuthKey.p8 APPLE_API_KEY_ID=… APPLE_API_ISSUER=… \
  bun run release:package-desktop      # signed, notarized app and DMG
```

The app's API and web origins are fixed at build time. `bundle.sh` reads `JITTLE_LAMP_API_ORIGIN` and `JITTLE_LAMP_WEB_ORIGIN` from the workspace `.env` locally; release builds take them from these GitHub Actions environment secrets in the `production` environment:

- `JITTLE_LAMP_API_ORIGIN`
- optional: `JITTLE_LAMP_WEB_ORIGIN`

Setting these only in the backend/deployment host is not enough for the macOS desktop artifact, because the packaged app cannot read that server environment after it has been built. (A value in the app's own environment overrides them at runtime, which is useful for local testing.)

## 4. Release notes specific to this repo

- The release workflow only accepts stable tags that match `vX.Y.Z`.
- The tag must point at the current `main` HEAD.
- `bun run release:check-version` fails if any workspace package version, or the desktop Cargo workspace version, drifts from the root release version.
- The extension companion integration assumes the desktop companion intake server runs on `http://127.0.0.1:48115`.
- The desktop companion output folder is set in the desktop app's Settings, or fixed with `JITTLE_LAMP_OUTPUT_DIR`. It is stored in `~/.jittle-lamp/companion.json`.

For the desktop app specifically (needs macOS 15+ and Rust stable from rustup):

- `bun run --cwd apps/desktop dev` runs the app with `cargo run`, including the companion intake server on `http://127.0.0.1:48115`.
- `bun run --cwd apps/desktop test` runs `cargo test --workspace`.
- `bun run --cwd apps/desktop build` (or `bun run build:desktop`) builds the release binary. The root `bun run build` does not build the desktop app.
- `bun run --cwd apps/desktop bundle` builds and signs `apps/desktop/target/bundle/Jittle Lamp.app`.

The companion only accepts artifact writes from `chrome-extension://` origins and rejects normal web origins. It does not currently pin a single extension ID. Output-folder changes happen through the desktop app, not over HTTP.
