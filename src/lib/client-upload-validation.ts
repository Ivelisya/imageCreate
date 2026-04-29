export const IMAGE_INPUT_LIMITS = {
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  maxImageCount: 16,
  maxSingleImageBytes: 10 * 1024 * 1024,
  maxTotalImageBytes: 40 * 1024 * 1024,
  maxUrlLength: 4096
} as const;

const allowedMimeTypes = new Set<string>(IMAGE_INPUT_LIMITS.allowedMimeTypes);

export type ClientUploadFile = {
  size?: number;
  type?: string;
};

export function formatMegabytes(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}

export function isAllowedImageMimeType(type: string | undefined): boolean {
  return typeof type === "string" && allowedMimeTypes.has(type.toLowerCase());
}

export function validateClientImageFiles(files: ClientUploadFile[]): string | null {
  if (files.length > IMAGE_INPUT_LIMITS.maxImageCount) {
    return `参考图最多支持 ${IMAGE_INPUT_LIMITS.maxImageCount} 张。`;
  }

  let totalBytes = 0;

  for (const file of files) {
    if (!isAllowedImageMimeType(file.type)) {
      return "参考图仅支持 PNG、JPEG、WebP 或 GIF 格式。";
    }

    if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) {
      return "无法读取参考图大小，请重新选择图片。";
    }

    if (file.size > IMAGE_INPUT_LIMITS.maxSingleImageBytes) {
      return `单张参考图不能超过 ${formatMegabytes(IMAGE_INPUT_LIMITS.maxSingleImageBytes)}MB。`;
    }

    totalBytes += file.size;
  }

  if (totalBytes > IMAGE_INPUT_LIMITS.maxTotalImageBytes) {
    return `参考图总大小不能超过 ${formatMegabytes(IMAGE_INPUT_LIMITS.maxTotalImageBytes)}MB。`;
  }

  return null;
}
