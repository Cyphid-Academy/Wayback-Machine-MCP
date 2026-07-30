# Decisions made

Every call made where the build spec left latitude, plus the empirical findings it
asked for. Written so the reasoning survives, not just the outcome.

---

## Empirical findings the spec asked for

### 1. Does a static bearer token work with the claude.ai connector dialog?

**Not determined — and the shipped default does not depend on it.**

This cannot be answered from a build environment: it requires attaching a
connector in a live claude.ai account and observing whether the Add-connector
dialog will send a static `Authorization: Bearer` header (its advanced settings
expose OAuth client credentials, which is a different mechanism).

The server therefore ships with `MCP_AUTH_TOKEN` **unset**, so unauthenticated
requests to the secret path are accepted, exactly as the spec directs. The bearer
path is implemented and tested — set `MCP_AUTH_TOKEN` and every request must
carry a matching bearer token — so the finding can be established later by
setting it and re-attaching the connector, with no code change either way.

**Path-secret-only is the shipped default. OAuth is the documented upgrade path**,
addable as another `AuthProvider` implementation without touching transport or
routing code.

### 2. Does claude.ai resolve a `ResourceLink` from a tool result?

**Not determined here; probe procedure below.**

Determining this requires a live connector. The probe: call `get_snapshot` on a
page whose extracted text exceeds 8,000 characters (the tool will report
`truncated: true` and attach a `ResourceLink`), then ask the model a question
whose answer appears only *after* the 2,000-character preview. If it can answer,
the host resolved the link; if it can only discuss the preview, it did not.

What is verified is that the link is **correct and resolvable**: the integration
suite takes the URI the tool actually advertises, fetches it, and asserts the
response is the complete extracted text whose length matches the `totalChars` the
tool reported. So if the host does fetch it, it will get the right artifact.

Per the spec, no redesign is warranted either way: `archive_stats`,
`list_revisions` and `compare_snapshots` return everything the acceptance test
needs inline, and the `/r/...` routes remain useful from Claude Code, Cowork and a
browser.

---

## Environment constraint that shaped verification

**`web.archive.org` was unreachable from the build environment.** Its egress
policy allows `archive.org` but blocks `web.archive.org` (connection reset on
direct requests, `HTTP 403` through the proxy). That host serves the CDX index,
capture replay, the sparkline and Save Page Now — most of this server's upstream
surface.

Consequences, each one a deliberate response rather than a workaround:

