/**
 * Lightweight structured logger.
 *
 * Wraps console.* with consistent tag prefixes so the DeveloperConsole
 * filter and grep both work reliably.
 *
 * Levels: debug, info, warn, error.
 * All output goes through console.* (captured by DeveloperConsole monkey-patch).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

function prefix(tag: string, msg: string): string {
  return `[${tag}] ${msg}`;
}

/** Create a scoped logger for a component / service / hook. */
export function createLogger(tag: string) {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      console.debug(prefix(tag, msg), ...args),
    info: (msg: string, ...args: unknown[]) =>
      console.info(prefix(tag, msg), ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(prefix(tag, msg), ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(prefix(tag, msg), ...args),
  };
}
