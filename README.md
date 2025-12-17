# GDExplorer

GDExplorer is a Tauri v2 desktop app (React + TypeScript) for queueing local files/folders and uploading them to Google Drive Shared Drives using Service Accounts.

Requirements

- Node.js 18+
- Rust (stable)
- Tauri system prerequisites for your OS

Run in development

1) Install dependencies:
   `npm install`

2) Start the dev app:
   `npm run tauri:dev`

Build installers

1) Build the frontend:
   `npm run build`

2) Build the Tauri app (installers/artifacts):
   `npm run tauri:build`

Auto-updates (GitHub Releases)

See `docs/UPDATER_GITHUB_RELEASES.md`.

License

MIT. See `LICENSE.md`.
