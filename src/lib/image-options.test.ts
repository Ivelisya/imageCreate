import { describe, expect, it } from "vitest";
import {
  isSupportedImageOption,
  normalizeImageOptions,
  supportedSizesForResolution
} from "./image-options";

describe("image option validation", () => {
  it("allows common 2k square generation", () => {
    expect(isSupportedImageOption({ resolution: "2k", size: "1:1" })).toBe(true);
  });

  it("rejects 4k square generation because DragonCode only allows wide/tall ratios", () => {
    expect(isSupportedImageOption({ resolution: "4k", size: "1:1" })).toBe(false);
  });

  it("returns only 4k-compatible ratios for 4k", () => {
    expect(supportedSizesForResolution("4k")).toEqual([
      "16:9",
      "9:16",
      "2:1",
      "1:2",
      "21:9",
      "9:21"
    ]);
  });

  it("normalizes unknown values to safe defaults", () => {
    expect(normalizeImageOptions({ resolution: "8k", size: "cinema" })).toEqual({
      resolution: "2k",
      size: "1:1"
    });
  });
});
