import { fetchDragonTask } from "./dragon-client";
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
  maxDurationMs?: number;
  maxConcurrentFetches?: number;
};

const DEFAULT_INITIAL_DELAY_MS = 2500;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_FETCHES = 4;
const POLLING_TIMEOUT_MESSAGE = "生成任务超过最长等待时间，已停止轮询。请重新提交任务。";
const activePolls = new Map<string, ReturnType<typeof setTimeout>>();
const activeRuns = new Set<Promise<void>>();
const pollFetchWaiters: Array<{ maxConcurrentFetches: number; resolve: () => void }> = [];
let activePollFetches = 0;

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

export async function pollGenerationJobOnce(
  jobId: string,
  options: Pick<PollingOptions, "databasePath" | "maxDurationMs" | "maxConcurrentFetches"> = {}
): Promise<{ job: GenerationJob | null; shouldContinue: boolean }> {
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
        errorMessage: task.errorMessage
      },
      options.databasePath
    );
    const updated = refreshed ?? job;
    const shouldContinue = updated.status === "pending" || updated.status === "submitted";

    return { job: updated, shouldContinue };
  } catch {
    return { job, shouldContinue: true };
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
          initialDelayMs: options.intervalMs ?? DEFAULT_INTERVAL_MS
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
  const activeJobs = await listActiveGenerationJobs(options.databasePath);

  for (const job of activeJobs) {
    startGenerationPolling(job, options);
  }

  return activeJobs.length;
}

export function resetGenerationPollingForTests() {
  for (const timer of activePolls.values()) {
    clearTimeout(timer);
  }

  activePolls.clear();
  activeRuns.clear();
  pollFetchWaiters.splice(0);
  activePollFetches = 0;
}

export async function waitForGenerationPollingForTests() {
  await Promise.all([...activeRuns]);
}
