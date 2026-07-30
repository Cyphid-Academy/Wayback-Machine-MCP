# Provenance

## How this code was written

Every module in `src/` was written from scratch for this repository, against the
Internet Archive's own published API documentation and against the Model Context
Protocol specification and TypeScript SDK.

Sources consulted:

- The Internet Archive developer portal, <https://archive.org/developers/> —
  including the item metadata API, Advanced Search, and the bots / automated
  access policy at <https://archive.org/developers/bots.html>.
- The Wayback Machine's public HTTP interfaces: the CDX capture index
  (`/cdx/search/cdx`), the closest-snapshot availability API
  (`/wayback/available`), the capture-count sparkline (`/__wb/sparkline`), capture
  replay with content modifiers (`/web/{timestamp}id_/{url}`), and Save Page Now
  (`POST /save/`).
- The Model Context Protocol specification, revision `2025-11-25`, in particular
  the Streamable HTTP transport, tool `outputSchema` / `structuredContent`, tool
  annotations, and the `ResourceLink` content type introduced in `2025-06-18`.
- The API surface of the packages this project depends on, read from their own
  type declarations as installed.

Endpoint behaviour was verified directly where the build environment allowed it.
The `archive.org` endpoints (availability, Advanced Search, item metadata) were
exercised against the live service and their response shapes confirmed. The
`web.archive.org` endpoints (CDX, capture replay, sparkline, Save Page Now) were
not reachable from the build environment — its egress policy blocks that host —
so they were implemented from the documented contract and verified against a
fixture server that reproduces it. See `DECISIONS-MADE.md` for what that means in
practice.

## No code was taken from any existing MCP server

No existing Internet Archive or Wayback Machine MCP server was forked, copied
from, or consulted while writing this. In particular
[`Mearman/mcp-wayback-machine`](https://github.com/Mearman/mcp-wayback-machine)
is licensed CC BY-NC-SA 4.0 — a non-commercial, share-alike licence — and was
deliberately **not** read, forked, or used as a reference. The licence position
of this repository is therefore clean and unencumbered by that project's terms.

Any resemblance in tool naming (`search_snapshots`, `get_snapshot` and similar)
follows from naming the underlying Internet Archive operations plainly, not from
shared code.

## Licence

This project is released under the MIT licence.

### Dependencies

| Package | Licence |
|---|---|
| `@modelcontextprotocol/sdk` | MIT |
| `express` | MIT |
| `zod` | MIT |
| `node-html-parser` | MIT |
| `diff` (jsdiff) | BSD-3-Clause |
| `typescript`, `tsx`, `@types/*` (dev only) | Apache-2.0 / MIT |

All are permissive and compatible with both commercial and non-commercial use.

## Data

This server stores nothing. It queries the Internet Archive on demand and holds
responses only in a per-process in-memory cache. Content served through the
`/r/...` resource routes is fetched from archive.org at request time and remains
the Internet Archive's, subject to their terms of use. Users of this server
should honour the Internet Archive's bots policy — which is why
`CONTACT_EMAIL` is a required setting and appears in every outbound
`User-Agent`.
