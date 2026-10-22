# Codex Account Manager

WebDAV sync is available under Settings → WebDAV Sync. Enter the server URL, username and password, browse to an existing folder (or enter its relative path), then independently select account sync and system settings sync. The password stays in the local OS credential store. Two-way sync merges both sides; first use, deletions and conflicts require a preview and confirmation. Previews and results show changes to this computer and the cloud separately, including account names and setting names. A changed data snapshot or cloud revision requires a new confirmation.

More actions offers Replace cloud with local and Replace local with cloud, scoped to selected content. Both require confirmation and save an encrypted local recovery copy of the pre-operation data and baseline, with its path shown in the result. The latest such recovery copy is retained for each sync destination. Downloads never upload and stop if selected cloud content is missing. Uploads do not replace local data. Automatic two-way checks run at startup and every minute, uploading only changed content; first use, deletions, conflicts and errors pause the task and show a main-window notice linking to sync settings.

Account sync also includes subscription expiry, hourly/weekly quotas and reset times, credit balance and unlimited-credit flags, and available reset credits with their expiry dates. Each observation group keeps the newest successful query; values are never added together. Downloaded caches are mapped to the destination's account IDs, displayed immediately and refreshed in the background. Expired reset credits no longer count. Errors preserve existing values; cached quotas do not trigger automatic warm-up. Cache-only changes neither create account edit conflicts nor resurrect deleted accounts. Older cloud files without caches remain readable.

The cloud stores one compressed `accounts.sync.gz` file without additional encryption. It contains full credentials when account sync is selected; use trusted storage and HTTPS. The UI shows the actual file size. Active account selection, startup settings, device paths, WebDAV configuration, lifetime/daily statistics, invocation rankings and execution history stay local. Existing cloud files require strong ETags for updates. Sync does not switch accounts or replace the CLI's active `auth.json`; concurrent credential refreshes across computers can still require signing in again.

A desktop application for managing multiple Codex accounts on Windows, macOS and Linux.

[中文说明](README.md) · [Download installers](https://github.com/duiwei996/codex-account-manager/releases)

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

After installing the dependencies and platform-specific Tauri build prerequisites, run `pnpm build:local` to create a local installer with automatic updates enabled. It uses the official public key in `src-tauri/updater-public-key.txt` and this repository's GitHub Releases update endpoint, enabling both frontend and backend update support. `TAURI_UPDATER_PUBLIC_KEY` can explicitly supply a public key matching the signatures of official updates.

Receiving official updates requires no private key and does not generate signed update artifacts. Updates distributed to other installations still use the signed release workflow. `pnpm build` builds only the frontend; direct Tauri build commands do not automatically enable updates.

On Windows, `build:local` adds a project-owned launcher around the stock installer. It checks installed versions and preserves the registered directory during upgrades. Shortcut handling uses official installer hooks; dependency source and third-party templates remain unmodified. Releases sign the final EXE, and Windows updates have separate EXE and MSI entries. All platform package formats remain available.

## Version management

Root `VERSION` is the single version source. Local builds never increment it; cloud builds use the same version. Reserved versions are skipped, and versions older than existing releases are rejected.

After editing `VERSION`, run `pnpm version:sync` to synchronize frontend, Tauri and Cargo metadata, or use `pnpm version:bump 1.0.5` to update all version files explicitly. `pnpm version:check` and build entry points verify consistency. Choose an unused version before releasing; existing drafts are also reserved and their artifacts are not overwritten.

Before pushing, install `cargo-audit 0.22.1` and run `pnpm check:ci` to check versions, Rust formatting, both dependency security audits, the frontend build and tests, and Rust tests on the current host. Any failure stops the checks. Audits use current advisories, so previously passing lockfiles must be checked again. Set `CARGO_AUDIT_BIN` to use an official prebuilt auditor. Use `pnpm release:preflight` for formatting and security checks only. Local checks do not replace CI on other operating systems; `pnpm build:local` creates an installer without certifying that CI passes. Legacy ZIP extraction is disabled in the updater; releases use raw EXE/MSI, AppImage and macOS tar.gz packages.

## License

[MIT](LICENSE). This project is not an official OpenAI application.
