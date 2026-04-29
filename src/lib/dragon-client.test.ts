import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDragonGenerationPayload,
  fetchDragonTask,
  isRetriableDragonTaskError,
  parseDragonTask,
  submitDragonGeneration,
  type DragonTaskResponse
} from "./dragon-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DragonCode client helpers", () => {
  it("builds a text-to-image payload without reference images", () => {
    expect(
      buildDragonGenerationPayload({
        prompt: "a quiet desk with a brass lamp",
        resolution: "2k",
        size: "1:1",
        imageUrls: []
      })
    ).toEqual({
      model: "gpt-image-2",
      prompt: "a quiet desk with a brass lamp",
      n: 1,
      size: "1:1",
      resolution: "2k"
    });
  });

  it("includes image_urls for image-to-image payloads", () => {
    expect(
      buildDragonGenerationPayload({
        prompt: "turn this into watercolor",
        resolution: "1k",
        size: "3:2",
        imageUrls: ["data:image/png;base64,abc"]
      })
    ).toMatchObject({
      image_urls: ["data:image/png;base64,abc"]
    });
  });

  it("normalizes completed task image URLs", () => {
    const response: DragonTaskResponse = {
      code: 200,
      data: {
        id: "task_123",
        status: "completed",
        progress: 100,
        result: {
          images: [{ url: ["https://dragoncode.codes/gpt-image/media/task_123/0?token=x"] }]
        }
      }
    };

    expect(parseDragonTask(response)).toEqual({
      dragonTaskId: "task_123",
      status: "completed",
      progress: 100,
      outputUrls: ["https://dragoncode.codes/gpt-image/media/task_123/0?token=x"],
      errorMessage: null
    });
  });

  it("normalizes failed task errors", () => {
    const response: DragonTaskResponse = {
      code: 200,
      data: {
        id: "task_124",
        status: "failed",
        progress: 20,
        error: { message: "审核未通过" }
      }
    };

    expect(parseDragonTask(response)).toEqual({
      dragonTaskId: "task_124",
      status: "failed",
      progress: 20,
      outputUrls: [],
      errorMessage: "审核未通过"
    });
  });

  it("marks DragonCode upstream tool routing failures as retriable and user-friendly", () => {
    const response: DragonTaskResponse = {
      code: 200,
      data: {
        id: "task_tool_route",
        status: "failed",
        progress: 10,
        error: {
          message:
            'all channels failed. Last error: HTTP 400: {"error":{"message":"Tool choice \'image_generation\' not found in \'tools\' parameter.","type":"invalid_request_error","param":"tool_choice"}}'
        }
      }
    };

    const parsed = parseDragonTask(response);

    expect(isRetriableDragonTaskError(parsed.errorMessage)).toBe(true);
    expect(parsed.errorMessage).toBe("DragonCode 上游绘图通道暂时异常，已准备自动重试。");
  });

  it("throws when task polling returns a non-JSON upstream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }))
    );

    await expect(fetchDragonTask("sk-test", "task_bad", { retries: 0 })).rejects.toThrow(
      "DragonCode task query failed with HTTP 502"
    );
  });

  it("throws when DragonCode task polling returns a business error envelope", () => {
    expect(() =>
      parseDragonTask({
        code: 500,
        data: {
          id: "task_business_error",
          status: "pending"
        }
      })
    ).toThrow("DragonCode task query failed with DragonCode code 500");
  });

  it("aborts DragonCode task polling when the request exceeds its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          })
      )
    );

    const pending = expect(
      fetchDragonTask("sk-test", "task_slow", {
        retries: 0,
        timeoutMs: 25
      })
    ).rejects.toThrow("DragonCode task query timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);

    await pending;
    vi.useRealTimers();
  });

  it("retries transient DragonCode submit failures once before returning the task id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("network reset"))
        .mockResolvedValueOnce(
          Response.json({
            code: 200,
            data: [{ status: "submitted", task_id: "task_retry_ok" }]
          })
        )
    );

    await expect(
      submitDragonGeneration(
        "sk-test",
        {
          imageUrls: [],
          prompt: "retry submit",
          resolution: "2k",
          size: "1:1"
        },
        { retryDelayMs: 0, retries: 1, timeoutMs: 1000 }
      )
    ).resolves.toBe("task_retry_ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "[dragon-client] transient DragonCode request failure",
      expect.objectContaining({ action: "DragonCode submit", attempt: 1 })
    );
  });

  it("retries retriable DragonCode business-code submit failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            code: 500,
            data: []
          })
        )
        .mockResolvedValueOnce(
          Response.json({
            code: 200,
            data: [{ status: "submitted", task_id: "task_business_retry_ok" }]
          })
        )
    );

    await expect(
      submitDragonGeneration(
        "sk-test",
        {
          imageUrls: [],
          prompt: "retry business code",
          resolution: "2k",
          size: "1:1"
        },
        { retryDelayMs: 0, retries: 1, timeoutMs: 1000 }
      )
    ).resolves.toBe("task_business_retry_ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "[dragon-client] transient DragonCode request failure",
      expect.objectContaining({
        action: "DragonCode submit",
        error: "DragonCode submit failed with DragonCode code 500"
      })
    );
  });
});
