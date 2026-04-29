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
};

const DEFAULT_INITIAL_DELAY_MS = 2500;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const POLLING_TIMEOUT_MESSAGE = "生成任务超过最长等待时间，已停止轮询。请重新提交任务。";
const activePolls = new Map<string, ReturnType<typeof setTimeout>>();
const activeRuns = new Set<Promise<void>>();
const pollStartedAt = new Map<string, number>();

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

function markGenerationJobTimedOut(
  jobId: string,
  options: Pick<PollingOptions, "databasePath"> = {}
) {
  const run = updateGenerationJob(
    jobId,
    {
      status: "failed",
      progress: 100,
      errorMessage: POLLING_TIMEOUT_MESSAGE
    },
    options.databasePath
  ).then(() => undefined);

  trackActiveRun(run);
}

export async function pollGenerationJobOnce(
  jobId: string,
  options: Pick<PollingOptions, "databasePath"> = {}
): Promise<{ job: GenerationJob | null; shouldContinue: boolean }> {
  const job = await getGenerationJob(jobId, options.databasePath);

  if (!isActiveJob(job)) {
    pollStartedAt.delete(jobId);
    return { job, shouldContinue: false };
  }

  try {
    const task = await fetchDragonTask(getDragonApiKey(), job.dragonTaskId);
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

    if (!shouldContinue) {
      pollStartedAt.delete(jobId);
    }

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

  const now = Date.now();
  const startedAt = pollStartedAt.get(jobId) ?? now;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  pollStartedAt.set(jobId, startedAt);

  if (now - startedAt > maxDurationMs) {
    pollStartedAt.delete(jobId);
    markGenerationJobTimedOut(jobId, options);
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
  pollStartedAt.clear();
}

export async function waitForGenerationPollingForTests() {
  await Promise.all([...activeRuns]);
}
