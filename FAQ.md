**English** · [Русский](FAQ.ru.md)

# FAQ

- [Nothing is uploaded after I install it](#nothing-is-uploaded-after-i-install-it)
- [Why did it not upload my change?](#why-did-it-not-upload-my-change)
- [It refuses to connect: the host key has changed](#it-refuses-to-connect-the-host-key-has-changed)
- [Where is my password kept?](#where-is-my-password-kept)
- [It asks me to confirm the destination](#it-asks-me-to-confirm-the-destination)
- [Everything uploads twice](#everything-uploads-twice)
- [Error: Failure](#error-failure)
- [Error: Connection closed](#error-connection-closed)
- [ENFILE: file table overflow](#enfile-file-table-overflow)
- [`passive: false` is ignored](#passive-false-is-ignored)
- [How do I upload the contents of a folder, but not the folder itself?](#how-do-i-upload-the-contents-of-a-folder-but-not-the-folder-itself)
- [How do I upload as root?](#how-do-i-upload-as-root)
- [Keeping both sides in step automatically](#keeping-both-sides-in-step-automatically)
- [Hidden files are missing from the remote explorer](#hidden-files-are-missing-from-the-remote-explorer)

---

## Nothing is uploaded after I install it

That is deliberate, and only happens once.

With no record of what is on the server, SyncX does not assume your local copy should win. On its first run it notes what is on disk and treats the server as matching it, so an outdated local file cannot silently overwrite something live.

Send the first copy yourself — **SyncX: Upload Project**, or **Sync Local → Remote** — and from then on changes go out on their own.

## Why did it not upload my change?

An event on a file is a reason to check, not a reason to send, so a file whose contents did not actually change is not re-sent. To find out what happened to a particular file:

1. **SyncX: Show Change Detection Diagnostics** — how many events arrived and where they stopped.
2. **SyncX: Dry Run: Show What Would Be Uploaded** — runs the whole pipeline and transfers nothing.
3. The **SyncX: change detection** output channel — one line per event, with the reason.

The usual answers are: the path matches an `ignore` rule, the content is identical to what was last sent, or the watcher is not configured (`watcher.autoUpload` off and `uploadOnSave` off).

## It refuses to connect: the host key has changed

A server you have connected to before is presenting a different key. SyncX refuses rather than asking, because that is what a machine-in-the-middle looks like.

If the change is expected — the server was rebuilt, or its keys were rotated — remove the old entry and connect again:

```sh
ssh-keygen -R example.com
```

If you accepted the key through SyncX rather than through `ssh`, its own store is `known_hosts` inside the extension's global storage directory; delete the line for that host there.

If you did not expect the change, do not proceed until you know why.

## Where is my password kept?

In VS Code's SecretStorage, not in `.vscode/sftp.json` — so the file stays safe to commit. You are offered the choice only after the password has actually worked.

- **SyncX: Forget Saved Password** removes it.
- A password that stops working is dropped automatically and you are asked again.
- A `password` written into the configuration file still works and is used as-is; nothing is stored in that case.

## It asks me to confirm the destination

Once per destination, before the first write of any kind to it — an upload, or a directory created for one — with a listing of what is already in that directory.

A typo in `remotePath` is not visible in the configuration file — it is a perfectly ordinary path, just not yours — and the first upload is what makes it permanent. Seeing `bin, boot, dev, etc` in that listing is a clearer signal than any warning.

**Declining sends nothing and records nothing.** Nothing is written to the server, no approval is stored, and the file is *not* marked as being on the server — so the next transfer to that destination asks the question again.

**SyncX: Reset Confirmed Upload Destinations** makes it ask again after you have agreed.

## Everything uploads twice

SyncX and the original extension are both enabled in the same workspace. They have separate commands, views and settings, but they read the **same** `.vscode/sftp.json`, so both act on every save.

Disable one of them for that workspace: Extensions view → the extension → *Disable (Workspace)*.

## Error: Failure

A generic message from the server: the SFTP server sends it when a syscall fails and it has nothing more specific to say.

SyncX puts the operation and the remote path in front of it, so the line reads `mkdir /srv/www/site: Failure` rather than `Failure` on its own — which is usually enough to tell which step failed. Enabling debug logging on the server side and repeating the transfer shows the rest.

Two things are worth trying first:

- If `remotePath` points at a symbolic link, use the path it resolves to.
- The server may be out of file descriptors. Raise its limit if you can; if you cannot, set [`limitOpenFilesOnRemote`](docs/configuration.md#limitopenfilesonremote) in your configuration, which keeps the number of handles open at once below a cap.

> Worth knowing if you tried this before: in the extension this was forked from, turning `limitOpenFilesOnRemote` on threw during connect and the connection simply failed. It works here.

## Error: Connection closed

Older servers may not support the algorithms negotiated by default. Override them explicitly in `.vscode/sftp.json` — this list removes `diffie-hellman-group-exchange-sha256`, which is the usual culprit:

```json
{
  "algorithms": {
    "kex": [
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521"
    ],
    "cipher": [
      "aes128-gcm",
      "aes128-gcm@openssh.com",
      "aes256-gcm",
      "aes256-gcm@openssh.com",
      "aes128-cbc",
      "aes192-cbc",
      "aes256-cbc",
      "aes128-ctr",
      "aes192-ctr",
      "aes256-ctr"
    ],
    "serverHostKey": [
      "ssh-rsa",
      "ssh-dss",
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "rsa-sha2-256",
      "rsa-sha2-512"
    ],
    "hmac": [
      "hmac-sha2-256",
      "hmac-sha2-512"
    ]
  }
}
```

Narrowing `serverHostKey` changes which key type the server offers, so the first connection afterwards may ask about a key you have not seen before. That is expected — compare the fingerprint with `ssh-keygen -lf` before accepting it.

## ENFILE: file table overflow

macOS limits the number of open files quite tightly. Raise it:

```sh
echo kern.maxfiles=65536 | sudo tee -a /etc/sysctl.conf
echo kern.maxfilesperproc=65536 | sudo tee -a /etc/sysctl.conf
sudo sysctl -w kern.maxfiles=65536
sudo sysctl -w kern.maxfilesperproc=65536
ulimit -n 65536
```

Lowering `concurrency` in the configuration reduces how many transfers run at once, which helps for the same reason.

## `passive: false` is ignored

The FTP transport is `basic-ftp`, which has no active mode, so the setting is warned about and passive mode is used.

Active mode requires the server to open a connection back to your machine, which almost no firewall or NAT allows — which is why passive has been the default for decades.

## How do I upload the contents of a folder, but not the folder itself?

Set `context` to the folder. Everything under it is then treated as the root of what gets synced.

This uploads the JavaScript and HTML in `./build` straight into `/folder1/folder2/folder3`, with no `build` directory on the server:

```json
{
  "name": "My Server",
  "host": "example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "context": "./build",
  "uploadOnSave": false,
  "watcher": {
    "files": "*.{js,html}",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

## How do I upload as root?

You cannot, and nothing in the configuration makes it possible.

> You may find advice elsewhere to set `"sshCustomParams": "sudo su -;"`. It does nothing for transfers: that option is appended to the command line of the **Open SSH in Terminal** command and never touches SFTP.

SFTP has no mechanism for changing user mid-session; doing it properly means running a shell on the server and piping the file through it, which is a different feature with its own security considerations. It is deliberately not implemented here.

What to do instead:

- Give the account you connect with write access to the target directory — `chown` it, or add the account to a group that can write there.
- Upload to a directory you can write, and move the files into place with a separate privileged step on the server.

## Keeping both sides in step automatically

Upload as files change, and mirror deletions:

```json
{
  "name": "My Server",
  "host": "example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "uploadOnSave": false,
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true
  },
  "syncOption": {
    "delete": true
  }
}
```

With a watcher over `**/*`, `uploadOnSave` is redundant -- the save reaches the watcher as a file-system event anyway -- but it is no longer harmful to leave on: an upload already under way is recognised as such, and the file is not sent twice.

This works with git too: checking out a branch, or reverting, updates the server to match — and only the files that actually differ are sent.

> **`autoDelete` deletes on the server.** VS Code collapses the removal of a folder into a single event, so one event can mean a recursive delete. It is off by default for that reason. Try it with `"autoUpload": true, "autoDelete": false` first, and watch the **SyncX: change detection** channel to see what it would have removed.

## Hidden files are missing from the remote explorer

Over FTP, whether dotfiles appear is up to the server.

**proftpd** — edit `proftpd.conf`, which lives in one of:

- `/etc/proftpd.conf`
- `/etc/proftpd/proftpd.conf`
- `/usr/local/etc/proftpd.conf`
- `/usr/local/etc/proftpd/proftpd.conf`

Change `ListOptions` from `"-l"` to `"-la"`:

```conf
<Global>
[...]
ListOptions "-la"
[...]
</Global>
```

Over SFTP, hidden files are listed normally. If something is missing there, check `remoteExplorer.filesExclude` in your configuration — it defaults to hiding `.git`, `.svn`, `.hg`, `CVS` and `.DS_Store`.
