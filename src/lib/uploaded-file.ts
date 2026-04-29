import { Buffer } from "node:buffer";
import {
  IMAGE_INPUT_LIMITS,
  formatMegabytes,
  isAllowedImageMimeType,
  validateClientImageFiles
} from "./client-upload-validation";

export { IMAGE_INPUT_LIMITS } from "./client-upload-validation";

export type UploadedFile = {
  name?: string;
  size?: number;
  type?: string;
  arrayBuffer: () => Promise<ArrayBufferLike>;
};

export function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function estimateDataUriBytes(value: string): number {
  const commaIndex = value.indexOf(",");

  if (commaIndex === -1) {
    return value.length;
  }

  return Math.floor((value.length - commaIndex - 1) * 0.75);
}

export function validateUploadedImageFiles(files: UploadedFile[]): string | null {
  return validateClientImageFiles(files);
}

export function validateImageUrlInputs(imageUrls: string[]): string | null {
  if (imageUrls.length > IMAGE_INPUT_LIMITS.maxImageCount) {
    return `参考图最多支持 ${IMAGE_INPUT_LIMITS.maxImageCount} 张。`;
  }

  let totalBytes = 0;

  for (const imageUrl of imageUrls) {
    if (imageUrl.startsWith("data:")) {
      const mimeMatch = /^data:([^;,]+)[;,]/i.exec(imageUrl);
      const mimeType = mimeMatch?.[1]?.toLowerCase();

      if (!isAllowedImageMimeType(mimeType)) {
        return "base64 参考图仅支持 PNG、JPEG、WebP 或 GIF 格式。";
      }

      const estimatedBytes = estimateDataUriBytes(imageUrl);

      if (estimatedBytes > IMAGE_INPUT_LIMITS.maxSingleImageBytes) {
        return `单张参考图不能超过 ${formatMegabytes(IMAGE_INPUT_LIMITS.maxSingleImageBytes)}MB。`;
      }

      totalBytes += estimatedBytes;
      continue;
    }

    if (imageUrl.length > IMAGE_INPUT_LIMITS.maxUrlLength) {
      return "参考图 URL 过长，请换成更短的图片链接。";
    }

    try {
      const parsed = new URL(imageUrl);

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "参考图 URL 仅支持 http 或 https。";
      }
    } catch {
      return "参考图 URL 格式不正确。";
    }
  }

  if (totalBytes > IMAGE_INPUT_LIMITS.maxTotalImageBytes) {
    return `参考图总大小不能超过 ${formatMegabytes(IMAGE_INPUT_LIMITS.maxTotalImageBytes)}MB。`;
  }

  return null;
}

export async function fileToDataUri(file: UploadedFile): Promise<string> {
  const contentType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());

  if (bytes.length > IMAGE_INPUT_LIMITS.maxSingleImageBytes) {
    throw new Error(`单张参考图不能超过 ${formatMegabytes(IMAGE_INPUT_LIMITS.maxSingleImageBytes)}MB。`);
  }

  return `data:${contentType};base64,${bytes.toString("base64")}`;
}
