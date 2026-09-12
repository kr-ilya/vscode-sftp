import { Uri } from 'vscode';
import app from '../app';
import { FileService, ServiceConfig } from '../core';
import UResource from '../uResource';
import logger from '../logger';
import { SkippedTargetError } from '../helper';
import { getFileService } from '../modules/serviceManager';

interface FileHandlerConfig {
  _?: boolean;
}

export interface FileHandlerContext {
  target: UResource;
  fileService: FileService;
  config: ServiceConfig;
}

type FileHandlerContextMethod<R = void> = (this: FileHandlerContext) => R;
type FileHandlerContextMethodArg1<A, R = void> = (this: FileHandlerContext, a: A) => R;

interface FileHandlerOption<T> {
  name: string;
  handle: FileHandlerContextMethodArg1<T, Promise<any>>;
  afterHandle?: FileHandlerContextMethod;
  config?: FileHandlerConfig;
  transformOption?: FileHandlerContextMethod<T>;
}

/**
 * The service a URI belongs to.
 *
 * A menu contribution whose `${command:...}` variable did not resolve arrives
 * here as a URI with the literal text still in it. That is not a file anyone
 * asked to transfer, so it is skipped rather than reported. Upstream threw an
 * empty string for this, which reached the error reporter and put a blank
 * notification on screen -- and named a command id that no longer exists.
 */
function isUnresolvedCommandVariable(uri: Uri): boolean {
  return /^file:\/\/\/\$\{command:/.test(uri.toString(true));
}

function requireFileService(uri: Uri): FileService {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (isUnresolvedCommandVariable(uri)) {
      throw new SkippedTargetError(uri);
    }
    throw new Error(`Config Not Found. (${uri.toString(true)})`);
  }
  return fileService;
}

export function handleCtxFromUri(uri: Uri): FileHandlerContext {
  const fileService = requireFileService(uri);
  const config = fileService.getConfig();
  const target = UResource.from(uri, {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: {
      host: config.host,
      port: config.port,
    },
  });

  return {
    fileService,
    config,
    target,
  };
}

export function allHandleCtxFromUri(uri: Uri): Array<FileHandlerContext> {
  const fileService = requireFileService(uri);

  const configArr = fileService.getAllConfig();

  return configArr.map(config => {
    const target = UResource.from(uri, {
      localBasePath: fileService.baseDir,
      remoteBasePath: config.remotePath,
      remoteId: fileService.id,
      remote: {
        host: config.host,
        port: config.port,
      },
    });

    return {
      fileService,
      config,
      target,
    };
  })
}

export default function createFileHandler<T extends object>(
  handlerOption: FileHandlerOption<T>
): (ctx: FileHandlerContext | Uri, option?: Partial<T>) => Promise<void> {
  async function fileHandle(ctx: Uri | FileHandlerContext, option?: Partial<T>) {
    const handleCtx = ctx instanceof Uri ? handleCtxFromUri(ctx) : ctx;
    const { target } = handleCtx;

    const invokeOption: T = handlerOption.transformOption
      ? handlerOption.transformOption.call(handleCtx)
      : ({} as T);
    if (option) {
      Object.assign(invokeOption, option);
    }

    const ignore = (invokeOption as { ignore?: (p: string) => boolean }).ignore;
    if (ignore && ignore(target.localFsPath)) {
      return;
    }

    logger.trace(`handle ${handlerOption.name} for`, target.localFsPath);

    app.sftpBarItem.startSpinner();
    try {
      await handlerOption.handle.call(handleCtx, invokeOption);
    // } catch (error) {
    //   reportError(error, `when ${handlerOption.name} ${target.localFsPath}`);
    //   Object.defineProperty(error, 'reported', {
    //     configurable: false,
    //     enumerable: false,
    //     value: true,
    //   });
    //   throw error;
    } finally {
      app.sftpBarItem.stopSpinner();
    }
    if (handlerOption.afterHandle) {
      handlerOption.afterHandle.call(handleCtx);
    }
  }

  return fileHandle;
}
