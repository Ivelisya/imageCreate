import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function createJsonFallbackPath() {
  const dir = await mkdtemp(join(tmpdir(), "pis-pg-store-"));
  tempDirs.push(dir);
  return join(dir, "fallback.json");
}

afterEach(async () => {
  vi.doUnmock("pg");
  vi.resetModules();
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_PATH;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PostgreSQL generation job store", () => {
  it("uses PostgreSQL instead of the JSON file when DATABASE_URL is configured", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const fallbackPath = await createJsonFallbackPath();

    vi.doMock("pg", () => ({ Pool }));
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://studio:secret@localhost/private_image_studio";
    process.env.DATABASE_PATH = fallbackPath;

    const store = await import("./store");
    const job = await store.createGenerationJob({
      clientRequestId: "request-db-1",
      dragonTaskId: "task_db_1",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "database backed job",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });

    await store.updateGenerationJob(job.id, {
      status: "completed",
      progress: 100,
      outputImages: ["https://example.com/db.png"]
    });
    await store.createOwnerAccount({
      username: "owner",
      passwordHash: "hash"
    });

    const rows = db.public.many("select id, prompt, status, output_images from generation_jobs");

    expect(rows).toMatchObject([
      {
        id: job.id,
        prompt: "database backed job",
        status: "completed",
        output_images: ["https://example.com/db.png"]
      }
    ]);
    await expect(store.listGenerationJobsPage(undefined, { page: 1, pageSize: 5 })).resolves.toMatchObject({
      jobs: [
        {
          id: job.id,
          status: "completed",
          outputImages: ["https://example.com/db.png"]
        }
      ],
      total: 1
    });
    await expect(store.getOwnerAccount()).resolves.toMatchObject({ username: "owner" });
    await expect(stat(fallbackPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates reserved jobs with the same client request id in PostgreSQL", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();

    vi.doMock("pg", () => ({ Pool }));
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://studio:secret@localhost/private_image_studio";

    const store = await import("./store");
    const first = await store.reserveGenerationJob({
      clientRequestId: "same-db-client-request",
      dragonTaskId: null,
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "first prompt",
      resolution: "2k",
      size: "1:1",
      status: "pending"
    });
    const second = await store.reserveGenerationJob({
      clientRequestId: "same-db-client-request",
      dragonTaskId: null,
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "second prompt",
      resolution: "2k",
      size: "1:1",
      status: "pending"
    });
    const rows = db.public.many("select id, prompt from generation_jobs");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(rows).toMatchObject([{ id: first.job.id, prompt: "first prompt" }]);
  });
});
