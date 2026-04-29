import { describe, expect, it } from "vitest";
import {
  BATCH_SUBMIT_CONCURRENCY,
  BATCH_PROMPT_LIMIT,
  buildBatchPromptValidation,
  createGenerationFingerprint,
  runWithConcurrencyLimit
} from "./batch-generation";

describe("batch generation helpers", () => {
  it("returns one trimmed prompt in single mode", () => {
    expect(buildBatchPromptValidation("  make a poster  ", false)).toEqual({
      prompts: ["make a poster"],
      error: null
    });
  });

  it("uses blank lines as prompt block separators so each image can have a multi-line prompt", () => {
    expect(buildBatchPromptValidation(" first image line 1\nfirst image line 2\n\n second image ", true)).toEqual({
      prompts: ["first image line 1\nfirst image line 2", "second image"],
      error: null
    });
  });

  it("supports explicit dash separators for long batch prompts", () => {
    expect(buildBatchPromptValidation("first image\n---\nsecond image line 1\nsecond image line 2", true)).toEqual({
      prompts: ["first image", "second image line 1\nsecond image line 2"],
      error: null
    });
  });

  it("keeps line-by-line batches when there are no block separators", () => {
    expect(buildBatchPromptValidation("first image\nsecond image\nthird image", true)).toEqual({
      prompts: ["first image", "second image", "third image"],
      error: null
    });
  });

  it("can repeat each parsed prompt for multi-variant batches while respecting the max count", () => {
    expect(buildBatchPromptValidation("same prompt", true, 3)).toEqual({
      prompts: ["same prompt", "same prompt", "same prompt"],
      error: null
    });
  });

  it("rejects batches over the conservative limit", () => {
    const input = Array.from({ length: BATCH_PROMPT_LIMIT + 1 }, (_value, index) => `prompt ${index}`).join("\n");
    const result = buildBatchPromptValidation(input, true);

    expect(result.prompts).toHaveLength(0);
    expect(result.error).toBe(`批量生成一次最多支持 ${BATCH_PROMPT_LIMIT} 条提示词。`);
  });

  it("creates stable fingerprints from prompt, options, mode and file metadata", () => {
    const fingerprint = createGenerationFingerprint({
      files: [
        {
          lastModified: 100,
          name: "ref.png",
          size: 1024,
          type: "image/png"
        }
      ],
      mode: "image",
      prompt: " make a poster ",
      resolution: "2k",
      size: "1:1"
    });

    expect(fingerprint).toBe(
      "{\"files\":[{\"lastModified\":100,\"name\":\"ref.png\",\"size\":1024,\"type\":\"image/png\"}],\"mode\":\"image\",\"prompt\":\"make a poster\",\"resolution\":\"2k\",\"size\":\"1:1\"}"
    );
  });

  it("can include a batch item key so repeated prompts do not reuse the same client request id", () => {
    const first = createGenerationFingerprint({
      files: [],
      mode: "text",
      prompt: "same prompt",
      resolution: "2k",
      size: "1:1",
      variantKey: "batch-0"
    });
    const second = createGenerationFingerprint({
      files: [],
      mode: "text",
      prompt: "same prompt",
      resolution: "2k",
      size: "1:1",
      variantKey: "batch-1"
    });

    expect(first).not.toBe(second);
    expect(first).toContain("\"variantKey\":\"batch-0\"");
  });


  it("runs batch work with the default concurrency limit of three", async () => {
    let running = 0;
    let maxRunning = 0;
    const results = await runWithConcurrencyLimit(
      [1, 2, 3, 4, 5, 6],
      BATCH_SUBMIT_CONCURRENCY,
      async (item) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running -= 1;

        return item * 10;
      }
    );

    expect(maxRunning).toBe(3);
    expect(results).toEqual([
      { index: 0, status: "fulfilled", value: 10 },
      { index: 1, status: "fulfilled", value: 20 },
      { index: 2, status: "fulfilled", value: 30 },
      { index: 3, status: "fulfilled", value: 40 },
      { index: 4, status: "fulfilled", value: 50 },
      { index: 5, status: "fulfilled", value: 60 }
    ]);
  });

  it("captures individual batch failures without stopping other queued work", async () => {
    const results = await runWithConcurrencyLimit([1, 2, 3], 3, async (item) => {
      if (item === 2) {
        throw new Error("boom");
      }

      return item;
    });

    expect(results).toMatchObject([
      { index: 0, status: "fulfilled", value: 1 },
      { index: 1, status: "rejected", reason: expect.any(Error) },
      { index: 2, status: "fulfilled", value: 3 }
    ]);
  });
});
