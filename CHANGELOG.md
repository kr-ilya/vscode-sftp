# Changelog

Versions are `YY.M.N`: the year, the month, and which release that month it is.
`26.9.0` is the first of September 2026, `26.9.1` the next, `26.10.0` the first
of October. The month is never zero-padded -- `26.09.0` is not a valid version
and cannot be published.

## 26.9.1 — 2026-09-16

### Fixed

- **Uploading a folder could fail with a bare `Error: Failure`.** A folder walk transfers its subtrees in parallel, and SFTP `ensureDir` retried `mkdir` unguarded after creating a missing parent — so when another transfer created the same directory in between, the loser was refused by a directory that existed by then. Reachable whenever several transfers build the same missing chain at once, which is the normal case for a first upload into an empty path. Reported from live use.
- **A failed transfer left a descriptor open.** `Promise.all` abandons the other promise on the first rejection, so a source that failed left the target's handle open, and on Windows the staging file could then not be removed. Both handles are opened as a pair and closed before anything is unlinked.
- **One save could be uploaded twice.** `uploadOnSave` and a watcher answer the same save by different routes, and the tracker only learns about an upload when it finishes — so the file went twice whenever the transfer outlasted the 400ms batching window, which on a slow link is every save. An upload now claims the bytes it is sending, and the watcher recognises them as already on their way.
- **Declining a destination looked like a completed upload.** The prompt returned quietly, which the watcher could not tell from a finished transfer: it recorded the file as being on the server and then dropped every later event for it, so a file nobody had sent was treated as sent.
- **Creating a directory did not ask about the destination.** The watcher creates directories before it uploads anything, so with a mistyped `remotePath` the first thing written was a `mkdir` nobody had approved. Both create commands now ask — and a batch starting several transfers at once asks one question rather than one per file in flight.

### Diagnostics

- **A failure names the operation and the remote path.** `mkdir /srv/www/site: Failure` rather than `Failure` on its own, on SFTP and FTP alike. A catch-all status arriving through the transport's own stack said nothing about which request had been refused.

### Performance

- **A batch is uploaded in parallel instead of one file at a time.** Directories still run shallowest first and deletions deepest first, because those orders are load-bearing; uploads constrain nothing and now run to the `concurrency` budget. Measured against a real sshd over loopback, 60 files: 253 ms sequential, 80 ms at `concurrency: 4`.
- **The change-detection state file is 14% smaller.** It is rewritten whole whenever anything changes, so its size is a cost paid over and over rather than once.

### Documentation

- The readme was restructured: a shorter first screen, features as cards, the comparison with the parent fork cut to what matters, and configuration examples moved out of the quick start. Local and remote are used consistently throughout. Both the English and Russian versions.

## 26.9.0 — 2026-09-15

