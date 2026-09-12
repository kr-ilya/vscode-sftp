import * as fs from 'fs';
import * as sshConfig from 'ssh-config';
import { fileContentCache } from '../fileContentCache';
import logger from '../logger';
import { replaceHomePath, resolvePath } from '../util/paths';
import upath from '../upath';
import type { FileServiceConfig } from '../fileService';

/**
 * Turning what is in .vscode/sftp.json into what a connection actually needs.
 *
 * Separated from FileService because none of it is about the service: it reads
 * the ignore file, folds in a named remote from the user's settings, applies
 * the matching ~/.ssh/config section, and merges a profile. The class was 713
 * lines with this inside it, and none of this could be exercised without one.
 */

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

export function filesIgnoredFromConfig(config: FileServiceConfig): string[] {
  const cache = fileContentCache;
  const ignore: string[] =
    config.ignore && config.ignore.length ? config.ignore : [];

  const ignoreFile = config.ignoreFile;
  if (!ignoreFile) {
    return ignore;
  }

  let ignoreFromFile;
  if (cache.has(ignoreFile)) {
    ignoreFromFile = cache.get(ignoreFile);
  } else if (fs.existsSync(ignoreFile)) {
    ignoreFromFile = fs.readFileSync(ignoreFile).toString();
    cache.set(ignoreFile, ignoreFromFile);
  } else {
    throw new Error(
      `File ${ignoreFile} not found. Check your config of "ignoreFile"`
    );
  }

  return ignore.concat(ignoreFromFile.split(/\r?\n/g));
}

export function getHostInfo(config) {
  const ignoreOptions = [
    'name',
    'remotePath',
    'uploadOnSave',
    'useTempFile',
    'openSsh',
    'downloadOnOpen',
    'ignore',
    'ignoreFile',
    'watcher',
    'concurrency',
    'syncOption',
    'sshConfigPath',
  ];

  return Object.keys(config).reduce((obj, key) => {
    if (ignoreOptions.indexOf(key) === -1) {
      obj[key] = config[key];
    }
    return obj;
  }, {});
}

export function chooseDefaultPort(protocol) {
  return protocol === 'ftp' ? 21 : 22;
}

function setConfigValue(config, key, value) {
  if (config[key] === undefined) {
    if (key === 'port') {
      config[key] = parseInt(value, 10);
    } else {
      config[key] = value;
    }
  }
}

/**
 * Looks up a named remote from the user's settings.
 *
 * `remote: "my-server"` in a config pulls its connection details from a
 * user-level setting rather than the workspace file. Reading that setting is an
 * editor capability, so it is injected: core states the shape it needs, and the
 * editor layer supplies it at activation.
 *
 * Unconfigured, no named remote resolves -- which surfaces as the same clear
 * "can't find remote" error a genuine typo would produce.
 */
export type NamedRemoteResolver = (name: string) => Record<string, any> | undefined;

let resolveNamedRemote: NamedRemoteResolver = () => undefined;

export function setNamedRemoteResolver(resolver: NamedRemoteResolver): void {
  resolveNamedRemote = resolver;
}

