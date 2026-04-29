import { describe, expect, it } from "vitest";
import { IMAGE_INPUT_LIMITS, validateClientImageFiles } from "./client-upload-validation";

function makeFile(input: { name?: string; size?: number; type?: string } = {}): File {
  return {
    lastModified: 0,
    name: input.name ?? "ref.png",
    size: input.size ?? 1,
    type: input.type ?? "image/png"
  } as File;
}

describe("client upload validation", () => {
  it("rejects image batches above DragonCode's sixteen image limit before submitting", () => {
    const files = Array.from({ length: IMAGE_INPUT_LIMITS.maxImageCount + 1 }, (_value, index) =>
      makeFile({ name: `ref-${index}.png` })
    );

    expect(validateClientImageFiles(files)).toBe("参考图最多支持 16 张。");
  });

  it("rejects unsupported image MIME types before submitting", () => {
    expect(validateClientImageFiles([makeFile({ name: "ref.bmp", type: "image/bmp" })])).toBe(
      "参考图仅支持 PNG、JPEG、WebP 或 GIF 格式。"
    );
  });

  it("rejects oversized image batches before submitting", () => {
    const files = [
      makeFile({ size: IMAGE_INPUT_LIMITS.maxSingleImageBytes }),
      makeFile({ size: IMAGE_INPUT_LIMITS.maxSingleImageBytes }),
      makeFile({ size: IMAGE_INPUT_LIMITS.maxSingleImageBytes }),
      makeFile({ size: IMAGE_INPUT_LIMITS.maxSingleImageBytes + 1 })
    ];

    expect(validateClientImageFiles(files)).toBe("单张参考图不能超过 10MB。");
  });
});
