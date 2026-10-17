// The engine's logger, and the way an embedder takes its lines. By default
// they go to the console as before; `routeEngineLogsTo` replaces that with the
// embedder's own sink (the CLI's output, a test's capture) without touching
// the code that logs.

import winston from 'winston';
import { logger } from '../services/logger';

export { logger };
// The request context id each line carries, read from the shell's own context.
export * from '../services/context/current_id';

export type EngineLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface EngineLogSink {
  (line: { level: EngineLogLevel; message: string; meta: Record<string, unknown> }): void;
}

const LEVELS: readonly string[] = ['error', 'warn', 'info', 'debug'];

function levelOf(raw: unknown): EngineLogLevel {
  // Dev colours the level (`\u001b[32minfo\u001b[39m`), so match what it contains.
  const text = typeof raw === 'string' ? raw : '';
  return (
    ['error', 'warn', 'info', 'debug'] as const
  ).find((level) => text.includes(level)) ?? 'info';
}

// Built on the console transport because winston's own base transport is not a
// dependency of this package; `log` is overridden so nothing is printed.
class SinkTransport extends winston.transports.Console {
  constructor(private readonly sink: EngineLogSink) {
    super();
  }

  override log(info: Record<string | symbol, unknown>, next: () => void): void {
    const { level, message, splat: _splat, ...meta } = info;
    if (typeof level === 'string' && LEVELS.some((known) => level.includes(known))) {
      this.sink({ level: levelOf(level), message: String(message), meta });
    }
    next();
  }
}

/** Send every engine log line to `sink` instead of the console. Returns a
 *  function that puts the console back. */
export function routeEngineLogsTo(sink: EngineLogSink): () => void {
  const transport = new SinkTransport(sink);
  const previous = [...logger.transports];
  logger.clear();
  logger.add(transport);
  return () => {
    logger.remove(transport);
    for (const kept of previous) logger.add(kept);
  };
}
