# Boss Experience Upgrade Design

## Goal

Upgrade the private image studio from a single-task MVP into a stable, fast workbench for internal use: searchable history, safe bulk deletion, controlled batch generation, lower polling pressure, and better mobile ergonomics.

## Constraints

- DragonCode GPT-Image-2 requests must stay centralized in `src/lib/dragon-client.ts`.
- Payloads must keep `model: "gpt-image-2"`, `n: 1`, valid `resolution`/`size`, and optional `image_urls`.
- Reference images remain capped at 16; base64 inputs must not be persisted back into UI responses.
- Production uses PostgreSQL. JSON store remains a development fallback and must not be treated as the long-history path.
- Stability and performance take priority over visual novelty.

## Design

Backend changes:

- Extend generation listing with server-side `q`, `status`, and `mode` filters.
- Add a bulk status endpoint that returns local job state for multiple ids without directly querying DragonCode.
- Add a bulk delete endpoint that supports selected ids plus safe scopes such as completed, failed, and all non-active records.
- Keep active jobs protected from bulk deletion unless a future explicit force path is added.
- Add store-level helpers for filtered listing, id lookups, and bulk deletion across PostgreSQL and JSON fallback.

Frontend changes:

- Add a compact history command bar: search, status filter, mode filter, selected count, and bulk actions.
- Add batch generation by parsing one prompt per line, capped to a conservative batch size.
- Submit batch prompts sequentially with a short delay between requests. Each item gets its own idempotency key.
- Replace per-selected-task polling with one bulk status request for visible active jobs.
- Keep single-task generation available and visually simple.
- Add mobile quick navigation and increase touch targets around history actions.

Testing strategy:

- Store tests cover filtering and bulk deletion for JSON and PostgreSQL.
- API tests cover search/filter, bulk status, and safe bulk delete behavior.
- Batch prompt parsing gets focused unit tests.
- Full verification must run `npm test`, `npm run lint`, and `npm run build`.

