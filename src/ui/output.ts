import * as vscode from 'vscode';
import app from '../app';
import { EXTENSION_DISPLAY_NAME } from '../constants';
import StatusBarItem from './statusBarItem';
import { setLogSink, setLogLevel, formatRecord } from '../core/logger';
import { getExtensionSetting } from '../modules/ext';

let isShow = false;
const outputChannel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);

export function show() {
  app.sftpBarItem.updateStatus(StatusBarItem.Status.ok);
  outputChannel.show();
  isShow = true;
}

export function hide() {
  outputChannel.hide();
  isShow = false;
}

export function toggle() {
  if (isShow) {
    hide();
  } else {
    show();
  }
}

/** The channel outlives nothing: activate() puts it on the subscription list. */
export function disposeOutput(): void {
  outputChannel.dispose();
}

export function print(...args) {
  const msg = args
    .map(arg => {
      if (!arg) {
        return arg;
      }

      if (arg instanceof Error) {
        return arg.stack;
      } else if (!arg.toString || arg.toString() === '[object Object]') {
        return JSON.stringify(arg);
      }

      return arg;
    })
    .join(' ');

  outputChannel.appendLine(msg);
}

/**
 * Points the core logger at the output channel.
 *
 * Called once from activate(). Until then the core logger buffers, so records
 * emitted while modules are still initialising are not lost -- which is exactly
 * when the interesting ones happen.
 *
 * The level is read here rather than at module load, which is what made the
 * `debug` setting require a window reload to take effect.
 */
export function installLogSink() {
  const setting = getExtensionSetting();
  setLogLevel(setting.debug || setting.printDebugLog ? 'trace' : 'info');
  setLogSink({ write: record => outputChannel.appendLine(formatRecord(record)) });
}
