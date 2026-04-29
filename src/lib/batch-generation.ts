import type { GenerationMode } from "./dragon-client";
import type { ImageResolution, ImageSize } from "./image-options";

export const BATCH_PROMPT_LIMIT = 12;

export type BatchPromptValidation = {
  prompts: string[];
  error: string | null;
};

export type FingerprintFile = {
  lastModified: number;
  name: string;
  size: number;
  type: string;
};

export function buildBatchPromptValidation(
  value: string,
  isBatchMode: boolean
): BatchPromptValidation {
  const prompts = isBatchMode
    ? value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [value.trim()].filter(Boolean);

  if (prompts.length === 0) {
    return { prompts: [], error: "请填写提示词。" };
  }

  if (isBatchMode && prompts.length > BATCH_PROMPT_LIMIT) {
    return {
      prompts: [],
      error: `批量生成一次最多支持 ${BATCH_PROMPT_LIMIT} 条提示词。`
    };
  }

  return { prompts, error: null };
}

export function createGenerationFingerprint(input: {
  files: FingerprintFile[];
  mode: GenerationMode;
  prompt: string;
  resolution: ImageResolution;
  size: ImageSize;
}): string {
  return JSON.stringify({
    files: input.files.map((file) => ({
      lastModified: file.lastModified,
      name: file.name,
      size: file.size,
      type: file.type
    })),
    mode: input.mode,
    prompt: input.prompt.trim(),
    resolution: input.resolution,
    size: input.size
  });
}
