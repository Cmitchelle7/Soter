# Audit log: paginated queries and partial-range verification (#1378)

## Pagination

`GET /api/v1/audit` accepts either page-based or cursor-based pagination:

- **Page** (`page` + `limit`): defaults page 1, limit 50, max 200. Rejects bad input with 422.
- **Cursor** (`cursor` + `limit`): `cursor` is opaque, `<iso_timestamp>\|<id>` from the previous page.

If `cursor` is present, `page` is ignored. The response body is the array of matching rows;
pagination metadata goes in headers:

- `X-Total-Count` - total rows matching the filter (unaffected by pagination)
- `X-Page` - always 1 in cursor mode
- `X-Limit` - the limit actually applied
- `X-Next-Cursor` - present only when another page is available in cursor mode

Cursor mode is preferred for large result sets because it uses
`WHERE (timestamp, id) < (last_ts, last_id)`, a range scan on `(timestamp)` with no
O(skip) row discard like page mode.

### Validated input

`AuditQueryDto` (in `src/audit/audit.service.ts`) is a real class with
`class-validator` decorators, not an interface. The global `ValidationPipe`
(`src/main.ts`: `whitelist: true, forbidNonWhitelisted: true`) rejects:

- `page < 1` or a non-integer `page` with 422
- `limit < 1` or `limit > 200` with 422
- `startTime` / `endTime` that are not ISO 8601 with 422
- Unknown query parameters with 422

Before this change, `AuditQuery` was a TypeScript interface, so decorators
never ran and `?page=abc` reached the service unmodified (Prisma then threw
on `skip: NaN` and the client got a 500). That is fixed here.

## Partial-range hash-chain verification

The audit log is tamper-evident: every sealed entry carries a `prevHash`
linking it to its predecessor and an `entryHash` covering its content. Any
verification scheme therefore has three distinct levels, and pagination makes
the distinction explicit:

1. **Content integrity** - for each returned row, recompute `entryHash` from
   its current fields and compare against the stored value. Proves the row
   itself has not been rewritten. Pagination-safe: each row is independent.

2. **Intra-range linkage** - for each adjacent pair of rows *within the
   returned subset*, the later row's `prevHash` must equal the earlier row's
   `entryHash`. Proves the subset is internally consistent. Does NOT prove
   anything about the boundary rows on either side of the range.

3. **Boundary disclosure** - a range response must expose its
   `firstPrevHash` (the `prevHash` of the first row in the range) and its
   `lastEntryHash` (the `entryHash` of the last row). A client that holds
   page N's `lastEntryHash` can then check that it equals page N+1's
   `firstPrevHash`. This is what makes cross-page verification possible
   without re-fetching the full log.

**What a paginated subset cannot prove**

- **Absence of deleted rows between ranges.** A range can be internally
  consistent while a gap exists between its last row and the next range's
  first row. That gap is only detectable by (a) walking the full chain
  (which is what the whole-log verifier is for), or (b) trusting a
  previously anchored head hash and checking that any prefix plus suffix
  pair reconstructs it.

- **Presence of every row between sequence N and sequence M.** The server
  controls what it returns; a client can only verify what it has. Whole-log
  verification (which walks every sealed row and re-derives the chain head)
  remains the only way to prove completeness.

**Recommended client protocol**

1. Page through `GET /api/v1/audit?cursor=...&limit=200`.
2. For each page, hold the boundary hashes.
3. Assert `page[n].lastEntryHash == page[n+1].firstPrevHash`.
4. Periodically call `GET /api/v1/audit/chain/status` to verify the whole
   log against a previously pinned head hash.

The endpoint-level `verifyRange` helper that would return those three values
per request is scoped to a follow-up: the chain service that would host it
moved out of `src/audit/` in the merge that added the webhook HMAC guards,
and wiring it into a new module is a larger change than #1378 asked for.
This document defines the invariant so the follow-up can implement against a
stable contract.

## Adding a test

See `src/audit/audit.pagination.spec.ts`. The suite mocks Prisma in memory,
so no DB is needed. When the cursor encoder changes, update the mock's
`applyWhere` at the same time or adjacent pages will overlap.
