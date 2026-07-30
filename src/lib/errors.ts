/**
 * Structured failures. Nothing in this server throws across a boundary: upstream
 * problems, bad input and internal bugs all become one of these, and the tool
 * dispatcher renders them as an MCP tool error with an actionable message.
 */
export type FailureCode =
  | 'invalid_input'
  | 'not_found'
  | 'no_captures'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  | 'network_error'
  | 'unsupported'
  | 'internal';

export interface Failure {
  readonly code: FailureCode;
  readonly message: string;
  /** What the caller should do next. Rendered on its own line. */
  readonly hint?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface FailureOptions {
  readonly hint?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export function failure(code: FailureCode, message: string, options: FailureOptions = {}): Failure {
  return {
    code,
    message,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
}

/** Human-readable rendering used as the text content of an MCP tool error. */
export function formatFailure(failureValue: Failure): string {
  const lines = [`${failureValue.code}: ${failureValue.message}`];
  if (failureValue.retryAfterMs !== undefined) {
    lines.push(`Retry after about ${Math.ceil(failureValue.retryAfterMs / 1000)}s.`);
  }
  if (failureValue.hint !== undefined) lines.push(failureValue.hint);
  return lines.join('\n');
}

/** Last-resort conversion for unexpected throws. Never leaks a stack trace. */
export function fromUnknown(error: unknown, context: string): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  return failure('internal', `${context}: ${detail}`, {
    hint: 'This is a bug in the server, not in the request. Retrying is unlikely to help.',
  });
}
