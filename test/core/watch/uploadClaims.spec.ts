import { describe, test, expect } from 'vitest';
import { createUploadClaims } from '../../../src/core/watch/uploadClaims';
import { createPathKeyer } from '../../../src/core/watch/pathkey';
import type { EntryFacts } from '../../../src/core/watch/state';

/**
 * Claims on uploads that are already under way.
 *
 * The situation being defended against: `uploadOnSave` and a watcher both react
 * to one save, and the tracker does not learn about the upload until it
 * finishes -- so an event examined while the transfer is still running sends
 * the same bytes again. Which of the two wins the race is decided by the
 * server's latency, so the defect appears on a slow link and is invisible on a
 * fast one.
 */

const keyer = createPathKeyer('sensitive');

function facts(over: Partial<EntryFacts> = {}): EntryFacts {
  return { type: 'file', size: 200, mtimeMs: 5000, ino: 7, dev: 2, ...over };
}

describe('what a claim covers', () => {
  test('the bytes it was made for are recognised as already on their way', () => {
    const claims = createUploadClaims(keyer);
    claims.claim('/w/a.txt', facts());

    expect(claims.isInFlight('/w/a.txt', facts())).toBe(true);
  });

  test('a path with no claim is not in flight', () => {
    const claims = createUploadClaims(keyer);
    claims.claim('/w/a.txt', facts());

    expect(claims.isInFlight('/w/other.txt', facts())).toBe(false);
  });

  test('an edit made while the upload runs is not covered by it', () => {
    // The whole point of matching on facts rather than on a timer: these bytes
    // are not the ones being sent, so this event has to go through.
    const claims = createUploadClaims(keyer);
    claims.claim('/w/a.txt', facts());

    expect(claims.isInFlight('/w/a.txt', facts({ mtimeMs: 5001 }))).toBe(false);
    expect(claims.isInFlight('/w/a.txt', facts({ size: 201 }))).toBe(false);
  });

  test('a file replaced by one of the same size and time, but a different inode', () => {
    // What an atomic save by another tool looks like: write a temp file, rename
    // it over the target.
    const claims = createUploadClaims(keyer);
    claims.claim('/w/a.txt', facts());

    expect(claims.isInFlight('/w/a.txt', facts({ ino: 8 }))).toBe(false);
  });

  test('one claim covers the several events a single save produces', () => {
    // A write is visible as repeated events before the file is even closed.
    const claims = createUploadClaims(keyer);
    claims.claim('/w/a.txt', facts());

    for (let i = 0; i < 5; i++) {
      expect(claims.isInFlight('/w/a.txt', facts())).toBe(true);
    }
  });

  test('paths are compared by key, not by spelling', () => {
    const insensitive = createUploadClaims(createPathKeyer('insensitive'));
    insensitive.claim('C:\\W\\A.txt', facts());

    expect(insensitive.isInFlight('c:/w/a.txt', facts())).toBe(true);
  });
});

describe('whether anything was actually held back', () => {
  // Every save is claimed, but only files the watcher covers produce an event.
  // A failed upload has something to undo only in the first case.
  test('a claim nothing asked about held nothing back', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());

    expect(claim.suppressed).toBe(false);
  });

  test('a claim that answered for an event held it back', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());

    claims.isInFlight('/w/a.txt', facts());

    expect(claim.suppressed).toBe(true);
  });

  test('an event it did not match is not credited to it', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());

    claims.isInFlight('/w/a.txt', facts({ mtimeMs: 5001 }));

    expect(claim.suppressed).toBe(false);
  });
});

describe('releasing', () => {
  test('a released claim covers nothing', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());
    claim.release();

    expect(claims.isInFlight('/w/a.txt', facts())).toBe(false);
    expect(claims.size).toBe(0);
  });

  test('releasing twice is harmless', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());
    claim.release();
    claim.release();

    expect(claims.size).toBe(0);
  });

  test('a second save supersedes the first, and the first does not undo it', () => {
    // Save, save again while the first upload is still running, first upload
    // finishes. Withdrawing the newer claim here would leave the event for the
    // newer bytes judged against nothing -- and it is the one that matters.
    const claims = createUploadClaims(keyer);
    const first = claims.claim('/w/a.txt', facts());
    claims.claim('/w/a.txt', facts({ mtimeMs: 6000 }));

    first.release();

    expect(claims.isInFlight('/w/a.txt', facts({ mtimeMs: 6000 }))).toBe(true);
    expect(claims.isInFlight('/w/a.txt', facts())).toBe(false);
  });

  test('nothing is held once every claim has been released', () => {
    const claims = createUploadClaims(keyer);
    const claim = claims.claim('/w/a.txt', facts());
    const newer = claims.claim('/w/a.txt', facts({ mtimeMs: 6000 }));

    claim.release();
    newer.release();

    expect(claims.size).toBe(0);
  });
});
