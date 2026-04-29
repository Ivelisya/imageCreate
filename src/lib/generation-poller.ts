import { DragonCodeRequestError, fetchDragonTask } from "./dragon-client";
import { getDragonApiKey } from "./env";
import {
  getGenerationJob,
  listActiveGenerationJobs,
  updateGenerationJob,
  type GenerationJob
} from "./store";

type ActiveGenerationJob = GenerationJob & {
  dragonTaskId: string;
  status: "pending" | "submitted";
};

type PollingOptions = {
  databasePath?: string;
  initialDelayMs?: number;
  intervalMs?: number;
  maxActiveScanIntervalMs?: number;
  maxDurationMs?: number;
  maxConcurrentFetches?: number;
  maxRetryDelayMs?: number;
  retryJitterMs?: number;
};

const DEFAULT_INITIAL_DELAY_MS = 2500;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_FETCHES = 3;
const DEFAULT_MAX_ACTIVE_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_JITTER_MS = 1000;
const POLLING_TIMEOUT_MESSAGE = "生成任务超过最长等待时间，已停止轮询。请重新提交任务。";
const TRANSIENT_POLLING_ERROR_MESSAGE = "DragonCode 查询暂时失败，系统正在自动降频重试。";
const activePolls = new Map<string, ReturnType<typeof setTimeout>>();
const activeRuns = new Set<Promise<void>>();
const pollFetchWaiters: Array<{ maxConcurrentFetches: number; resolve: () => void }> = [];
let activePollFetches = 0;
let lastActiveScanStartedAt = 0;
let activeScanRun: Promise<number> | null = null;

function isActiveJob(job: GenerationJob | null): job is ActiveGenerationJob {
  return (
    typeof job?.dragonTaskId === "string" &&
    job.dragonTaskId.length > 0 &&
    (job.status === "pending" || job.status === "submitted")
  );
}

function setBackgroundTimer(callback: () => void | Promise<void>, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  const maybeNodeTimer = timer as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };

  maybeNodeTimer.unref?.();

  return timer;
}

function trackActiveRun(run: Promise<void>) {
  activeRuns.add(run);
  run.finally(() => activeRuns.delete(run));
}

function normalizedFetchLimit(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_CONCURRENT_FETCHES;
}

export function calculatePollRetryDelayMs(
  retryCount: number | undefined,
  options: Pick<PollingOptions, "intervalMs" | "maxRetryDelayMs" | "retryJitterMs"> = {}
): number {
  const attempt = Math.max(1, Math.floor(retryCount ?? 1));
  const baseDelayMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const exponentialDelayMs = baseDelayMs * 2 ** Math.min(attempt, 5);
  const jitterMs = Math.floor(Math.random() * Math.max(0, options.retryJitterMs ?? DEFAULT_RETRY_JITTER_MS));

  return Math.min(maxDelayMs, exponentialDelayMs + jitterMs);
}

async function acquirePollFetchSlot(maxConcurrentFetches: number): Promise<void> {
  if (activePollFetches < maxConcurrentFetches) {
    activePollFetches += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    pollFetchWaiters.push({ maxConcurrentFetches, resolve });
  });
}

function releasePollFetchSlot() {
  activePollFetches = Math.max(0, activePollFetches - 1);

  const nextIndex = pollFetchWaiters.findIndex(
    (waiter) => activePollFetches < waiter.maxConcurrentFetches
  );

  if (nextIndex === -1) {
    return;
  }

  const [next] = pollFetchWaiters.splice(nextIndex, 1);

  activePollFetches += 1;
  next.resolve();
}

async function withPollFetchSlot<T>(
  maxConcurrentFetches: number | undefined,
  operation: () => Promise<T>
): Promise<T> {
  await acquirePollFetchSlot(normalizedFetchLimit(maxConcurrentFetches));

  try {
    return await operation();
  } finally {
    releasePollFetchSlot();
  }
}

function hasPollingTimedOut(job: GenerationJob, maxDurationMs: number): boolean {
  const createdAtMs = Date.parse(job.createdAt);

  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  return Date.now() - createdAtMs > maxDurationMs;
}

async function markGenerationJobTimedOut(
  jobId: string,
  options: Pick<PollingOptions, "databasePath"> = {}
): Promise<GenerationJob | null> {
  return updateGenerationJob(
    jobId,
    {
      status: "failed",
      progress: 100,
      errorMessage: POLLING_TIMEOUT_MESSAGE
    },
    options.databasePath
  );
}

function pollingErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "DragonCode 查询失败。";
}

