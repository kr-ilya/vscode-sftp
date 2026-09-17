import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import logger from './logger';
import upath from './upath';
import Ignore from './ignore';
import { FileSystem } from './fs';
import { fileContentCache } from './fileContentCache';
import { isSubpathOf } from './util/paths';
import * as path from 'path';
import {
  chooseDefaultPort,
  filesIgnoredFromConfig,
  getCompleteConfig,
  getHostInfo,
  mergeProfile,
} from './config/serviceConfig';
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

enum Event {
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
}

// Re-exported: the composition root installs the resolver through this module,
// which is where every other capability of a service is wired up.
export { setNamedRemoteResolver, type NamedRemoteResolver } from './config/serviceConfig';

let id = 0;

/**
 * Names the change-detection state that belongs to one watcher.
 *
 * It used to carry `this.id`, a counter over the life of the process. Every
 * reload of the configuration builds new services with new ids, so the state
 * file was renamed on every save of `sftp.json`: what had been recorded was
 * never found again, the whole tree was hashed afresh, and the previous file
 * was left behind in global storage for good.
 *
 * Derived from where the files go instead. The profile is part of it because
 * one file legitimately has different state per server; so is the destination,
 * because state recorded against one server says nothing about another, and a
 * `remotePath` that has been repointed must not look already synchronised.
 */
function watchScope(config: ServiceConfig, profile: string): string {
  const destination = [
    config.protocol ?? '',
    config.host ?? '',
    config.port ?? '',
    config.username ?? '',
    config.remotePath ?? '',
  ].join('\u0000');

  return `${createHash('sha256').update(destination).digest('hex').slice(0, 16)}:${profile}`;
}

export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _name: string | undefined;
  private _watcherConfig: WatcherConfig;
  private _profiles: string[] | undefined;
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _transferGroup: TransferGroup | null = null;
  private readonly _configMemo = new Map<string, ServiceConfig>();
  private _configMemoGeneration = -1;
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

  /**
   * The configuration a connection and a transfer actually run against.
   *
   * Memoised because it is asked for once per file handled -- a five thousand
   * file sync asked five thousand times -- and answering costs about a third of
   * a millisecond: the ssh_config is parsed, the ignore rules compiled, and a
   * handful of objects copied, every time, from inputs that do not move.
   *
   * The memo is keyed on the profile and on the content cache's generation, so
   * editing ~/.ssh/config or the ignore file drops it; changing
   * .vscode/sftp.json disposes the service outright. A failure is not memoised,
   * so an invalid configuration keeps reporting itself on every call.
   */
  getConfig(useProfile = this._activeProfileProvider()): ServiceConfig {
    const memoKey = useProfile ?? '';
    const generation = fileContentCache.generation;
    if (this._configMemoGeneration !== generation) {
      this._configMemo.clear();
      this._configMemoGeneration = generation;
    }

    const memoised = this._configMemo.get(memoKey);
    if (memoised) {
      return memoised;
    }

    const resolved = this._resolveConfig(useProfile);
    this._configMemo.set(memoKey, resolved);
    return resolved;
  }

  private _resolveConfig(useProfile: string | undefined | null): ServiceConfig {
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

  /**
   * Releases the watcher and the connection.
   *
   * Nothing here may throw. `_disposeFileSystem` resolves the configuration to
   * find which connection to close, and resolving it fails for exactly the
   * configurations most likely to be disposed -- an incomplete one being
   * edited, or one whose profile has not been chosen. Thrown, that aborted the
   * loop reloading every service in the workspace, leaving some removed and
   * none recreated until the window was reloaded.
   */
  dispose() {
    try {
      this._disposeWatcher();
    } catch (error) {
      logger.warn('[service] could not dispose the watcher', error);
    }
    try {
      this._disposeFileSystem();
    } catch (error) {
      logger.warn('[service] could not close the connection', error);
    }
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
      // By segment, not by prefix: `/work/proj-backup/a.txt` is not inside
      // `/work/proj`, and treating it as local made the ignore rules apply
      // relative to a root the file does not belong to.
      if (normalizedPath === localContext || isSubpathOf(localContext, normalizedPath)) {
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
      scope = watchScope(config, this._activeProfileProvider() ?? '');
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