First release of **SyncX**, forked from [Natizyskunk/vscode-sftp 1.16.3](https://github.com/Natizyskunk/vscode-sftp). Everything below is a difference from that version.

The configuration format is unchanged: the same `.vscode/sftp.json`, the same keys. Commands moved to the `syncx.*` namespace, so both extensions can be installed at once — but they read the same configuration file, so only one should be enabled per workspace.

### Change detection

- **A file-system event no longer means "upload".** Events pass through a gate — ignored, entry type, our own write, metadata, content hash — and each step can stop them. An event on a *directory* no longer re-uploads everything underneath it, which is what made `watcher.autoUpload` re-send whole projects that had not changed.
- What was last sent is remembered between windows, per service and per profile, so a reload no longer looks like "nothing is known about any file".
- **With no recorded state, nothing is uploaded.** A fresh install records what is on disk and assumes the server matches. A real divergence waits for an explicit sync — doing nothing is recoverable, mass-uploading over a live server is not.
- `ignore` is applied before a file is queued rather than after, and now defaults to `['.vscode', '.git', '.DS_Store']` — the list upstream's own JSON schema documented but never applied, which is why `.git/index` and `.vscode/sftp.json` were uploaded on every git operation and every edit.
- A profile can override `watcher`, and switching profiles restarts it. It used to be frozen at construction.
- New commands: **Show Change Detection Diagnostics** (counters per stage) and **Dry Run: Show What Would Be Uploaded**.

### Security

- **The server's host key is verified.** ssh2 was given neither `hostVerifier` nor `hostHash`, so any key was accepted silently. Keys are checked against `~/.ssh/known_hosts`, `known_hosts2` and the system file; the fingerprint is shown in OpenSSH's `SHA256:…` notation; a known host presenting a different key is **refused**, not reported in a dismissible notification.
- **Passwords go to SecretStorage** instead of the file you commit, keyed by protocol, host, port, username and kind. A password is offered for saving only after it has worked. Added **Forget Saved Password**.
- **The first upload to a new destination asks,** showing what is already in that directory. A typo in `remotePath` could otherwise deploy a project into `/`. Added **Reset Confirmed Upload Destinations**.
- `capabilities.untrustedWorkspaces` is declared unsupported, and nothing runs shell commands out of a configuration file.
- Runtime dependencies: 28 known vulnerabilities, two of them critical, down to none.

### Fixed

- **SSH connections failed outright** with `TypeError: The "listener" argument must be of type function`. A listener was wired as `.on('close', this.end())` — calling `end()` at wiring time and passing its result. Present upstream since December 2023.
- **An SFTP upload could hang forever** on a transfer that had already completed: ssh2's write stream destroys itself when `autoClose` is on, so it emits `close` and never `finish`, which is what was being waited for.
- **Renaming never worked**: local paths were sent to the server, and in the wrong order.
- **Upload Changed Files reported success before doing anything.** None of its three branches were awaited, so `Promise.all` waited for nothing and failures escaped as unhandled rejections. It also threw for any file that no longer exists locally — that is, for every renamed or deleted one.
- **`sync --delete` dropped its deletions** the same way: fired and not awaited.
- **Cancel missed the tasks easiest to stop.** The body of `cancel()` was guarded on a stream that queued tasks do not yet have, so cancelling anything still in the queue did nothing.
- **`limitOpenFilesOnRemote` broke the connection instead of limiting it.** It patched `sftp._stream`, which ssh2 has not had for years, so enabling the option threw during connect. The accounting underneath it was also wrong in three ways, one of which could wedge a client permanently after enough failed opens.
- **FTP `symlink` reported success and created nothing**, so a sync that should have said "this transport cannot do that" said it had worked.
- **New File / New Folder lost the name you typed** when used on the remote explorer: it was appended to the URI's string form, and a remote URI keeps its path in the query.
- A missing `~/.ssh/config` was logged as a warning. Most machines do not have one.

### Transfers

- **Atomic by default.** Content goes to a uniquely named staging file and is renamed into place. Upstream wrote directly — truncating the target at the start of the transfer, so a dropped connection left a shortened file with the old version already gone — and its optional staging used a fixed `.new` suffix, so two transfers to one path corrupted each other silently.
- **`concurrency` is a budget for the server, not for each operation.** A fresh scheduler was created per operation, each with its own budget: three overlapping uploads with `concurrency: 4` ran twelve transfers at once, which is what trips `MaxSessions`.
- **Progress shows bytes, and can be cancelled.** Transfers lasting more than two seconds get a notification with a running count and a Cancel button.
- The FTP transport moved from `ftp@0.3.10`, last released in 2015, to `basic-ftp`. **`passive: false` is no longer supported** — the new transport is passive-only; a configured value is warned about and ignored.

### Remote explorer

- Files are marked against the local copy: `M` when they differ, `↓` when there is no local copy, nothing when they match. A file that could not be compared says so in its tooltip rather than claiming to be up to date.
- Refreshing after an operation no longer reports `Can't find config for remote resource …` on every successful save.

### Setup

- **SyncX: Config** can collect a connection, verify it, store the password in SecretStorage and only then write the file. Upstream wrote a stub immediately and you found out whether it worked on the first upload.

### Under the hood

Not user-visible, but the reason the rest is possible: `src/core` no longer imports the editor API (enforced by two checks in CI), the configuration schema is a single zod definition that also generates the JSON schema for the editor, the build is esbuild with a smoke test that loads the packaged bundle, and there is a contract test suite that runs the same cases against the local file system, a real sshd and a real FTP server. Upstream's `npm test` did not run at all, and upstream's HEAD did not compile with its own toolchain.

---

Releases before this fork -- the history of
[Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) up to 1.16.3 -- are
kept in [docs/history-upstream.md](docs/history-upstream.md).
