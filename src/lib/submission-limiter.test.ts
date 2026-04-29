import { afterEach, describe, expect, it } from "vitest";
import {
  resetSubmissionLimiterForTests,
  SubmissionQueueFullError,
  withSubmissionConcurrencyLimit
} from "./submission-limiter";

afterEach(() => {
  resetSubmissionLimiterForTests();
});

describe("submission limiter", () => {
  it("rejects immediately when the queue is full", async () => {
    const releases: Array<() => void> = [];
    const active = withSubmissionConcurrencyLimit(
      async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
      { concurrency: 1, maxQueued: 1 }
    );
    const queued = withSubmissionConcurrencyLimit(
      async () => "queued",
      { concurrency: 1, maxQueued: 1 }
    );

    await expect(
      withSubmissionConcurrencyLimit(
        async () => "overflow",
        { concurrency: 1, maxQueued: 1 }
      )
    ).rejects.toBeInstanceOf(SubmissionQueueFullError);

    releases.splice(0).forEach((release) => release());
    await active;
    await expect(queued).resolves.toBe("queued");
  });
});
