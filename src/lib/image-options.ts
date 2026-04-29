export const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;

export const IMAGE_SIZES = [
  "auto",
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "21:9",
  "9:21"
] as const;

const FOUR_K_SIZES = ["16:9", "9:16", "2:1", "1:2", "21:9", "9:21"] as const;

export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type ImageSize = (typeof IMAGE_SIZES)[number];

export type ImageOptions = {
  resolution: ImageResolution;
  size: ImageSize;
};

export function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTIONS.includes(value as ImageResolution);
}

export function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

export function supportedSizesForResolution(resolution: ImageResolution): ImageSize[] {
  if (resolution === "4k") {
    return [...FOUR_K_SIZES];
  }

  return [...IMAGE_SIZES];
}

export function isSupportedImageOption(options: ImageOptions): boolean {
  return supportedSizesForResolution(options.resolution).includes(options.size);
}

export function normalizeImageOptions(input: {
  resolution?: unknown;
  size?: unknown;
}): ImageOptions {
  const resolution = isImageResolution(input.resolution) ? input.resolution : "2k";
  const size = isImageSize(input.size) ? input.size : "1:1";

  if (!isSupportedImageOption({ resolution, size })) {
    return { resolution, size: supportedSizesForResolution(resolution)[0] };
  }

  return { resolution, size };
}
