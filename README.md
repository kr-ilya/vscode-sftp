**English** · [Русский](README.ru.md)

# SyncX — SFTP & FTP Sync

**Keep a local folder and a remote one in step, without leaving VS Code.**

Upload on save, mirror either direction on demand, browse and diff the remote side — over SFTP, FTP/FTPS, or a path on this machine.

[**Install from the Marketplace**](https://marketplace.visualstudio.com/items?itemName=kr-ilya.syncx) · [Releases](https://github.com/kr-ilya/vscode-sftp/releases) · [Configuration](docs/configuration.md) · [FAQ](FAQ.md)

- Upload on save, or as files change
- Mirror local → remote, remote → local, or both, with skip/update/delete rules
- Upload exactly what Git reports as changed
- A remote file tree, with each file marked against your local copy
- Several remotes per folder: staging, production, jump hosts
- Host keys verified, passwords in VS Code's SecretStorage

---

## Features

**Sync** — Upload or download a single file, a folder, or the whole project. Mirror local → remote, remote → local, or both directions, with rules for what to skip, update or delete.

**Upload on save** — `uploadOnSave` sends the file you just saved, and `downloadOnOpen` fetches one as you open it. A watcher can upload as files change, and mirror deletions if asked to.

**Remote explorer** — Browse the remote side in its own tree view, open files from it, and see at a glance which ones differ locally. Any file can be diffed against its remote version.

**Git-aware uploads** — Upload everything changed since the last commit, renames and deletions included, with `Ctrl+Alt+U`.

**Profiles** — Several remotes for one folder, switched from the command palette. Multi-root workspaces get a remote per folder, and subtrees can have their own.

**SSH, FTP and FTPS** — Password, private key, `ssh-agent` or keyboard-interactive; entries from `~/.ssh/config` are applied; connections can pass through one or more jump hosts.

## Why SyncX?

A fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), itself a fork of [liximomo/vscode-sftp](https://github.com/liximomo/vscode-sftp). The configuration format is unchanged, so an existing `.vscode/sftp.json` works as it is.

| | Original | SyncX |
| --- | --- | --- |
| **What starts an upload** | Any file-system event, a directory's included | An event starts a check; content is compared before anything is sent |
| **Host keys** | Accepted silently | Verified against `~/.ssh/known_hosts`; a changed key is refused |
| **Passwords** | In the file you commit | In SecretStorage, saved only after they work |
| **A typo in `remotePath`** | Deployed wherever it points | The first upload to a new path asks, showing what is already there |
| **An interrupted upload** | Truncates the remote file | Staged and renamed into place |
| **`concurrency: 4`** | Four transfers per operation | Four in total |
| **During a transfer** | A spinner | Bytes moved, and a Cancel button |
| **Untrusted workspaces** | Not declared | Declared unsupported; no shell commands run from a config file |

Ten defects were fixed along the way, among them SSH connections failing outright, uploads that could hang forever, and `sync --delete` reporting success without deleting anything. The [changelog](CHANGELOG.md) has the full list.

## Install

Install **SyncX** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=kr-ilya.syncx), or download a `.vsix` from the [releases page](https://github.com/kr-ilya/vscode-sftp/releases) and run `code --install-extension syncx-<version>.vsix`.

Requires VS Code **1.90** or newer.

> ⚠️ **Running the original extension too?** Both read the same `.vscode/sftp.json`, so every save would upload twice. Disable one of them for the workspace.

## Quick start

1. Open the folder you want to sync.
2. Run **SyncX: Config** (`Ctrl+Shift+P` / `Cmd+Shift+P`) and fill in the connection — the wizard can test it before writing anything.
3. Already have files on the remote? Run **SyncX: Download Project** first.
4. Edit and save. With `uploadOnSave`, that is all it takes.

```jsonc
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

Leave `password` out and you are asked for it once, with the option to remember it in SecretStorage.

## Configuration

The file lives at `.vscode/sftp.json` and accepts comments and trailing commas. [Every option is documented](docs/configuration.md); the common additions are below.

<details>
<summary><b>Upload as files change, not only on save</b></summary>

```jsonc
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

`autoDelete` is off by default: VS Code collapses the deletion of a folder into a single event, so one event can mean a recursive delete on the remote.

</details>

<details>
<summary><b>Several remotes for one folder</b></summary>

```jsonc
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

Switch with **SyncX: Set Profile**. A profile overrides the top level, `watcher` and `ignore` included.

</details>

<details>
<summary><b>Connect with a key, or through a jump host</b></summary>

```jsonc
{
  "host": "example.com",
  "username": "deploy",
  "remotePath": "/srv/www",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": true,

  "hop": [
    { "host": "bastion.example.com", "username": "jump", "privateKeyPath": "~/.ssh/id_ed25519" }
  ]
}
```

`"passphrase": true` asks for it instead of storing it. Matching entries in `~/.ssh/config` are applied to anything left unset.

</details>

<details>
<summary><b>Leave files out</b></summary>

```jsonc
{
  "ignore": [".vscode", ".git", ".DS_Store", "node_modules"],
  "ignoreFile": ".gitignore"
}
```

The default is `[".vscode", ".git", ".DS_Store"]`, and setting `ignore` replaces that list rather than extending it. Patterns read from `ignoreFile` are added to it. Both are applied before anything is queued, so an ignored file costs nothing.

</details>

## Commands

| Command | |
| --- | --- |
| **Config** | Create or open the configuration for this folder |
| **Set Profile** | Switch the active profile |
| **Upload Changed Files** | Everything changed since the last commit — `Ctrl+Alt+U` |
| **Upload / Download Active File · Folder · Project** | One file, one folder, or all of it |
| **Sync Local → Remote · Remote → Local · Both Directions** | Mirror one side onto the other |
| **Diff Active File with Remote** | Compare with the remote version |
| **List · List Active Folder · List All** | Pick a remote file and open it |
| **Open SSH in Terminal** | A terminal already logged in |
| **Cancel All Transfers** | Stop everything, queued transfers included |
| **Show Change Detection Diagnostics** | Events seen, stopped at each stage, uploaded |
| **Dry Run: Show What Would Be Uploaded** | The whole pipeline, transferring nothing |
| **Forget Saved Password** | Drop a password from SecretStorage |
| **Reset Confirmed Upload Destinations** | Ask again before the next upload to each remote path |

All are prefixed **SyncX:** in the palette. Most also appear in the explorer's context menu, where holding `Alt` swaps Upload and Download for **Force Upload** and **Force Download**, which disregard ignore rules.

Full reference: [commands](docs/commands.md) · [configuration](docs/configuration.md) · [editor settings](docs/setting.md) · [FAQ](FAQ.md).

## Diagnostics

Two output channels:

- **SyncX** — operations and errors. Failures name the operation and the remote path, so a report reads `mkdir /srv/www/site: Failure` rather than `Failure`.
- **SyncX: change detection** — one line per event: what was uploaded, what was stopped, and why.

**SyncX: Show Change Detection Diagnostics** reports the counters for the session, and **Dry Run: Show What Would Be Uploaded** runs the whole pipeline and transfers nothing. Between them, every decision the watcher made is visible.

Set `syncx.debug` for verbose logging. The level is read at activation, so reload the window after changing it.

## Limitations

- **FTP is passive-only.** The transport is `basic-ftp`, which has no active mode, so `passive: false` is warned about and ignored. Active mode requires the server to connect back to your machine, which almost no firewall allows.
- **A first run assumes the two sides match.** With nothing recorded yet, SyncX notes what is on disk and uploads nothing; a real difference waits for an explicit sync. Uploading a whole project into a live remote on first launch is not reversible.

## Credits

MIT, inherited. The licence carries one condition — *mention and credit all original and precedent work*:

- **[liximomo](https://github.com/liximomo/vscode-sftp)** — author of the original extension.
- **[Natizyskunk](https://github.com/Natizyskunk/vscode-sftp)** — maintained it for years; the direct parent of this fork.
- Everyone who contributed to either.

Two further forks were read while planning this one, for ideas rather than code: [philipdaoud/sftp-neo](https://github.com/philipdaoud/sftp-neo) and [e-u-shapovalov/vscode-sftp](https://github.com/e-u-shapovalov/vscode-sftp). Where an approach came from one of them, the comment in the source says so.

Issues and pull requests: <https://github.com/kr-ilya/vscode-sftp/issues>
