import * as path from 'path';

const VENDOR_FOLDER = '.vscode';

export const EXTENSION_NAME = 'syncx';
// Deliberately unchanged: this is a user setting we only read, so sharing it
// with upstream costs nothing and keeps existing named remotes working.
export const SETTING_KEY_REMOTE = 'remotefs.remote';

// Global across extensions -- only one content provider may claim a scheme,
// so this must not collide with upstream's 'remote'.
export const REMOTE_SCHEME = 'syncx';

// The config filename deliberately stays `sftp.json`: the command namespace is
// ours, but renaming the file would force every existing project to migrate
// for no benefit. (Renaming it is what gave the WireFerry fork its migration
// problem.)
export const CONFIG_FILENAME = 'sftp.json';
export const CONFIG_PATH = path.join(VENDOR_FOLDER, CONFIG_FILENAME);

// command not in package.json
export const COMMAND_TOGGLE_OUTPUT = 'syncx.toggleOutput';

// commands in package.json
export const COMMAND_CONFIG = 'syncx.config';
export const COMMAND_SET_PROFILE = 'syncx.setProfile';
export const COMMAND_CANCEL_ALL_TRANSFER = 'syncx.cancelAllTransfer';
export const COMMAND_OPEN_CONNECTION_IN_TERMINAL = 'syncx.openConnectInTerminal';

export const COMMAND_FORCE_UPLOAD = 'syncx.forceUpload';
export const COMMAND_UPLOAD = 'syncx.upload';
export const COMMAND_UPLOAD_FILE = 'syncx.upload.file';
export const COMMAND_UPLOAD_CHANGEDFILES = 'syncx.upload.changedFiles';
export const COMMAND_UPLOAD_ACTIVEFILE = 'syncx.upload.activeFile';
export const COMMAND_UPLOAD_FOLDER = 'syncx.upload.folder';
export const COMMAND_UPLOAD_ACTIVEFOLDER = 'syncx.upload.activeFolder';
export const COMMAND_UPLOAD_PROJECT = 'syncx.upload.project';

export const COMMAND_FORCE_UPLOAD_TO_ALL_PROFILES = 'syncx.forceUpload.to.allProfiles';
export const COMMAND_UPLOAD_TO_ALL_PROFILES = 'syncx.upload.to.allProfiles';
export const COMMAND_UPLOAD_FILE_TO_ALL_PROFILES = 'syncx.upload.file.to.allProfiles';
export const COMMAND_UPLOAD_ACTIVEFILE_TO_ALL_PROFILES = 'syncx.upload.activeFile.to.allProfiles';
export const COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES = 'syncx.upload.folder.to.allProfiles';
export const COMMAND_UPLOAD_ACTIVEFOLDER_TO_ALL_PROFILES = 'syncx.upload.activeFolder.to.allProfiles';
export const COMMAND_UPLOAD_PROJECT_TO_ALL_PROFILES = 'syncx.upload.project.to.allProfiles';

export const COMMAND_FORCE_DOWNLOAD = 'syncx.forceDownload';
export const COMMAND_DOWNLOAD = 'syncx.download';
export const COMMAND_DOWNLOAD_FILE = 'syncx.download.file';
export const COMMAND_DOWNLOAD_ACTIVEFILE = 'syncx.download.activeFile';
export const COMMAND_DOWNLOAD_FOLDER = 'syncx.download.folder';
export const COMMAND_DOWNLOAD_ACTIVEFOLDER = 'syncx.download.activeFolder';
export const COMMAND_DOWNLOAD_PROJECT = 'syncx.download.project';

export const COMMAND_SYNC_LOCAL_TO_REMOTE = 'syncx.sync.localToRemote';
export const COMMAND_SYNC_REMOTE_TO_LOCAL = 'syncx.sync.remoteToLocal';
export const COMMAND_SYNC_BOTH_DIRECTIONS = 'syncx.sync.bothDirections';

export const COMMAND_DIFF = 'syncx.diff';
export const COMMAND_DIFF_ACTIVEFILE = 'syncx.diff.activeFile';
export const COMMAND_LIST = 'syncx.list';
export const COMMAND_LIST_ACTIVEFOLDER = 'syncx.listActiveFolder';
export const COMMAND_LIST_ALL = 'syncx.listAll';
export const COMMAND_DELETE_REMOTE = 'syncx.delete.remote';
export const COMMAND_REVEAL_IN_EXPLORER = 'syncx.revealInExplorer';
export const COMMAND_REVEAL_IN_REMOTE_EXPLORER = 'syncx.revealInRemoteExplorer';

export const COMMAND_REMOTEEXPLORER_REFRESH = 'syncx.remoteExplorer.refresh';
export const COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE = "syncx.remoteExplorer.refreshActiveFile"
export const COMMAND_REMOTEEXPLORER_EDITINLOCAL = 'syncx.remoteExplorer.editInLocal';
export const COMMAND_REMOTEEXPLORER_VIEW_CONTENT = 'syncx.viewContent';

export const COMMAND_CREATE_FOLDER = 'syncx.create.folder';
export const COMMAND_CREATE_FILE = 'syncx.create.file';
