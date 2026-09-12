import { FileSystem } from './fs';
import { Readable } from 'stream';

interface FileOption {
  mode?: number;
}

export async function transferFile(
  src: string,
  des: string,
  srcFs: FileSystem,
  desFs: FileSystem,
  option?: FileOption
): Promise<void> {
  const inputStream = await srcFs.get(src, option);
  await desFs.put(inputStream, des, option);
}

export function transferSymlink(
  src: string,
  des: string,
  srcFs: FileSystem,
  desFs: FileSystem
): Promise<void> {
  return srcFs.readlink(src).then(targetPath => {
    return desFs.symlink(targetPath, des).catch(err => {
      // ignore file already exist
      if (err.code === 4 || err.code === 'EEXIST') {
        return;
      }
      throw err;
    });
  });
}

export function removeFile(path: string, fs: FileSystem): Promise<void> {
  return fs.unlink(path);
}

export function removeDir(path: string, fs: FileSystem): Promise<void> {
  return fs.rmdir(path, true);
}

export function rename(srcPath: string, destPath: string, fs: FileSystem): Promise<void> {
  return fs.rename(srcPath, destPath);
}

export function createDir(path: string, fs: FileSystem): Promise<void> {
  return fs.mkdir(path);
}

export async function createFile(path: string, fs: FileSystem): Promise<void> {
  let exists = false;
  try {
    await fs.lstat(path);
    exists = true;
  } catch {
    // lstat throwing is the expected path here: the file does not exist yet,
    // which is exactly the precondition for creating it.
  }

  if (exists) {
    // Previously this showed a VS Code error dialog and then returned as if it
    // had succeeded, so the caller could not tell that nothing happened -- and
    // a core file operation owned a piece of the UI. Throwing reaches the user
    // through the command's own reportError, and reports the failure honestly.
    throw new Error(`Can't create "${path}" because it already exists.`);
  }

  const targetFd = await fs.open(path, 'w');
  const s = new Readable();
  s._read = () => { };
  s.push(null);
  return fs.put(s, path, { fd: targetFd });
}
