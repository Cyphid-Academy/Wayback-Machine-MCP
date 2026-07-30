import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { BearerTokenAuthProvider, PathSecretAuthProvider, buildAuthProvider, isOriginAllowed } from '../src/auth.js';
import { createLogger, redactSecrets } from '../src/lib/log.js';

describe('PathSecretAuthProvider', () => {
  const provider = new PathSecretAuthProvider('correct-secret');

  it('accepts the exact secret', () => {
    assert.deepEqual(provider.check({ pathSecret: 'correct-secret', authorization: undefined }), { ok: true });
  });

  it('rejects a wrong, absent, or partial secret as a 404', () => {
    for (const candidate of [undefined, '', 'wrong', 'correct-secre', 'correct-secret ']) {
      const result = provider.check({ pathSecret: candidate, authorization: undefined });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 404, 'a bad secret is indistinguishable from an unknown route');
        assert.equal(result.message, 'Not found.');
      }
    }
  });
});

describe('BearerTokenAuthProvider', () => {
  const provider = new BearerTokenAuthProvider('tok-123');

  it('accepts a correct bearer token, case-insensitively on the scheme', () => {
    assert.deepEqual(provider.check({ pathSecret: undefined, authorization: 'Bearer tok-123' }), { ok: true });
    assert.deepEqual(provider.check({ pathSecret: undefined, authorization: 'bearer tok-123' }), { ok: true });
  });

  it('rejects a missing or wrong token with 401 and a challenge', () => {
    for (const header of [undefined, '', 'Bearer nope', 'tok-123', 'Basic tok-123']) {
      const result = provider.check({ pathSecret: undefined, authorization: header });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 401);
        assert.equal(result.wwwAuthenticate, 'Bearer realm="wayback-mcp"');
      }
    }
  });
});

describe('buildAuthProvider', () => {
  it('requires only the path secret by default', () => {
    const config = loadConfig({ MCP_PATH_SECRET: 'abc' });
    const provider = buildAuthProvider(config);
    assert.equal(provider.name, 'path-secret');
    assert.deepEqual(provider.check({ pathSecret: 'abc', authorization: undefined }), { ok: true });
  });

  it('additionally requires a bearer token when MCP_AUTH_TOKEN is set', () => {
    const config = loadConfig({ MCP_PATH_SECRET: 'abc', MCP_AUTH_TOKEN: 'tok' });
    const provider = buildAuthProvider(config);
    assert.equal(provider.name, 'path-secret+bearer');
    const noToken = provider.check({ pathSecret: 'abc', authorization: undefined });
    assert.equal(noToken.ok, false);
    assert.deepEqual(provider.check({ pathSecret: 'abc', authorization: 'Bearer tok' }), { ok: true });
  });

  it('rejects a bad path secret before looking at the token', () => {
    const provider = buildAuthProvider(loadConfig({ MCP_PATH_SECRET: 'abc', MCP_AUTH_TOKEN: 'tok' }));
    const result = provider.check({ pathSecret: 'wrong', authorization: 'Bearer tok' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 404);
  });
});

describe('isOriginAllowed', () => {
  const config = loadConfig({ DEPLOY_URL: 'https://my-app.replit.app', ALLOWED_ORIGINS: 'https://tools.example.org,*.partner.test' });

  it('allows a request with no Origin — Anthropic calls server-to-server', () => {
    assert.equal(isOriginAllowed(undefined, config), true);
    assert.equal(isOriginAllowed('', config), true);
    assert.equal(isOriginAllowed('null', config), true);
  });

  it('allows claude.ai, anthropic.com and their subdomains', () => {
    for (const origin of ['https://claude.ai', 'https://www.claude.ai', 'https://console.anthropic.com']) {
      assert.equal(isOriginAllowed(origin, config), true, origin);
    }
  });

  it('allows localhost on any port, for the MCP Inspector', () => {
    assert.equal(isOriginAllowed('http://localhost:6274', config), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:3000', config), true);
  });

  it('allows the deployment origin itself', () => {
    assert.equal(isOriginAllowed('https://my-app.replit.app', config), true);
  });

  it('honours ALLOWED_ORIGINS, including a wildcard subdomain', () => {
    assert.equal(isOriginAllowed('https://tools.example.org', config), true);
    assert.equal(isOriginAllowed('https://a.partner.test', config), true);
    assert.equal(isOriginAllowed('https://partner.test', config), true);
  });

  it('rejects an unrelated browser origin', () => {
    for (const origin of ['https://evil.example', 'https://claude.ai.evil.example', 'http://notlocalhost']) {
      assert.equal(isOriginAllowed(origin, config), false, origin);
    }
  });

  it('rejects a malformed or non-http origin', () => {
    assert.equal(isOriginAllowed('not a url', config), false);
    assert.equal(isOriginAllowed('file:///etc/passwd', config), false);
  });
});

describe('secret redaction', () => {
  it('replaces secrets wherever they appear in a log line', () => {
    const line = 'GET /mcp/supersecretvalue with Bearer tok-abcdefgh';
    assert.equal(
      redactSecrets(line, ['supersecretvalue', 'tok-abcdefgh']),
      'GET /mcp/[redacted] with Bearer [redacted]',
    );
  });

  it('ignores undefined and very short secrets', () => {
    assert.equal(redactSecrets('abc', [undefined, 'a']), 'abc');
  });

  it('scrubs secrets from logger output', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      createLogger({ pathSecret: 'psecret-value', authToken: 'tsecret-value' }).info('called /mcp/psecret-value', {
        token: 'tsecret-value',
      });
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    assert.ok(!(lines[0] ?? '').includes('psecret-value'));
    assert.ok(!(lines[0] ?? '').includes('tsecret-value'));
    assert.match(lines[0] ?? '', /\[redacted\]/);
  });
});
