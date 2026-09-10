import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { CONFIG_FILENAME } from '../constants';

export function isValidFile(uri: vscode.Uri) {
  return uri.scheme === 'file';
}

export function isConfigFile(uri: vscode.Uri) {
  const filename = path.basename(uri.fsPath);
  return filename === CONFIG_FILENAME;
}

// Pure, so it lives in core; re-exported for the existing call sites.
export { fileDepth } from '../core/util/paths';

export function makeTmpFile(option): Promise<string> {
  return new Promise((resolve, reject) => {
    tmp.file({ ...option, discardDescriptor: true }, (err, tmpPath) => {
      if (err) reject(err);

      resolve(tmpPath);
    });
  });
}
