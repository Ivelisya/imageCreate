import { describe, expect, it } from "vitest";
import { normalizeGenerationJobForResponse } from "./generation-response";
import type { GenerationJob } from "./store";

const baseJob: GenerationJob = {
  id: "job_1",
  dragonTaskId: "task_1",
  mode: "text",
  prompt: "test",
  resolution: "2k",
  size: "1:1",
  status: "failed",
  progress: 100,
  inputImages: [],
  outputImages: [],
  errorMessage: null,
  retryCount: 0,
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T00:00:00.000Z",
  completedAt: "2026-04-29T00:00:00.000Z"
};

describe("generation response helpers", () => {
  it("omits uploaded input images from jobs sent to the UI", () => {
    const job = {
      ...baseJob,
      inputImages: ["data:image/png;base64," + "a".repeat(1024)],
      outputImages: ["https://example.com/generated.png"]
    };

    expect(normalizeGenerationJobForResponse(job)).toEqual(
      expect.not.objectContaining({
        inputImages: expect.any(Array)
      })
    );
    expect(normalizeGenerationJobForResponse(job)).toMatchObject({
      outputImages: ["https://example.com/generated.png"]
    });
  });

  it("normalizes persisted DragonCode tool routing errors before sending jobs to the UI", () => {
    const job = {
      ...baseJob,
      errorMessage:
        'all channels failed. Last error: HTTP 400: {"error":{"message":"Tool choice \'image_generation\' not found in \'tools\' parameter.","type":"invalid_request_error","param":"tool_choice"}}'
    };

    expect(normalizeGenerationJobForResponse(job)).toMatchObject({
      errorMessage: "DragonCode 上游绘图通道暂时异常，已准备自动重试。"
    });
  });
});
