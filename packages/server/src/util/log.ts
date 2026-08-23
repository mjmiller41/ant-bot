type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.ANTBOT_LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line, extra ?? '');
}

export const logger = (scope: string) => ({
  debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
  info: (m: string, e?: unknown) => emit('info', scope, m, e),
  warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
  error: (m: string, e?: unknown) => emit('error', scope, m, e),
});
