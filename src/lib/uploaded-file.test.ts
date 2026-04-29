import { describe, expect, it } from "vitest";
import { fileToDataUri, isUploadedFile, validateUploadedImageFiles } from "./uploaded-file";

describe("uploaded file helpers", () => {
  it("recognizes multipart file values without relying on a global File constructor", async () => {
    const originalFile = globalThis.File;
    Reflect.deleteProperty(globalThis, "File");

    try {
      const value = {
        type: "text/plain",
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer
      };

      expect(isUploadedFile(value)).toBe(true);
      expect(isUploadedFile("not-a-file")).toBe(false);
      await expect(fileToDataUri(value)).resolves.toBe("data:text/plain;base64,aGVsbG8=");
    } finally {
      Object.defineProperty(globalThis, "File", {
        configurable: true,
        value: originalFile,
        writable: true
      });
    }
  });

  it("rejects multipart image batches above DragonCode's sixteen image limit", () => {
    const files = Array.from({ length: 17 }, (_value, index) => ({
      name: `ref-${index}.png`,
      size: 1,
      type: "image/png",
      arrayBuffer: async () => new Uint8Array([index]).buffer
    }));

    expect(validateUploadedImageFiles(files)).toBe("参考图最多支持 16 张。");
  });
});
