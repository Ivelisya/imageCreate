export const DEFAULT_SUBMISSION_CONCURRENCY = 3;
const DEFAULT_MAX_QUEUED_SUBMISSIONS = 60;

type SubmissionWaiter = {
  resolve: (release: () => void) => void;
};

export class SubmissionQueueFullError extends Error {
  constructor() {
    super("生成提交队列已满，请稍后再试。");
    this.name = "SubmissionQueueFullError";
  }
}

let activeSubmissions = 0;
const submissionWaiters: SubmissionWaiter[] = [];

function normalizedLimit(value: number | undefined): number {
  const envLimit = Number.parseInt(process.env.SUBMISSION_CONCURRENCY ?? "", 10);
  const fallback = Number.isFinite(envLimit) && envLimit > 0
    ? envLimit
    : DEFAULT_SUBMISSION_CONCURRENCY;

  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback;
}

function normalizedMaxQueued(value: number | undefined): number {
  const envMaxQueued = Number.parseInt(process.env.SUBMISSION_MAX_QUEUED ?? "", 10);
  const fallback = Number.isFinite(envMaxQueued) && envMaxQueued > 0
    ? envMaxQueued
    : DEFAULT_MAX_QUEUED_SUBMISSIONS;

  return Math.max(1, Math.floor(value ?? fallback));
}

function releaseSubmissionSlot() {
  activeSubmissions = Math.max(0, activeSubmissions - 1);

  const next = submissionWaiters.shift();

  if (!next) {
    return;
  }

  activeSubmissions += 1;
  next.resolve(releaseSubmissionSlot);
}

async function acquireSubmissionSlot(options: {
  concurrency?: number;
  maxQueued?: number;
} = {}): Promise<() => void> {
  const concurrency = normalizedLimit(options.concurrency);

  if (activeSubmissions < concurrency) {
    activeSubmissions += 1;
    return releaseSubmissionSlot;
  }

  const maxQueued = normalizedMaxQueued(options.maxQueued);

  if (submissionWaiters.length >= maxQueued) {
    throw new SubmissionQueueFullError();
  }

  return new Promise((resolve) => {
    submissionWaiters.push({ resolve });
  });
}

export async function withSubmissionConcurrencyLimit<T>(
  operation: () => Promise<T>,
  options: {
    concurrency?: number;
    maxQueued?: number;
  } = {}
): Promise<T> {
  const release = await acquireSubmissionSlot(options);

  try {
    return await operation();
  } finally {
    release();
  }
}

export function resetSubmissionLimiterForTests() {
  activeSubmissions = 0;
  submissionWaiters.splice(0);
}

export function getSubmissionLimiterStateForTests() {
  return {
    activeSubmissions,
    queuedSubmissions: submissionWaiters.length
  };
}
