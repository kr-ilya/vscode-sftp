# Commands

Everything here is in the command palette under **SyncX**, unless it says otherwise.

## Configuration

### SyncX: Config
Create a configuration for this folder, or open the one that exists. Offers to collect the
connection details, test them, and store the password in SecretStorage before writing
`.vscode/sftp.json`.

### SyncX: Set Profile
Switch the active [profile](configuration.md#profiles). The watcher restarts with
that profile's settings.

**Keybinding argument:** `func(profileName: string)`

## Uploading

### SyncX: Upload Changed Files
Upload everything changed or created since the last commit, using git's own view of the
working tree. Bound to `Ctrl+Alt+U` by default. Renames are sent as a rename on the server;
deletions are deleted.

### SyncX: Upload Active File
Upload the file in the active editor.

### SyncX: Upload Active Folder
Upload the folder the active file is in.

### SyncX: Upload Project
Upload everything under `remotePath`.

### SyncX: Upload Active File / Folder / Project To All Profiles
The same, repeated for every profile in the configuration. Asks for confirmation first.

## Downloading

### SyncX: Download Active File
Download the remote version of the active file, overwriting the local copy.

### SyncX: Download Active Folder
Download the folder the active file is in.

### SyncX: Download Project
Download everything under `remotePath`. This is the usual way to start from an empty
local folder.

## Synchronising

### SyncX: Sync Local -> Remote
1. Files that exist on both sides with different timestamps are copied over.
2. Files that exist only locally are copied over.

Adjust with [`syncOption`](configuration.md#syncoption).

### SyncX: Sync Remote -> Local
The same, in the other direction.

### SyncX: Sync Both Directions
Compares modification times and makes the newer copy of each file present in both places.

Only [`skipCreate`](configuration.md#syncoptionskipcreate) and
[`ignoreExisting`](configuration.md#syncoptionignoreexisting) apply to this one.

## Looking at the server

### SyncX: List / List Active Folder / List All
List a remote folder and open what you pick.

### SyncX: Diff Active File with Remote
Open a diff between the active file and its remote version.

### SyncX: Refresh Active Remote File
Re-read the file the active editor is showing from the remote explorer.

### SyncX: Open SSH in Terminal
Open a terminal logged in to the configured server.

## Transfers

### SyncX: Cancel All Transfers
Stop everything in flight, queued transfers included.

## Change detection

### SyncX: Show Change Detection Diagnostics
Counters for the current session: events received, how many were stopped at each stage of
the gate, and how many were uploaded. The first thing to look at when the watcher is doing
more or less than expected.

### SyncX: Dry Run: Show What Would Be Uploaded
Run the whole tree through the same gate the watcher uses and print the decisions.
Transfers nothing.

## Credentials and destinations

### SyncX: Forget Saved Password
Remove a remembered password from SecretStorage.

### SyncX: Reset Confirmed Upload Destinations
Forget which destinations have been confirmed, so the next upload to each asks again.

## Context menu only

These appear on files and folders in the explorer and in the remote explorer, not in the
palette:

**Upload File**, **Upload Folder**, **Download File**, **Download Folder**,
**Diff with Remote**, **Delete**, **Create File**, **Create Folder**,
**Reveal in Explorer**, **Reveal in Remote Explorer**, **Edit in Local**, **View Content**,
**Refresh**.

Holding `Alt` while the menu opens swaps two of them:

- **Force Upload** — upload, disregarding ignore rules.
- **Force Download** — download, disregarding ignore rules.
