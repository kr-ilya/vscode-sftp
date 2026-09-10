import { describe, test, expect, beforeEach } from 'vitest';
import logger, {
  setLogSink,
  setLogLevel,
  resetLogging,
  formatRecord,
  createMemorySink,
} from '../../src/core/logger';

/**
 * None of this was testable before: the logger created a VS Code output channel
 * at module load, so importing it outside an extension host threw.
 */

beforeEach(() => {
  resetLogging();
});

describe('logger', () => {
  test('sends records to the installed sink', () => {
    const sink = createMemorySink();
    setLogSink(sink);

    logger.info('hello', 42);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].level).toBe('info');
    expect(sink.records[0].parts).toEqual(['hello', 42]);
  });

  test('drops records below the threshold', () => {
    const sink = createMemorySink();
    setLogSink(sink);

    logger.trace('noisy');
    logger.debug('also noisy');
    logger.warn('kept');

    expect(sink.records.map(r => r.level)).toEqual(['warn']);
  });

  test('the threshold can be lowered at runtime', () => {
    // The old logger read the debug setting once at import, which is why its
    // description told users to reload the window after changing it.
    const sink = createMemorySink();
    setLogSink(sink);
    setLogLevel('trace');

    logger.trace('now visible');

    expect(sink.records.map(r => r.level)).toEqual(['trace']);
  });

  test('records logged before a sink exists are replayed, not lost', () => {
    // Modules log while initialising, which is before activate() can install
    // the output channel. Dropping exactly the startup diagnostics would be
    // the least useful possible behaviour.
    logger.info('during module init');
    logger.warn('also during init');

    const sink = createMemorySink();
    setLogSink(sink);

    expect(sink.records.map(r => r.parts[0])).toEqual([
      'during module init',
      'also during init',
    ]);
  });

  test('the replay buffer is bounded', () => {
    for (let i = 0; i < 600; i++) logger.info(`message ${i}`);

    const sink = createMemorySink();
    setLogSink(sink);

    expect(sink.records).toHaveLength(500);
    // The oldest were dropped, the newest kept.
    expect(sink.records[sink.records.length - 1].parts[0]).toBe('message 599');
  });

  test('records arriving after the sink is installed are not buffered', () => {
    const sink = createMemorySink();
    setLogSink(sink);
    logger.info('one');
    setLogSink(sink);
    expect(sink.records).toHaveLength(1);
  });
});

describe('formatRecord', () => {
  const at = new Date(2026, 8, 10, 4, 5, 6);

  test('renders timestamp, level and message', () => {
    expect(formatRecord({ level: 'info', timestamp: at, parts: ['hello'] })).toBe(
      '[09-10 04:05:06] [info] hello'
    );
  });

  test('renders an Error as its stack, not [object Object]', () => {
    const error = new Error('boom');
    const rendered = formatRecord({ level: 'error', timestamp: at, parts: ['failed', error] });
    expect(rendered).toContain('failed');
    expect(rendered).toContain('boom');
  });

  test('serialises plain objects', () => {
    expect(
      formatRecord({ level: 'info', timestamp: at, parts: ['config', { host: 'a' }] })
    ).toContain('{"host":"a"}');
  });
});
