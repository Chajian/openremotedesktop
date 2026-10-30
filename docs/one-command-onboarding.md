# One-command device installation and pairing

## Rollout gates

- **Default OFF:** set `ODR_AGENT_INSTALL_ENABLED=true` only after
  the exact Agent version pinned in both installers is approved and publicly available on npm,
  script URLs/checksums are verified, and fresh Windows/macOS pairing reaches READY.
- No production deployment, npm staging/tagging, or existing Agent process change
  is performed by opening this PR.
- `ODR_PUBLIC_BASE_URL` remains the **currently deployed, correct HTTPS origin**.
  Do not use the new hostname until OAuth/Agent multi-domain migration is agreed.
- Deploy Server from the same reviewed Git commit as the installation scripts:
  Dockerfile copies `scripts/install-{windows.ps1,macos.sh}` into the image.
- Keep `ODR_AGENT_INSTALL_ENABLED=false` for rollback without disrupting paired devices.

## User interface scope

- Only the standalone `/dashboard/connect` Add Device wizard is updated to the
  approved full-screen, step-by-step layout (OS → install → manual pairing fallback).
- The existing Dashboard navigation, other pages, and global design are not redesigned.
- Docker Compose forwards `ODR_AGENT_INSTALL_ENABLED` explicitly, with a safe
  default of `false`. Opening the new wizard must not enable unpublished downloads.

## User flow

1. Sign in to Dashboard; use **Add device** (`/dashboard/connect`).
2. Pick Windows or macOS and copy the **one command**. The browser command
   downloads the same-origin script to a temporary file, verifies SHA-256,
   then runs it. Script source and checksum are separately visible.
3. A private Node.js 24 runtime is installed in the current user's directory,
   with no administrator prompt, global PATH modification, Git or Homebrew.
   npm uses **https://registry.npmjs.org/** and installs an exact Agent version.
   The private runtime is added to PATH for npm lifecycle scripts and Agent
   child processes. Windows restores the caller's PATH when the installer
   returns or fails; macOS changes PATH only inside the installer process.
4. The Agent attempts to open `/device?code=XXXX-XXXX`. This carries only
   a ten-minute one-time code, never a refresh token or device code.
   Browser launch is best-effort; terminal always prints the fallback link.
5. The signed-in user **explicitly clicks Approve**. GET cannot approve; POST
   requires a session + CSRF. Approval creates a device owned by that account.
6. The device detail page polls owner-scoped status every 2.5 seconds until READY.
   The first connection remains in the terminal foreground.

## Release and maintenance

1. Merge PR after CI and review; confirm all three platform Agent-smoke jobs.
2. If a new version is needed, run `node scripts/set-agent-version.mjs X.Y.Z`
   **before merging**. This updates npm manifest, both installers and web label.
3. Create `agent-vX.Y.Z` tag on merged master only when explicitly approved.
   Existing GitHub Actions verify the package, stage npm, and create checksummed
   GitHub Release assets. Human completes npm 2FA approval (no token shared).
4. Only after `npm view open-desktop-remote-agent@X.Y.Z version
   --registry=https://registry.npmjs.org/` succeeds, deploy the matching
   Server commit with `ODR_AGENT_INSTALL_ENABLED=true`.
5. Visit the HTTPS `/dashboard/connect` and `/install/windows.ps1` and
   `/install/macos.sh` to verify source, checksum and install command.
   Complete fresh-user Windows and macOS pairing and READY acceptance.
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
