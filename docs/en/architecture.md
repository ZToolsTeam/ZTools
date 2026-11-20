**English** | [简体中文](../architecture.md)

# Architecture Overview

A contributor's map of the codebase: what each module owns and where to find it. Source code and tests are the final source of truth. For build steps, see [Building from Source](building.md).

## High-Level Structure

```text
UI Layer (Vue, frontend/)  ── window.ztools ──>  Preload Script (preload)
                                                        │  ztools:call single channel
                                                        ▼
                                        Main Process (electron-client/src/main)
                                        Validates method, caller, permissions, params, timeout
                                                        │
                        ┌───────────────────────────────┼───────────────────────────┐
                        ▼                               ▼                           ▼
                System Services (services/)     Plugin Windows / Declarative    Native Helpers (native/)
```

## Module Responsibilities

| Module | Path | Responsibility |
| --- | --- | --- |
| Main Process | [`electron-client/src/main/`](../../electron-client/src/main/) | App lifecycle, windows, global shortcuts, tray, plugin installation & runtime, system capabilities |
| Preload Script | [`electron-client/src/preload/`](../../electron-client/src/preload/) | Exposes method-by-method bridges via `contextBridge`; never exposes Node modules |
| IPC Contracts | [`electron-client/src/contracts/`](../../electron-client/src/contracts/) | Request schema, method allowlist, caller capability table, error codes, payload & timeout limits |
| UI Layer | [`frontend/src/`](../../frontend/src/) | Workspace dashboard, floating launcher bar, settings, and declarative view renderer |
| Host API | [`frontend/public/js/cef-ipc/`](../../frontend/public/js/cef-ipc/) | Builds `window.ztools`, forwarding calls to the preload bridge |
| Declarative UI | [`packages/declarative-ui/`](../../packages/declarative-ui/) | Plugin components, runtime reconciler, hooks, and examples |
| Plugin Spec | [`packages/ztools-plugins-spec/`](../../packages/ztools-plugins-spec/), [`packages/api/`](../../packages/api/) | `plugin.json` JSON Schema, validator, and TypeScript definitions |
| AI & MCP | [`packages/ai-mcp/`](../../packages/ai-mcp/) | LLM router (including local model discovery) and MCP host implementation |
| Crypto & Sync | [`packages/sync-crypto/`](../../packages/sync-crypto/) | End-to-end encryption (Argon2id key derivation, AES-256-GCM) and WebDAV / GitHub Gist sync adapters |
| Native Helpers | [`electron-client/native/`](../../electron-client/native/) | Platform-specific C++ / Objective-C++ binaries running as isolated processes |

Frequently visited paths in the main process:

