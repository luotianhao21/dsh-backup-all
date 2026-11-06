# dsh-backup-all

> **Snapshot everything. Keep a full backup of your own DSH environment.**
> One click packs your entire DSH setup — plugins, Skills, MCP servers, Agent Presets, config, credentials and external data — into a restorable snapshot file. Before upgrades, before switching machines, before reinstalling the OS.

[简体中文](README.md) | **English**

[![npm](https://img.shields.io/npm/v/dsh-backup-all.svg)](https://www.npmjs.com/package/dsh-backup-all)
[![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-6f42c1.svg)](https://github.com/deepseek-ai)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## What it is

A long-lived DSH environment is scattered across many places: profile config, plugins in `node_modules`, local plugins under `dshbox-plugins`, Skills, MCP connections, Agent Presets, `.credentials.yaml`, external working directories. Manual backup is almost impossible to make complete.

**The point of dsh-backup-all is simple: snapshot everything and keep a backup for yourself.**

- It is **not** a migration-only tool — it is your **environment undo button**: save the full scene before changing anything;
- On snapshot, the Host collects fixed configs, credentials and Skills; AI discovers external data that is actually referenced at runtime and writes a restore plan plus `RESTORE.md`;
- On restore, AI compares the snapshot with the current environment, applies files in batches (with safety backups), then reinstalls dependencies;
- It can also carry a snapshot to a new machine or OS — cross-OS compatible restore is an **extra capability**, not the main purpose.

## When you would use it

| Situation | How |
|---|---|
| Before upgrading DSH / changing plugins | Create a snapshot first; roll back if anything breaks |
| Accidentally deleted config / Skills / local plugins | Restore the snapshot and get the full scene back |
| Reinstalling the OS / moving to another machine | Create a snapshot, copy the `.backup.tar.br`, restore on the new machine |
| Keeping an offline safety archive | Create snapshots regularly; each file is self-contained |
| Just curious what is installed | `INVENTORY.md` / `RESTORE.md` / `manifest.json` inside the snapshot are complete inventories |

## What gets backed up

- **Profile config**: `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, etc.;
- **Plugins**: registry plugins record their source (reinstalled on restore); local `file:`/`link:` plugins — the ones you cannot download again — can be packed in full;
- **Skills / Agent Presets**: discovered entries and config;
- **MCP connections**: connection definitions and related config;
- **Credentials**: `.credentials.yaml` (can be excluded by policy);
- **External data**: AI combines inventory and runtime references to include the directories/scripts you would actually need after restore (validated against safety rules).

> The default policy is "local-only": plugins that can be re-downloaded are recorded by source and reinstalled; only locally-undownloadable plugin code is packed, keeping snapshots reasonably small.

## How it works

**Snapshot**: Host scans the environment (plugins / Skills / MCP / Presets / config / credentials) → AI decides which external data is worth including → writes a restore plan and `RESTORE.md` → packs everything into a tar + Brotli archive (usually ~10% of the original size). Progress is visible and the run is interruptible.

**Restore (rollback)**: a pre-restore snapshot of the current environment is created automatically → AI compares the snapshot with the current state → applies files in batches (every overwritten file is backed up first) → reinstalls dependencies → restart DSH. Because of the pre-restore snapshot, **a rollback can itself be rolled back**.

## Features

- High-compression snapshots (tar + Brotli quality 11) with `manifest.json` / `INVENTORY.md` / `RESTORE.md`;
- AI-driven snapshot and restore using a separately configurable model (OpenAI-compatible / Anthropic), with visible, interruptible tool calls;
- Double safety net: pre-restore snapshot + per-file safety backups;
- A dedicated "Backup ALL" settings page (list / archived / advanced), floating progress ball, mobile layout;
- Per-card **export**; any `.backup.tar.br` can be brought back via **import**;
- Snapshot filenames carry the OS type (`...-linux.backup.tar.br` / `...-windows.backup.tar.br`), and restore picks the strategy automatically;
- **Extra capability: cross-OS compatible restore** for moving Linux ↔ Windows (config/data/credentials migrate; plugin code follows a policy, skipped by default; optional experimental pure-JS migration). Native plugins and system-specific parts must be rebuilt on the target OS.

<table>
<tr>
<td><img src="docs/screenshots/vm-win-01-list.png" alt="Snapshot list with OS badges" width="100%"></td>
<td><img src="docs/screenshots/vm-linux-10-import-dialog.png" alt="Import snapshot dialog" width="100%"></td>
</tr>
<tr>
<td align="center">Snapshot list · OS badges · per-card export</td>
<td align="center">Import snapshot · filename-derived default name</td>
</tr>
</table>

## Install

Requirements: DSH `0.2.1-rc.5` (or compatible), Node.js >= 22, pnpm (provided by DSH plugin management).

```bash
# From npm (recommended)
dsh plugin --profile web add dsh-backup-all

# Or from GitHub
dsh plugin --profile web add github:luotianhao21/dsh-backup-all
```

npm page: <https://www.npmjs.com/package/dsh-backup-all>. Restart DSH; check **Settings → Plugins** that `dsh-backup-all` is enabled — a **Backup ALL** section appears in Settings.

From a local checkout:

```bash
git clone https://github.com/luotianhao21/dsh-backup-all.git
cd dsh-backup-all
dsh plugin --profile web add link:"$PWD"
```

## Quick start (backup → rollback)

1. **Settings → Backup ALL → Advanced**: configure the AI model (Base URL / API Key / Model ID) and test the connection;
2. (Optional) snapshot policy: plugin-code packing scope and whether to exclude credentials;
3. On the **Snapshots** page click **Create snapshot** and confirm — that is your environment archive;
4. To roll back, click **Restore** on the snapshot card; a pre-restore snapshot is created automatically;
5. To keep it offline, click **Export** and store the `.backup.tar.br` somewhere safe; bring it back with **Import snapshot** when needed.

### Snapshot policy

| Setting | Default | Description |
|---|---|---|
| Plugin code | local-only | `local-only` / `all` / `none` |
| Exclude credentials | off | When on, `.credentials.yaml` is not packed |
| Cross-OS plugin code | skip | `skip` / `js` (cross-OS only, experimental pure-JS migration) |

### Restore strategy (chosen from snapshot OS → current OS)

| Snapshot OS → current OS | Strategy | Behavior |
|---|---|---|
| Same OS | Full restore | All entries + dependency reinstall (the usual rollback path) |
| Cross OS | Compatible restore | Config/data/credentials migrate; plugin code skipped by default; symlinks skipped; registry plugins reinstalled; external paths fall back |

> Cross-OS is **compatible restore**, not a byte-for-byte mirror; native plugins, system services and registry-related content must be rebuilt on the target. Same-OS restore is the main design path of this plugin.

## Security

- Snapshots may contain plaintext credentials (`.credentials.yaml`); treat snapshot files as sensitive;
- Overwritten files are backed up before writing; a pre-restore snapshot is created automatically;
- AI prompts contain environment summaries, not plaintext credentials;
- Rotate API keys and other secrets after restoring/migrating.

## Project layout

```
dsh-backup-all/
├── index.js            # Host plugin entry (routes / tools / UI slots)
├── client.js           # Web client (settings page / floating ball / dialogs)
├── cordis.patch.yml    # DSH bundle patch
├── lib/                # Host logic (archive / runner / tools / prompts / platform)
├── prompts/            # Generic AI system prompts
├── locale/             # zh-CN / en-US strings
├── test/               # Node test suite (81 tests)
└── docs/               # API contract / platform strategies / UI spec
```

## Development

```bash
node --check client.js
for f in lib/*.js; do node --check "$f"; done
node --test test/*.test.mjs     # 81 tests
```

## Docs

- [API contract](docs/API-CONTRACT.md)
- [Platform & restore strategies](docs/PLATFORM-STRATEGIES.md)
- [UI spec](docs/UI-SPEC.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 luotianhao21

> Independently developed; not affiliated with DeepSeek. Snapshots contain environment information — evaluate storage and credential security before use.
