import type { Config } from '../config.js';

export interface Logger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

/** Replaces the path secret and auth token with a placeholder wherever they appear. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function serialise(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/**
 * Console logger that scrubs secrets from every line. Boot-time lines that must
 * contain the secret (the connector URL) bypass this by writing directly.
 */
export function createLogger(config: Pick<Config, 'pathSecret' | 'authToken'>): Logger {
  const secrets = [config.pathSecret, config.authToken];
  const emit = (level: string, message: string, detail?: Record<string, unknown>): void => {
    const line = redactSecrets(`[${level}] ${message}${serialise(detail)}`, secrets);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  };
}
