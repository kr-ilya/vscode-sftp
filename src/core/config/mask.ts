/**
 * Hiding credentials before a configuration reaches the log.
 *
 * Pure, and here rather than beside the logger, so that it can be tested
 * directly: the only thing that makes this function worth having is that it
 * misses nothing, and the way to know is to assert it.
 */

const MASK = '******';
const SECRET_KEYS = new Set(['username', 'password', 'passphrase']);

/**
 * A copy of the configuration with its secrets replaced, for the log.
 *
 * Recursive on purpose. It used to walk only the top level, which left two
 * whole categories of credential in plain text: `hop`, where every jump host
 * carries its own username and password, and `profiles`, where each named
 * environment does -- and a configuration with several environments is the
 * reason profiles exist at all. This is written to the output channel on every
 * activation and on every save of `sftp.json`, which is exactly the output
 * people paste into bug reports.
 */
export function maskConfig(config: unknown): unknown {
  if (Array.isArray(config)) {
    return config.map(item => maskConfig(item));
  }
  // Functions and class instances are not configuration -- `ignore` is a
  // function by the time a service holds one -- and are left to the serialiser.
  if (config === null || typeof config !== 'object') {
    return config;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) {
      copy[key] = MASK;
    } else if (key === 'interactiveAuth' && Array.isArray(value)) {
      copy[key] = value.map(() => MASK);
    } else {
      copy[key] = maskConfig(value);
    }
  }
  return copy;
}
