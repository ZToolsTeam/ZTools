**English** | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing Guide

Issues and Pull Requests that improve the ZTools desktop client are welcome. For plugin contributions, head over to [ZTools Extensions](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/CONTRIBUTING.md).

## Reporting Issues

Open a new issue in [Issues](https://github.com/ZToolsTeam/ZTools/issues) and include:

- OS version and architecture (e.g., Windows 11 x64, macOS 15 Apple Silicon);
- Client version (or commit SHA if running from source);
- Steps to reproduce, expected behavior, and actual behavior;
- Relevant logs or screenshots. Scrub personal details such as usernames, local paths, and tokens before posting.

If you find a security vulnerability, describe only the affected scope in the issue without publishing exploit steps. Maintainers will follow up to coordinate details.

## Submitting a Pull Request

1. Fork this repository and create a branch from `main`.
2. Make your changes, add tests, and verify they pass locally (see [Pre-Submit Checks](#pre-submit-checks)).
3. Open a Pull Request targeting the `main` branch of `ZToolsTeam/ZTools`.
4. Check the **Contributor License** checkbox in the PR description (see [Contributor Licensing](#contributor-licensing)). PRs without it checked cannot be merged.
5. Wait for maintainer review. Push follow-up commits directly to your branch if changes are requested.
6. Approved PRs are merged via squash.

In your PR description, include:

- What changed and why (for larger changes, open an Issue to discuss the design first);
- Which test commands you ran and their results;
- Which platforms you verified manually (Windows / macOS).

Keep each PR focused on a single concern without unrelated formatting or refactoring. Both English and Chinese are welcome in Issues and Pull Requests.

## Code Requirements

- **Coding Standards**: See [Coding Standards](docs/en/coding-standards.md) for the seven core principles (completeness, paired cleanup, mutual exclusion, state machines, boundaries, untrusted input defense, and test coverage), per-layer rules, line endings, and commit message conventions.
- **Testing**: See [Testing](docs/en/testing.md). Default to integration tests and cover failure paths such as crashes, timeouts, concurrency, and corrupted data.
- **Module Boundaries**: See [Architecture Overview](docs/en/architecture.md).

## Pre-Submit Checks

```bash
npm run test:quick
```

Then run the test suite for each module you touched. See [Running Tests by Module](docs/en/testing.md#running-tests-by-module).

## Contributor Licensing

Every Pull Request template includes one required checkbox:

```text
- [x] 我确认本次贡献是我本人的原创作品（或我有权提交），并同意以 GPL-3.0-only 和 MIT 双重许可提供 / I confirm this contribution is my own work (or I have the right to submit it) and I agree to license it under both GPL-3.0-only and MIT
```

Change `[ ]` to `[x]` without modifying the text. Pull Requests without this box checked will not be merged.

Why dual licensing? This repository is published under `GPL-3.0-only`, so anyone has access to the source code. Official release installers combine this open-source codebase with closed-source components (such as accounts and cloud services). Because GPL requires combined works to be distributed under GPL whereas MIT does not, licensing your contribution under both `GPL-3.0-only` and `MIT` allows official installers to include your work. The public repository remains under `GPL-3.0-only`, and you retain copyright to your contribution.

If your contribution includes third-party code, ensure you have the right to submit it under these terms and note its source and original license in the PR description.

## License

This repository is licensed under [GNU GPL v3.0](LICENSE) (`GPL-3.0-only`). External contributions are additionally licensed to the project under MIT as described in [Contributor Licensing](#contributor-licensing).
