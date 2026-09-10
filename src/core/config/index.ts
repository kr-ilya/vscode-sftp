import { configSchema } from './schema';

export { configSchema, configFileSchema } from './schema';
export type { Config, Profile, WatcherConfig } from './schema';
export { defaultConfig, mergeDefaults } from './defaults';
export { parseConfigContent } from './parse';

/**
 * Validation result, shaped like what the old joi-based validator returned so
 * that callers keep working: an `Error` when the config is bad, `undefined`
 * when it is fine.
 */
export type ValidationError = Error | undefined;

/**
 * Renders a zod issue path the way a user reading their own JSON would see it:
 * `profiles.staging.watcher.files` rather than an array of segments.
 */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.length ? path.map(String).join('.') : '(root)';
}

export function validateConfig(config: unknown): ValidationError {
  const result = configSchema.safeParse(config);
  if (result.success) {
    return undefined;
  }

  // Report every problem at once. joi stopped at the first, which meant fixing
  // a config with three mistakes took three round trips.
  const message = result.error.issues
    .map(issue => `${formatPath(issue.path)}: ${issue.message}`)
    .join('; ');

  return new Error(message);
}
