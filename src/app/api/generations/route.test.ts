import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGenerationJob,
  getGenerationJob,
  listGenerationJobs
} from "@/lib/store";
import {
  fetchDragonTask,
  submitDragonGeneration
} from "@/lib/dragon-client";
import { resetGenerationPollingForTests } from "@/lib/generation-poller";
import {
  getSubmissionLimiterStateForTests,
  resetSubmissionLimiterForTests
} from "@/lib/submission-limiter";
import { GET, POST } from "./route";
import { GET as GET_GENERATION } from "./[id]/route";
import { POST as BULK_DELETE } from "./delete/route";
import { GET as GET_STATUS } from "./status/route";

vi.mock("@/lib/dragon-client", () => ({
  fetchDragonTask: vi.fn(),
  isRetriableDragonTaskError: vi.fn((message: string | null | undefined) =>
    Boolean(message?.includes("tool_choice"))
  ),
  normalizeDragonTaskError: vi.fn((message: string | null | undefined) => message ?? null),
  submitDragonGeneration: vi.fn()
}));

vi.mock("@/lib/server-auth", () => ({
  getCurrentUser: vi.fn(() => ({ username: "tester" }))
}));

const tempDirs: string[] = [];

async function createDatabasePath() {
  const dir = await mkdtemp(join(tmpdir(), "pis-api-route-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

function createAuthedRequest(
  method: string,
  pathname: string,
  body?: Record<string, unknown>
) {
  const headers = new Headers();

  if (body) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-with-at-least-thirty-two-characters";
  process.env.DRAGON_API_KEY = "sk-test";
  process.env.DATABASE_PATH = await createDatabasePath();
  vi.mocked(submitDragonGeneration).mockReset();
  vi.mocked(fetchDragonTask).mockReset();
  resetGenerationPollingForTests();
  resetSubmissionLimiterForTests();
});

afterEach(async () => {
  resetGenerationPollingForTests();
  resetSubmissionLimiterForTests();
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.DATABASE_PATH;
  delete process.env.DRAGON_API_KEY;
  delete process.env.SESSION_SECRET;
  delete process.env.SUBMISSION_CONCURRENCY;
  delete process.env.SUBMISSION_MAX_QUEUED;
});

describe("generation API routes", () => {
  it("rejects submissions with more than sixteen reference images", async () => {
    const response = await POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "too-many-images",
        imageUrls: Array.from({ length: 17 }, (_value, index) => `https://example.com/ref-${index}.png`),
        mode: "image",
        prompt: "make a poster",
        resolution: "2k",
        size: "1:1"
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("参考图最多支持 16 张。");
    expect(vi.mocked(submitDragonGeneration)).not.toHaveBeenCalled();
  });

  it("rejects generation requests whose declared body is too large before parsing uploads", async () => {
    const request = createAuthedRequest("POST", "/api/generations", {
      clientRequestId: "too-large-body",
      mode: "text",
      prompt: "make a poster",
      resolution: "2k",
      size: "1:1"
    });

    request.headers.set("content-length", String(65 * 1024 * 1024));

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error).toContain("上传内容过大");
    expect(vi.mocked(submitDragonGeneration)).not.toHaveBeenCalled();
  });

  it("omits uploaded base64 input images from the POST response", async () => {
    vi.mocked(submitDragonGeneration).mockResolvedValueOnce("task_post");

    const response = await POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "request-with-image",
        imageUrls: ["data:image/png;base64,very-large-input"],
        mode: "image",
        prompt: "make a poster",
        resolution: "2k",
        size: "1:1"
      })
    );
    const payload = await response.json();
    const savedJobs = await listGenerationJobs();

    expect(response.status).toBe(201);
    expect(payload.job.inputImages).toBeUndefined();
    expect(payload.job.clientRequestId).toBe("request-with-image");
    expect(savedJobs[0].inputImages).toEqual([]);
    expect(vi.mocked(submitDragonGeneration)).toHaveBeenCalledWith("sk-test", expect.objectContaining({
      imageUrls: ["data:image/png;base64,very-large-input"]
    }));
  });

  it("returns the existing job for repeated client request ids without resubmitting", async () => {
    vi.mocked(submitDragonGeneration).mockResolvedValueOnce("task_once");
    const body = {
      clientRequestId: "same-submit-click",
      imageUrls: ["data:image/png;base64,avatar"],
      mode: "image",
      prompt: "make a poster",
      resolution: "2k",
      size: "1:1"
    };

    const firstResponse = await POST(createAuthedRequest("POST", "/api/generations", body));
    const firstPayload = await firstResponse.json();
    const secondResponse = await POST(createAuthedRequest("POST", "/api/generations", body));
    const secondPayload = await secondResponse.json();

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    expect(firstPayload.job.id).toBe(secondPayload.job.id);
    expect(vi.mocked(submitDragonGeneration)).toHaveBeenCalledTimes(1);
    expect(await listGenerationJobs()).toHaveLength(1);
  });

  it("queues direct API submissions so DragonCode sees at most three concurrent requests", async () => {
    let running = 0;
    let started = 0;
    let maxRunning = 0;
    const releaseSubmissions: Array<() => void> = [];

    vi.mocked(submitDragonGeneration).mockImplementation(async () => {
      const taskIndex = started;

      started += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);

      await new Promise<void>((resolve) => {
        releaseSubmissions.push(() => {
          running -= 1;
          resolve();
        });
      });

      return `task_limited_${taskIndex}`;
    });

    const responsesPromise = Promise.all(
      Array.from({ length: 6 }, (_value, index) =>
        POST(
          createAuthedRequest("POST", "/api/generations", {
            clientRequestId: `api-limit-${index}`,
            mode: "text",
            prompt: `make poster ${index}`,
            resolution: "2k",
            size: "1:1"
          })
        )
      )
    );

    await vi.waitFor(() => expect(started).toBe(3));
    expect(maxRunning).toBe(3);
    releaseSubmissions.splice(0).forEach((release) => release());

    await vi.waitFor(() => expect(started).toBe(6));
    expect(maxRunning).toBe(3);
    releaseSubmissions.splice(0).forEach((release) => release());

    const responses = await responsesPromise;

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(vi.mocked(submitDragonGeneration)).toHaveBeenCalledTimes(6);
  });

  it("returns 429 without reserving a local job when the submission queue is full", async () => {
    process.env.SUBMISSION_CONCURRENCY = "1";
    process.env.SUBMISSION_MAX_QUEUED = "1";
    resetSubmissionLimiterForTests();
    let started = 0;
    const releaseSubmissions: Array<() => void> = [];

    vi.mocked(submitDragonGeneration).mockImplementation(async () => {
      const taskIndex = started;

      started += 1;
      await new Promise<void>((resolve) => {
        releaseSubmissions.push(resolve);
      });

      return `task_queue_full_${taskIndex}`;
    });

    const first = POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "queue-full-active",
        mode: "text",
        prompt: "active submit",
        resolution: "2k",
        size: "1:1"
      })
    );
    await vi.waitFor(() => expect(started).toBe(1));
    const second = POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "queue-full-waiting",
        mode: "text",
        prompt: "queued submit",
        resolution: "2k",
        size: "1:1"
      })
    );
    await vi.waitFor(() =>
      expect(getSubmissionLimiterStateForTests()).toMatchObject({
        activeSubmissions: 1,
        queuedSubmissions: 1
      })
    );
    const overflow = await POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "queue-full-overflow",
        mode: "text",
        prompt: "overflow submit",
        resolution: "2k",
        size: "1:1"
      })
    );
    const payload = await overflow.json();

    expect(overflow.status).toBe(429);
    expect(payload.error).toContain("提交队列已满");
    expect((await listGenerationJobs()).some((job) => job.clientRequestId === "queue-full-overflow")).toBe(false);

    releaseSubmissions.shift()?.();
    await first;
    await vi.waitFor(() => expect(started).toBe(2));
    releaseSubmissions.shift()?.();
    await second;
    delete process.env.SUBMISSION_CONCURRENCY;
    delete process.env.SUBMISSION_MAX_QUEUED;
  });

  it("reclaims stale idempotent reservations that never received a DragonCode task id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const stale = await createGenerationJob({
      clientRequestId: "stale-reservation",
      dragonTaskId: null,
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 0,
      prompt: "make a poster",
      resolution: "2k",
      size: "1:1",
      status: "pending"
    });
    vi.setSystemTime(new Date("2026-04-29T00:03:00.000Z"));
    vi.mocked(submitDragonGeneration).mockResolvedValueOnce("task_reclaimed");

    const response = await POST(
      createAuthedRequest("POST", "/api/generations", {
        clientRequestId: "stale-reservation",
        mode: "text",
        prompt: "make a poster",
        resolution: "2k",
        size: "1:1"
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.job.id).toBe(stale.id);
    expect(payload.job.dragonTaskId).toBe("task_reclaimed");
    expect(payload.job.status).toBe("submitted");
    expect(vi.mocked(submitDragonGeneration)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("polls failed tasks without auto-submitting replacement DragonCode jobs", async () => {
    const job = await createGenerationJob({
      clientRequestId: "poll-only",
      dragonTaskId: "task_original",
      errorMessage: null,
      inputImages: ["data:image/png;base64,avatar"],
      mode: "image",
      outputImages: [],
      progress: 0,
      prompt: "make a poster",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    vi.mocked(fetchDragonTask).mockResolvedValueOnce({
      dragonTaskId: "task_original",
      errorMessage:
        "tool_choice image_generation not found in tools",
      outputUrls: [],
      progress: 100,
      status: "failed"
    });
    vi.mocked(submitDragonGeneration).mockResolvedValueOnce("task_retry");

    const response = await GET_GENERATION(
      createAuthedRequest("GET", `/api/generations/${job.id}`),
      { params: Promise.resolve({ id: job.id }) }
    );
    const payload = await response.json();
    const saved = await getGenerationJob(job.id);

    expect(response.status).toBe(200);
    expect(payload.job.inputImages).toBeUndefined();
    expect(payload.job.status).toBe("failed");
    expect(vi.mocked(submitDragonGeneration)).not.toHaveBeenCalled();
    expect(saved?.dragonTaskId).toBe("task_original");
    expect(saved?.status).toBe("failed");
  });

  it("filters history on the server", async () => {
    await createGenerationJob({
      clientRequestId: "api-text",
      dragonTaskId: "task_api_text",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: ["https://example.com/text.png"],
      progress: 100,
      prompt: "quiet scene",
      resolution: "2k",
      size: "1:1",
      status: "completed"
    });
    const matching = await createGenerationJob({
      clientRequestId: "api-image",
      dragonTaskId: "task_api_image",
      errorMessage: null,
      inputImages: [],
      mode: "image",
      outputImages: ["https://example.com/poster.png"],
      progress: 100,
      prompt: "boss poster",
      resolution: "2k",
      size: "1:1",
      status: "completed"
    });

    const response = await GET(
      createAuthedRequest("GET", "/api/generations?q=poster&status=completed&mode=image&pageSize=5")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].id).toBe(matching.id);
    expect(payload.pagination.total).toBe(1);
  });

  it("returns multiple local job statuses without polling DragonCode", async () => {
    const first = await createGenerationJob({
      clientRequestId: "status-one",
      dragonTaskId: "task_status_one",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 10,
      prompt: "first",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    const second = await createGenerationJob({
      clientRequestId: "status-two",
      dragonTaskId: "task_status_two",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: ["https://example.com/two.png"],
      progress: 100,
      prompt: "second",
      resolution: "2k",
      size: "1:1",
      status: "completed"
    });

    const response = await GET_STATUS(
      createAuthedRequest("GET", `/api/generations/status?ids=${first.id},${second.id},missing`)
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.jobs.map((job: { id: string }) => job.id).sort()).toEqual([first.id, second.id].sort());
    expect(vi.mocked(fetchDragonTask)).not.toHaveBeenCalled();
  });

  it("bulk deletes selected history while keeping active jobs", async () => {
    const active = await createGenerationJob({
      clientRequestId: "delete-active",
      dragonTaskId: "task_delete_active",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 20,
      prompt: "active",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });
    const completed = await createGenerationJob({
      clientRequestId: "delete-completed",
      dragonTaskId: "task_delete_completed",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: ["https://example.com/done.png"],
      progress: 100,
      prompt: "completed",
      resolution: "2k",
      size: "1:1",
      status: "completed"
    });

    const response = await BULK_DELETE(
      createAuthedRequest("POST", "/api/generations/delete", {
        ids: [active.id, completed.id, "missing"]
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      deletedCount: 1,
      notFoundIds: ["missing"],
      skippedActive: 1
    });
    expect(await getGenerationJob(active.id)).not.toBeNull();
    expect(await getGenerationJob(completed.id)).toBeNull();
  });

  it("rejects deleting an active job so the upstream DragonCode task remains traceable", async () => {
    const active = await createGenerationJob({
      clientRequestId: "delete-active-single",
      dragonTaskId: "task_delete_active_single",
      errorMessage: null,
      inputImages: [],
      mode: "text",
      outputImages: [],
      progress: 20,
      prompt: "active single",
      resolution: "2k",
      size: "1:1",
      status: "submitted"
    });

    const response = await (
      await import("./[id]/route")
    ).DELETE(
      createAuthedRequest("DELETE", `/api/generations/${active.id}`),
      { params: Promise.resolve({ id: active.id }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("生成中的任务不能删除");
    expect(await getGenerationJob(active.id)).not.toBeNull();
  });
});
