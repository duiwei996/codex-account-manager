# Codex Account Manager

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
4. Click the top transfer icon to switch between Import and Export tabs. Account cards also support single-account export in official auth.json or CPA format.
5. When a new version is offered, confirm installation and restart the app as prompted.

JSON files contain full login credentials; keep them private. CPA Codex format supports signed-in accounts; API key accounts use official format. Optional warm-ups may consume account quota.

Settings provide startup behavior, automatic refresh scope and interval, and automatic update checks. Automatic refresh defaults to the active account every minute; background polling uses five times the interval. Launch at login and minimize to tray at login are enabled by default. The top transfer icon opens Import and Export tabs.

Scheduled warm-up times appear as tags; use the pencil button to edit them in a dialog. Schedules use local time while the app is running; missed times are skipped. Automatic warm-up runs near the beginning of a quota window, at most once per window. Both modes check live quota before sending a request.

On startup, previously fetched account information, quota and statistics appear immediately while data refreshes in the background. Accounts without cached data are fetched once; expired authorization or request failures preserve the last successful values.

## Local builds

After installing the dependencies and platform-specific Tauri build prerequisites, run `pnpm build:local` to create a local installer with automatic updates enabled. It uses the official public key in `src-tauri/updater-public-key.txt` and this repository's GitHub Releases update endpoint, enabling both frontend and backend update support. `TAURI_UPDATER_PUBLIC_KEY` can explicitly supply a public key matching the signatures of official updates.

Receiving official updates requires no private key and does not generate signed update artifacts. Updates distributed to other installations still use the signed release workflow. `pnpm build` builds only the frontend; direct Tauri build commands do not automatically enable updates.

## Version management

Root `VERSION` is the single version source. Local builds never increment it; cloud builds use the same version. Reserved versions are skipped, and versions older than existing releases are rejected.

After editing `VERSION`, run `pnpm version:sync` to synchronize frontend, Tauri and Cargo metadata, or use `pnpm version:bump 1.0.5` to update all version files explicitly. `pnpm version:check` and build entry points verify consistency. Choose an unused version before releasing; existing drafts are also reserved and their artifacts are not overwritten.

## License

[MIT](LICENSE). This project is not an official OpenAI application.
