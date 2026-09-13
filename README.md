# SyncX — SFTP & FTP Sync

Keep a local folder and a remote server in step, over SFTP or FTP, from inside VS Code.

SyncX is a fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), which is itself a fork of [liximomo/vscode-sftp](https://github.com/liximomo/vscode-sftp). It keeps the same `.vscode/sftp.json` format, so an existing configuration works unchanged, and rebuilds the parts that decide **what** to send and **whether to trust the server you are sending it to**.

---

## Why this fork exists

The thing that prompted it: with `watcher.autoUpload` on, the original re-uploads files that have not changed — sometimes the whole project. The cause is that a single file-system event on a *directory* is treated as "transfer this path", and transferring a directory means walking it and uploading every file underneath, regardless of whether any of them differ.

SyncX treats an event as a reason to **check**, not a reason to send:

```
event → is it ignored? → is it a directory? → did we write it ourselves?
      → did size/mtime/inode move? → did the content hash move? → upload
```

Each step can stop the event, and the expensive ones only run when the cheap ones were inconclusive. A `git checkout` between branches now uploads exactly the files that actually differ. Two commands let you see the machinery rather than trust it: **Show Change Detection Diagnostics** (counters per stage) and **Dry Run: Show What Would Be Uploaded** (runs the whole pipeline and sends nothing).

## What else is different

**The server's identity is checked.** The original passes ssh2 neither `hostVerifier` nor `hostHash`, so any host key is accepted silently and the connection is open to a machine-in-the-middle. SyncX verifies it against your real `~/.ssh/known_hosts` (plus `known_hosts2` and the system file), shows the fingerprint in OpenSSH's own `SHA256:…` notation so you can compare it with `ssh-keygen -lf`, and **refuses** when a known host presents a different key — rather than showing a dismissible notification. A host you already accepted in a terminal is not asked about twice.

**Passwords go to VS Code's SecretStorage,** not into the file you commit. They are offered for saving only after they have worked, and there is a *Forget Saved Password* command.

**The first upload to a new destination asks.** A typo in `remotePath` can deploy a project into `/`. Before the first transfer to a path the extension has not used before, it shows you what is actually in that directory and asks once.

**Uploads are atomic by default.** Content goes to a uniquely named staging file and is renamed into place, so a dropped connection leaves the previous version intact instead of a truncated file.

**`concurrency` is a budget for the server,** not for each operation. The original created a scheduler per operation, each with its own budget, so three overlapping uploads with `concurrency: 4` ran twelve transfers at once — which is what trips `MaxSessions` and looks like a flaky network.

**Transfers show bytes and can be stopped.** Long transfers get a notification with a running count and a Cancel button. Short ones stay silent.

**The remote explorer says how each file stands** against your local copy: `M` when it differs, `↓` when there is no local copy, nothing when they match. A file it could not compare says so in the tooltip rather than claiming to be up to date.

**Setup verifies before it writes.** `SyncX: Config` can walk you through a connection, test it, and only then write the file.

**Safety of the workspace itself.** `untrustedWorkspaces` is declared unsupported, and there is no mechanism for running shell commands out of a configuration file. Opening someone else's repository cannot execute anything.

## Install

From the Marketplace: search for **SyncX** in the Extensions view, or

```
ext install kr-ilya.syncx
```

From a `.vsix` (each [release](https://github.com/kr-ilya/vscode-sftp/releases) has one attached):

```
code --install-extension syncx-<version>.vsix
```

Requires VS Code 1.90 or newer.

### Running it alongside the original

Both can be installed at once — the commands live in separate namespaces (`syncx.*` and `sftp.*`), as do the views and settings. But **both read the same `.vscode/sftp.json`**, so with both enabled in the same workspace a saved file is uploaded twice. Disable one of them per workspace.

## Getting started

1. Open the folder you want to sync.
2. Run **SyncX: Config** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Fill in the connection. The wizard can test it before anything is written; the file lands at `.vscode/sftp.json`.
4. To pull an existing project down first, run **SyncX: Download Project**.
5. Edit locally. With `uploadOnSave: true`, saving uploads.

A minimal configuration:

```json
{
  "name": "My Server",
  "host": "example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "deploy",
  "remotePath": "/srv/www/project",
  "uploadOnSave": true
}
```

Leave `password` out and you will be prompted, with the option to remember it in SecretStorage. The file accepts comments and trailing commas.

To upload on every change rather than on save, add a watcher:

```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

`autoDelete` stays off by default: VS Code collapses the deletion of a folder into a single event, so one event can mean a recursive delete on the server.

Several servers for one folder are `profiles`, switched with **SyncX: Set Profile**. A
profile overrides the top level, including `watcher` and `ignore`:

```json
{
  "host": "staging.example.com",
  "username": "deploy",
  "remotePath": "/srv/staging",
  "defaultProfile": "staging",
  "profiles": {
    "staging": { "host": "staging.example.com", "remotePath": "/srv/staging" },
    "production": { "host": "example.com", "remotePath": "/srv/www", "uploadOnSave": false }
  }
}
```

## Documentation

- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md) — every option
- [Common configuration](docs/common_configuration.md)
- [SFTP-only options](docs/sftp_configuration.md)
- [FTP-only options](docs/ftp_configuration.md)
- [Editor settings](docs/setting.md)

## Commands

| Command | What it does |
| --- | --- |
| `SyncX: Config` | Create or open the configuration for this folder |
| `SyncX: Set Profile` | Switch the active profile |
| `SyncX: Upload Changed Files` | Upload everything changed since the last commit (`Ctrl+Alt+U`) |
| `SyncX: Upload Active File` / `Folder` / `Project` | Send one file, one folder, or all of it |
| `SyncX: Download Active File` / `Folder` / `Project` | The same, in reverse |
| `SyncX: Sync Local -> Remote` | Mirror local onto the server |
| `SyncX: Sync Remote -> Local` | Mirror the server onto local |
| `SyncX: Sync Both Directions` | Make the newer copy of each file present in both places |
| `SyncX: Diff Active File with Remote` | Open a diff against the remote version |
| `SyncX: Cancel All Transfers` | Stop everything in flight |
| `SyncX: Open SSH in Terminal` | Open a terminal logged in to the server |
| `SyncX: Show Change Detection Diagnostics` | Counters: events seen, stopped at each stage, uploaded |
| `SyncX: Dry Run: Show What Would Be Uploaded` | The full pipeline, transferring nothing |
| `SyncX: Forget Saved Password` | Remove a password from SecretStorage |
| `SyncX: Reset Confirmed Upload Destinations` | Ask again before the next upload to each destination |

Most also appear in the file explorer's context menu, where holding `Alt` offers **Force Upload** and **Force Download**, which disregard ignore rules.

## Diagnostics

Two output channels: **syncx** for operations and errors, and **SyncX: change detection** for the per-event trace of what was uploaded, what was stopped, and why. Set `syncx.debug` to `true` for verbose logging — the level is read when the extension activates, so reload the window after changing it.

## Known limitations

- **FTP is passive-only.** The transport is `basic-ftp`, which does not implement active mode, so `passive: false` is warned about and ignored. Active mode needs the server to open a connection back to your machine, which almost no firewall allows.
- **A cold start assumes the server matches.** With no recorded state — a fresh install, or a new workspace — SyncX records what is on disk and uploads nothing. If local and remote genuinely differ at that moment, the difference stays until you run an explicit sync. Doing nothing is recoverable; uploading a whole project over a live server is not.
- **Deferred, not implemented:** versioned backups, SSH key generation, drag-and-drop conflict resolution, `su` escalation, and localisation.

## Credits and licence

MIT, inherited from the work this is built on. The licence carries one condition — *mention and credit all original and precedent work* — which is met here and kept in the licence file:

- [liximomo](https://github.com/liximomo/vscode-sftp) — the original extension
- [Natizyskunk](https://github.com/Natizyskunk/vscode-sftp) — maintained it for years afterwards, and is the direct parent of this fork
- Everyone who contributed to either

Two other forks were read while planning this one, for ideas rather than code: [philipdaoud/sftp-neo](https://github.com/philipdaoud/sftp-neo) and [e-u-shapovalov/vscode-sftp](https://github.com/e-u-shapovalov/vscode-sftp). Where an approach was taken from one of them, the comment in the source says so.

Issues and pull requests: <https://github.com/kr-ilya/vscode-sftp/issues>
