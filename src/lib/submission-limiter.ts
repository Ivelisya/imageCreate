export const DEFAULT_SUBMISSION_CONCURRENCY = 3;
const DEFAULT_MAX_QUEUED_SUBMISSIONS = 60;

type SubmissionWaiter = {
  resolve: (release: () => void) => void;
};

let activeSubmissions = 0;
const submissionWaiters: SubmissionWaiter[] = [];

function normalizedLimit(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.floor(value)
    : DEFAULT_SUBMISSION_CONCURRENCY;
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

  const maxQueued = Math.max(1, Math.floor(options.maxQueued ?? DEFAULT_MAX_QUEUED_SUBMISSIONS));

  while (submissionWaiters.length >= maxQueued) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
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
