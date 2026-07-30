# Internet Archive MCP server

A remote [MCP](https://modelcontextprotocol.io) server that gives a chat client a
full Internet Archive query surface: enumerate historical captures of a URL,
collapse them into the handful of times the page actually changed, read a capture
as clean text, diff two captures against each other, and search archive.org
items. It is built to be added as a **custom connector in claude.ai** and to run
on **Replit Autoscale**.

The driving use case: reconstructing the edit history of a documentation or
support page that is rewritten in place at a stable URL, where search engines
only ever surface the current version.

- **Stack:** TypeScript (strict), Node 22+, `@modelcontextprotocol/sdk`, Express, Zod
- **Transport:** Streamable HTTP, stateless, MCP protocol `2025-11-25`
- **Storage:** none — see [Why there is no database](#why-there-is-no-database)

---

## Why results are small

Custom-connector tool results are capped at roughly **30,000 tokens** (~150,000
characters). A single archived HTML page routinely exceeds that several times
over, and when a result breaches the cap the call **fails outright** — it does
not truncate gracefully.

So this server reduces server-side and returns handles for the rest:

| Channel | Carries |
|---|---|
| `content` (text) | a compact human-readable summary, kept under ~2,000 characters |
| `structuredContent` | typed JSON matching each tool's `outputSchema` |
| `ResourceLink` | a URI plus metadata for the full artifact, which the host may fetch or ignore |

Concretely:

- No tool ever returns raw HTML in `content`.
- Extracted text over **8,000 characters** comes back as a 2,000-character preview plus a `ResourceLink` and a `totalChars` count.
- Diffs are capped at **15,000 characters**, with a `ResourceLink` to the full diff beyond that.
- Table-shaped results (capture rows, revisions) are trimmed to 250 rows, and the tool tells the caller how to page.

Both character limits are the *defaults*. Because claude.ai turns out not to fetch
resource links (see `DECISIONS-MADE.md`), `get_snapshot` and `compare_snapshots`
accept a `maxChars` parameter — up to 100,000 — that inlines more text directly.
That is opt-in escalation, not paging: there is no `offset`, and a document is
never chunked across calls.

---

## Tools

Cheap orientation tools first. Every tool declares an `outputSchema` and
populates `structuredContent`.

### `archive_stats` — recommended first call
How much history exists for a URL: total captures, first and last capture, a
per-year breakdown, and counts split by HTTP status class with the 200-only date
range reported separately. One request, no page content. The status breakdown is
what tells you a URL has moved rather than changed.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |

### `check_availability`
The closest capture to a date.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `timestamp` | `YYYY` \| `YYYYMM` \| `YYYYMMDD` \| `YYYY-MM-DD` \| `YYYYMMDDhhmmss` | most recent capture |

### `search_snapshots`
The general CDX capture-index query. Returns rows as objects — `timestamp`,
`original`, `statuscode`, `mimetype`, `digest`, `length`, `snapshotUrl` — never a
raw CDX text blob.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `matchType` | `exact` \| `prefix` \| `host` \| `domain` | `exact` |
| `from`, `to` | date, any accepted form | |
| `limit` | int, 1–1000 | 50 |
| `offset`, `page`, `pageSize` | int | |
| `collapse` | string, e.g. `timestamp:8`, `digest` | |
| `filter` | string[], e.g. `["statuscode:200","!mimetype:image.*"]` | |
| `resolveRevisits` | bool | `true` |

### `list_revisions` — the highest-value tool here
Distinct **content** revisions of a URL. A page with hundreds of captures may
have only eight distinct bodies; this returns one row per revision with
`revisionIndex`, `digest`, `firstSeen`, `lastSeen` and `captureCount`. Feed two
`firstSeen` values to `compare_snapshots`.

Grouping is by CDX content digest where that works, and by a hash of the extracted
text where it does not — see Limitations. `method` forces one or the other. The
output always reports which was used, how many captures were examined and how many
were excluded.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `from`, `to` | date | |
| `maxCaptures` | int, 10–10000 | 3000 |
| `includeRedirects` | bool | `false` |
| `method` | `auto` \| `digest` \| `text` | `auto` |

### `get_snapshot`
One capture as chrome-stripped text or markdown. Fetched with the `id_` modifier
(the original bytes, not the Wayback-wrapped replay page). Navigation, headers,
footers, cookie banners and language switchers are removed before extraction.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `timestamp` | timestamp \| `latest` \| `earliest` | `latest` |
| `format` | `text` \| `markdown` \| `raw` | `text` |
| `modifier` | `id_` \| `if_` \| `im_` \| `js_` \| `cs_` | `id_` |
| `maxChars` | int, 500–100000 | 8000 |

`format=raw` never inlines the bytes; it returns metadata, a text preview and a
`ResourceLink`. A partial date resolves to the nearest capture, and the result
reports `offsetDays` — plus a prominent note when the gap exceeds three days — so
content is never misattributed to the date you asked for. Raise `maxChars` to
inline more text instead of following a resource link.

### `compare_snapshots`
Diffs two captures and returns only what changed: added/removed characters,
changed-section count, the Wayback visual-diff URL, and a unified diff capped at
15,000 characters by default (raise `maxChars` for more). Both captures are fetched
via `id_` and stripped of chrome first, so the diff shows content changes rather
than banner noise. Each endpoint reports what you asked for alongside what was
actually fetched, so a change is never dated to the wrong day.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `timestampA` | timestamp \| `earliest` \| `latest` | earliest capture |
| `timestampB` | timestamp \| `earliest` \| `latest` | latest capture |
| `granularity` | `line` \| `word` | `line` |
| `maxChars` | int, 1000–100000 | 15000 |

### `list_screenshots`
Screenshot captures for a URL — timestamps and URLs only, never image bytes.
Most URLs have none; an empty result is normal.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `from`, `to` | date | |
| `limit` | int, 1–500 | 50 |

### `search_items`
archive.org Advanced Search over items (texts, audio, movies, software, …).

| Parameter | Type | Default |
|---|---|---|
| `query` | string, required — Lucene syntax | |
| `mediatype` | `texts` \| `audio` \| `movies` \| `software` \| `image` \| `etree` \| `data` \| `web` \| `collection` | |
| `fields` | string[] | identifier, title, creator, date, mediatype |
| `sort` | string, e.g. `downloads desc` | |
| `rows` | int, 1–100 | 20 |
| `page` | int | 1 |

### `get_item_metadata`
An item's metadata plus a file listing (name, format, size) — not file contents.

| Parameter | Type | Default |
|---|---|---|
| `identifier` | string, required | |
| `maxFiles` | int, 1–500 | 100 |

### `save_url` — only registered when `ENABLE_SAVE=true`
Save Page Now. The only tool that writes to the Internet Archive.

| Parameter | Type | Default |
|---|---|---|
| `url` | string, required | |
| `captureScreenshot` | bool | `false` |
| `captureOutlinks` | bool | `false` |
| `ifNotArchivedWithin` | string, e.g. `1h`, `3d` | |
| `jsBehaviorTimeout` | int, 0–30 seconds | |
| `forceGet` | bool | `false` |
| `delayWbAvailability` | bool | `false` |
| `waitForCompletion` | bool | `true` |

### `clear_cache`
Flushes cached upstream responses. No parameters.

---

## HTTP resource routes

The artifacts that `ResourceLink` URIs point at. All are gated behind the same
path secret as the MCP endpoint, and all re-derive their content from
archive.org on every request — so resource links never expire and survive
scale-to-zero without any persistence layer.

| Route | Returns |
|---|---|
| `GET /r/{MCP_PATH_SECRET}/snapshot/{timestamp}/{encodedUrl}?format=text\|markdown\|raw` | The capture, extracted, as `text/plain` or `text/markdown` (`raw` serves the original bytes) |
| `GET /r/{MCP_PATH_SECRET}/diff/{timestampA}/{timestampB}/{encodedUrl}?granularity=line\|word` | The complete unified diff as `text/plain` |
| `GET /healthz` | `200 ok` immediately, touching nothing |
| `GET /` | Server info: name, version, protocol versions, tool names. Never the secret. |

Resource URIs are built from the **`Host` header of the request that produced
them** (honouring `X-Forwarded-Proto`), so a link emitted by the deployment points
at the deployment. `DEPLOY_URL` is only the fallback for a caller that sends no
Host. A server whose links would point at a `*.replit.dev` workspace domain warns
about it once at boot.

`{timestamp}` accepts `latest`, `earliest` or any date form. The target URL may be
percent-encoded, passed un-encoded in the path tail, or supplied as `?url=`.
Responses carry `Cache-Control: public, max-age=86400` because captures are
immutable.

---

## Running locally

```bash
npm install
cp .env.example .env      # then edit CONTACT_EMAIL
npm run dev               # tsx, no build step
```

The boot log prints the full connector URL, including the path secret, once:

```
MCP endpoint:      http://localhost:3000/mcp/<secret>
```

Other scripts:

```bash
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm test            # 259 unit + integration tests, no network access
npm run typecheck   # strict typecheck including the test suite
```

### Verifying with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP
# URL:       http://localhost:3000/mcp/<secret>
```

Or headless:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp/<secret> \
  --transport http --method tools/list
```

---

## Deploying to Replit Autoscale

1. **Import this repository into Replit.** Use Replit's GitHub import, not "create
   an app from a prompt" — the import brings the repository in as the app itself
   and reads the committed `.replit` below, whereas prompting an agent to build an
   app produces a scaffold that this project then has to be untangled from.

   - *Rapid import* (public repositories): open
     `https://replit.com/github.com/{owner}/{repo}` — for this repository,
     <https://replit.com/github.com/Cyphid-Academy/Wayback-Machine-MCP> — and press
     Enter.
   - *Guided import* (public or private): open <https://replit.com/import>, choose
     GitHub, connect the account, pick the repository, and select Import.

   The import brings across the files, the dependency manifest and the run/build
   configuration. It imports the repository's **default branch**, so if the work
   lives on a feature branch either make that branch the default first or switch
   to it in the workspace's Git pane after importing.
2. **Check `.replit`.** It is already correct and should not need editing:

   ```toml
   modules = ["nodejs-22"]

   run = "npm run dev"
   entrypoint = "src/index.ts"

   [deployment]
   deploymentTarget = "autoscale"
   build = ["npm", "run", "build"]
   run = ["npm", "run", "start"]

   [[ports]]
   localPort = 3000
   externalPort = 80
   ```

   Autoscale exposes **exactly one external port, and it must be 80.** If you add
   any other `externalPort` entry the deployment fails. `localPort` must match
   what the server listens on (3000, or whatever `PORT` you set). A mismatch
   presents as "an open port was not detected" with no other diagnostic.
3. **Set the workspace secrets** (Tools → Secrets) from the table below, at
   minimum `CONTACT_EMAIL` and `MCP_PATH_SECRET`.
4. **Run it in the workspace** and confirm the webview shows the server-info JSON.
5. **Deploy** (Deploy → Autoscale, build `npm run build`, run `npm run start`).
6. **⚠️ Re-enter every secret in the Deployments pane.** Workspace secrets do
   **not** propagate to deployments. This is the single most common post-deploy
   failure: the server starts, but `DEPLOY_URL` is wrong so resource links point
   at localhost, and `MCP_PATH_SECRET` is regenerated on every cold start so your
   saved connector URL stops working.
7. **Set `DEPLOY_URL`** to the deployment's public URL, e.g.
   `https://your-app.replit.app`. (If left unset it is inferred from
   `REPLIT_DOMAINS`, which is usually right, but setting it explicitly is safer.)
8. **Verify from outside**: `curl https://your-app.replit.app/healthz` → `ok`.
9. **Add the connector in claude.ai**: Settings → Connectors → Add custom
   connector → paste `https://your-app.replit.app/mcp/<MCP_PATH_SECRET>`.

### Secrets

| Secret | Required | Purpose |
|---|---|---|
| `CONTACT_EMAIL` | yes | goes in the `User-Agent` per the Internet Archive bots policy |
| `DEPLOY_URL` | yes | public base URL, used to build ResourceLink URIs |
| `MCP_PATH_SECRET` | recommended | unguessable path segment; auto-generated if absent |
| `MCP_AUTH_TOKEN` | no | if set, requires `Authorization: Bearer` |
| `IA_ACCESS_KEY` / `IA_SECRET_KEY` | no | only raises Save Page Now limits |
| `ENABLE_SAVE` | no | `true` registers `save_url` |

All query tools work anonymously. No Internet Archive account is needed.

Further optional settings: `ALLOWED_ORIGINS` (extra browser origins),
`MCP_SSE=true` (stream MCP responses as SSE instead of plain JSON),
`RATE_LIMIT_PER_MINUTE` (default 10), `UPSTREAM_TIMEOUT_MS` (default 25000),
`PORT`, `HOST`.

---

## Authentication

Optimised for "the connector attaches on the first try":

1. **Path secret (primary).** MCP is served at `/mcp/{MCP_PATH_SECRET}` and
   resources at `/r/{MCP_PATH_SECRET}/...`. A 32-character URL-safe secret is
   generated and logged once at boot if you do not supply one. A wrong secret
   returns `404`, indistinguishable from an unknown route.
2. **Bearer token (optional, off by default).** Setting `MCP_AUTH_TOKEN` requires
   `Authorization: Bearer <token>` in addition to the path secret. It defaults to
   unset because it is unconfirmed that claude.ai's Add-connector dialog accepts
   a static bearer token, and shipping bearer-required by default risks a
   connector that silently will not attach.
3. **Origin policy.** Requests with **no** `Origin` header are allowed — Anthropic
   calls your server from its own infrastructure, server-to-server, and sends
   none. Browser origins are checked against claude.ai, anthropic.com, localhost,
   your `DEPLOY_URL` and `ALLOWED_ORIGINS`.

Both checks live behind an `AuthProvider` interface, so OAuth can be added later
without touching transport or routing code.

---

## Why there is no database

archive.org is already the durable store. Every resource URI re-derives its
content from upstream on demand, so nothing needs to survive a restart for links
to keep working. Adding Replit DB, Object Storage, Postgres or Redis would buy a
marginal cache-hit improvement in exchange for setup steps, secrets, another
failure mode and cold-start latency.

What ships instead, behind swappable interfaces:

- `InMemoryCache` (`CacheBackend`), keyed on the full upstream URL, with these deliberately asymmetric TTLs:

  | Resource | TTL | Reason |
  |---|---|---|
  | Snapshot content | 24h | immutable once captured |
  | CDX / availability / sparkline | 1h | append-only, never mutates |
  | Save Page Now status | 30s | changes while a job runs |

- `InMemoryTokenBucket` (`RateLimiter`), 10 requests/minute against archive.org, honouring `Retry-After` on `429` and surfacing a structured `rate_limited` error rather than throwing.

---

## Limitations

- **The cache and rate limiter are per-instance and per-process.** They are lost on restart and on Autoscale's scale-to-zero, and two concurrent instances do not share them (so the effective upstream rate can be 10/minute *per instance*). This is accepted; see above.
- **The first connector handshake after an idle period will probably time out.** Autoscale scales to zero after ~15 minutes idle and cold-starts in 10–30s, while the client wants a response sooner. Retrying once connects. If it becomes annoying, move to a Reserved VM rather than optimising further.
- **Tool results are size-capped.** Page text over 8,000 characters and diffs over 15,000 characters are not inlined; you get a preview plus a `ResourceLink`. Row-shaped results are trimmed to 250 rows and tell you how to page. This is the constraint the whole design exists to satisfy — an oversized result would fail the call outright.
- **Whether claude.ai resolves a `ResourceLink` from a tool result is unverified.** If it does not, nothing breaks: `archive_stats`, `list_revisions` and `compare_snapshots` return everything needed inline, and the `/r/...` routes stay useful from Claude Code, Cowork and a browser. See `DECISIONS-MADE.md`.
- **CDX content digests are unreliable on many modern pages.** The Wayback digest is a hash of the delivered bytes, so a Next.js build id or an embedded per-request nonce changes it on every capture even when the visible text is identical. `list_revisions` detects this (distinct digests approaching one per capture) and falls back to hashing the chrome-stripped text of up to 24 evenly-spaced captures. That works, but it is **sampled**: revision boundaries are accurate to the sampling interval rather than to the day. Narrow `from`/`to` and re-run to sharpen a boundary. The output always says which method produced it. Text mode costs one capture fetch per sample, so it is bounded by the rate limiter — raising `RATE_LIMIT_PER_MINUTE` gives a finer sample.
- **Client-rendered pages extract to almost nothing.** If the text lives in JavaScript that never ran, there is no text in the capture to extract, whatever `format` you ask for. Both Anthropic pricing pages are examples: the capture is a shell. `archive_stats` and `search_snapshots` still work on them; `get_snapshot` and `compare_snapshots` will look empty, and that is the capture's fault rather than the extractor's.
- **Chrome stripping is heuristic.** `nav`, `header`, `footer`, `aside`, cookie banners and language switchers are removed, which is what makes diffs readable — but a page that puts real content in a `<header>` will lose it. Use `format=raw` (via the resource route) to see the untouched capture.
- **`list_screenshots` is unverified against the live CDX index.** It queries the `screenshot:` pseudo-URL, which is how Save Page Now screenshots are indexed; it could not be exercised against the real service from the build environment.
- **`list_revisions` groups *consecutive* identical digests.** A page that reverts to an earlier body reports two separate revisions with the same digest, which is the honest answer — `distinctDigests` tells you how many unique bodies there were.

---

## Testing

```bash
npm test
```

259 tests, no network access: unit tests over timestamp normalisation, CDX
parsing, HTML extraction (including nav and language-list stripping), the
8,000-character ResourceLink threshold, diff capping, cache TTL and eviction, the
token bucket, auth and origin policy, and the upstream client's retry,
`Retry-After` and byte-cap behaviour — plus an end-to-end suite that drives the
real MCP protocol over HTTP against a fixture Internet Archive.

The end-to-end suite covers the acceptance case with fixtures: ~300 captures of a
help-centre page with 8 distinct bodies wrapped in a 13-language switcher,
asserting that `list_revisions` returns 8 rows rather than hundreds and that
`compare_snapshots` surfaces the changed message-limit sentence with no language
or navigation noise in the diff.

### Acceptance test (manual, against live archive.org)

Run this in claude.ai once the connector is attached:

> Find every distinct revision of
> `support.anthropic.com/en/articles/8325612-does-claude-pro-have-any-usage-limits`
> and tell me when the message allowance changed.

Note the slug. The bare-ID form of that URL has **no captures of its own** — the
archived URL carries the full slug, which is exactly what `search_snapshots` with
`matchType: "prefix"` is for.

**Pass criteria:** a single-digit revision count, and a correctly identified
two-stage change in **April 2024** — first the window (8 hours → 5 hours, warning
20 → 10, with the trailing "reset every 8 hours" left stale), then the allowance
(100 → 45, warning 10 → 7, trailing sentence corrected). Both edits bracketed to
within about a week without manual bisection.

This page defeats CDX digest grouping (88 captures, 88 distinct digests), so
`list_revisions` will report that it fell back to text-digest mode — that is the
expected path, not a failure.

**If it fails, diagnose in this order:**

| Symptom | Cause |
|---|---|
| Hundreds of rows from `list_revisions` | digest grouping is not being applied |
| A diff dominated by navigation or a 13-language list | extraction is not stripping chrome, or `id_` is not being used |
| An empty diff / `identical: true` | both timestamps resolved to the same capture |
| Connector shows "Disconnected" | cold start (retry once), wrong path secret, or `DEPLOY_URL` mismatch |
| `upstream_error: ... HTTP 403` | an egress proxy or firewall is blocking `web.archive.org` |

---

## Licence and provenance

MIT. Written against the Internet Archive's published API documentation; no code
was taken from any existing MCP server. See `PROVENANCE.md`.
