# Linux desktop builds and CI

## Prerequisites

Target: x86_64 GNU/Linux; CI builds on Ubuntu 22.04 to keep its glibc baseline.
Install current stable Rust (edition 2024), Node.js 22 LTS, npm and native dependencies:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config dpkg-dev file libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev libudev-dev
# Use HTTPS for public plugin submodules when no SSH key is configured:
git -c url.https://github.com/.insteadOf=git@github.com: submodule update --init --recursive
npm ci --prefix frontend
```

## Local unsigned packages (no publishing credentials)

```sh
npm run test:packaging
npm run build:linux                      # release .deb + .AppImage
npm run build:linux -- --debug --bundles deb # faster debug install package
```

The script uses the frontend's pinned Tauri CLI, builds/stages the three database
engine sidecars (ClickHouse, MongoDB, Redis), runs `tsc -b && vite build`, and
packages the app. A temporary config disables **updater artifact signing only**;
no repository config/public key is changed and no development private key is
created. These test packages are not an official signed auto-update release.

Artifacts: `target/release/bundle/{deb,appimage}/` (or `target/debug/bundle/deb/`).
Install with `sudo apt install ./target/release/bundle/deb/*.deb`, then launch
`omnipanel-app` from a graphical session. For AppImage, set executable permission;
on systems without FUSE use `./OmniPanel_*.AppImage --appimage-extract-and-run`.
A tray icon may require a desktop AppIndicator extension. Linux credential storage
requires an unlocked Secret Service (e.g. GNOME Keyring); a headless build has no
such session. Do not disable WebKit sandboxing on normal installed desktops.

For an isolated smoke test use a fresh `HOME` **as well as** `XDG_CONFIG_HOME`,
`XDG_DATA_HOME` and `XDG_CACHE_HOME`: app data lives in `~/.omnipd`, so XDG variables
alone do not isolate it. Do not use an existing user's app profile. Check window visibility,
local terminal command/output and tab close, local file navigation, settings
persistence after restart, plugin list and the DB sidecar handshake. External
SSH/database/cloud/AI integrations need separate test endpoints/credentials;
build success alone does not prove those connections.

## GitHub Actions

- **Linux Packages (no publish)** (`linux-package.yml`): manual or relevant PR;
  no secrets, no release/OSS writes. Builds release `.deb` and `.AppImage`, inspects
  the Debian package and sidecars, uploads Actions artifacts for 14 days. The app
  version follows Cargo/Tauri metadata; release tags must match that version.
- **Build & Release** (`build.yml`): Linux is included in `all`, and can be selected
  with `platforms=linux`. Keeps existing signed release behavior: OSS preflight,
  updater signing, tag version/CHANGELOG validation, GitHub Release and tag-only
  OSS publishing. Requires the existing OSS/updater repository secrets. A manual
  run of this workflow still creates a draft release using the workspace version;
  use **Linux Packages (no publish)** for a credential-free test build instead.
- PR/CI frontend jobs use Node 22 to match current tooling (notably jsdom 29).

Remote Actions execution requires committing/pushing these local changes and an
explicitly authorized workflow run. Local equivalent tests are not a remote CI pass.

## Native Linux startup regression

Tao 0.35.3/GTK aborts if `set_ignore_cursor_events(true)` runs on a hidden,
unrealized window (there is no `GdkWindow` yet). The prewarmed quick launcher
previously made the app abort at startup, and hidden module windows had the same
risk. Linux now skips that Windows-oriented pointer passthrough workaround;
hidden GTK windows do not receive pointer events anyway. Windows/macOS behavior
is unchanged. The artifact workflow also runs the actual Debian-packaged app and AppImage under
Xvfb in an isolated home for 30 seconds, detecting early process exits/panics.
This is process-startup coverage, not a claim that interactive UI tests passed.

For a local headless smoke install `xvfb xauth dbus-x11`, then run:

```sh
bash scripts/smoke-linux-startup.sh target/release/omnipanel-app
```

AppImage's GTK deployment plugin needs `dpkg-architecture` (`dpkg-dev`) and `file`; the local
build checks this before Rust compilation. Debian packages explicitly depend on
`libudev1` and `libssl3` in addition to Tauri's GTK/WebKit/AppIndicator defaults.

## Linux GUI follow-up regressions

The fresh local-terminal UI previously stored the presentation label `PowerShell`
with `shellSpec=null`. Its legacy-label migration converted that label to
Windows PowerShell 5, so the real UI requested a nonexistent executable on Linux
although a direct Bash PTY test succeeded. New tabs use the neutral `Shell` label;
Unix legacy display-only labels delegate detection to the native default shell.
Explicit Bash/zsh/fish/pwsh choices remain explicit; Windows legacy behavior is
preserved. Tests invoke the real `addLocalTerminalTab` -> `createBackendSession`
path and verify the `create_terminal` payload, then exercise `shell=None` in a real
native PTY with `SHELL` unset. Spawn errors now retain their complete cause chain.

Linux launcher hiding no longer applies Windows off-screen/1x1 parking. Placement
uses the requested physical size (not asynchronous GTK cached allocations), the
monitor work area, and bounds clamping, including after result-height changes.
A post-map reapplication handles GTK/WM configure ordering on reopen. Geometry
regressions cover small work areas, negative monitor origins, and HiDPI.
