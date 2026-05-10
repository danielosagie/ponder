# Releasing the Ponder desktop app

The npm package (`ponder` SDK + CLI) and the desktop app share this repo. The SDK ships via `npm publish`; the desktop app ships as a code-signed, notarized macOS DMG via GitHub Releases.

## Prerequisites (one-time)

You need an Apple Developer account ($99/year) before you can ship a DMG that doesn't trip Gatekeeper. Without notarization, customers see "Ponder.app cannot be opened because the developer cannot be verified."

### 1. Create a Developer ID Application certificate

1. Sign in to [developer.apple.com/account](https://developer.apple.com/account)
2. **Certificates** → **+** → **Developer ID Application** → follow the CSR flow
3. Download the `.cer`, double-click to install in Keychain Access
4. In Keychain Access: right-click the cert → **Export** → save as `DeveloperID.p12` with a strong password (you'll need it)
5. Base64-encode the .p12 for GitHub Actions:
   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```

### 2. Generate an app-specific password

1. [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific Passwords**
2. Create one labeled "Ponder notarization"
3. Save it — you only see it once

### 3. Find your Team ID

[developer.apple.com/account](https://developer.apple.com/account) → **Membership Details** → 10-character Team ID

### 4. Add GitHub repo secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
|---|---|
| `APPLE_ID` | your Apple Developer email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 2 |
| `APPLE_TEAM_ID` | your 10-char Team ID |
| `CSC_LINK` | base64 string from step 1.5 |
| `CSC_KEY_PASSWORD` | the .p12 export password from step 1.4 |

`GITHUB_TOKEN` is auto-injected — don't set it manually.

## Optional: app icon

Drop a `build/icon.icns` (1024×1024 source, multi-resolution) before building. electron-builder picks it up automatically. Without it the app uses the default Electron icon, which is fine for early testing but should be replaced before the first public release.

## Local dry-run (no Apple cert required)

Build an unsigned `.app` bundle to verify the config works:

```bash
npm run release:dir       # builds to release/mac-arm64/Ponder.app, no DMG
```

To build a DMG locally without signing (useful for sharing test builds):

```bash
npm run release:local
```

Both set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder doesn't try to sign with a missing cert. The output `.app` will throw "unidentified developer" on customer Macs — that's expected for unsigned builds.

## Cutting a real release

```bash
# 1. Bump the version in package.json
npm version patch          # or minor / major

# 2. Push the tag
git push --follow-tags
```

Pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml` on macos-latest. The workflow:

1. `npm ci`
2. `npm run build` (tsup → dist/, the SDK)
3. `npm run build:app` (electron-vite → out/, the Electron internals)
4. `electron-builder --mac --publish always`
   - Code-signs with `CSC_LINK` cert
   - Notarizes via Apple's notary service (Apple's servers do the actual notarization; the workflow waits for the result, ~5-10min)
   - Staples the notarization ticket into the DMG
   - Uploads the DMG to a fresh GitHub Release matching the tag

Total runtime: ~12-18 min the first time (cold node_modules + cold notarization queue), ~8-10min for subsequent runs.

## Manual workflow run

If you want to test the workflow without tagging:

Repo → **Actions** → **Release Desktop App** → **Run workflow** → enable **Dry run**. Builds + signs + notarizes but skips the GH Release upload. Artifacts attach to the workflow run for 14 days.

## Customer install flow

Once a release is published:

1. Customer downloads `Ponder-0.1.0-arm64.dmg` from your Releases page
2. Drag-installs to `/Applications`
3. First launch — macOS verifies the notarization ticket → "Ponder is from an identified developer." No warning.
4. Customer clicks `ponder://configure?convex=https://your-deployment.convex.cloud` from your onboarding email
5. Ponder picks up the URL, writes `~/Library/Application Support/Ponder/config.json`, and connects on next launch

## Troubleshooting

- **"electron-builder cannot find Developer ID identity"** locally → expected. Use `release:dir` or `release:local` (both set `CSC_IDENTITY_AUTO_DISCOVERY=false`).
- **Notarization fails with "Hardened Runtime is not enabled"** → check `electron-builder.yml` has `mac.hardenedRuntime: true` (it does).
- **Notarization fails with "library validation"** → a native module (likely nut-js) ships an unsigned binary. The `disable-library-validation` entitlement in `build/entitlements.mac.plist` covers this.
- **The signed app crashes immediately** → run `codesign --verify --deep --strict --verbose=2 release/mac/Ponder.app` to find the bad signature; usually a native module that needs to be added to `asarUnpack` in `electron-builder.yml`.
- **"This app is from an unknown developer" still appears** after install → run `xcrun stapler validate Ponder.app` — the staple may have failed. Re-run notarization.

## What about Windows / Linux?

Out of scope for v1.1 — the desktop runtime hasn't been ported beyond macOS yet (item 4 in the roadmap). Windows/Linux release pipelines are a separate add-on once nut-js is verified on those platforms and the perms.ts gating is generalized.
