**English** | [简体中文](../building.md)

# Building from Source

This guide covers how to run and package ZTools from source on Windows and macOS. See [Architecture Overview](architecture.md) for module responsibilities and [Testing](testing.md) for test commands.

## Prerequisites

| Purpose | Requirement |
| --- | --- |
| Development (both platforms) | Node.js 24 (minimum 22.12), npm, Git |
| Windows native helpers (optional) | CMake, Visual Studio 2022 "Desktop development with C++" workload |
| macOS packaging | Xcode Command Line Tools (`clang`, `lipo`, `codesign`, `hdiutil`) |

You can run the client without a C++ toolchain; features that rely on native helpers (such as the Windows 32-bit DLL host, or macOS per-device audio control and font preview) will simply be unavailable.

## Installing Dependencies

From the repository root:

```bash
npm install
```

This also installs dependencies for `electron-client/` and `frontend/` and builds `packages/declarative-ui`. Electron is downloaded during install; if downloads are slow or blocked, see [Troubleshooting](#troubleshooting).

## Running in Development

```bash
npm run dev            # Build and launch the client (same as npm start)
npm run start:rebuild  # Ignore cached artifacts, force full rebuild and launch
```

`npm run dev` dispatches by platform:

- **macOS**: Runs `electron-client`'s `start:mac`, building and launching Electron.
- **Windows**: Attempts to compile `NativeHost32` via CMake if not already built (skipping on failure), then builds and launches the client.

There is no hot reload: after editing code, exit the client and run the command again. macOS rebuilds on every launch; Windows skips rebuilding when source files have not changed.

## Building Without Launching

```bash
npm --prefix electron-client run build
```

This compiles the main process, UI layer, and preload scripts. On macOS with Xcode Command Line Tools installed, it also builds the audio, Vision OCR / font glyph, and path-access helpers (reusing cached binaries when unchanged). Output goes to `electron-client/out/`, with UI assets under `electron-client/out/assets/web/`.

Windows native helpers are built separately:

```bash
npm --prefix electron-client run build:native-host32     # 32-bit DLL plugin host
npm --prefix electron-client run build:native:sidecars   # File indexer and other sidecar helpers
```

Windows OCR prefers a local PP-OCRv5 model (~21 MB, running offline via ONNX Runtime in a `utilityProcess`). The model is not checked into git; fetch it once (verified against pinned checksums):

```bash
npm --prefix electron-client run fetch:ocr-models   # Downloads to electron-client/out/ocr-models
```

Without the model downloaded, OCR falls back to Windows built-in OCR while all other features continue working normally.

## macOS Packaging

Must be run on macOS. First build a universal `.app` bundle (Apple Silicon + Intel):

```bash
npm --prefix electron-client run package:app:darwin:universal -- \
  --app-bundle-id com.example.ztools \
  --minimum-os 13.0 \
  --short-version 1.1.8 \
  --build-version 1.1.8
```

- All four flags are required: `--short-version` takes three numeric segments; `--build-version` takes one to three. Use your own reverse-DNS bundle ID for local builds.
- Output is written to `electron-client/artifacts/<version>/darwin-universal/ZTools-darwin-universal/ZTools.app`. The script aborts if the output directory already exists; move or remove it before rebuilding.

For local testing, ad-hoc sign the app and build a DMG:

```bash
APP="$PWD/electron-client/artifacts/<version>/darwin-universal/ZTools-darwin-universal/ZTools.app"
codesign --force --deep --sign - "$APP"
npm --prefix electron-client run package:dmg:darwin -- \
  --app "$APP" \
  --output "$PWD/ZTools-local-darwin-universal.dmg" \
  --allow-unsigned
```

`--app` and `--output` must be absolute paths. A matching `.sha256` checksum file is generated alongside the DMG.

**Public distribution** requires signing with an Apple Developer ID certificate and notarizing with Apple; otherwise Gatekeeper blocks the app on other Macs. Sign and notarize the `.app` using `sign:mac:prototype` ([`electron-client/scripts/sign-macos.mjs`](../../electron-client/scripts/sign-macos.mjs)), then pass `--sign-identity` and `--notary-profile` to `package:dmg:darwin`. Run either script with `--help` for full options. Entitlements live in [`electron-client/scripts/macos-entitlements/`](../../electron-client/scripts/macos-entitlements/).

Reading LAN device MAC addresses on macOS 27 also requires the **Network Topology Observation** entitlement. The network helper is packaged separately at `Contents/Helpers/ZToolsMacNetwork.app` with bundle ID `<app-bundle-id>.network-topology` (e.g., `com.example.ztools.network-topology`). Enable this capability for that identifier in your Apple Developer account, create a **Developer ID** provisioning profile containing your Developer ID Application certificate, and pass `--network-profile <absolute-profile-path>` during signing. The signer validates app ID, team, certificate, expiration, and entitlements, embeds the profile in the helper, and grants the entitlement only to the helper. Without the profile, the helper receives standard signing and automatic MAC discovery is disabled while signing and packaging still succeed; if a profile is explicitly passed but fails validation, signing aborts. See the [Apple Developer Forums note](https://developer.apple.com/forums/thread/841958) and [Signing a daemon with a restricted entitlement](https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement).

Development runs and ad-hoc signed builds do not carry this restricted entitlement. On macOS 27, LAN host and port scanning still works, but automatic MAC discovery is unavailable and the UI informs the user; Wake-on-LAN with a manually entered MAC address does not require this entitlement. Running a standalone command in Terminal does not prove that the packaged app holds the entitlement.

Official macOS installers on [Releases](https://github.com/ZToolsTeam/ZTools/releases) are built, signed, and notarized by maintainers on macOS using these scripts; the release upload workflow is not part of this repository.

## Open-Source vs. Official Edition

This repository is the open-source edition of ZTools. Official installers on [Releases](https://github.com/ZToolsTeam/ZTools/releases) are built from the same source tree plus closed-source account and cloud service modules that provide sign-in, user profiles, in-app feedback, plugin reviews/ratings/version history, cloud sync, usage telemetry, and auto-update services. Those modules are not included in this repository.

Building from source produces an **offline edition**:

- Ships the same 9 cross-platform bundled tools as the official build with no first-run download (see [Default Bundled Plugins](architecture.md#default-bundled-plugins));
- Omits account sign-in, in-app feedback, plugin reviews/ratings, cloud sync, and auto-update checks (download new releases from Releases);
- Never contacts the official backend or sends usage telemetry;
- The sidebar "Feedback" link opens [GitHub Issues](https://github.com/ZToolsTeam/ZTools/issues) in your browser;
- The plugin marketplace reads the public CDN catalog normally—browsing, installing, and updating plugins work out of the box;
- Online translation requires build-time configuration (below). Without it, the translate command uses only the built-in dictionary and reports that no translation service is configured for other queries.

Edition-specific capabilities are isolated behind an edition interface implemented in `frontend/src/edition-oss/` and `electron-client/src/main/edition-oss/`. See [Edition Interface](architecture.md#edition-interface).

Optional build-time environment variable:

| Variable | Description |
| --- | --- |
| `VITE_TRANSLATION_ENDPOINT` | Online translation API endpoint (`http://` or `https://`) passed when building the client or frontend, or set in `frontend/.env.local`. When unset or invalid, only the built-in dictionary is used |

```bash
VITE_TRANSLATION_ENDPOINT=https://translate.example.com/api npm --prefix electron-client run build
```

## Windows Installers

Windows installers and portable archives are built and published by maintainers to [Releases](https://github.com/ZToolsTeam/ZTools/releases); their packaging scripts are not included in this repository. When contributing, run and verify from source using `npm run dev`.

## Troubleshooting

- **Electron download fails or is slow**: Set `ELECTRON_MIRROR` to an accessible mirror before running `npm install`.
- **Changes on Windows do not show up after relaunch**: Run `npm run start:rebuild` to force a clean rebuild.
- **Account sign-in and feedback are missing in a local build**: Those belong to closed-source modules in official installers and are intentionally absent from the open-source edition (see [Open-Source vs. Official Edition](#open-source-vs-official-edition)). The plugin marketplace works normally.
