import { describe } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';
import localFs from '../../src/core/localFs';
import { runFileSystemContract } from './fileSystemContract';

/**
 * The contract, run against the local file system.
 *
 * This is the reference implementation: if the suite passes here and fails on a
 * remote one, the remote one is wrong. Running it here also proves the suite
 * itself is meaningful before it is pointed at anything that needs a server --
 * a contract nothing has ever satisfied would be no evidence at all.
 */
describe('local file system', () => {
  runFileSystemContract(async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'syncx-contract-'));
    return {
      name: 'local',
      fs: localFs,
      root,
      capabilities: { symlinks: true, setTimes: true, chmod: process.platform !== 'win32' },
      async teardown() {
        await fse.remove(root);
      },
    };
  });
});
