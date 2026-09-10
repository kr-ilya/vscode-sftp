import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import { CONFIG_PATH } from '../constants';
import { reportError } from '../helper';
import { showTextDocument } from '../host';
import { mergeDefaults, validateConfig, parseConfigContent } from '../core/config';

// The schema, its validation and the parsing rules all live in src/core/config,
// which imports no editor API. This module is only the adapter: find the file,
// read it, hand the text over, and own the UI for creating a new one.
export { validateConfig };

function getConfigPath(basePath: string) {
  return path.join(basePath, CONFIG_PATH);
}

export async function readConfigsFromFile(configPath: string): Promise<any[]> {
  const content = await fse.readFile(configPath, 'utf8');
  const parsed = parseConfigContent(content, configPath);
  const configs = Array.isArray(parsed) ? parsed : [parsed];
  return configs.map(mergeDefaults);
}

export async function tryLoadConfigs(workspace: string): Promise<any[]> {
  const configPath = getConfigPath(workspace);
  try {
    if (!(await fse.pathExists(configPath))) {
      return [];
    }
    return await readConfigsFromFile(configPath);
  } catch {
    // An absent or unreadable config is not an error here: the caller reads an
    // empty list as "this folder is not configured".
    return [];
  }
}

export function newConfig(basePath: string) {
  const configPath = getConfigPath(basePath);

  return fse
    .pathExists(configPath)
    .then(exist => {
      if (exist) {
        return showTextDocument(vscode.Uri.file(configPath));
      }

      return fse
        .outputJson(
          configPath,
          {
            name: 'My Server',
            host: 'localhost',
            protocol: 'sftp',
            port: 22,
            username: 'username',
            remotePath: '/',
            uploadOnSave: false,
            useTempFile: false,
            openSsh: false,
          },
          { spaces: 4 }
        )
        .then(() => showTextDocument(vscode.Uri.file(configPath)));
    })
    .catch(reportError);
}
