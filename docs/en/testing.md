**English** | [简体中文](../testing.md)

# Testing

This guide lists test commands by module and outlines what new tests must cover. Make sure you have run `npm install` per [Building from Source](building.md).

## Minimum Check Before Submitting

```bash
npm run test:quick
```

This runs `npm --prefix electron-client run test:quick`, executing three checks in order:

1. TypeScript type-checking and source boundary linting (`lint`);
2. Main-process unit and contract tests (`electron-client/tests/unit/`);
3. Cross-platform path, capability, and data contract tests (`test:portable-contract`).

Full logs for each step are written under `electron-client/out-test/test-reports/`. Check the corresponding log first when a test fails.

A small number of Windows-only tests are not yet platform-skipped and fail on macOS (e.g., taskbar, file shredder, and a `packages/declarative-ui` process termination test expecting `taskkill`). When submitting a PR, ensure your changes introduce no new failures compared to baseline.

## Running Tests by Module

| Scope | Command |
| --- | --- |
| UI Layer (`frontend/`) | `npm --prefix frontend test` |
| Declarative UI (`packages/declarative-ui/`) | `npm --prefix packages/declarative-ui test` |
| Plugin Spec (`packages/ztools-plugins-spec/`) | `npm --prefix packages/ztools-plugins-spec test` |
| Plugin API Contracts (`packages/api/`) | `npm --prefix packages/api test` |
| AI & MCP (`packages/ai-mcp/`) | `npm --prefix packages/ai-mcp test` |
| Crypto & Sync (`packages/sync-crypto/`) | `npm --prefix packages/sync-crypto run build && npm --prefix packages/sync-crypto test` |
| Root cross-module tests (`tests/`) | `npm test` (main cross-module suite), or `node --test tests/<file>.test.mjs` for a single file (see note below) |
| Windows native helpers (`electron-client/native/`) | `npm --prefix electron-client run test:sidecars` (Windows only; compiles via CMake first) |

Tests in the root `tests/` directory import compiled outputs directly, so build once on a fresh clone:

```bash
npm test                                      # pretest compiles packages/declarative-ui, ai-mcp, sync-crypto dist/ and electron-client/out/
npm --prefix electron-client run build:test   # required for tests importing electron-client/out-test/
```

After editing `electron-client/src/` or `packages/*/src/`, re-run the corresponding build before running tests; otherwise you will test stale artifacts.

Frontend tests use Vitest: `npm --prefix frontend run test:watch` for watch mode and `npm --prefix frontend run test:coverage` for coverage reports.

## Test Locations

| Module | Location & Naming |
| --- | --- |
| Main Process | `electron-client/tests/unit/*.test.ts` (compiled to `out-test/`) and `electron-client/tests/scripts/` |
| UI Layer | `__tests__/*.spec.js` alongside the tested file |
| `packages/*` | `tests/*.test.mjs` inside each package |
| Cross-Module | `tests/*.test.mjs` at the repository root |

## Test Requirements

All tests in the client repository follow these rules.

### Default to Integration Tests

- When a change spans multiple modules (e.g., UI -> IPC -> main-process service -> child process or network), include at least one integration test exercising the full path: call -> main-process validation -> service -> result or UI feedback.
- Wire real internal modules together and mock only at system boundaries: network, child processes, OS APIs, and clocks. Do not stub every internal dependency to always succeed.
- Pure functions and parsers may use unit tests, but still must cover the failure categories below.
- Tests must not rely on live internet access or pre-existing local machine state: use temporary directories for files and local test servers or stubs for remotes.

### Cover Failure Paths

Happy-path tests are not enough. Pick the relevant categories for your change (a single PR does not need all of them):

| Category | Scenarios to Simulate |
| --- | --- |
| Boundary inputs | Empty values, zero, oversized strings, malformed formats, path traversal (`../`), oversized payloads |
| Processes & IPC | Child process crashes or forced termination, truncated pipe streams, half-packets or garbled frames, unresponsive renderer |
| Timing & concurrency | Rapid repeated triggers (e.g., fast window show/hide), out-of-order responses, mid-flight cancellation, timeouts |
| Network & remotes | Offline state, timeouts, HTTP 412 (version conflict), 429 (rate limit), 5xx; verify retry, fallback, or error reporting |
| Data corruption | Corrupted or truncated JSON/files; single-bit flips in ciphertext or wrong passwords must fail decryption |
| Security inputs | Path traversal, undeclared permissions; for plugin scanner changes, cover obfuscated `eval` (`window["ev"+"al"]`), `({}).constructor.constructor(...)`, dynamic `require`, etc. |
| Paired lifecycle | After register/unregister, open/close, subscribe/unsubscribe, verify no leaked listeners, timers, or child processes remain |

### Assert Specific Outcomes

- Assert exact error codes, error types, or fallback behaviors—never just "did not throw" or "returned a truthy value".
- Assert post-failure state remains healthy: no stuck intermediate states, locks released, subsequent calls succeed, and no process crash or hang.

Changes touching global shortcuts, windows, clipboard, or plugin bridges must also be verified manually in the real client on each target OS and noted in the PR description.

## Manual Verification

Launch the client with `npm run dev`. Note that development runs share the default data directory (`ZTools/DataV2` under the OS app data directory) with installed releases. To avoid touching your personal data, build first and launch with an isolated `--data-root`:

```bash
npm --prefix electron-client run build
cd electron-client
npx electron . --data-root=/path/to/ztools-dev/Data
```

Data is stored in the `--data-root` directory, with logs and caches placed in its parent directory. Only one instance can run at a time: if the app exits immediately on launch, close any running ZTools instance first (including official builds on macOS). On macOS, a small amount of Electron's own configuration still lives in the default system location.

To attach DevTools to the renderer, launch with the Chromium remote debugging port:

```bash
# macOS: build and launch
npm --prefix electron-client run start:mac -- --remote-debugging-port=9222
# Windows: build once with npm run dev, then launch directly
cd electron-client
npx electron . --remote-debugging-port=9222
```

Then open `chrome://inspect` in Chrome to attach. Both flags can be combined: `npx electron . --data-root=<dir> --remote-debugging-port=9222`. Note that `start:mac` accepts only the debugging port flag; use `npx electron .` when passing `--data-root`.
