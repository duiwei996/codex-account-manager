# Codex Account Manager

WebDAV sync is available in Settings → WebDAV Sync. Select an existing directory and choose accounts and/or settings. Credentials remain in the local OS credential store. Account data includes risk status and refreshed quota, expiry and reset-credit caches; risk-isolated accounts remain part of synchronization.

Each device remembers the last successful cloud revision. Local changes upload while that revision remains unchanged. When the cloud changes or first-time copies differ, choose the complete local or cloud copy, or cancel. There is no automatic field merge or one-sided account restoration. Equal copies establish the baseline without prompting. Whole-copy choices include additions, edits and deletions within selected sections.

The header offers Sync now with success and failure feedback. Settings also offer Replace cloud with local and Replace local with cloud, both requiring confirmation. Sync no longer creates recovery copies; existing historical files remain untouched. Missing selected cloud sections stop downloads instead of clearing local data.

Automatic sync checks once after startup, then every 30 minutes by default, configurable from 1 to 1440 minutes. Pending choices pause background sync; after cancelling, Sync now checks again. Network errors retry at the next scheduled check. Strong ETags prevent overwriting a concurrent cloud change. The local successful baseline is encrypted; the cloud gzip file contains full credentials, so use trusted storage and HTTPS.

The Risk category excludes accounts from ordinary All/Free/Team refreshes, exports and warm-ups. Moving an account out restores its original plan category. Active selection remains local. See [release notes](CHANGELOG.md).

## Features

- Add and sign in to accounts, import existing accounts, rename, hide or delete them.
- Switch accounts from the main window or system tray and view subscriptions, quotas and usage.
- Export one or all accounts as official auth.json or CPA JSON, import multiple files, and choose Chinese or English.
- Check for new versions and install updates after confirmation.

## Installation

Open the [releases page](https://github.com/duiwei996/codex-account-manager/releases) and select the installer for your computer:

| System | Installer and installation |
| --- | --- |
| Windows | Download `setup.exe`, open it and follow the installation prompts. |
| macOS | Download `.dmg`, open it and drag the app into Applications. Choose `aarch64` for Apple silicon or `x64` for Intel. |
| Linux | Download `.AppImage`, make it executable and run it, or install `.deb` / `.rpm` with your system's software installation tool. |

If your operating system displays a security prompt, confirm that the installer came from this repository's releases page.

macOS installers use ad-hoc signing and are not notarized by Apple. If the first launch shows a warning that Apple cannot verify whether the app contains malware, confirm that the installer came from this repository and follow these steps:

1. Click Done in the warning.
2. Open System Settings → Privacy & Security, scroll to the blocked app notice, and click Open Anyway.
3. Confirm as prompted and click Open. macOS saves the exception for this app.

## Usage

1. Open the app and add an account by signing in through your browser or importing an existing `auth.json`.
2. View account information in the account list, select an account and switch to it.
3. You can also switch accounts from the system tray.
4. Click the top transfer icon to switch between Import and Export tabs. Export filters default to all categories and valid accounts; both dropdowns place All first. Account cards also support single-account export in official auth.json or CPA format.
5. When a new version is offered, confirm installation and restart the app as prompted.

JSON files contain full login credentials; keep them private. CPA Codex format supports signed-in accounts; API key accounts use official format. Optional warm-ups may consume account quota.

Settings provide startup behavior, automatic refresh scope and interval, and automatic update checks. Automatic refresh defaults to the selected category plus the account in use every minute; active-account-only scope is also available. Invalid accounts are skipped, and background polling uses five times the interval. Refresh intervals and warm-up settings are shared across categories. Launch at login and minimize to tray at login are enabled by default.

Top refresh and both warm-up modes target valid accounts in the selected category plus the account in use, without duplicates. All categories includes every valid account; subsequent warm-up requests follow category changes. Scheduled warm-up times appear as tags; use the pencil button to edit them in a dialog. Schedules use local time while the app is running; missed times are skipped. Automatic warm-up runs near the beginning of a quota window, at most once per window. Both modes check live quota before sending a request.

The tray always uses the active account's hourly and weekly remaining quota mode, with no display-mode setting. Old hidden-tray preferences are ignored. macOS shows quota text in the menu bar; Windows keeps the tray icon and its quota panel.

On startup, previously fetched account information, quota and statistics appear immediately while data refreshes in the background. Accounts without cached data are fetched once; expired authorization or request failures preserve the last successful values.

## Local builds

Use the Node.js version in `.node-version`, pnpm from `package.json`, and Rust from `rust-toolchain.toml`. After installing the platform-specific Tauri build prerequisites and `cargo-audit 0.22.1`, run `pnpm build:local`. It runs the full checks shared with CI before creating an installer, and any failed check stops packaging. It uses the official public key in `src-tauri/updater-public-key.txt` and this repository's GitHub Releases update endpoint, enabling both frontend and backend update support. `TAURI_UPDATER_PUBLIC_KEY` can explicitly supply a public key matching the signatures of official updates.

Receiving official updates requires no private key and does not generate signed update artifacts. Updates distributed to other installations still use the signed release workflow. `pnpm build` builds only the frontend; direct Tauri build commands do not automatically enable updates.

On Windows, `build:local` adds a project-owned launcher around the stock installer. It checks installed versions and preserves the registered directory during upgrades. Shortcut handling uses official installer hooks; dependency source and third-party templates remain unmodified. Releases sign the final EXE, and Windows updates have separate EXE and MSI entries. All platform package formats remain available.

## Version management

`pnpm install` installs repository-local pre-push checks; `pnpm hooks:install` reinstalls them. Each normal `git push` performs fresh frontend and Rust security audits, toolchain, version and Rust format checks. High and critical frontend findings block pushes; low and moderate findings remain visible warnings. Rust retains its existing audit policy. Unavailable audit services and missing tools also block pushes. A clean tree matching the pushed HEAD is required. Existing hook configurations require integration first. Reinstall after moving the toolchain or an explicit `CARGO_AUDIT_BIN`; CI skips hook installation. Do not bypass checks with `--no-verify`. Cloud audits remain enabled for newly published advisories.

Root `VERSION` is the single version source. Local builds never increment it; cloud builds use the same version. Reserved versions are skipped, and versions older than existing releases are rejected.

After editing `VERSION`, run `pnpm version:sync` to synchronize frontend, Tauri and Cargo metadata, or use `pnpm version:bump 1.0.5` to update all version files explicitly. `pnpm version:check` and build entry points verify consistency. Choose an unused version before releasing; existing drafts are also reserved and their artifacts are not overwritten.

Before pushing, run `pnpm check:ci` to check toolchains, versions, frozen dependency installation, Rust formatting, both dependency security audits, the frontend build and tests, and Rust tests on the current host. Any failure stops the checks. CI uses `pnpm check:frontend` and `pnpm check:rust` from the same script; `pnpm build:local` requires the combined checks to pass. Audits use current advisories from official sources, so previously passing lockfiles must be checked again. Set `CARGO_AUDIT_BIN` to use an official prebuilt auditor. Use `pnpm release:preflight` for formatting and security checks only. Local checks do not replace CI on other operating systems or signed release verification. Legacy ZIP extraction is disabled in the updater; releases use raw EXE/MSI, AppImage and macOS tar.gz packages.

## License

[MIT](LICENSE). This project is not an official OpenAI application.
