# One-command device installation and pairing

## Rollout gates

- **Default OFF:** set `ODR_AGENT_INSTALL_ENABLED=true` only after
  the exact Agent version pinned in all three installers is approved and publicly available on npm,
  script URLs/checksums are verified, and fresh Windows/macOS/Linux pairing reaches READY.
  An instance already serving Windows/macOS must verify Linux before deploying this
  extension with installation enabled; the shared flag also controls the Linux route.
- No production deployment, npm staging/tagging, or existing Agent process change
  is performed by opening this PR.
- `ODR_PUBLIC_BASE_URL` remains the **currently deployed, correct HTTPS origin**.
  Do not use the new hostname until OAuth/Agent multi-domain migration is agreed.
- Deploy Server from the same reviewed Git commit as the installation scripts:
  Dockerfile copies `scripts/install-{windows.ps1,macos.sh,linux.sh}` into the image.
- Keep `ODR_AGENT_INSTALL_ENABLED=false` for rollback without disrupting paired devices.

## User interface scope

- Only the standalone `/dashboard/connect` Add Device wizard is updated to the
  approved full-screen, step-by-step layout (OS → install → manual pairing fallback).
- The existing Dashboard navigation, other pages, and global design are not redesigned.
- Docker Compose forwards `ODR_AGENT_INSTALL_ENABLED` explicitly, with a safe
  default of `false`. Opening the new wizard must not enable unpublished downloads.

## User flow

1. Sign in to Dashboard; use **Add device** (`/dashboard/connect`).
2. Pick Windows, macOS or Linux and copy the **one command**. The browser command
   downloads the same-origin script to a temporary file, verifies SHA-256,
   then runs it. Script source and checksum are separately visible.
3. A private Node.js 24 runtime is installed in the current user's directory,
   with no administrator prompt, global PATH modification, Git or Homebrew.
   npm uses **https://registry.npmjs.org/** and installs an exact Agent version.
   The private runtime is added to PATH for npm lifecycle scripts and Agent
   child processes. Windows restores the caller's PATH when the installer
   returns or fails; macOS/Linux change PATH only inside the installer process.
4. The Agent attempts to open `/device?code=XXXX-XXXX`. This carries only
   a ten-minute one-time code, never a refresh token or device code.
   Browser launch is best-effort; terminal always prints the fallback link.
5. The signed-in user **explicitly clicks Approve**. GET cannot approve; POST
   requires a session + CSRF. Approval creates a device owned by that account.
6. The device detail page polls owner-scoped status every 2.5 seconds until READY.
   The first connection remains in the terminal foreground.

## Linux installation

The Linux installer supports x64 (`x86_64`) and ARM64 (`aarch64`/`arm64`)
with glibc 2.28+ and a Node.js 24-compatible OS. The upstream
[Node.js platform requirements](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)
also require Linux kernel 4.18+ and compatible system libraries. Alpine/musl,
32-bit ARM and other architectures are not supported by this installer.
It requires Bash, curl with working HTTPS certificates, tar/gzip, sha256sum,
getconf and standard GNU command-line utilities. It does not install OS packages.

Use **Add device → Linux** and copy the checksum-pinned command. It downloads
`/install/linux.sh`, verifies SHA-256 using `sha256sum`, then invokes Bash. The
script installs a private Node.js 24 runtime and the same exact Agent release as
the other platforms into `${XDG_DATA_HOME:-$HOME/.local/share}/OpenDesktopRemote`.
No Git, pnpm, preinstalled Node.js, sudo, global PATH changes or inbound port are
needed. Run it as the user whose local files and terminal you intend to authorize.

For an already downloaded and verified script:

```bash
bash ./install-linux.sh --server https://remote.example.com
```

Options include `--download-source npmmirror`, `--install-dir /absolute/path`,
`--install-only` (install without pairing), and `--package` for an explicit
test/local package with the official source. Repeating installation reuses a
matching Agent version and keeps saved pairing credentials. A failed npm install
is not retried automatically. Existing credentials remain scoped to the Server
origin; installation does not grant device authorization.

On headless or SSH-only machines, open the terminal's pairing link on another
computer or phone, sign in, and approve the one-time code. Keep the terminal/SSH
session open while the device should be online. The installer does not configure
systemd, background services or autostart.

<a id="downloaded-windows-temporary-support"></a>

## Downloaded temporary support

With support and installation enabled and `ODR_SUPPORT_AGENT_VERSION` pinned to
a verified public version >= 0.1.6, creating a session at `/dashboard/support`
returns a customer invitation page with a Windows/macOS/Linux selector and
platform-specific download links. Each platform offers an official-source link,
an npmmirror acceleration link and a manual command fallback.

On Windows, download and double-click `OpenRemote-Support.cmd`. On macOS, run
`bash ~/Downloads/OpenRemote-Support.command` in Terminal; on Linux, run
`bash ~/Downloads/OpenRemote-Support.sh`, adjusting the path if saved elsewhere.
The Linux requirements above also apply to temporary support.
The invitation, trusted Server
origin and exact Agent version are embedded; no code or `YES` input is needed.
Running this file starts full remote support, as explained on the page and in the
foreground window. Only run files from a trusted requester. OS/browser
security prompts may still appear; the launcher does not bypass them.

