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

macOS installers use ad-hoc signing and are not notarized by Apple. On first launch, you may need to click Open Anyway in System Settings → Privacy & Security. If that option is unavailable or the app still reports that it is damaged, report your macOS version and installer filename.

## Usage

1. Open the app and add an account by signing in through your browser or importing an existing `auth.json`.
2. View account information in the account list, select an account and switch to it.
3. You can also switch accounts from the system tray.
4. Click Export on an account card to choose official auth.json or CPA format, preview, copy or download. Use the top export icon to export all accounts. When adding accounts, select multiple JSON files to import both formats together.
5. When a new version is offered, confirm installation and restart the app as prompted.

JSON files contain full login credentials; keep them private. CPA Codex format supports signed-in accounts; API key accounts use official format. Optional warm-ups may consume account quota.

## License

[MIT](LICENSE). This project is not an official OpenAI application.
