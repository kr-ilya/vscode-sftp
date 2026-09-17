import * as path from 'path';
import * as fs from 'fs';
import { upath } from '../core';
import { pathRelativeToWorkspace, getWorkspaceFolders } from '../host';
import { isSubpathOf } from '../core/util/paths';

// from https://github.com/microsoft/vscode-eslint/blob/d97a8b5e99ad30d2ce32ffa5646447202f873413/server/src/eslintServer.ts#L816
function getFileSystemPath(fsPath: string): string {
	let result = fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		result = result[0].toUpperCase() + result.substr(1);
	}
	if (process.platform === 'win32' || process.platform === 'darwin') {
		// Best effort only: this exists to recover the on-disk casing, and it must
		// not be fatal when the path is not there. It is routinely not -- a file
		// being renamed no longer exists under its old name, and a deleted one
		// does not exist at all -- and an unguarded realpath made every such
		// mapping throw ENOENT on Windows and macOS.
		try {
			const realpath = fs.realpathSync.native(result);
			// Only use the real path if only the casing has changed.
			if (realpath.toLowerCase() === result.toLowerCase()) {
				result = realpath;
			}
		} catch {
			// Keep the path as given.
		}
	}
	return result;
}

export function simplifyPath(absolutePath: string) {
  return pathRelativeToWorkspace(absolutePath);
}

// FIXME: use fs.pathResolver instead of upath
export function toRemotePath(localPath: string, localContext: string, remoteContext: string) {
  return upath.join(remoteContext, path.relative(getFileSystemPath(localContext), getFileSystemPath(localPath)));
}

// FIXME: use fs.pathResolver instead of upath
export function toLocalPath(remotePath: string, remoteContext: string, localContext: string) {
  return path.join(localContext, upath.relative(remoteContext, remotePath));
}

// Pure path helpers live in core so that importing one does not drag the editor
// API in with it. Re-exported here for the existing call sites.
export { isSubpathOf, replaceHomePath, resolvePath } from '../core/util/paths';

/** Editor-aware: needs to know what the open workspace folders are. */
export function isInWorkspace(filepath: string): boolean {
  const workspaceFolders = getWorkspaceFolders();
  // Folded to lower case because VS Code does not promise stable casing for the
  // paths it hands out; compared by segment because a string prefix answers yes
  // for a sibling folder whose name merely starts the same way.
  const file = filepath.toLowerCase();
  return Boolean(
    workspaceFolders &&
    workspaceFolders.some(folder => {
      const root = folder.uri.fsPath.toLowerCase();
      return file === root || isSubpathOf(root, file);
    })
  );
}