- **Upstream base URLs are configurable** via `WEB_ARCHIVE_BASE` and
  `ARCHIVE_BASE` (defaulting to the real hosts). This exists so the whole server
  can be driven end-to-end against a fixture, and it is what makes the test suite
  hermetic — which the spec required anyway ("never hit live archive.org from
  unit tests").
- **A fixture Internet Archive** (`test/fixtures/upstream.ts`) implements the CDX
  contract (field lists, `from`/`to`, positive and negative `limit`, `offset`,
  `filter`, `collapse`), the availability API, capture replay including the
  redirect to the nearest capture, the sparkline, Advanced Search, item metadata
  and Save Page Now. The end-to-end suite runs the real MCP protocol over real
  HTTP against it.
- **The `archive.org` endpoints were verified live**: `/wayback/available`,
  `/advancedsearch.php` and `/metadata/{id}` were called against the real service,
  their response shapes confirmed, and `check_availability`, `search_items` and
  `get_item_metadata` were then exercised end-to-end through the MCP Inspector
  against the live API.
- **The `web.archive.org` tools are verified against the documented contract, not
  the live service.** `archive_stats`, `search_snapshots`, `list_revisions`,
  `get_snapshot`, `compare_snapshots` and `list_screenshots` pass end-to-end
  against the fixture. The §10 acceptance test remains a manual step, as the spec
  specifies, and is the first thing to run after deploying.
- A `403`/`401` from upstream now carries the hint that an egress proxy or
  firewall may be blocking `web.archive.org` — the failure that cost the most time
  here should be self-explaining next time.

---

## How this project should reach Replit

**Replit's MCP server cannot create an app from a repository URL.** Its full tool
surface was checked: app creation and modification both take a natural-language
prompt and nothing else (app creation additionally takes a stack from a fixed
enum, none of which is a headless Node service). The listing and lookup tools are
read-only, and the one remaining tool that accepts a URL imports a single
self-contained HTML bundle from Claude Design's export flow, not a git repository.
There is no branch, clone or import parameter anywhere in the surface.

So the only route through MCP is to have the agent create a scaffolded app and
then ask it to clone the repository — which is exactly the wrong shape. The agent
lands the clone in a subfolder of a scaffold it has already generated, so the
committed `.replit` is not at the app root where Replit reads it, and the scaffold
leaves behind a competing package manifest and workspace files. It can be
untangled afterwards by moving the project to the root and deleting the scaffold,
but it should not be necessary.

**Use Replit's own GitHub import instead**, either the rapid import at
`replit.com/github.com/{owner}/{repo}` for a public repository or the guided
import at `replit.com/import`. That brings the repository in as the app itself,
reads the committed `.replit`, and picks up the dependency manifest and run/build
configuration — no scaffold, nothing to undo. Note that it imports the
repository's **default branch**. The README documents both flows.

---

## Deviations from the spec, with reasons

### `list_revisions` derives revisions client-side instead of using `collapse=digest`

The spec describes `list_revisions` as `search_snapshots` with `collapse=digest`
and `filter=["statuscode:200"]`, "post-processed" to carry `revisionIndex`,
`digest`, `firstSeen`, `lastSeen` and `captureCount`.

That is not achievable from a collapsed result set. CDX `collapse` suppresses
**adjacent** rows sharing a field value, so a collapsed response contains one row
per *run* and carries neither the run's last capture nor how many captures it
covered. `lastSeen` and `captureCount` are simply not in the data.

So the tool fetches the capture list with a minimal field set
(`timestamp,digest,mimetype,length,statuscode`) and groups consecutive digests in
`groupRevisions()`. The output contract is exactly as specified, and the result is
strictly better: the spec's own failure mode ("hundreds of rows means
`collapse=digest` isn't reaching the CDX query") cannot occur, because grouping no
longer depends on an upstream parameter.

Cost: one request returning up to `maxCaptures` rows (default 3,000) rather than a
pre-collapsed one. It is a single request with ~60 bytes per row, entirely
server-side. When the cap is hit, `capturesTruncated: true` is returned and the
summary says to narrow `from`/`to`.

A page that reverts to an earlier body yields two runs with the same digest. That
is the honest answer, and `distinctDigests` reports how many unique bodies exist.

### Resource routes live under the path secret

§6 lists routes as `/r/snapshot/...` while §8 says resources are served at
`/r/{MCP_PATH_SECRET}/...`. §8 wins: the canonical form is
`/r/{MCP_PATH_SECRET}/snapshot/...`. Serving an unsecured alias would defeat the
gate the spec asks for. `ResourceLink` URIs are built to match.

### `get_snapshot` with `format=raw` never inlines the bytes

§2 forbids raw HTML in `content`, unconditionally. `format=raw` therefore returns
metadata, a **text-extracted** preview, and a `ResourceLink` to the original bytes.
The `/r/.../snapshot/...?format=raw` route does serve the untouched bytes, since
that channel has no such constraint and is not model context.

For a capture whose content type is not textual, that route redirects (302) to the
upstream capture rather than re-encoding binary through a string decode.

### `clear_cache` annotations

Query tools are `readOnlyHint: true, openWorldHint: true` and `save_url` is
`readOnlyHint: false, destructiveHint: false, openWorldHint: true`, per §3.
`clear_cache` is neither: it mutates only this process's memory and touches no
external system, so it is `readOnlyHint: false, destructiveHint: false,
idempotentHint: true, openWorldHint: false`.

### `list_screenshots` queries the `screenshot:` pseudo-URL

§5 describes screenshots as "`im_` rows". In the CDX index, Save Page Now
screenshots are indexed under a `screenshot:{url}` pseudo-URL; `im_` is the
content modifier that serves the image bytes. The tool queries the former and
returns both a replay URL and an `im_` direct-image URL, never bytes. This is the
one tool that could not be checked against the live index (see above), so it is
also listed under README "Limitations".

### `archive_stats` falls back to the CDX index

The sparkline endpoint is the primary source (one cheap request). If it is
unavailable or returns no years, the tool aggregates a CDX query by year instead
and reports `source: 'cdx'` so the caller knows which path produced the numbers.
The output carries one field beyond the spec's shape (`source`, plus ISO-formatted
dates and a calendar URL) because a number whose provenance is unknown is worth
less than one whose provenance is stated.

---

## Judgement calls the spec left open

### Transport response mode: plain JSON by default

`enableJsonResponse: true` is the default, so MCP POST replies are plain JSON
rather than an SSE stream. Both are legal Streamable HTTP. JSON was chosen because
it is immune to proxy buffering and needs no stream state, and the spec's stated
priority is that the connector attaches on the first try. Set `MCP_SSE=true` to
switch to SSE streaming.

Stateless mode is achieved by **omitting** `sessionIdGenerator` rather than
passing `undefined`. The SDK reads `options?.sessionIdGenerator`, so the two are
identical at runtime; omitting it is what `exactOptionalPropertyTypes` permits.

### A fresh MCP server per request

Rather than a long-lived `Server` instance, each request constructs its own
`Server` and transport and closes them when the response closes. Construction does
no I/O, so this is cheap, and it makes statelessness structural instead of
conventional — nothing can accumulate per-connection state that a scaled-away
instance would lose.

