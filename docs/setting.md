# Editor settings

Three settings, in VS Code's own settings rather than in `.vscode/sftp.json`:

- Windows/Linux: **File → Preferences → Settings**
- macOS: **Code → Settings → Settings**

Search for `syncx`, or edit `settings.json` directly.

These are settings of the editor. Everything about a *server* lives in
`.vscode/sftp.json` — see [Configuration](./configuration.md).

## syncx.debug

Verbose logging in the output channel. Useful when reporting a problem: it
records what was attempted and what the server answered.

Read it in **View → Output**, channel **syncx**. The per-event decisions of
change detection have their own channel, **SyncX: change detection**, which is
written regardless of this setting.

The level is read when the extension activates, so **reload the window** after
changing it.

| Key | Value | Default |
| --- | --- | --- |
| `syncx.debug` | *boolean* | `false` |

```json
{
  "syncx.debug": true
}
```

## syncx.printDebugLog

The same thing under its older name, kept so existing settings keep working.
Either turns verbose logging on.

| Key | Value | Default |
| --- | --- | --- |
| `syncx.printDebugLog` | *boolean* | `false` |

## syncx.downloadWhenOpenInRemoteExplorer

What clicking a file in the remote explorer does.

- `false` — open a read-only preview of the file as it is on the server.
- `true` — download it and open the local copy, ready to edit.

| Key | Value | Default |
| --- | --- | --- |
| `syncx.downloadWhenOpenInRemoteExplorer` | *boolean* | `false` |

```json
{
  "syncx.downloadWhenOpenInRemoteExplorer": true
}
```

## remotefs.remote

Not a setting of this extension, but read by it: named remotes, so that a
server's connection details live in your user settings instead of in a file
committed with the project. See [`remote`](./configuration.md#remote).
