---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''

---

**Have you read the FAQ?**
- [ ] Yes.
- [ ] [I am going to read it now.](https://github.com/kr-ilya/vscode-sftp/blob/develop/FAQ.md)

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Run command '....'
3. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Versions**
 - OS: [e.g. Windows, macOS, Linux]
 - VS Code version: [e.g. 1.90.0]
 - SyncX version: [e.g. 26.9.1]
 - Protocol: [SFTP, FTP, FTPS, or local]

**Logs** — *required*
  1. Set `syncx.debug` to `true` in settings, then reload the window — the level is read when the extension activates.
  2. Reproduce the problem.
  3. Attach the output from **View > Output**, channel **SyncX**.

**If a file was uploaded when it should not have been, or the other way round**
Also attach:
  - the output channel **SyncX: change detection**, which carries one line per event with the reason;
  - the result of **SyncX: Show Change Detection Diagnostics**.

**Configuration**
Your `.vscode/sftp.json`, with the host and any credentials removed.
