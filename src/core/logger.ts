/**
 * Logging for the core, with the destination injected.
 *
 * The previous logger created a VS Code output channel at module load and read
 * the debug setting once, at import time. That made it impossible for anything
 * importing it -- which is most of `src/core` -- to be tested or reused without
 * an editor host, and it meant the debug setting only took effect after a
 * window reload (the setting description said as much).
 *
 * What remains module-global here is a single sink slot, not editor coupling: a
 * logger is used from too many call sites to thread through every signature,
 * and the point of the exercise is that core does not depend on `vscode`, not
 * that it has no module state at all. Tests install a capturing sink.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  critical: 60,
};

export interface LogRecord {
  level: LogLevel;
  timestamp: Date;
  parts: unknown[];
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
  critical(message: string | Error, ...args: unknown[]): void;
}

/**
 * Records logged before a real sink is installed are kept rather than dropped.
 * Activation happens after several modules have already initialised, and
 * losing exactly the startup diagnostics is the opposite of useful.
 */
const PENDING_LIMIT = 500;
let pending: LogRecord[] = [];

let sink: LogSink | null = null;
let threshold = LEVEL_ORDER.info;

export function setLogSink(next: LogSink | null): void {
  sink = next;
  if (sink && pending.length) {
    const buffered = pending;
    pending = [];
    for (const record of buffered) sink.write(record);
  }
}

/** Messages below this level are dropped. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

export function getLogLevel(): LogLevel {
  return (Object.keys(LEVEL_ORDER) as LogLevel[]).find(l => LEVEL_ORDER[l] === threshold) ?? 'info';
}

/** Drops the sink and any buffered records. For tests. */
export function resetLogging(): void {
  sink = null;
  pending = [];
  threshold = LEVEL_ORDER.info;
}

function emit(level: LogLevel, parts: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const record: LogRecord = { level, timestamp: new Date(), parts };
  if (sink) {
    sink.write(record);
    return;
  }
  if (pending.length >= PENDING_LIMIT) pending.shift();
  pending.push(record);
}

const logger: Logger = {
  trace: (message, ...args) => emit('trace', [message, ...args]),
  debug: (message, ...args) => emit('debug', [message, ...args]),
  info: (message, ...args) => emit('info', [message, ...args]),
  warn: (message, ...args) => emit('warn', [message, ...args]),
  error: (message, ...args) => emit('error', [message, ...args]),
  critical: (message, ...args) => emit('critical', [message, ...args]),
};

export default logger;

/** Renders one record the way the output channel has always shown it. */
export function formatRecord(record: LogRecord): string {
  const pad = (n: number) => `0${n}`.slice(-2);
  const t = record.timestamp;
  const stamp = `[${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(
    t.getMinutes()
  )}:${pad(t.getSeconds())}]`;

  const body = record.parts
    .map(arg => {
      if (!arg) return arg;
      if (arg instanceof Error) return arg.stack;
      if (typeof arg !== 'object') return arg;
      return JSON.stringify(arg);
    })
    .join(' ');

  return `${stamp} [${record.level}] ${body}`;
}

/** A sink that keeps everything in memory. For tests and diagnostics. */
export function createMemorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: record => void records.push(record) };
}
