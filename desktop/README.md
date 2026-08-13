# Dashou Desktop

Dashou Desktop is the small Tauri launcher for the existing Dashou Node service. It is the user-facing distribution path; npm remains a developer and CLI distribution path.

The app bundles a reviewed Node 22 runtime, the built Dashou service and production dependencies, and a platform-matched cloudflared binary.

User configuration and OAuth state live in the Tauri application data directory, not inside the installed application bundle. The desktop updater uses Tauri signed updater artifacts and never replaces the running service in place.

## Local development

From the repository root:

    npm run desktop:install
    npm run desktop:dev

To stage the runtime resources and build a local bundle:

    DASHOU_CLOUDFLARED_BINARY=/absolute/path/to/cloudflared npm run desktop:build

The build intentionally stops until a real Tauri updater public key is configured. Configure it only in the release environment using desktop/scripts/configure-release.mjs; never commit the updater private key.

The CI workflow builds separate macOS Apple Silicon and Intel `.app`/DMG artifacts plus a Windows NSIS installer. The macOS `.app` target is also required for Tauri updater artifacts. It downloads the pinned official Cloudflare 2026.6.1 release asset and verifies the SHA-256 of the executable that is staged into the bundle. The updater artifacts are signed by the Tauri updater key. Controlled pilot builds may be ad-hoc/unsigned at the platform level; Apple Developer ID/notarization and Windows Authenticode secrets are required before broad public distribution.

Once a signed desktop release is published, the app checks for updates in the background at launch and every six hours. A user can also press “检查更新”; all updater downloads are verified by Tauri signatures before relaunch.

## First-run flow

The user selects an authorized directory, enters the administrator-issued pilot connection code, optionally enters a Tunnel token, and enters the assigned HTTPS public host. The app stores the connection code and generated OAuth owner token in a private application-data file, starts the bundled service, and exposes only the existing five-tool MCP contract.
