import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as sshConfig from 'ssh-config';
import { fileContentCache } from './fileContentCache';
import logger from './logger';
import { replaceHomePath, resolvePath } from './util/paths';
import upath from './upath';
import Ignore from './ignore';
import { FileSystem } from './fs';
import { createTransferGroup, TransferGroup } from './transferGroup';
import { createRemoteIfNoneExist, removeRemoteFs } from './remoteFs';
import TransferTask from './transferTask';
import localFs from './localFs';

type Omit<T, U> = Pick<T, Exclude<keyof T, U>>;

interface Root {
  name: string;
  context: string;
  watcher: WatcherConfig;
  defaultProfile: string;
}

interface Host {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  connectTimeout: number;
}

interface ServiceOption {
  protocol: string;
  remote?: string;
  uploadOnSave: boolean;
  useTempFile: boolean;
  openSsh: boolean;
  downloadOnOpen: boolean | 'confirm';
  filePerm?: number;
  dirPerm?: number;
  syncOption: {
    delete: boolean;
    skipCreate: boolean;
    ignoreExisting: boolean;
    update: boolean;
  };
  ignore: string[];
  ignoreFile: string;
  remoteExplorer: {
    filesExclude?: string[];
    order: number;
  };
  remoteTimeOffsetInHours: number;
  limitOpenFilesOnRemote: number | true;
}

interface WatcherConfig {
  files: false | string;
  autoUpload: boolean;
  autoDelete: boolean;
}

interface SftpOption {
  // sftp
  agent?: string;
  privateKeyPath?: string;
  passphrase: string | true;
  interactiveAuth: boolean | string[];
  algorithms: any;
  sshConfigPath?: string;
  concurrency: number;
  sshCustomParams?: string;
  hop: (Host & SftpOption)[] | (Host & SftpOption);
}

interface FtpOption {
  secure: boolean | 'control' | 'implicit';
  secureOptions: any;
}

export interface FileServiceConfig
  extends Root,
    Host,
    ServiceOption,
    SftpOption,
    FtpOption {
  profiles?: {
    [x: string]: FileServiceConfig;
  };
}

export interface ServiceConfig
  extends Root,
    Host,
    Omit<ServiceOption, 'ignore'>,
    SftpOption,
    FtpOption {
  ignore?: ((fsPath: string) => boolean) | null;
}

/**
 * What the watcher implementation needs from the service it watches for.
 *
 * `isIgnored` is passed in rather than being looked up later so the watcher can
 * drop an ignored path before it costs a queue slot, a debounce cycle and a
 * handler invocation -- upstream only checked ignore rules deep inside the
 * transfer, after all of that had already happened.
 */
export interface WatcherContext {
  /** Identifies the state store this tree's records belong to. */
  scope: string;
  isIgnored(fsPath: string): boolean;
  /** The service's transfer budget, reused for examining files. */
  concurrency?: number;
}

export interface WatcherService {
  create(watcherBase: string, watcherConfig: WatcherConfig, context: WatcherContext): any;
  dispose(watcherBase: string): void;
}

interface TransferScheduler {
  // readonly _scheduler: Scheduler;
  size: number;
  add(x: TransferTask): void;
  run(): Promise<void>;
  stop(): void;
}

// Returns undefined when the config is valid. The previous signature claimed
// an error was always returned, which was never true -- joi returned
// undefined on success, and getConfig() has always branched on that.
type ConfigValidator = (x: unknown) => { message: string } | undefined;

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

function filesIgnoredFromConfig(config: FileServiceConfig): string[] {
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

function getHostInfo(config) {
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

function chooseDefaultPort(protocol) {
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
  const copyed = Object.assign({}, config);

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
      setConfigValue(copyed, targetKey, remote[key]);
    });
  }

  if (config.protocol !== 'sftp') {
    return copyed;
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
    return copyed;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: copyed.host,
  });

  // ssh-config@5 types this as a union of line kinds; only sections carry a
  // nested config. Narrow instead of asserting, so a plain directive here
  // degrades to "no ssh_config overrides" rather than throwing.
  if (!section || !('config' in section) || !Array.isArray(section.config)) {
    return copyed;
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
      copyed[key] = line.value;
    } else {
      setConfigValue(copyed, key, line.value);
    }
  });

  // Bug introduced in pull request #69 : Fix ssh config resolution
  /* const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const computed = parsedSSHConfig.compute(copyed.host);

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  Object.entries<any>(computed).forEach(([param, value]) => {
    if (param.toLowerCase() === 'identityfile') {
      setConfigValue(copyed, 'privateKeyPath', value[0]);
      return;
    }

    const key = mapping.get(param.toLowerCase());

    if (key !== undefined) {
      // don't need consider config priority, always set to the resolve host.
      if (key === 'host') {
        copyed[key] = value;
      } else {
        setConfigValue(copyed, key, value);
      }
    }
  }); */

  return copyed;
}

