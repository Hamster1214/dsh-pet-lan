# Security

## Supported versions

Security fixes are provided for the latest published `0.3.x` release.

## Trust model

`dsh-pet-lan` is a **local-network** plugin. It uses UDP broadcast on the LAN and a loopback-only HTTP control surface. It does not contact external servers and does not send telemetry.

The LAN protocol is **plaintext and unauthenticated**:

- The room name is a filter, **not a password**. Anyone on the same LAN who knows the room name and UDP port can announce a pet, spoof another pet's name, send waves, or read broadcast data.
- Presence includes pet names, hostname, viewport and positions. If **Broadcast bubble text** is enabled it also includes the pet's bubble text (which can contain snippets of a conversation) and meme names.
- Incoming waves are rate-limited per sender and globally, and can be disabled with **Accept waves**.
- Use this plugin only on a trusted private LAN. Do not enable it on public Wi-Fi.

No encryption, signing or per-peer authentication is implemented. If you need those properties, do not use this plugin on an untrusted network.

## The optional dsh-pet patch

`scripts/patch-dsh-pet.mjs` is **optional** and **never runs automatically**. When executed, it edits four runtime files inside the installed `dsh-pet` package:

- `lib/client.js`
- `runtime/electron-helper/preload.js`
- `runtime/electron-helper/main.js`
- `runtime/electron-helper/sprite.js`

Each original is backed up as `*.dsh-pet-lan.bak`. The patch is idempotent and must be re-run after a `dsh-pet` update.

Risks:

- It modifies another package outside this plugin's own directory (supply-chain/integrity risk).
- A future `dsh-pet` update can change the anchors and make the patch fail or need adjustment.
- Review the script before running it; keep the backups; restore them to uninstall.

The core LAN features (discovery, names, positions, waves, desktop windows, browser overlay) work without the patch. The patch only adds live animation/bubble/meme synchronization.

## Permissions and side effects

- Opens a UDP socket (default `41234`) for broadcast and unicast.
- Writes config/state under `$DSH_HOME` (`dsh-pet-lan.json`, status/desktop helper files).
- In desktop mode, spawns an Electron helper from `$DSH_HOME/electron` (installed by dsh-pet's desktop mode) and creates transparent, always-on-top windows.
- Starts a loopback-only HTTP API under `/api/pet-lan`; requests from non-loopback sockets are rejected, and Host/Origin/Sec-Fetch-Site are checked.
- Reads local dsh-pet assets for animations/memes; peer-supplied names are bounded and resolved only inside known asset directories.

## Defenses in place

- UDP datagrams larger than 4096 bytes are dropped.
- Presence fields are length-bounded and control characters are stripped.
- Animation/image names reject path separators and `.`/`..` and are resolved under known roots.
- Peer count, per-IP packet rate and global wave rate are bounded.
- The desktop helper uses `contextIsolation: true`, `nodeIntegration: false`, and renders peer text with `textContent` (no `innerHTML`).
- No `postinstall` script; the dsh-pet patch is manual.

## Reporting

Open a private security report via the repository's **Security → Report a vulnerability**, or contact the maintainer through GitHub. Please do not open a public issue for an exploitable problem before a fix is available.
