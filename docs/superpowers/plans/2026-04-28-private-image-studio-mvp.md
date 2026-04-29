# Private Image Studio MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or inline TDD discipline for task-by-task implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user private image generation site powered by DragonCode `gpt-image-2`.

**Architecture:** A Next.js App Router application handles login, server-side DragonCode API calls, local SQLite persistence, image upload conversion, task polling, and a compact private dashboard UI. The browser never receives the DragonCode API key.

**Tech Stack:** Next.js, TypeScript, Vitest, JSON file persistence for the single-user MVP, bcrypt password verification, HTTP-only cookies, plain CSS modules/global CSS.

---

### Task 1: Project Foundation

**Files:**
- Create: `package.json`, Next.js app files, TypeScript config, Vitest config, `.env.example`

- [ ] Scaffold a Next.js TypeScript app in the current directory.
- [ ] Install runtime dependencies: `bcryptjs`, `zod`.
- [ ] Install test dependencies: `vitest`, `@vitejs/plugin-react`, `jsdom`.
- [ ] Add scripts: `dev`, `build`, `lint`, `test`.
- [ ] Add `.env.example` with `DRAGON_API_KEY`, `APP_USERNAME`, `APP_PASSWORD_HASH`, `SESSION_SECRET`, `APP_BASE_URL`.

### Task 2: Core Domain Tests And Modules

**Files:**
- Create: `src/lib/image-options.ts`
- Create: `src/lib/auth.ts`
- Create: `src/lib/dragon-client.ts`
- Test: `src/lib/*.test.ts`

- [ ] Write failing tests for resolution/size validation, especially invalid `4k + 1:1`.
- [ ] Implement image option validation and exported supported option lists.
- [ ] Write failing tests for session signing and verification.
- [ ] Implement signed cookie session helpers.
- [ ] Write failing tests for Dragon response normalization with completed/failed/pending task data.
- [ ] Implement Dragon client request payload building and task response parsing.

### Task 3: Persistence And API Routes

**Files:**
- Create: `src/lib/store.ts`
- Create: `src/app/api/auth/login/route.ts`
- Create: `src/app/api/auth/logout/route.ts`
- Create: `src/app/api/auth/me/route.ts`
- Create: `src/app/api/generations/route.ts`
- Create: `src/app/api/generations/[id]/route.ts`

- [ ] Create JSON-backed storage for generation jobs and image records.
- [ ] Add login/logout/me endpoints with HTTP-only session cookie.
- [ ] Add protected generation creation endpoint accepting JSON or multipart form data.
- [ ] Convert uploaded reference files to base64 data URIs for `image_urls`.
- [ ] Add protected generation list/detail endpoints.
- [ ] On detail fetch, refresh pending Dragon task status and persist completed image URLs.

### Task 4: Private UI

**Files:**
- Create/modify: `src/app/page.tsx`, `src/app/login/page.tsx`, `src/app/generate/page.tsx`
- Create: client components under `src/components/`
- Modify: `src/app/globals.css`

- [ ] Build login page.
- [ ] Build generation workspace with mode switch, prompt, upload, size, resolution, and validation.
- [ ] Disable unsupported `4k` ratios in UI.
- [ ] Poll active task until completed/failed.
- [ ] Build history strip/list with prompt, options, status, and image actions.

### Task 5: Verification

**Files:**
- All created project files

- [ ] Run `npm test` and read the output.
- [ ] Run `npm run lint` and read the output.
- [ ] Run `npm run build` and read the output.
- [ ] Fix failures until the verification commands exit successfully or report exact blockers.
