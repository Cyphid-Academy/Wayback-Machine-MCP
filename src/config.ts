import { randomBytes } from 'node:crypto';

/** Everything the server needs to run, resolved once from the environment. */
export interface Config {
  readonly port: number;
  readonly host: string;
  /** Public base URL with no trailing slash. Used to build ResourceLink URIs. */
  readonly deployUrl: string;
  readonly contactEmail: string;
  /** Unguessable path segment: MCP lives at /mcp/{pathSecret}, resources at /r/{pathSecret}/... */
  readonly pathSecret: string;
  /** True when no MCP_PATH_SECRET was supplied and one was generated for this process. */
  readonly pathSecretGenerated: boolean;
  /** When set, requests must carry `Authorization: Bearer <token>`. Unset by default. */
  readonly authToken: string | undefined;
  readonly enableSave: boolean;
  readonly iaAccessKey: string | undefined;
  readonly iaSecretKey: string | undefined;
  /** Base for the Wayback Machine (CDX, captures, Save Page Now). Overridable for tests. */
  readonly webArchiveBase: string;
  /** Base for archive.org (availability, advancedsearch, metadata). Overridable for tests. */
  readonly archiveBase: string;
  readonly userAgent: string;
  readonly rateLimitPerMinute: number;
  readonly upstreamTimeoutMs: number;
  /** false => MCP POST replies stream as SSE; true => plain JSON replies. */
  readonly jsonResponse: boolean;
  readonly extraAllowedOrigins: readonly string[];
  /** Warnings to surface at boot (missing CONTACT_EMAIL etc.) without failing startup. */
  readonly warnings: readonly string[];
}

export type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 3000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000;

function str(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** 32 URL-safe characters of entropy. */
export function generatePathSecret(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Replit exposes the public hostname via REPLIT_DOMAINS (deployments) or
 * REPLIT_DEV_DOMAIN (workspace), so DEPLOY_URL can usually be inferred.
 */
function inferDeployUrl(env: Env, port: number): { url: string; inferred: boolean } {
  const explicit = str(env, 'DEPLOY_URL');
  if (explicit !== undefined) {
    const withScheme = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
    return { url: stripTrailingSlash(withScheme), inferred: false };
  }
  const domains = str(env, 'REPLIT_DOMAINS');
  if (domains !== undefined) {
    const first = domains.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return { url: `https://${stripTrailingSlash(first)}`, inferred: true };
    }
  }
  const devDomain = str(env, 'REPLIT_DEV_DOMAIN');
  if (devDomain !== undefined) {
    return { url: `https://${stripTrailingSlash(devDomain)}`, inferred: true };
  }
  return { url: `http://localhost:${String(port)}`, inferred: true };
}

export function loadConfig(env: Env = process.env): Config {
  const warnings: string[] = [];

  const port = int(env, 'PORT', DEFAULT_PORT, 1, 65_535);
  const deploy = inferDeployUrl(env, port);
  if (deploy.inferred && !deploy.url.startsWith('http://localhost')) {
    warnings.push(`DEPLOY_URL was not set; inferred ${deploy.url} from the Replit environment.`);
  }

  const contactEmail = str(env, 'CONTACT_EMAIL');
  if (contactEmail === undefined) {
    warnings.push(
      'CONTACT_EMAIL is not set. The Internet Archive bots policy asks for a contact address in the User-Agent — set it before exposing this server publicly.',
    );
  }

  const suppliedSecret = str(env, 'MCP_PATH_SECRET');
  const pathSecret = suppliedSecret ?? generatePathSecret();
  if (suppliedSecret === undefined) {
    warnings.push(
      'MCP_PATH_SECRET is not set; a random one was generated for this process. It changes on every restart, which invalidates a saved connector URL — set it explicitly for anything long-lived.',
    );
  }

  const enableSave = bool(env, 'ENABLE_SAVE', false);
  const iaAccessKey = str(env, 'IA_ACCESS_KEY');
  const iaSecretKey = str(env, 'IA_SECRET_KEY');
  if (enableSave && (iaAccessKey === undefined || iaSecretKey === undefined)) {
    warnings.push(
      'ENABLE_SAVE is on without IA_ACCESS_KEY/IA_SECRET_KEY. Save Page Now still works anonymously but with much tighter rate limits.',
    );
  }

  const extraAllowedOrigins = (str(env, 'ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    port,
    host: str(env, 'HOST') ?? '0.0.0.0',
    deployUrl: deploy.url,
    contactEmail: contactEmail ?? 'unset@example.invalid',
    pathSecret,
    pathSecretGenerated: suppliedSecret === undefined,
    authToken: str(env, 'MCP_AUTH_TOKEN'),
    enableSave,
    iaAccessKey,
    iaSecretKey,
    webArchiveBase: stripTrailingSlash(str(env, 'WEB_ARCHIVE_BASE') ?? 'https://web.archive.org'),
    archiveBase: stripTrailingSlash(str(env, 'ARCHIVE_BASE') ?? 'https://archive.org'),
    userAgent: `wayback-mcp/1.0 (+${deploy.url}; ${contactEmail ?? 'unset@example.invalid'})`,
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', DEFAULT_RATE_LIMIT_PER_MINUTE, 1, 600),
    upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT_MS, 1_000, 120_000),
    jsonResponse: !bool(env, 'MCP_SSE', false),
    extraAllowedOrigins,
    warnings,
  };
}

/** The MCP endpoint path, including the path secret. */
export function mcpPath(config: Config): string {
  return `/mcp/${config.pathSecret}`;
}

/** The base path for HTTP resource routes, including the path secret. */
export function resourceBasePath(config: Config): string {
  return `/r/${config.pathSecret}`;
}