### Origin policy is permissive by design

No `Origin` header → allowed (the case the spec calls out as the most likely cause
of a silently broken connector). Browser origins are allowed for `claude.ai`,
`anthropic.com`, their subdomains, `localhost`/`127.0.0.1` on any port (for the
MCP Inspector), the configured `DEPLOY_URL`, and anything in `ALLOWED_ORIGINS`
(which supports `*.example.com`). Everything else is rejected with `403`.

The SDK's own origin/host validation options are deprecated in favour of external
middleware, so this is implemented as middleware.

### Row caps on table-shaped results

`search_snapshots` accepts `limit` up to 1,000 per the spec, but 1,000 CDX rows in
`structuredContent` would be tens of thousands of tokens on its own — the very
failure §2 exists to prevent. Tables are therefore trimmed to **250 rows**, with
`rowsTruncated: true` and a `nextOffset` in the output plus an explicit "page with
offset=N" line in the summary. Nothing is silently dropped.

`hasMore` is exact rather than inferred: the tool requests `limit + 1` rows and
reports whether the extra one came back.

### One suppressed type check, at a dependency boundary

`src/index.ts` contains a single `@ts-ignore`, in `connectTransport()`. The SDK's
`StreamableHTTPServerTransport` declares its optional callbacks as
`(() => void) | undefined`, while the `Transport` interface it must be passed to
declares them `?: () => void`. Under `exactOptionalPropertyTypes` (required by
§12) those are different types, so the SDK's concrete transport is not assignable
to the SDK's own interface. The mismatch is in the dependency's declarations and
the runtime shapes are identical.

The alternatives were worse: dropping `exactOptionalPropertyTypes` weakens every
file, and a delegating `Transport` adapter would add ~30 lines of accessor
forwarding on the server's hottest path to satisfy a type. `@ts-ignore` was chosen
over `@ts-expect-error` deliberately: the latter fails the build if the SDK ever
fixes its declarations, which would break a deployed server on a routine dependency
bump. No other check is suppressed anywhere in the codebase, and there is no `any`
and no type assertion in `src/` or `test/`.

### Cache entries carry their content type

The cache stores a one-line metadata envelope (content type and final URL) ahead
of the body. Storing the bare body lost the content type on a cache hit, which
made a cached HTML capture look like opaque bytes — enough to change behaviour
between the first and second call for the same capture. Caught by the integration
suite; fixed rather than papered over.

### Bounded memory, everywhere

- Upstream bodies are read through a **6 MB cap**; a capture that exceeds it is truncated with `bodyTruncated: true` reported, and is never cached.
- The cache is bounded at **500 entries / 64 MB**, evicting expired entries first, then oldest-first.
- Diffs run with an **8-second algorithm timeout**; on expiry the tool returns statistics with `degraded: true` instead of hanging.

Without these, one pathological capture could exhaust the instance.

### Rate limiter reserves pessimistically

The token bucket decrements before sleeping, letting the balance go negative, so
each caller waits off its own deficit. Concurrent callers therefore queue instead
of all observing the same free token. A caller waits up to 12s for a slot; beyond
that it gets a structured `rate_limited` failure with `retryAfterMs`, as §7
requires.

### Files beyond the spec's layout

The spec's layout is a minimum. Added: `src/config.ts` (environment resolution,
secret generation), `src/lib/log.ts` (logging with secret redaction),
`src/lib/urls.ts` (URL normalisation and Wayback URL construction),
`src/lib/cdx.ts` (CDX query building, header-mapped row parsing, revision
grouping), `src/lib/wayback.ts` (upstream operations shared by tools and the
`/r/...` routes), `src/tools/define.ts` (the typed tool factory) and
`src/tools/format.ts` (summary formatting). `src/lib/wayback.ts` matters most: the
resource routes must reduce content exactly as the tools do, and sharing the code
is what guarantees it.

### CDX rows are mapped by header name

Columns are read from the response's own header row rather than by position,
because `resolveRevisits` and similar parameters can change the column set. An
explicit `fl` field list is always sent as well, so the payload stays small.

### Timestamp bounds pad in the direction of their role

`from` pads downwards and `to` upwards: `to=2023` becomes `20231231235959`, not
`20230101000000`, with month lengths and leap years respected. A `to` bound that
silently meant "the first instant of that year" would quietly exclude a year of
captures.

### `DEPLOY_URL` and `CONTACT_EMAIL` warn rather than fail

Both are documented as required. Neither aborts startup: `DEPLOY_URL` is inferred
from `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` and falls back to `localhost`, and
`CONTACT_EMAIL` falls back to a placeholder. Both emit a loud boot warning. A
server that refuses to start is harder to debug on Autoscale than one that starts
and tells you what is wrong — and the health check needs to pass for the
deployment to come up at all.
