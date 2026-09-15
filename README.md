**English** · [Русский](README.ru.md)

# SyncX — SFTP & FTP Sync

**Keep a local folder and a remote server in step, from inside VS Code.**
Upload on save, mirror in either direction, browse the server in a tree, diff against it — over SFTP, FTP/FTPS, or a local path.

A fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) (itself a fork of [liximomo/vscode-sftp](https://github.com/liximomo/vscode-sftp)). Same `.vscode/sftp.json`, so an existing configuration works unchanged.

---

## What it does

| | |
| --- | --- |
| **Transfer** | Upload or download a file, a folder, or the whole project. SFTP, FTP, FTPS, or a path on this machine. |
| **On save** | `uploadOnSave` sends the file you just saved. `downloadOnOpen` fetches it when you open one. |
| **On change** | A watcher can upload as files change, and optionally mirror deletions. |
| **Sync** | Local → remote, remote → local, or both directions, with rules for what to skip, update or delete. |
| **From git** | Upload everything changed since the last commit, renames and deletions included (`Ctrl+Alt+U`). |
| **Remote explorer** | Browse the server in its own tree view, open files from it, and see which ones differ from your copy. |
| **Diff** | Compare the file in the editor with the version on the server. |
| **Profiles** | Several servers for one folder — staging, production — switched from the palette. |
| **Multiple roots** | A different server per workspace folder, and per subtree within one. |
| **Hopping** | Reach a server through one or more jump hosts. |
| **Ignore rules** | Glob patterns inline or from a file, applied before anything is queued. |
| **Auth** | Password, private key, `ssh-agent`, keyboard-interactive. Settings from `~/.ssh/config` are picked up. |

## How it differs from the fork it came from

| | Original | SyncX |
| --- | --- | --- |
| **What triggers an upload** | Any file-system event — including one on a *directory*, which re-uploads everything underneath it | An event starts a check. Ignored → directory → our own write → size/mtime/inode → content hash. A `git checkout` uploads only what actually differs |
| **Server identity** | Any host key accepted silently; no man-in-the-middle protection at all | Verified against your `~/.ssh/known_hosts`; fingerprint shown as OpenSSH prints it; a changed key is **refused** |
| **Passwords** | In the file you commit | VS Code's SecretStorage, saved only after they have worked |
| **Wrong `remotePath`** | Deploys into whatever the typo points at | The first upload to a new destination shows what is already there and asks once |
| **Interrupted upload** | Target truncated at the start, so a dropped connection loses both versions | Written to a staging file and renamed into place |
| **`concurrency: 4`** | Four transfers *per operation* — three at once meant twelve | Four for the server, whatever is running |
| **During a transfer** | A spinner | Bytes moved, and a Cancel button |
| **Remote explorer** | File names | File names, marked against your local copy |
| **New configuration** | Written immediately; you find out it is wrong on the first upload | Offered as a wizard that connects first |
| **Untrusted workspace** | Not declared | Declared unsupported; nothing runs shell commands out of a config file |

Ten defects were fixed along the way — among them SSH connections failing outright, an SFTP upload that could hang forever, rename never working, and `sync --delete` reporting success without deleting anything. The [changelog](CHANGELOG.md) lists them.

## Install

**From the Marketplace** — search for *SyncX* in the Extensions view, or:

```
ext install kr-ilya.syncx
```

**From a file** — every [release](https://github.com/kr-ilya/vscode-sftp/releases) has a `.vsix` attached:

```
code --install-extension syncx-<version>.vsix
```

Needs VS Code **1.90** or newer.

> **Installing both?**
> SyncX and the original can be installed together — separate commands, views and settings — but **both read the same `.vscode/sftp.json`**. With both enabled in one workspace, every save uploads twice. Disable one of them per workspace.

## Quick start

1. Open the folder you want to sync.
2. Run **SyncX: Config** (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Fill in the connection — the wizard can test it before writing anything.
4. Already have files on the server? **SyncX: Download Project** first.
5. Edit. With `uploadOnSave`, saving sends the file.

The file lands at `.vscode/sftp.json` and accepts comments and trailing commas:

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

Leave `password` out and you are asked for it, with the option to remember it in SecretStorage.

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

`autoDelete` is off by default: VS Code collapses the deletion of a folder into one event, so a single event can mean a recursive delete on the server.

</details>

<details>
<summary><b>Several servers for one folder</b></summary>

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

`"passphrase": true` asks for it instead of storing it. Matching entries in `~/.ssh/config` are applied for anything left unset.

</details>

## Commands

| Command | |
| --- | --- |
| **Config** | Create or open the configuration for this folder |
| **Set Profile** | Switch the active profile |
| **Upload Changed Files** | Everything changed since the last commit — `Ctrl+Alt+U` |
| **Upload / Download Active File · Folder · Project** | One file, one folder, or all of it |
| **Sync Local → Remote · Remote → Local · Both Directions** | Mirror one side onto the other |
| **Diff Active File with Remote** | Compare with the version on the server |
| **List · List Active Folder · List All** | Pick a remote file and open it |
| **Open SSH in Terminal** | A terminal already logged in |
| **Cancel All Transfers** | Stop everything, queued transfers included |
| **Show Change Detection Diagnostics** | Events seen, stopped at each stage, uploaded |
| **Dry Run: Show What Would Be Uploaded** | The whole pipeline, transferring nothing |
| **Forget Saved Password** | Drop a password from SecretStorage |
| **Reset Confirmed Upload Destinations** | Ask again before the next upload to each |

All are prefixed **SyncX:** in the palette. Most also sit in the explorer's context menu, where holding `Alt` swaps Upload and Download for **Force Upload** and **Force Download**, which disregard ignore rules.

## Documentation

[Commands](docs/commands.md) · [Configuration](docs/configuration.md) — every option, with [SFTP](docs/configuration.md#sftp-only-configuration) and [FTP](docs/configuration.md#ftps-only-configuration) sections · [Editor settings](docs/setting.md) · [FAQ](FAQ.md)

## When something looks wrong

Two output channels:

- **syncx** — operations and errors.
- **SyncX: change detection** — one line per event: what was uploaded, what was stopped, and why.

`SyncX: Show Change Detection Diagnostics` gives the counters, and `Dry Run` shows what *would* be sent without sending it — between them, "why did it upload that" is answerable rather than guessable. Set `syncx.debug` for verbose logging; the level is read at activation, so reload the window after changing it.

## Limitations

- **FTP is passive-only.** The transport is `basic-ftp`, which has no active mode, so `passive: false` is warned about and ignored. Active mode needs the server to connect back to your machine, which almost no firewall allows.
- **A first run assumes the server matches.** With nothing recorded yet, SyncX notes what is on disk and uploads nothing. A genuine difference waits for an explicit sync — doing nothing is recoverable, overwriting a live server is not.
- **Not implemented:** versioned backups, SSH key generation, drag-and-drop conflict resolution, `su` escalation, localisation.

## Credits

MIT, inherited. The licence carries one condition — *mention and credit all original and precedent work* — which is why this section exists and stays:

- **[liximomo](https://github.com/liximomo/vscode-sftp)** — wrote the original extension.
- **[Natizyskunk](https://github.com/Natizyskunk/vscode-sftp)** — maintained it for years, and is the direct parent of this fork.
- Everyone who contributed to either.

Two further forks were read while planning this one, for ideas rather than code: [philipdaoud/sftp-neo](https://github.com/philipdaoud/sftp-neo) and [e-u-shapovalov/vscode-sftp](https://github.com/e-u-shapovalov/vscode-sftp). Where an approach came from one of them, the comment in the source says so.

Issues and pull requests: <https://github.com/kr-ilya/vscode-sftp/issues>
