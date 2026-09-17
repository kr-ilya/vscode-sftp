import { describe, test, expect } from 'vitest';
import { createRenameRegistry } from '../../../src/core/watch/renames';
import { createPathKeyer } from '../../../src/core/watch/pathkey';

/**
 * Deletions that are not deletions.
 *
 * A rename in the editor reaches the watcher as a deletion of the old path and
 * a creation of the new one. The server has already been told, in one command,
 * so acting on the deletion would undo the move: with `autoDelete` on, the file
 * that was renamed a moment ago is removed, content and all.
 *
 * Matched by path rather than by facts, unlike our own writes: there is nothing
 * left at the old path to compare against. The time limit is therefore part of
 * the mechanism rather than housekeeping, and short.
 */

const keyer = createPathKeyer('sensitive');
const now = 1_000_000;

describe('a path renamed away', () => {
  test('its deletion is recognised as the rename it is', () => {
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old.txt');

    expect(renames.consume('/w/old.txt', now)).toBe(true);
  });

  test('an unrelated deletion is left alone', () => {
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old.txt');

    expect(renames.consume('/w/other.txt', now)).toBe(false);
  });

  test('is consumed once, so a later deletion of the same path means it', () => {
    // A rename produces exactly one deletion. Holding the entry would swallow a
    // real removal of a file that has since come back under the old name.
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old.txt');

    expect(renames.consume('/w/old.txt', now)).toBe(true);
    expect(renames.consume('/w/old.txt', now)).toBe(false);
  });

  test('nothing is held once it has been used', () => {
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old.txt');
    renames.consume('/w/old.txt', now);

    expect(renames.size).toBe(0);
  });
});

describe('a directory renamed away', () => {
  test('covers a file reported inside it', () => {
    // VS Code collapses the removal of a folder into one event on the folder,
    // but a file within one can still arrive on its own.
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old-dir');

    expect(renames.consume('/w/old-dir/src/file.txt', now)).toBe(true);
  });

  test('does not cover a sibling whose name merely starts the same way', () => {
    const renames = createRenameRegistry(keyer);
    renames.renamedAway('/w/old-dir');

    expect(renames.consume('/w/old-dir-backup/file.txt', now)).toBe(false);
  });
});

describe('when the deletion never comes', () => {
  test('the entry is swept rather than kept for ever', () => {
    const renames = createRenameRegistry(keyer, 30_000);
    renames.renamedAway('/w/old.txt');

    expect(renames.consume('/w/old.txt', Date.now() + 60_000)).toBe(false);
    expect(renames.size).toBe(0);
  });

  test('and one still inside the window is honoured', () => {
    const renames = createRenameRegistry(keyer, 30_000);
    renames.renamedAway('/w/old.txt');

    expect(renames.consume('/w/old.txt', Date.now() + 1_000)).toBe(true);
  });
});