function mergeConfigWithExternalRefer(
  config: FileServiceConfig
): FileServiceConfig {
  const resolved = Object.assign({}, config);

  if (config.remote) {
    const remote = resolveNamedRemote(config.remote);
    if (!remote) {
      throw new Error(`Can't not find remote "${config.remote}"`);
    }
    const remoteKeyMapping = new Map([['scheme', 'protocol']]);

    const remoteKeyIgnored = new Map([['rootPath', 1]]);

    Object.keys(remote).forEach(key => {
      if (remoteKeyIgnored.has(key)) {
        return;
      }

      const targetKey = remoteKeyMapping.has(key)
        ? remoteKeyMapping.get(key)
        : key;
      setConfigValue(resolved, targetKey, remote[key]);
    });
  }

  if (config.protocol !== 'sftp') {
    return resolved;
  }

  const sshConfigPath = replaceHomePath(
    config.sshConfigPath || DEFAULT_SSHCONFIG_FILE
  );

  const cache = fileContentCache;
  let sshConfigContent;
  if (cache.has(sshConfigPath)) {
    sshConfigContent = cache.get(sshConfigPath);
  } else {
    try {
      sshConfigContent = fs.readFileSync(sshConfigPath, 'utf8');
    } catch (error) {
      // Having no ~/.ssh/config is the normal state of most machines, so its
      // absence is not a warning. A path the user named themselves is a
      // different matter: if that one is missing, the defaults they expect to
      // be applied silently are not being applied.
      const askedForByName = Boolean(config.sshConfigPath);
      if (askedForByName || error.code !== 'ENOENT') {
        logger.warn(error.message, `load ${sshConfigPath} failed`);
      } else {
        logger.debug(`no ssh config at ${sshConfigPath}; continuing without one`);
      }
      sshConfigContent = '';
    }
    cache.set(sshConfigPath, sshConfigContent);
  }

  if (!sshConfigContent) {
    return resolved;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: resolved.host,
  });

  // ssh-config@5 types this as a union of line kinds; only sections carry a
  // nested config. Narrow instead of asserting, so a plain directive here
  // degrades to "no ssh_config overrides" rather than throwing.
  if (!section || !('config' in section) || !Array.isArray(section.config)) {
    return resolved;
  }

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['identityfile', 'privateKeyPath'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  section.config.forEach(line => {
    // A section holds comments as well as directives; only the latter have
    // a param/value pair.
    if (!('param' in line) || !line.param || typeof line.value !== 'string') {
      return;
    }

    const key = mapping.get(line.param.toLowerCase());
    if (key === undefined) {
      return;
    }

    if (key === 'host') {
      resolved[key] = line.value;
    } else {
      setConfigValue(resolved, key, line.value);
    }
  });

  // Bug introduced in pull request #69 : Fix ssh config resolution
  /* const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const computed = parsedSSHConfig.compute(resolved.host);

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  Object.entries<any>(computed).forEach(([param, value]) => {
    if (param.toLowerCase() === 'identityfile') {
      setConfigValue(resolved, 'privateKeyPath', value[0]);
      return;
    }

    const key = mapping.get(param.toLowerCase());

    if (key !== undefined) {
      // don't need consider config priority, always set to the resolve host.
      if (key === 'host') {
        resolved[key] = value;
      } else {
        setConfigValue(resolved, key, value);
      }
    }
  }); */

  return resolved;
}

export function getCompleteConfig(
  config: FileServiceConfig,
  workspace: string
): FileServiceConfig {
  const mergedConfig = mergeConfigWithExternalRefer(config);

  if (mergedConfig.agent && mergedConfig.privateKeyPath) {
    logger.warn(
      'Config Option Conflicted. You are specifing "agent" and "privateKey" at the same time, ' +
        'the later will be ignored.'
    );
  }

  // remove the './' part from a relative path
  mergedConfig.remotePath = upath.normalize(mergedConfig.remotePath);
  if (mergedConfig.privateKeyPath) {
    mergedConfig.privateKeyPath = resolvePath(
      workspace,
      mergedConfig.privateKeyPath
    );
  }

  if (mergedConfig.ignoreFile) {
    mergedConfig.ignoreFile = resolvePath(workspace, mergedConfig.ignoreFile);
  }

  // convert ingore config to ignore function
  if (mergedConfig.agent && mergedConfig.agent.startsWith('$')) {
    const evnVarName = mergedConfig.agent.slice(1);
    const val = process.env[evnVarName];
    if (!val) {
      throw new Error(`Environment variable "${evnVarName}" not found`);
    }
    mergedConfig.agent = val;
  }

  return mergedConfig;
}

export function mergeProfile(
  target: FileServiceConfig,
  source: FileServiceConfig
): FileServiceConfig {
  const res = Object.assign({}, target);
  delete res.profiles;

  const keys = Object.keys(source);
  for (const key of keys) {
    if (key === 'ignore') {
      res.ignore = res.ignore.concat(source.ignore);
    } else {
      res[key] = source[key];
    }
  }

  return res;
}
