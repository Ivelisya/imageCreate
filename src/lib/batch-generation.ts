import type { GenerationMode } from "./dragon-client";
import type { ImageResolution, ImageSize } from "./image-options";

export const BATCH_PROMPT_LIMIT = 12;
export const BATCH_SUBMIT_CONCURRENCY = 3;

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
  isBatchMode: boolean,
  copiesPerPrompt = 1
): BatchPromptValidation {
  const parsedPrompts = isBatchMode ? parseBatchPromptBlocks(value) : [normalizePromptBlock(value)].filter(Boolean);
  const copies = normalizeCopies(copiesPerPrompt);
  const prompts = parsedPrompts.flatMap((prompt) =>
    Array.from({ length: isBatchMode ? copies : 1 }, () => prompt)
  );

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

function normalizeCopies(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function normalizePromptBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isExplicitPromptSeparator(line: string): boolean {
  return /^-{3,}$/.test(line.trim());
}

export function parseBatchPromptBlocks(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").trim();

  if (!normalized) {
    return [];
  }

  const hasBlockSeparators = /\n\s*\n/.test(normalized) || /^-{3,}\s*$/m.test(normalized);

  if (!hasBlockSeparators) {
    return normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const blocks: string[] = [];
  let currentLines: string[] = [];

  function pushCurrentBlock() {
    const block = normalizePromptBlock(currentLines.join("\n"));

    if (block) {
      blocks.push(block);
    }

    currentLines = [];
  }

  for (const line of normalized.split("\n")) {
    if (!line.trim() || isExplicitPromptSeparator(line)) {
      pushCurrentBlock();
      continue;
    }

    currentLines.push(line);
  }

  pushCurrentBlock();

  return blocks;
}

export type LimitedConcurrencyResult<T> =
  | {
      index: number;
      status: "fulfilled";
      value: T;
    }
  | {
      index: number;
      reason: unknown;
      status: "rejected";
    };

export async function runWithConcurrencyLimit<Input, Output>(
  items: Input[],
  limit: number,
  worker: (item: Input, index: number) => Promise<Output>
): Promise<Array<LimitedConcurrencyResult<Output>>> {
  const normalizedLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const workerCount = Math.min(normalizedLimit, items.length);
  const results = new Array<LimitedConcurrencyResult<Output>>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;

        nextIndex += 1;

        try {
          results[index] = {
            index,
            status: "fulfilled",
            value: await worker(items[index], index)
          };
        } catch (reason) {
          results[index] = {
            index,
            reason,
            status: "rejected"
          };
        }
      }
    })
  );

  return results;
}

export function createGenerationFingerprint(input: {
  files: FingerprintFile[];
  mode: GenerationMode;
  prompt: string;
  resolution: ImageResolution;
  size: ImageSize;
  variantKey?: string;
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
    size: input.size,
    ...(input.variantKey ? { variantKey: input.variantKey } : {})
  });
}
