import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export interface AuthRequest {
  /** Path secret taken from the URL, if the route carried one. */
  readonly pathSecret: string | undefined;
  readonly authorization: string | undefined;
}

export type AuthResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly wwwAuthenticate?: string;
    };

/**
 * Pluggable authentication. The shipped default is path-secret-only (see
 * DECISIONS-MADE.md); bearer checking activates when MCP_AUTH_TOKEN is set, and
 * OAuth can be added later as another implementation without touching transport
 * or routing code.
 */
export interface AuthProvider {
  readonly name: string;
  check(request: AuthRequest): AuthResult;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The primary control: an unguessable path segment. */
export class PathSecretAuthProvider implements AuthProvider {
  readonly name = 'path-secret';
  private readonly expected: string;

  constructor(expected: string) {
    this.expected = expected;
  }

  check(request: AuthRequest): AuthResult {
    if (request.pathSecret !== undefined && constantTimeEquals(request.pathSecret, this.expected)) {
      return { ok: true };
    }
    // Deliberately indistinguishable from an unknown route.
    return { ok: false, status: 404, code: 'not_found', message: 'Not found.' };
  }
}

/** Optional `Authorization: Bearer <token>` check, off unless MCP_AUTH_TOKEN is set. */
export class BearerTokenAuthProvider implements AuthProvider {
  readonly name = 'bearer';
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  check(request: AuthRequest): AuthResult {
    const header = request.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const presented = match?.[1];
    if (presented !== undefined && constantTimeEquals(presented.trim(), this.token)) return { ok: true };
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'A valid Authorization: Bearer token is required.',
      wwwAuthenticate: 'Bearer realm="wayback-mcp"',
    };
  }
}

export class CompositeAuthProvider implements AuthProvider {
  readonly name: string;
  private readonly providers: readonly AuthProvider[];

  constructor(providers: readonly AuthProvider[]) {
    this.providers = providers;
    this.name = providers.map((provider) => provider.name).join('+');
  }

  check(request: AuthRequest): AuthResult {
    for (const provider of this.providers) {
      const result = provider.check(request);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
}

export function buildAuthProvider(config: Config): AuthProvider {
  const providers: AuthProvider[] = [new PathSecretAuthProvider(config.pathSecret)];
  if (config.authToken !== undefined) providers.push(new BearerTokenAuthProvider(config.authToken));
  return new CompositeAuthProvider(providers);
}

/**
 * Origin policy. Requests with no Origin header are allowed on purpose: Anthropic
 * calls a custom connector server-to-server from its own infrastructure and sends
 * no Origin. Rejecting those is the most common cause of a connector that shows
 * "Disconnected" with no useful error.
 */
export function isOriginAllowed(origin: string | undefined, config: Config): boolean {
  if (origin === undefined || origin.length === 0 || origin.toLowerCase() === 'null') return true;

  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(origin);
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    return false;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return true;
  if (host === 'anthropic.com' || host.endsWith('.anthropic.com')) return true;

  try {
    if (host === new URL(config.deployUrl).hostname.toLowerCase()) return true;
  } catch {
    // An unparseable DEPLOY_URL simply contributes no allowed origin.
  }

  return config.extraAllowedOrigins.some((allowed) => {
    const trimmed = allowed.trim().toLowerCase();
    if (trimmed === origin.toLowerCase()) return true;
    if (trimmed.startsWith('*.')) return host === trimmed.slice(2) || host.endsWith(trimmed.slice(1));
    return host === trimmed;
  });
}
