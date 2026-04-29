import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDragonTask } from "./dragon-client";
import {
  createGenerationJob,
  getGenerationJob,
  listActiveGenerationJobs
} from "./store";
import {
  pollGenerationJobOnce,
  resetGenerationPollingForTests,
  startActiveGenerationPolling,
  startGenerationPolling,
  waitForGenerationPollingForTests
} from "./generation-poller";

vi.mock("./dragon-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dragon-client")>();

  return {
    ...actual,
    fetchDragonTask: vi.fn()
  };
});

const tempDirs: string[] = [];

async function createDatabasePath() {
  const dir = await mkdtemp(join(tmpdir(), "pis-poller-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

beforeEach(async () => {
  vi.useFakeTimers();
  process.env.DRAGON_API_KEY = "sk-test";
  process.env.DATABASE_PATH = await createDatabasePath();
  vi.mocked(fetchDragonTask).mockReset();
  resetGenerationPollingForTests();
});

afterEach(async () => {
  await waitForGenerationPollingForTests();
  resetGenerationPollingForTests();
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.DATABASE_PATH;
  delete process.env.DRAGON_API_KEY;
});

describe("generation poller", () => {
  it("updates an active job to completed without a foreground request", async () => {
    const job = await createGenerationJob({
      clientRequestId: "background-sync",
      dragonTaskId: "task_background",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "background sync",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    vi.mocked(fetchDragonTask).mockResolvedValueOnce({
      dragonTaskId: "task_background",
      errorMessage: null,
      outputUrls: ["https://example.com/image.png"],
      progress: 100,
      status: "completed"
    });

    startGenerationPolling(job, { initialDelayMs: 0, intervalMs: 5000 });
    await vi.runOnlyPendingTimersAsync();
    await waitForGenerationPollingForTests();

    const saved = await getGenerationJob(job.id);

    expect(vi.mocked(fetchDragonTask)).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({
      status: "completed",
      progress: 100,
      outputImages: ["https://example.com/image.png"]
    });
  });

  it("resumes polling active jobs already stored on server startup", async () => {
    const job = await createGenerationJob({
      clientRequestId: "resume-active",
      dragonTaskId: "task_resume",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "resume active",
      resolution: "2k",
      size: "1:1",
      status: "pending"
    });
    vi.mocked(fetchDragonTask).mockResolvedValueOnce({
      dragonTaskId: "task_resume",
      errorMessage: null,
      outputUrls: ["https://example.com/resume.png"],
      progress: 100,
      status: "completed"
    });

    const count = await startActiveGenerationPolling({ initialDelayMs: 0, intervalMs: 5000 });
    await vi.runOnlyPendingTimersAsync();
    await waitForGenerationPollingForTests();

    expect(count).toBe(1);
    expect(await listActiveGenerationJobs()).toEqual([]);
    expect(await getGenerationJob(job.id)).toMatchObject({
      status: "completed",
      outputImages: ["https://example.com/resume.png"]
    });
  });

  it("marks an active job as failed when polling exceeds the maximum duration", async () => {
    const job = await createGenerationJob({
      clientRequestId: "timeout-active",
      dragonTaskId: "task_timeout",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "timeout active",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });

    expect(startGenerationPolling(job, { initialDelayMs: 0, maxDurationMs: -1 })).toBe(false);
    await waitForGenerationPollingForTests();

    expect(vi.mocked(fetchDragonTask)).not.toHaveBeenCalled();
    expect(await getGenerationJob(job.id)).toMatchObject({
      status: "failed",
      errorMessage: "生成任务超过最长等待时间，已停止轮询。请重新提交任务。"
    });
  });

  it("uses the persisted creation time to time out old active jobs after a restart", async () => {
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const job = await createGenerationJob({
      clientRequestId: "old-active-after-restart",
      dragonTaskId: "task_old_active",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "old active",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    resetGenerationPollingForTests();
    vi.setSystemTime(new Date("2026-04-29T00:10:00.000Z"));

    expect(startGenerationPolling(job, { initialDelayMs: 0, maxDurationMs: 60_000 })).toBe(false);
    await waitForGenerationPollingForTests();

    expect(vi.mocked(fetchDragonTask)).not.toHaveBeenCalled();
    expect(await getGenerationJob(job.id)).toMatchObject({
      status: "failed",
      errorMessage: "生成任务超过最长等待时间，已停止轮询。请重新提交任务。"
    });
  });

  it("keeps a completed result when an older concurrent poll resolves as pending later", async () => {
    const job = await createGenerationJob({
      clientRequestId: "stale-poll-race",
      dragonTaskId: "task_race",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "race",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    let resolveSlowPoll: ((value: Awaited<ReturnType<typeof fetchDragonTask>>) => void) | null = null;
    vi.mocked(fetchDragonTask)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlowPoll = resolve;
        })
      )
      .mockResolvedValueOnce({
        dragonTaskId: "task_race",
        errorMessage: null,
        outputUrls: ["https://example.com/final.png"],
        progress: 100,
        status: "completed"
      });

    const slowPoll = pollGenerationJobOnce(job.id);
    const fastPoll = pollGenerationJobOnce(job.id);
    await fastPoll;
    resolveSlowPoll?.({
      dragonTaskId: "task_race",
      errorMessage: null,
      outputUrls: [],
      progress: 5,
      status: "pending"
    });
    await slowPoll;

    expect(await getGenerationJob(job.id)).toMatchObject({
      status: "completed",
      progress: 100,
      outputImages: ["https://example.com/final.png"]
    });
  });
});