export async function pollGenerationJobOnce(
  jobId: string,
  options: Pick<
    PollingOptions,
    | "databasePath"
    | "intervalMs"
    | "maxConcurrentFetches"
    | "maxDurationMs"
    | "maxRetryDelayMs"
    | "retryJitterMs"
  > = {}
): Promise<{ job: GenerationJob | null; nextDelayMs?: number; shouldContinue: boolean }> {
  const job = await getGenerationJob(jobId, options.databasePath);

  if (!isActiveJob(job)) {
    return { job, shouldContinue: false };
  }

  if (hasPollingTimedOut(job, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)) {
    const timedOut = await markGenerationJobTimedOut(job.id, options);

    return { job: timedOut ?? job, shouldContinue: false };
  }

  try {
    const task = await withPollFetchSlot(options.maxConcurrentFetches, () =>
      fetchDragonTask(getDragonApiKey(), job.dragonTaskId)
    );
    const refreshed = await updateGenerationJob(
      job.id,
      {
        status: task.status,
        progress: task.progress,
        outputImages: task.outputUrls,
        errorMessage: task.errorMessage,
        retryCount: 0
      },
      options.databasePath
    );
    const updated = refreshed ?? job;
    const shouldContinue = updated.status === "pending" || updated.status === "submitted";

    return { job: updated, shouldContinue };
  } catch (error) {
    if (error instanceof DragonCodeRequestError && !error.retriable) {
      const failed = await updateGenerationJob(
        job.id,
        {
          status: "failed",
          progress: 100,
          errorMessage: pollingErrorMessage(error)
        },
        options.databasePath
      );

      return { job: failed ?? job, shouldContinue: false };
    }

    const retryCount = (job.retryCount ?? 0) + 1;
    const updated = await updateGenerationJob(
      job.id,
      {
        retryCount,
        errorMessage: TRANSIENT_POLLING_ERROR_MESSAGE
      },
      options.databasePath
    );

    return {
      job: updated ?? job,
      nextDelayMs: calculatePollRetryDelayMs(retryCount, options),
      shouldContinue: true
    };
  }
}

export function startGenerationPolling(
  jobOrId: GenerationJob | string,
  options: PollingOptions = {}
): boolean {
  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId.id;
  const inputJob = typeof jobOrId === "string" ? null : jobOrId;

  if (inputJob && !isActiveJob(inputJob)) {
    return false;
  }

  if (activePolls.has(jobId)) {
    return false;
  }

  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  if (inputJob && hasPollingTimedOut(inputJob, maxDurationMs)) {
    trackActiveRun(markGenerationJobTimedOut(jobId, options).then(() => undefined));
    return false;
  }

  const timer = setBackgroundTimer(() => {
    activePolls.delete(jobId);
    const run = pollGenerationJobOnce(jobId, options).then((result) => {
      if (result.shouldContinue) {
        startGenerationPolling(jobId, {
          ...options,
          initialDelayMs: result.nextDelayMs ?? options.intervalMs ?? DEFAULT_INTERVAL_MS
        });
      }
    });

    trackActiveRun(run);

    return run;
  }, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

  activePolls.set(jobId, timer);

  return true;
}

export async function startActiveGenerationPolling(
  options: PollingOptions = {}
): Promise<number> {
  const maxActiveScanIntervalMs = options.maxActiveScanIntervalMs ?? 0;
  const now = Date.now();

  if (
    maxActiveScanIntervalMs > 0 &&
    lastActiveScanStartedAt > 0 &&
    now - lastActiveScanStartedAt < maxActiveScanIntervalMs
  ) {
    return 0;
  }

  if (activeScanRun) {
    return activeScanRun;
  }

  activeScanRun = (async () => {
    lastActiveScanStartedAt = Date.now();
    const activeJobs = await listActiveGenerationJobs(options.databasePath);

    for (const job of activeJobs) {
      startGenerationPolling(job, options);
    }

    return activeJobs.length;
  })();

  try {
    return await activeScanRun;
  } finally {
    activeScanRun = null;
  }
}

export function scheduleActiveGenerationPollingRecovery(options: PollingOptions = {}): void {
  void startActiveGenerationPolling({
    ...options,
    maxActiveScanIntervalMs:
      options.maxActiveScanIntervalMs ?? DEFAULT_MAX_ACTIVE_SCAN_INTERVAL_MS
  });
}

export function resetGenerationPollingForTests() {
  for (const timer of activePolls.values()) {
    clearTimeout(timer);
  }

  activePolls.clear();
  activeRuns.clear();
  pollFetchWaiters.splice(0);
  activePollFetches = 0;
  lastActiveScanStartedAt = 0;
  activeScanRun = null;
}

export async function waitForGenerationPollingForTests() {
  await Promise.all([...activeRuns]);
}