function getCompleteConfig(
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

function mergeProfile(
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

enum Event {
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
}

let id = 0;

export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _name: string | undefined;
  private _watcherConfig: WatcherConfig;
  private _profiles: string[] | undefined;
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _transferGroup: TransferGroup | null = null;
  private _config: FileServiceConfig;
  private _configValidator: ConfigValidator | undefined;
  private _activeProfileProvider: () => string | undefined | null = () => undefined;
  private _watcherService: WatcherService = {
    create() {
      /* do nothing  */
    },
    dispose() {
      /* do nothing  */
    },
  };
  id: number;
  baseDir: string;
  workspace: string;

  constructor(baseDir: string, workspace: string, config: FileServiceConfig) {
    this.id = ++id;
    this.workspace = workspace;
    this.baseDir = baseDir;
    this._watcherConfig = config.watcher;
    this._config = config;
    if (config.profiles) {
      this._profiles = Object.keys(config.profiles);
    }
  }

  get name(): string {
    return this._name ? this._name : '';
  }

  set name(name: string) {
    this._name = name;
  }

  setConfigValidator(configValidator: ConfigValidator) {
    this._configValidator = configValidator;
  }

  /**
   * Supplies the currently selected profile. Injected rather than read from the
   * application singleton, so core does not depend on the UI layer and tests can
   * drive profile selection directly.
   */
  setActiveProfileProvider(provider: () => string | undefined | null) {
    this._activeProfileProvider = provider;
  }

  setWatcherService(watcherService: WatcherService) {
    if (this._watcherService) {
      this._disposeWatcher();
    }

    this._watcherService = watcherService;
    this._createWatcher();
  }

  getAvailableProfiles(): string[] {
    return this._profiles || [];
  }

  getPendingTransferTasks(): TransferTask[] {
    return Array.from(this._pendingTransferTasks);
  }

  isTransferring() {
    return this._transferSchedulers.length > 0;
  }

  cancelTransferTasks() {
    // keep the order
    // 1, remove tasks not start
    this._transferSchedulers.forEach(transfer => transfer.stop());
    this._transferSchedulers.length = 0;

    // 2. cancel running task
    this._pendingTransferTasks.forEach(t => t.cancel());
    this._pendingTransferTasks.clear();
  }

  beforeTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.BEFORE_TRANSFER, listener);
  }

  afterTransfer(listener: (err: Error | null, task: TransferTask) => void) {
    this._eventEmitter.on(Event.AFTER_TRANSFER, listener);
  }

  /**
   * Opens a batch on this service's shared transfer scheduler.
   *
   * `concurrency` is a budget for the *service*. Upstream created a fresh
   * scheduler per call, each with its own budget, so three overlapping uploads
   * with `concurrency: 4` ran twelve transfers at once -- which is what trips a
   * server's MaxSessions and looks like a flaky network rather than a setting
   * that was never honoured.
   */
  createTransferScheduler(concurrency): TransferScheduler {
    if (!this._transferGroup) {
      this._transferGroup = createTransferGroup({
        concurrency,
        onTaskStart: task => {
          this._pendingTransferTasks.add(task as TransferTask);
          this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
        },
        onTaskDone: (err, task) => {
          this._pendingTransferTasks.delete(task as TransferTask);
          this._eventEmitter.emit(Event.AFTER_TRANSFER, err, task);
        },
      });
    } else {
      // A profile change can alter it.
      this._transferGroup.setConcurrency(concurrency);
    }

    const batch = this._transferGroup.openBatch();
    const transferScheduler: TransferScheduler = {
      get size() {
        return batch.size;
      },
      stop() {
        batch.stop();
      },
      add(task: TransferTask) {
        batch.add(task);
      },
      run: () =>
        // Deregister on completion. The list backs "is a transfer running?"
        // and the Cancel command, so leaving finished batches in it would make
        // the service look permanently busy and give Cancel nothing to cancel.
        batch.run().finally(() => this._removeScheduler(transferScheduler)),
    };

    this._storeScheduler(transferScheduler);
    return transferScheduler;
  }

  getLocalFileSystem(): FileSystem {
    return localFs;
  }

  getRemoteFileSystem(config: ServiceConfig): Promise<FileSystem> {
    return createRemoteIfNoneExist(getHostInfo(config));
  }

  getConfig(useProfile = this._activeProfileProvider()): ServiceConfig {
    let config = this._config;
    const hasProfile =
      config.profiles && Object.keys(config.profiles).length > 0;
    if (hasProfile && useProfile) {
      logger.info(`Using profile: ${useProfile}`);
      const profile = config.profiles![useProfile];
      if (!profile) {
        throw new Error(
          `Unkown Profile "${useProfile}".` +
            ' Please check your profile setting.' +
            ' You can set a profile by running command `SFTP: Set Profile`.'
        );
      }
      config = mergeProfile(config, profile);
    }

    const completeConfig = getCompleteConfig(config, this.workspace);
    const error =
      this._configValidator && this._configValidator(completeConfig);
    if (error) {
      let errorMsg = `Config validation fail: ${error.message}.`;
      // tslint:disable-next-line triple-equals
      if (hasProfile && this._activeProfileProvider() == null) {
        errorMsg += ' You might want to set a profile first.';
      }
      throw new Error(errorMsg);
    }

    return this._resolveServiceConfig(completeConfig);
  }

  getAllConfig(): Array<ServiceConfig> {
    const profiles = this._config.profiles;
    return profiles ? Object.keys(profiles).map(p => this.getConfig(p)) : [];
  }

  dispose() {
    this._disposeWatcher();
    this._disposeFileSystem();
  }

  private _resolveServiceConfig(
    fileServiceConfig: FileServiceConfig
  ): ServiceConfig {
    const serviceConfig: ServiceConfig = fileServiceConfig as any;

    if (serviceConfig.port === undefined) {
      serviceConfig.port = chooseDefaultPort(serviceConfig.protocol);
    }
    if (serviceConfig.protocol === 'ftp') {
      serviceConfig.concurrency = 1;
    }
    serviceConfig.ignore = this._createIgnoreFn(fileServiceConfig);

    return serviceConfig;
  }

  private _storeScheduler(scheduler: TransferScheduler) {
    this._transferSchedulers.push(scheduler);
  }

  private _removeScheduler(scheduler: TransferScheduler) {
    const index = this._transferSchedulers.findIndex(s => s === scheduler);
    if (index !== -1) {
      this._transferSchedulers.splice(index, 1);
    }
  }

  private _createIgnoreFn(config: FileServiceConfig): ServiceConfig['ignore'] {
    const localContext = this.baseDir;
    const remoteContext = config.remotePath;

    const ignoreConfig = filesIgnoredFromConfig(config);
    if (ignoreConfig.length <= 0) {
      return null;
    }

    const ignore = Ignore.from(ignoreConfig);
    const ignoreFunc = fsPath => {
      // vscode will always return path with / as separator
      const normalizedPath = path.normalize(fsPath);
      let relativePath;
      if (normalizedPath.indexOf(localContext) === 0) {
        // local path
        relativePath = path.relative(localContext, fsPath);
      } else {
        // remote path
        relativePath = upath.relative(remoteContext, fsPath);
      }

      // skip root
      return relativePath !== '' && ignore.ignores(relativePath);
    };

    return ignoreFunc;
  }

  /**
   * Rebuilds the watcher from the *effective* configuration.
   *
   * Upstream captured `config.watcher` in the constructor and never looked
   * again, so a profile that overrode `watcher` was ignored and switching
   * profiles left the old watcher in place. Reading it here, through
   * getConfig(), means the active profile applies.
   */
  private _createWatcher() {
    let watcherConfig = this._watcherConfig;
    let isIgnored: (fsPath: string) => boolean = () => false;
    let scope = String(this.id);
    let concurrency: number | undefined;

    try {
      const config = this.getConfig();
      watcherConfig = config.watcher ?? watcherConfig;
      const ignore = config.ignore;
      if (ignore) isIgnored = fsPath => ignore(fsPath);
      scope = `${this.id}:${this._activeProfileProvider() ?? ''}`;
      concurrency = config.concurrency;
    } catch {
      // An invalid or incomplete config must not prevent the watcher from
      // existing at all; fall back to what the constructor was given.
    }

    this._watcherService.create(this.baseDir, watcherConfig, { scope, isIgnored, concurrency });
  }

  /** Rebuilds the watcher, e.g. after the active profile changed. */
  reloadWatcher() {
    this._disposeWatcher();
    this._createWatcher();
  }

  private _disposeWatcher() {
    this._watcherService.dispose(this.baseDir);
  }

  // fixme: remote all profiles
  private _disposeFileSystem() {
    return removeRemoteFs(getHostInfo(this.getConfig()));
  }
}