- `bootstrap.ts`, `application-lifecycle.ts`: Startup and shutdown sequences.
- `windows/`: Main window, floating launcher bar (`launcher-controller.ts`), plugin windows, and system tray.
- `ipc/router.ts`: Single entry point for all `ztools:call` requests.
- `services/`: Config, clipboard, file search, plugin installer, updater, and other system capabilities (one file per service).
- `edition.ts`, `edition-types.ts`, `edition-oss/`: Main-process edition interface and its open-source implementation (see [Edition Interface](#edition-interface)).
- `platform/`: Platform-specific implementations under `windows/` and `macos/`.
- `protocol/ztools-protocol.ts`: Custom `ztools://` protocol serving UI and plugin assets.

## Edition Interface

Accounts, in-app feedback, plugin reviews and ratings, cloud sync, usage telemetry, and client update checks are only shipped in official installers (see [Open-Source vs. Official Edition](building.md#open-source-vs-official-edition)). Shared code never imports these features directly; instead, it consumes an edition interface. This repository provides the open-source implementation, which is strictly offline and makes no network requests.

Update checking and installation are decoupled: official builds fetch the full installer for Windows or macOS. On Windows, the installer handles replacement. On macOS, the client downloads and verifies the DMG, validates bundle identifier, target version, and code-signing requirements against the running app, archives the `.app` bundle to ZIP, and hands it to Electron `autoUpdater` (Squirrel.Mac) via a loopback-only local server. `quitAndInstall()` is called only after releasing databases, run locks, and windows, leaving rollback and relaunch to the native updater. In-place replacement is disabled for dev runs, disk images, and App Translocation, and requires a writable install location. Downloads can be canceled; once the native updater takes over, cancellation is disabled and duplicate handoffs are prevented. When no update source is configured, no update check is sent.

Plugin distribution is a public capability shared by both editions: catalog listings, categories, metadata, packages, and updates are read from `plugins-v2/catalog.json` on the official CDN. Before installing or updating, the client fetches a fresh catalog to check revocation status, platform targets, `minAppVersion`, package URL, and SHA-256 checksum; if the catalog is unreachable, it fails explicitly. Local snapshots are for offline browsing only and never bypass pre-install verification. Refreshing the catalog or checking updates also syncs revocation records to disable already-installed revoked plugins.

| Layer | Interface Entry | Open-Source Implementation |
| --- | --- | --- |
| UI Layer | `@edition` alias (configured in `frontend/vite.config.js` and `vitest.config.js`) | [`frontend/src/edition-oss/`](../../frontend/src/edition-oss/): no extra routes, pages, or plugin detail tabs; feedback opens GitHub Issues; always signed out; telemetry and sync are no-ops |
| Main Process | [`edition.ts`](../../electron-client/src/main/edition.ts), types in [`edition-types.ts`](../../electron-client/src/main/edition-types.ts) | [`electron-client/src/main/edition-oss/`](../../electron-client/src/main/edition-oss/): always signed out with no credentials, drops telemetry, no update source, relies only on release-bundled integrity anchors for shared libraries |

The IPC contract is identical across editions: methods such as `user_get_info`, `user_set_token`, `user_logout`, and `analytics_report` exist in both. In the open-source edition, account methods always report signed-out state, credential writes are rejected, telemetry is dropped, and `window.ztools` omits account and telemetry APIs.

When modifying edition-dependent features:

- Shared code must read capabilities only through `@edition` or the main-process edition interface, never by importing a specific edition directly.
- When adding or changing fields on the interface, update the open-source stub in lockstep and verify `frontend/src/edition-oss/__tests__/` and `electron-client/tests/unit/main-edition.test.ts`.
- The open-source implementation must never issue network requests or write account credential files.

## Request Lifecycle

1. The UI or a plugin calls a method on `window.ztools`.
2. The preload script wraps it as `{ messageId, method, params, timeoutMs }` and sends it over `ztools:call`.
3. Main-process [`router.ts`](../../electron-client/src/main/ipc/router.ts) validates in order:
   - Request shape and payload size ([`contracts/ipc.ts`](../../electron-client/src/contracts/ipc.ts): 1 MiB default payload cap, 10 s default timeout);
   - Method allowlist membership and current platform support;
   - Caller capability ([`contracts/capabilities.ts`](../../electron-client/src/contracts/capabilities.ts), distinguishing `main` vs. `plugin`);
   - Declared plugin permissions in `plugin.json` when required ([`ipc/plugin-principal.ts`](../../electron-client/src/main/ipc/plugin-principal.ts)).
4. Caller identity is derived from the originating window (`WebContents`), never from self-reported fields in the request payload.
5. Responses always return `{ success, data }` or `{ success: false, error: { code, message } }`.

When adding a host method, update the contract, capability table, preload allowlist, and router together, along with unit/contract tests.

## Plugin Model

Each plugin is a directory containing `plugin.json` with required fields `id`, `name`, `version`, `description`, `author`, `entry`, `icon`, `permissions`, `targets`, and `nativeComponents` (`[]` for pure JS plugins). See [`plugin.schema.json`](../../packages/ztools-plugins-spec/plugin.schema.json) for the complete schema. Plugins describe UI using `@ztools/declarative-ui` components rendered by [`frontend/src/declarative/`](../../frontend/src/declarative/), and load assets through `ztools://plugins/<plugin-id>/...`.

For manifest fields, host APIs, and publishing rules, see the [API Reference](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/api.md) and [Publishing Guide](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/publishing.md) in `ZTools-extensions`.

### Default Bundled Plugins

Both the open-source and official editions share the same [bundled plugin manifest](../../frontend/src/config/bundledPlugins.json), shipping 9 cross-platform core tools out of the box: Calculator, QR Code Generator, JSON Formatter, Timestamp Converter, Text Diff, Encoding & Crypto, Color Picker, Sticky Notes, and Todo List.

Selection criteria for bundled plugins:

- Ready on first launch without requiring an account, API key, or extra model downloads;
- Covers frequent, immediate tasks that save opening another app or website;
- Loads on demand with zero idle background processes, continuous scanning, or network activity;
- Verified on both Windows and macOS and maintained in sync with client releases.

Official authorship and default bundling are managed separately: not every official plugin is bundled, and additional plugins are installed on demand from the marketplace. Do not auto-download extra plugins just to populate the home screen.

Bundled plugin assets ship directly with the repository and client installer, with no account, cloud, or first-run download dependency. At runtime, copies in `frontend/public/bundled-plugins/` take precedence and update with the client; marketplace packages with the same ID cannot overwrite them independently.

Bundled plugins can be hidden or restored in Settings. Hiding removes the plugin from the installed list and search results while preserving its assets and user data; restoring brings back the existing data.

Image Base64, 2FA Authenticator, Download Manager, Image Compressor, Archive Manager, Invoice Assistant, and Selection Translate are now on-demand marketplace plugins. Users upgrading from older versions can install them from the marketplace; plugin IDs and storage namespaces remain unchanged so existing data is preserved.

## Native Helpers

| Directory | Platform | Role |
| --- | --- | --- |
| `ZToolsNativeHost32/` | Windows | Isolated host process for 32-bit DLL plugins |
| `ZToolsService/` | Windows | Runs allowlisted commands that require elevated privileges |
| `ztools-indexer/` | Windows | File indexing and fast search |
| `ztools-uiaccess/` | Windows | Cross-privilege operations such as reading selected text from other apps |
| `ZToolsPathAccess/` | Windows, macOS | Scoped file access when plugins read/write user-selected files |
| `ZToolsMacClipboard/`, `ZToolsMacVision/`, `ZToolsMacAudio/`, `ZToolsMacInputLock/`, `ZToolsMacDns/` | macOS | Clipboard I/O, Vision OCR & system font glyph rendering, per-device audio input/output control, timed keyboard-cleaning input lock, and DNS configuration under system configuration locks |
| `ZToolsMacNative/` | macOS | Interface and policy for macOS native plugin host (not yet enabled) |

All native helpers run as separate processes communicating with the main process over pipes, so a helper crash never takes down the main process. If native helpers are not built, dependent features report unavailable while the rest of the client runs normally.

On Windows, OCR runs PP-OCRv5 inside an Electron `utilityProcess` via ONNX Runtime (WebAssembly), starting on first use and exiting after 1 minute of inactivity; if the model is missing or the worker fails repeatedly, it falls back to Windows built-in OCR. macOS uses system Vision.

Formula OCR (macOS and Windows) also runs Pix2Text-MFR 1.5 (MIT) via ONNX Runtime in a dedicated `utilityProcess` to output LaTeX. The ~114 MB model is not bundled in the installer; on first use, the main process downloads it to `Models/` under the data directory (trying the official CDN first, then a pinned Hugging Face commit and its mirror, verifying every file against the same SHA-256) and runs offline thereafter. Only model files are downloaded; images never leave the machine.

`NativeHost32` and `ZToolsService` only execute allowlisted plugins and functions.

## Background Resources

Hidden windows progressively release resources while avoiding flicker on reopen:

- **Floating launcher bar**: After 15 seconds hidden, background rendering is throttled and memory reclamation is triggered. On reopen, the window waits for the first painted frame (up to 150 ms) before showing. See [`launcher-controller.ts`](../../electron-client/src/main/windows/launcher-controller.ts) and [`frame-sync-manager.ts`](../../electron-client/src/main/services/frame-sync-manager.ts).
- **Plugin windows**: Suspended (muted and throttled) after 30 seconds hidden. At most 4 active background plugin windows are kept; exceeding this suspends the oldest hidden window first. See [`plugin-window-manager.ts`](../../electron-client/src/main/windows/plugin-window-manager.ts).

Changes to these lifecycles must stay consistent under rapid hide/show toggles.

## Security Baseline

- Every window enables `contextIsolation`, `sandbox`, and `webSecurity`, and disables `nodeIntegration`.
- Neither the UI nor plugins can access Node modules, arbitrary IPC channels, or native loaders; only allowlisted methods are exposed.
- The main process validates method, caller, permissions, parameters, and timeout on every request, treating all external input as untrusted.
- Plugins cannot access login credentials: account methods only return credentials to the client's own UI, verified by the originating window rather than self-reported claims (in the open-source edition, accounts do not exist and these methods always return signed-out state).
- Plugin windows run in isolated sessions. Declarative plugins share a rendering context with the host UI, secured through manifest permission checks, pre-publish source review, and static security scanning.