The file checks invitation availability, downloads the existing installer and
checks its SHA-256 before execution. Default support installation directories are
`%LOCALAPPDATA%\OpenRemoteSupport` on Windows,
`$HOME/Library/Application Support/OpenRemoteSupport` on macOS and
`${XDG_DATA_HOME:-$HOME/.local/share}/OpenRemoteSupport` on Linux.
These are separate from ordinary device installation; the flow reuses the installer's runtime,
package verification and mirror fallback. Downloading alone grants no access and
does not consume the invitation. The five-minute deadline includes installation;
if it expires, request a new download link. Old files do not renew invitations.

Keep the window open during support. Ctrl+C runs the existing stop/revoke flow;
wait for confirmed revocation before closing the terminal. The Windows launcher
keeps success or error output visible afterward. No background service or
autostart is installed. Support credentials remain in memory and ordinary pairing
credentials are not used. Normal manual CLI usage still requires `YES` and an
exact Agent version >= 0.1.4; downloaded automatic launchers require >= 0.1.6.
Before deployment, verify actual downloaded-file startup, READY, a read-only tool
call, and confirmed owner/customer revocation on real Windows, macOS and Linux
devices using the public package. Shell fixtures do not establish real platform acceptance.

## Release and maintenance

### Optional China download acceleration

The device wizard and all three support installers offer **Official (default)**
and **China acceleration (npmmirror)**. The script URL stays on the same trusted
Server origin and its SHA-256 remains pinned in the displayed command. This does
not configure a CDN or change global npm settings.

For a saved, verified installer, select acceleration with
`-DownloadSource npmmirror` on Windows or `--download-source npmmirror` on macOS/Linux.
The default remains `official`. Only exact `open-desktop-remote-agent@X.Y.Z`
packages can use acceleration; use `official` for custom/local package inputs.

- Node.js archive bytes may come from npmmirror, but their expected SHA-256 is
  always obtained from nodejs.org. A failed mirror download falls back to the
  official archive. A checksum mismatch aborts before extraction.
- The exact Agent package metadata and SHA-512 come from registry.npmjs.org.
  The downloaded Agent tarball is verified before npm installation. A missing or
  unreachable mirror falls back to the official tarball and registry; a digest
  mismatch or missing authoritative metadata aborts.
- Transitive packages use the selected registry's metadata and npm integrity
  checks. This is not independent verification of the entire dependency tree
  against an official lockfile. Third-party lifecycle downloads are not redirected.
- Registry selection applies only to the install command. npm failures after
  installation begins are reported, not automatically replayed: lifecycle
  scripts may already have run. Reused installations retain their device identity.

The official metadata endpoints must remain reachable even with acceleration.
Mirror timing depends on the device network and package synchronization; selecting
a mirror does not guarantee faster installation.

### Release checklist

1. Merge PR after CI and review; confirm all three platform Agent-smoke jobs.
2. If a new version is needed, run `node scripts/set-agent-version.mjs X.Y.Z`
   **before merging**. This updates npm manifest, all three installers and web label.
3. Create `agent-vX.Y.Z` tag on merged master only when explicitly approved.
   Existing GitHub Actions verify the package, stage npm, and create checksummed
   GitHub Release assets. Human completes npm 2FA approval (no token shared).
4. Only after `npm view open-desktop-remote-agent@X.Y.Z version
   --registry=https://registry.npmjs.org/` succeeds, deploy the matching
   Server commit with `ODR_AGENT_INSTALL_ENABLED=true`.
5. Visit the HTTPS `/dashboard/connect` and `/install/windows.ps1` and
   `/install/macos.sh` and `/install/linux.sh` to verify source, checksum and install command.
   Complete fresh-user Windows, macOS and Linux pairing and READY acceptance;
   verify Linux x64 and ARM64 separately, including headless approval and reconnect.
6. To roll back: disable the install feature. Existing Agent identities
   and server DB rows remain untouched.

## Security and limitations

- Agent access has local file/terminal capabilities; the consent page warns
  about this. Unknown or expired pairing codes cannot issue credentials.
- Stored credentials are keyed by a hash of the server origin; matching legacy
  Keyring/Keychain or file identities are read and copied into scoped storage.
  The old credential is intentionally not deleted by migration.
- The script SHA-256 is pinned in the rendered command. Node.js archive hashes
  are retrieved from nodejs.org over HTTPS and checked before extraction.
  npm tarball integrity is verified by npm; no publisher 2FA is bypassed.
- A foreground Agent needs its terminal left open. This PR intentionally
  does **not** install background services, autostart or an uninstaller.
- The website rollout is blocked until the pinned Agent version is publicly available
  and the real-device acceptance gates above pass.
- Fresh-system READY cannot be claimed until a real user approves a
  device on a deployed test server; isolated `--install-only` tests do not
  perform device pairing or modify the production Agent.
