**English** | [简体中文](../coding-standards.md)

# Coding Standards

These standards apply across the entire client repository (`electron-client/`, `frontend/`, `packages/`). See [Testing](testing.md) for test expectations and [Architecture Overview](architecture.md) for module boundaries. For plugin UI rules, see the [UI Guidelines](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/ui-guidelines.md) in `ZTools-extensions`.

## Before You Write Code

- **Keep it simple**: Start with the simplest solution that works. Do not abstract for hypothetical future requirements. Check whether a helper or service already exists before writing a new one.
- **Fix root causes**: Reproduce and diagnose the underlying cause before editing; do not mask symptoms with surface-level patches.
- **Justify every UI addition**: Before adding a button, card, banner, or interaction step, answer "how does this help the user finish faster?" If there is no clear answer, leave it out.
- **Design complex changes up front**: For changes involving state transitions, concurrency, or multiple modules, outline the design in an Issue first, covering:
  - States and allowed transitions;
  - Boundary conditions (empty values, limits, timeouts, mid-flight cancellation);
  - Mutually exclusive operations and how overlap is prevented;
  - Behavior on error, timeout, and process exit.

  Discuss open questions before writing code.

## Seven Core Principles

1. **Completeness**: Handle all enum values and branches, keeping a `default` / `else` fallback.
2. **Paired cleanup**: Match every open with close, register with unregister, subscribe with unsubscribe. Clean up across normal exit, error, and shutdown paths.
3. **Mutual exclusion**: Operations that cannot run concurrently must hold an explicit lock or state guard to prevent re-entry.
4. **State machines**: Initialize state variables explicitly and reason through transitions before mutating state. In check-then-act sequences, re-verify state across async boundaries.
5. **Boundaries**: Validate empty values, zero, maximums, overflow, concurrency, timeouts, and mid-flight cancellation.
6. **Defense against untrusted input**: Treat IPC params, file contents, network responses, and CLI arguments as untrusted—validate before use. Errors should fail only the current operation without breaking unrelated features.
7. **Test coverage**: Every feature and fix must include tests covering failure paths. See [Testing](testing.md).

Three additional rules:

- **Never hide failures**: Return real errors instead of substituting sample data or fake success responses. Avoid empty `catch {}` blocks; when intentionally ignoring an error, comment why.
- **Never commit local machine info**: Keep absolute local paths, usernames, tokens, and personal data out of code, comments, logs, and test fixtures.
- **Avoid copy-paste duplication**: Extract shared logic into a reusable function or module rather than duplicating blocks.

## Per-Layer Rules

### Main Process & Preload (`electron-client/`)

- **Maintain the security baseline**: Keep window security flags intact, expose preload methods individually, and resolve caller identity from the originating window (see [Security Baseline](architecture.md#security-baseline)). Static checks in `npm run test:quick` reject `nodeIntegration: true`, `contextIsolation: false`, and `ipcRenderer` usage outside preload entry points.
- **Update host methods atomically**: Change the request schema and capability table in [`electron-client/src/contracts/`](../../electron-client/src/contracts/), the preload bridge, and the IPC router together (see [Request Lifecycle](architecture.md#request-lifecycle)).
- **Make long tasks cancelable**: Support cancellation for long-running work, stop and clean up when windows close, bound shutdown cleanup with timeouts, and make cleanup idempotent.
- **Paired cleanup**: Every listener, timer, global shortcut, system hook, and child process must be cleaned up where it is registered.
- **TypeScript**: `electron-client` runs with `strict: true`; do not introduce explicit `any` in new code.

### UI Layer (`frontend/`)

- Use Vue 3 Composition API with `<script setup>` (no Options API).
- Name new components with multi-word names, e.g. `PluginCard.vue`, `SearchBar.vue`.
- Manage state with Pinia; use `storeToRefs` when destructuring reactive properties.
- Prefer styling in this order: Ant Design Vue components > components with Tailwind CSS > native HTML with Tailwind CSS.
- Scope `<style>` blocks (`scoped` or `module`) to avoid leaking global styles. Use theme CSS variables (e.g., `var(--rc-text-muted)`) instead of hardcoded hex colors so light and dark themes switch cleanly.
- Clean up timers and event listeners created in components inside `onUnmounted`.
- The UI layer has no Node access; call host capabilities exclusively via `window.ztools`.

### Declarative UI (`packages/declarative-ui/`)

Plugins describe interfaces only with `List`, `Detail`, `Form`, `ActionPanel`, `Action`, and related primitives—no direct DOM manipulation or custom CSS. Styling and themes are owned by the client. Do not introduce APIs that let plugins access the DOM or inject styles.

### Native Helpers (`electron-client/native/`)

- Run native code in isolated processes communicating over pipes rather than loading into the main process, so native crashes cannot crash the app.
- On the main-process side, treat helper exits, timeouts, and malformed output as expected failure modes: fail the current request, mark the capability unavailable, and keep the rest of the app running.
- Native helpers must validate every incoming parameter and execute only allowlisted operations.

## Formatting & Line Endings

- Preserve existing line endings (LF or CRLF) when editing existing files; configure your editor not to rewrite them.
- Use LF for new files, except `.bat` files which use CRLF.
- Follow the conventions of the file you are editing. Do not run repo-wide reformatting or mix formatting churn into functional changes.

## Commit Messages

Use `type: description` or `type(scope): description`. Common types:

| Type | Purpose |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code refactoring without behavior change |
| `docs` | Documentation |
| `test` | Tests |
| `chore` | Build, dependencies, scripts, or maintenance |

`perf`, `style`, `build`, `ci`, and `revert` are also accepted. Descriptions may be in English or Chinese and should clearly state what changed:

```text
fix(launcher): prevent window flicker on rapid consecutive invocations
feat: add keyboard shortcut for clearing clipboard history
```

Pull Requests are squash-merged, and maintainers may tidy the final commit title.
