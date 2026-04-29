import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DragonCodeRequestError, fetchDragonTask } from "./dragon-client";
import {
  createGenerationJob,
  getGenerationJob,
  listActiveGenerationJobs
} from "./store";
import {
  calculatePollRetryDelayMs,
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
    let resolveSlowPoll: (value: Awaited<ReturnType<typeof fetchDragonTask>>) => void = () => {
      throw new Error("slow poll resolver was not initialized");
    };
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

    const slowPoll = pollGenerationJobOnce(job.id, { maxConcurrentFetches: 2 });
    await vi.waitFor(() => expect(vi.mocked(fetchDragonTask)).toHaveBeenCalledTimes(1));
    const fastPoll = pollGenerationJobOnce(job.id, { maxConcurrentFetches: 2 });
    await fastPoll;

    resolveSlowPoll({
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

  it("limits concurrent DragonCode task queries when many jobs are refreshed together", async () => {
    const first = await createGenerationJob({
      clientRequestId: "concurrency-one",
      dragonTaskId: "task_concurrency_one",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "one",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    const second = await createGenerationJob({
      clientRequestId: "concurrency-two",
      dragonTaskId: "task_concurrency_two",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "two",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    let running = 0;
    let maxRunning = 0;
    const resolvePolls: Array<() => void> = [];

    vi.mocked(fetchDragonTask).mockImplementation(
      (async (_apiKey: string, dragonTaskId: string) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);

        await new Promise<void>((resolve) => {
          resolvePolls.push(() => {
            running -= 1;
            resolve();
          });
        });

        return {
          dragonTaskId,
          errorMessage: null,
          outputUrls: [],
          progress: 5,
          status: "pending"
        };
      }) as typeof fetchDragonTask
    );

    const firstPoll = pollGenerationJobOnce(first.id, { maxConcurrentFetches: 1 });
    const secondPoll = pollGenerationJobOnce(second.id, { maxConcurrentFetches: 1 });
    await vi.waitFor(() => expect(resolvePolls.length).toBeGreaterThan(0));

    expect(maxRunning).toBe(1);
    expect(resolvePolls).toHaveLength(1);
    resolvePolls.shift()?.();
    await vi.waitFor(() => expect(resolvePolls).toHaveLength(1));
    expect(maxRunning).toBe(1);
    resolvePolls.shift()?.();

    await Promise.all([firstPoll, secondPoll]);
    expect(vi.mocked(fetchDragonTask)).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it("records transient polling failures and backs off the next poll", async () => {
    const job = await createGenerationJob({
      clientRequestId: "poll-backoff",
      dragonTaskId: "task_backoff",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "backoff",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    vi.mocked(fetchDragonTask).mockRejectedValueOnce(new Error("upstream busy"));

    const result = await pollGenerationJobOnce(job.id, {
      intervalMs: 5000,
      retryJitterMs: 0
    });
    const saved = await getGenerationJob(job.id);

    expect(result).toMatchObject({
      nextDelayMs: 10_000,
      shouldContinue: true
    });
    expect(saved).toMatchObject({
      retryCount: 1,
      status: "submitted",
      errorMessage: "DragonCode 查询暂时失败，系统正在自动降频重试。"
    });
  });

  it("marks non-retriable DragonCode polling failures as failed immediately", async () => {
    const job = await createGenerationJob({
      clientRequestId: "poll-permanent-failure",
      dragonTaskId: "task_permanent_failure",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "permanent failure",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    vi.mocked(fetchDragonTask).mockRejectedValueOnce(
      new DragonCodeRequestError("DragonCode task query failed with DragonCode code 400", {
        retriable: false,
        status: 400
      })
    );

    const result = await pollGenerationJobOnce(job.id, {
      intervalMs: 5000,
      retryJitterMs: 0
    });
    const saved = await getGenerationJob(job.id);

    expect(result.shouldContinue).toBe(false);
    expect(saved).toMatchObject({
      status: "failed",
      progress: 100,
      errorMessage: "DragonCode task query failed with DragonCode code 400"
    });
  });

  it("throttles active job recovery scans when status requests arrive frequently", async () => {
    await createGenerationJob({
      clientRequestId: "throttle-active-scans",
      dragonTaskId: "task_throttle_scan",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "throttle scans",
      resolution: "2k",
      size: "1:1",
      status: "pending"
    });

    await expect(
      startActiveGenerationPolling({
        initialDelayMs: 60_000,
        maxActiveScanIntervalMs: 60_000
      })
    ).resolves.toBe(1);
    await expect(
      startActiveGenerationPolling({
        initialDelayMs: 60_000,
        maxActiveScanIntervalMs: 60_000
      })
    ).resolves.toBe(0);
  });

  it("caps exponential polling backoff", () => {
    expect(
      calculatePollRetryDelayMs(12, {
        intervalMs: 5000,
        maxRetryDelayMs: 60_000,
        retryJitterMs: 0
      })
    ).toBe(60_000);
  });

  it("contains background polling storage failures instead of rejecting timer runs", async () => {
    const brokenDirectory = await mkdtemp(join(tmpdir(), "pis-broken-store-"));
    tempDirs.push(brokenDirectory);
    process.env.DATABASE_PATH = brokenDirectory;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    startGenerationPolling("job-with-broken-store", { initialDelayMs: 0, intervalMs: 5000 });
    await vi.runOnlyPendingTimersAsync();

    await expect(waitForGenerationPollingForTests()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[generation-poller] background polling failed",
      expect.objectContaining({ jobId: "job-with-broken-store" })
    );
  });
});
