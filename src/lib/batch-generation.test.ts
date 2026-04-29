import { describe, expect, it } from "vitest";
import {
  BATCH_PROMPT_LIMIT,
  buildBatchPromptValidation,
  createGenerationFingerprint
} from "./batch-generation";

describe("batch generation helpers", () => {
  it("returns one trimmed prompt in single mode", () => {
    expect(buildBatchPromptValidation("  make a poster  ", false)).toEqual({
      prompts: ["make a poster"],
      error: null
    });
  });

  it("splits batch prompts by line and ignores blanks", () => {
    expect(buildBatchPromptValidation(" first image\n\n second image \r\n third image", true)).toEqual({
      prompts: ["first image", "second image", "third image"],
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
});
