# Boss Experience Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add searchable history, safe bulk deletion, controlled batch generation, lower polling pressure, and mobile ergonomics without weakening DragonCode compliance.

**Architecture:** Keep DragonCode calls centralized and avoid browser-side API keys. Add backend store/API capabilities first, then wire the React workbench to those stable contracts. Batch generation is client-orchestrated with server idempotency and conservative sequential submission.

**Tech Stack:** Next.js App Router, React 19, TypeScript, PostgreSQL/JSON store abstraction, Vitest, ESLint.

---

### Task 1: Store And API Safety

**Files:**
- Modify: `src/lib/store.ts`
- Modify: `src/app/api/generations/route.ts`
- Create: `src/app/api/generations/delete/route.ts`
- Create: `src/app/api/generations/status/route.ts`
- Test: `src/lib/store.test.ts`
- Test: `src/lib/store.postgres.test.ts`
- Test: `src/app/api/generations/route.test.ts`

- [ ] Add failing tests for filtered history, selected bulk delete, active-skip bulk delete, and bulk status lookup.
- [ ] Implement store filters for prompt query, status, and mode.
- [ ] Implement bulk delete with active-job protection.
- [ ] Implement bulk status lookup by id.
- [ ] Wire API routes and validate request sizes.
- [ ] Run targeted tests.

### Task 2: Batch Prompt Helpers

**Files:**
- Create: `src/lib/batch-generation.ts`
- Test: `src/lib/batch-generation.test.ts`

- [ ] Add failing tests for one-prompt mode, one-line-per-prompt batch mode, max batch count, blank-line trimming, and fingerprint stability.
- [ ] Implement prompt parsing and fingerprint helpers.
- [ ] Run targeted tests.

### Task 3: Workbench UX

**Files:**
- Modify: `src/components/generation-workspace.tsx`
- Modify: `src/app/globals.css`

- [ ] Add batch toggle and one-line-per-prompt copy.
- [ ] Submit batch prompts sequentially with idempotency keys and conservative pacing.
- [ ] Add search/filter command bar for history.
- [ ] Add selection, selected delete, clear failed, clear completed, and clear all non-active actions.
- [ ] Switch visible active job refresh to bulk status endpoint.
- [ ] Add mobile quick navigation and touch-target improvements.

### Task 4: Verification And Release

**Files:**
- No new source files expected.

- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Review `git diff` for accidental secrets, unrelated churn, and DragonCode contract drift.
- [ ] Commit and push to GitHub.
- [ ] Deploy to the Tencent server only after local verification passes.
- [ ] Run production smoke checks for login, history API, guarded image limit, and static page health.

