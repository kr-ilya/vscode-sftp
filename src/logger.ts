/**
 * The logger the whole extension shares.
 *
 * The implementation is in src/core/logger.ts, which knows nothing about the
 * editor; the output-channel sink is installed at activation by
 * src/ui/output.ts. This file exists so the ~18 existing call sites keep their
 * import path.
 */
export { default, setLogSink, setLogLevel, getLogLevel, resetLogging, formatRecord, createMemorySink } from './core/logger';
export type { Logger, LogLevel, LogRecord, LogSink } from './core/logger';
