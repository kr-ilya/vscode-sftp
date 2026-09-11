/**
 * Explicit command registry.
 *
 * This replaces webpack's `require.context()`, which the old build used to glob
 * this directory at bundle time. That API is webpack-specific -- esbuild has no
 * equivalent -- so the switch of bundlers required making the list explicit.
 *
 * That is an improvement independent of the bundler: the set of commands is now
 * greppable and diffable instead of being an emergent property of filenames and
 * three regexes. Adding a command means adding one import and one row here.
 *
 * The first tuple element is the raw name the old code recovered from the
 * filename; it is still fed through nomalizeCommandName() for display.
 */


import {
  createCommand,
  createFileCommand,
  createFileMultiCommand,
} from './abstract/createCommand';

import commandCancelAllTransfer from './commandCancelAllTransfer';
import commandConfig from './commandConfig';
import commandForgetPassword from './commandForgetPassword';
import commandResetRemotePathApprovals from './commandResetRemotePathApprovals';
import commandListActiveFolder from './commandListActiveFolder';
import commandOpenSshConnection from './commandOpenSshConnection';
import commandSetProfile from './commandSetProfile';
import commandToggleOutputPanel from './commandToggleOutputPanel';
import commandUploadChangedFiles from './commandUploadChangedFiles';
import commandWatchDiagnostics from './commandWatchDiagnostics';
import commandWatchDryRun from './commandWatchDryRun';
import fileCommandCreateFile from './fileCommandCreateFile';
import fileCommandCreateFolder from './fileCommandCreateFolder';
import fileCommandDeleteRemote from './fileCommandDeleteRemote';
import fileCommandDiff from './fileCommandDiff';
import fileCommandDiffActiveFile from './fileCommandDiffActiveFile';
import fileCommandDownload from './fileCommandDownload';
import fileCommandDownloadActiveFile from './fileCommandDownloadActiveFile';
import fileCommandDownloadActiveFolder from './fileCommandDownloadActiveFolder';
import fileCommandDownloadFile from './fileCommandDownloadFile';
import fileCommandDownloadFolder from './fileCommandDownloadFolder';
import fileCommandDownloadForce from './fileCommandDownloadForce';
import fileCommandDownloadProject from './fileCommandDownloadProject';
import fileCommandEditInLocal from './fileCommandEditInLocal';
import fileCommandList from './fileCommandList';
import fileCommandListAll from './fileCommandListAll';
import fileCommandRevealInExplorer from './fileCommandRevealInExplorer';
import fileCommandRevealInRemoteExplorer from './fileCommandRevealInRemoteExplorer';
import fileCommandSyncBothDirections from './fileCommandSyncBothDirections';
import fileCommandSyncLocalToRemote from './fileCommandSyncLocalToRemote';
import fileCommandSyncRemoteToLocal from './fileCommandSyncRemoteToLocal';
import fileCommandUpload from './fileCommandUpload';
import fileCommandUploadActiveFile from './fileCommandUploadActiveFile';
import fileCommandUploadActiveFolder from './fileCommandUploadActiveFolder';
import fileCommandUploadFile from './fileCommandUploadFile';
import fileCommandUploadFolder from './fileCommandUploadFolder';
import fileCommandUploadForce from './fileCommandUploadForce';
import fileCommandUploadProject from './fileCommandUploadProject';
import fileMultiCommandUploadActiveFileToAllProfiles from './fileMultiCommandUploadActiveFileToAllProfiles';
import fileMultiCommandUploadActiveFolderToAllProfiles from './fileMultiCommandUploadActiveFolderToAllProfiles';
import fileMultiCommandUploadFileToAllProfiles from './fileMultiCommandUploadFileToAllProfiles';
import fileMultiCommandUploadFolderToAllProfiles from './fileMultiCommandUploadFolderToAllProfiles';
import fileMultiCommandUploadForceToAllProfiles from './fileMultiCommandUploadForceToAllProfiles';
import fileMultiCommandUploadProjectToAllProfiles from './fileMultiCommandUploadProjectToAllProfiles';
import fileMultiCommandUploadToAllProfiles from './fileMultiCommandUploadToAllProfiles';

/** [rawName, commandOption] as recovered from the old filename convention. */
export type CommandEntry = [string, any];

export const plainCommands: CommandEntry[] = [
  ['CancelAllTransfer', commandCancelAllTransfer],
  ['Config', commandConfig],
  ['ForgetPassword', commandForgetPassword],
  ['ResetRemotePathApprovals', commandResetRemotePathApprovals],
  ['ListActiveFolder', commandListActiveFolder],
  ['OpenSshConnection', commandOpenSshConnection],
  ['SetProfile', commandSetProfile],
  ['ToggleOutputPanel', commandToggleOutputPanel],
  ['UploadChangedFiles', commandUploadChangedFiles],
  ['WatchDiagnostics', commandWatchDiagnostics],
  ['WatchDryRun', commandWatchDryRun],
];

export const fileCommands: CommandEntry[] = [
  ['CreateFile', fileCommandCreateFile],
  ['CreateFolder', fileCommandCreateFolder],
  ['DeleteRemote', fileCommandDeleteRemote],
  ['Diff', fileCommandDiff],
  ['DiffActiveFile', fileCommandDiffActiveFile],
  ['Download', fileCommandDownload],
  ['DownloadActiveFile', fileCommandDownloadActiveFile],
  ['DownloadActiveFolder', fileCommandDownloadActiveFolder],
  ['DownloadFile', fileCommandDownloadFile],
  ['DownloadFolder', fileCommandDownloadFolder],
  ['DownloadForce', fileCommandDownloadForce],
  ['DownloadProject', fileCommandDownloadProject],
  ['EditInLocal', fileCommandEditInLocal],
  ['List', fileCommandList],
  ['ListAll', fileCommandListAll],
  ['RevealInExplorer', fileCommandRevealInExplorer],
  ['RevealInRemoteExplorer', fileCommandRevealInRemoteExplorer],
  ['SyncBothDirections', fileCommandSyncBothDirections],
  ['SyncLocalToRemote', fileCommandSyncLocalToRemote],
  ['SyncRemoteToLocal', fileCommandSyncRemoteToLocal],
  ['Upload', fileCommandUpload],
  ['UploadActiveFile', fileCommandUploadActiveFile],
  ['UploadActiveFolder', fileCommandUploadActiveFolder],
  ['UploadFile', fileCommandUploadFile],
  ['UploadFolder', fileCommandUploadFolder],
  ['UploadForce', fileCommandUploadForce],
  ['UploadProject', fileCommandUploadProject],
];

export const fileMultiCommands: CommandEntry[] = [
  ['UploadActiveFileToAllProfiles', fileMultiCommandUploadActiveFileToAllProfiles],
  ['UploadActiveFolderToAllProfiles', fileMultiCommandUploadActiveFolderToAllProfiles],
  ['UploadFileToAllProfiles', fileMultiCommandUploadFileToAllProfiles],
  ['UploadFolderToAllProfiles', fileMultiCommandUploadFolderToAllProfiles],
  ['UploadForceToAllProfiles', fileMultiCommandUploadForceToAllProfiles],
  ['UploadProjectToAllProfiles', fileMultiCommandUploadProjectToAllProfiles],
  ['UploadToAllProfiles', fileMultiCommandUploadToAllProfiles],
];

export const commandGroups = [
  { entries: plainCommands, create: createCommand },
  { entries: fileCommands, create: createFileCommand },
  { entries: fileMultiCommands, create: createFileMultiCommand },
] as const;
