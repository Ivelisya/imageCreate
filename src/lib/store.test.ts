import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnerAccount,
  createGenerationJob,
  deleteGenerationJobs,
  deleteGenerationJob,
  getGenerationJob,
  getOwnerAccount,
  listGenerationJobsByIds,
  listActiveGenerationJobs,
  listGenerationJobsPage,
  listGenerationJobs,
  reserveGenerationJob,
  updateGenerationJob
} from "./store";

const tempDirs: string[] = [];

async function createDatabasePath() {
  const dir = await mkdtemp(join(tmpdir(), "pis-store-"));
  tempDirs.push(dir);
  return join(dir, "nested", "store.json");
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generation job store", () => {
  it("creates the JSON file on first write and lists jobs newest first", async () => {
    const databasePath = await createDatabasePath();

    expect(await listGenerationJobs(databasePath)).toEqual([]);

    const older = await createGenerationJob(
      {
        dragonTaskId: "task_old",
        mode: "text",
        prompt: "first",
        resolution: "2k",
        size: "1:1",
        status: "submitted",
        progress: 0,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );
    const newer = await createGenerationJob(
      {
        dragonTaskId: "task_new",
        mode: "image",
        prompt: "second",
        resolution: "1k",
        size: "3:2",
        status: "pending",
        progress: 10,
        inputImages: ["data:image/png;base64,abc"],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );

    expect(await listGenerationJobs(databasePath)).toEqual([newer, older]);

    const saved = JSON.parse(await readFile(databasePath, "utf8")) as { jobs: unknown[] };
    expect(saved.jobs).toHaveLength(2);
  });

  it("updates an existing job and stores completion time for completed jobs", async () => {
    const databasePath = await createDatabasePath();
    const job = await createGenerationJob(
      {
        dragonTaskId: "task_done",
        mode: "text",
        prompt: "finish it",
        resolution: "2k",
        size: "1:1",
        status: "submitted",
        progress: 20,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );

    const updated = await updateGenerationJob(
      job.id,
      {
        status: "completed",
        progress: 100,
        outputImages: ["https://example.com/image.png"]
      },
      databasePath
    );

    expect(updated).toMatchObject({
      id: job.id,
      status: "completed",
      progress: 100,
      outputImages: ["https://example.com/image.png"]
    });
    expect(updated?.createdAt).toBe(job.createdAt);
    expect(updated?.updatedAt).not.toBe(job.updatedAt);
    expect(updated?.completedAt).toEqual(expect.any(String));
    expect(await getGenerationJob(job.id, databasePath)).toEqual(updated);
  });

  it("does not let a stale active update move a terminal JSON job backwards", async () => {
    const databasePath = await createDatabasePath();
    const job = await createGenerationJob(
      {
        dragonTaskId: "task_terminal_json",
        mode: "text",
        prompt: "finish once",
        resolution: "2k",
        size: "1:1",
        status: "submitted",
        progress: 0,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );
    const completed = await updateGenerationJob(
      job.id,
      {
        status: "completed",
        progress: 100,
        outputImages: ["https://example.com/final.png"]
      },
      databasePath
    );

    const stale = await updateGenerationJob(
      job.id,
      {
        status: "pending",
        progress: 5,
        outputImages: []
      },
      databasePath
    );

    expect(stale).toEqual(completed);
    expect(await getGenerationJob(job.id, databasePath)).toEqual(completed);
  });

  it("deletes one job without removing the rest of history", async () => {
    const databasePath = await createDatabasePath();
    const first = await createGenerationJob(
      {
        dragonTaskId: "task_keep",
        mode: "text",
        prompt: "keep this",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/keep.png"],
        errorMessage: null
      },
      databasePath
    );
    const second = await createGenerationJob(
      {
        dragonTaskId: "task_delete",
        mode: "image",
        prompt: "delete this",
        resolution: "1k",
        size: "3:2",
        status: "completed",
        progress: 100,
        inputImages: ["data:image/png;base64,abc"],
        outputImages: ["https://example.com/delete.png"],
        errorMessage: null
      },
      databasePath
    );

    expect(await deleteGenerationJob(second.id, databasePath)).toBe(true);
    expect(await getGenerationJob(second.id, databasePath)).toBeNull();
    expect(await listGenerationJobs(databasePath)).toEqual([first]);
    expect(await deleteGenerationJob("missing", databasePath)).toBe(false);
    expect(await listGenerationJobs(databasePath)).toEqual([first]);
  });

  it("lists one page of jobs with pagination metadata", async () => {
    vi.useFakeTimers();
    const databasePath = await createDatabasePath();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const first = await createGenerationJob(
      {
        dragonTaskId: "task_first",
        mode: "text",
        prompt: "first",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/first.png"],
        errorMessage: null
      },
      databasePath
    );
    vi.setSystemTime(new Date("2026-04-29T00:00:01.000Z"));
    const second = await createGenerationJob(
      {
        dragonTaskId: "task_second",
        mode: "text",
        prompt: "second",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/second.png"],
        errorMessage: null
      },
      databasePath
    );
    vi.setSystemTime(new Date("2026-04-29T00:00:02.000Z"));
    await createGenerationJob(
      {
        dragonTaskId: "task_third",
        mode: "text",
        prompt: "third",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/third.png"],
        errorMessage: null
      },
      databasePath
    );

    expect(second.prompt).toBe("second");
    await expect(listGenerationJobsPage(databasePath, { page: 2, pageSize: 2 })).resolves.toEqual({
      jobs: [first],
      page: 2,
      pageSize: 2,
      total: 3,
      totalPages: 2
    });
  });

  it("filters paginated history by prompt, status and mode", async () => {
    const databasePath = await createDatabasePath();
    await createGenerationJob(
      {
        dragonTaskId: "task_text",
        mode: "text",
        prompt: "quiet landscape",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/text.png"],
        errorMessage: null
      },
      databasePath
    );
    const matching = await createGenerationJob(
      {
        dragonTaskId: "task_image",
        mode: "image",
        prompt: "boss poster with warm light",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/image.png"],
        errorMessage: null
      },
      databasePath
    );
    await createGenerationJob(
      {
        dragonTaskId: "task_failed",
        mode: "image",
        prompt: "boss poster failed draft",
        resolution: "2k",
        size: "1:1",
        status: "failed",
        progress: 100,
        inputImages: [],
        outputImages: [],
        errorMessage: "failed"
      },
      databasePath
    );

    await expect(
      listGenerationJobsPage(databasePath, {
        mode: "image",
        page: 1,
        pageSize: 5,
        query: "poster",
        status: "completed"
      })
    ).resolves.toMatchObject({
      jobs: [matching],
      total: 1,
      totalPages: 1
    });
  });

  it("bulk deletes selected non-active jobs and reports skipped active records", async () => {
    const databasePath = await createDatabasePath();
    const active = await createGenerationJob(
      {
        dragonTaskId: "task_active",
        mode: "text",
        prompt: "still running",
        resolution: "2k",
        size: "1:1",
        status: "submitted",
        progress: 10,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );
    const completed = await createGenerationJob(
      {
        dragonTaskId: "task_completed",
        mode: "text",
        prompt: "done",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/done.png"],
        errorMessage: null
      },
      databasePath
    );
    const failed = await createGenerationJob(
      {
        dragonTaskId: "task_failed",
        mode: "text",
        prompt: "failed",
        resolution: "2k",
        size: "1:1",
        status: "failed",
        progress: 100,
        inputImages: [],
        outputImages: [],
        errorMessage: "failed"
      },
      databasePath
    );

    await expect(
      deleteGenerationJobs(
        {
          ids: [active.id, completed.id, "missing-id"]
        },
        databasePath
      )
    ).resolves.toEqual({
      deletedCount: 1,
      notFoundIds: ["missing-id"],
      skippedActive: 1
    });
    const remainingJobs = await listGenerationJobsByIds([active.id, completed.id, failed.id], databasePath);

    expect(remainingJobs.map((job) => job.id).sort()).toEqual([active.id, failed.id].sort());
  });

  it("bulk deletes by safe scope without removing active jobs", async () => {
    const databasePath = await createDatabasePath();
    const active = await createGenerationJob(
      {
        dragonTaskId: "task_active_scope",
        mode: "text",
        prompt: "still running",
        resolution: "2k",
        size: "1:1",
        status: "pending",
        progress: 10,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );
    await createGenerationJob(
      {
        dragonTaskId: "task_failed_scope",
        mode: "text",
        prompt: "failed",
        resolution: "2k",
        size: "1:1",
        status: "failed",
        progress: 100,
        inputImages: [],
        outputImages: [],
        errorMessage: "failed"
      },
      databasePath
    );

    await expect(deleteGenerationJobs({ scope: "failed" }, databasePath)).resolves.toEqual({
      deletedCount: 1,
      notFoundIds: [],
      skippedActive: 0
    });
    await expect(listGenerationJobs(databasePath)).resolves.toEqual([active]);
  });

  it("lists active jobs without returning completed history", async () => {
    vi.useFakeTimers();
    const databasePath = await createDatabasePath();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    await createGenerationJob(
      {
        dragonTaskId: "task_done",
        mode: "text",
        prompt: "done",
        resolution: "2k",
        size: "1:1",
        status: "completed",
        progress: 100,
        inputImages: [],
        outputImages: ["https://example.com/done.png"],
        errorMessage: null
      },
      databasePath
    );
    vi.setSystemTime(new Date("2026-04-29T00:00:01.000Z"));
    const submitted = await createGenerationJob(
      {
        dragonTaskId: "task_submitted",
        mode: "text",
        prompt: "submitted",
        resolution: "2k",
        size: "1:1",
        status: "submitted",
        progress: 0,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );
    vi.setSystemTime(new Date("2026-04-29T00:00:02.000Z"));
    const pending = await createGenerationJob(
      {
        dragonTaskId: "task_pending",
        mode: "text",
        prompt: "pending",
        resolution: "2k",
        size: "1:1",
        status: "pending",
        progress: 0,
        inputImages: [],
        outputImages: [],
        errorMessage: null
      },
      databasePath
    );

    await expect(listActiveGenerationJobs(databasePath)).resolves.toEqual([pending, submitted]);
  });

  it("reserves an idempotent generation job only once for the same client request id", async () => {
    const databasePath = await createDatabasePath();
    const first = await reserveGenerationJob(
      {
        clientRequestId: "same-client-request",
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
      },
      databasePath
    );
    const second = await reserveGenerationJob(
      {
        clientRequestId: "same-client-request",
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
      },
      databasePath
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await listGenerationJobs(databasePath)).toHaveLength(1);
  });
});

describe("owner account store", () => {
  it("starts without an owner account and creates one once", async () => {
    const databasePath = await createDatabasePath();

    expect(await getOwnerAccount(databasePath)).toBeNull();

    const created = await createOwnerAccount(
      {
        username: "creator",
        passwordHash: "hash_value"
      },
      databasePath
    );

    expect(created).toMatchObject({
      username: "creator",
      passwordHash: "hash_value"
    });
    expect(created.createdAt).toEqual(expect.any(String));
    expect(await getOwnerAccount(databasePath)).toEqual(created);
  });

  it("does not replace an existing owner account", async () => {
    const databasePath = await createDatabasePath();
    const first = await createOwnerAccount(
      {
        username: "first",
        passwordHash: "first_hash"
      },
      databasePath
    );

    await expect(
      createOwnerAccount(
        {
          username: "second",
          passwordHash: "second_hash"
        },
        databasePath
      )
    ).rejects.toThrow("Owner account already exists");
    expect(await getOwnerAccount(databasePath)).toEqual(first);
  });
});
