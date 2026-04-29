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
import { POST } from "./route";
import { GET as GET_GENERATION } from "./[id]/route";

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
});

afterEach(async () => {
  resetGenerationPollingForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.DATABASE_PATH;
  delete process.env.DRAGON_API_KEY;
  delete process.env.SESSION_SECRET;
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
});
