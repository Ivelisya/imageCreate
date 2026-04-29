import type { ImageResolution, ImageSize } from "./image-options";

const DRAGON_BASE_URL = "https://dragoncode.codes/gpt-image/v1";
const DEFAULT_SUBMIT_TIMEOUT_MS = 45_000;
const DEFAULT_TASK_TIMEOUT_MS = 15_000;
const DEFAULT_SUBMIT_RETRIES = 0;
const DEFAULT_TASK_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;

export type GenerationMode = "text" | "image";

export type DragonGenerationInput = {
  prompt: string;
  resolution: ImageResolution;
  size: ImageSize;
  imageUrls: string[];
};

export type DragonGenerationPayload = {
  model: "gpt-image-2";
  prompt: string;
  n: 1;
  size: ImageSize;
  resolution: ImageResolution;
  image_urls?: string[];
};

export type DragonSubmitResponse = {
  code: number;
  data: Array<{
    status: string;
    task_id: string;
  }>;
};

export type DragonTaskStatus = "pending" | "submitted" | "completed" | "failed";

export type DragonTaskResponse = {
  code: number;
  data: {
    id: string;
    status: DragonTaskStatus | string;
    progress?: number;
    result?: {
      images?: Array<{
        url?: string[];
      }>;
    };
    error?: {
      message?: string;
    };
  };
};

export type NormalizedDragonTask = {
  dragonTaskId: string;
  status: DragonTaskStatus;
  progress: number;
  outputUrls: string[];
  errorMessage: string | null;
};

const RETRIABLE_TOOL_ROUTE_MESSAGE = "DragonCode 上游绘图通道暂时异常，已准备自动重试。";

export type DragonRequestOptions = {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

export class DragonCodeRequestError extends Error {
  readonly retriable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retriable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "DragonCodeRequestError";
    this.retriable = options.retriable ?? false;
    this.status = options.status;
  }
}

export function isRetriableDragonTaskError(message: string | null | undefined): boolean {
  if (message === RETRIABLE_TOOL_ROUTE_MESSAGE) {
    return true;
  }

  return Boolean(
    message &&
      message.includes("tool_choice") &&
      message.includes("image_generation") &&
      message.includes("not found in") &&
      message.includes("tools")
  );
}

export function normalizeDragonTaskError(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }

  if (isRetriableDragonTaskError(message)) {
    return RETRIABLE_TOOL_ROUTE_MESSAGE;
  }

  return message;
}

export function buildDragonGenerationPayload(
  input: DragonGenerationInput
): DragonGenerationPayload {
  const payload: DragonGenerationPayload = {
    model: "gpt-image-2",
    prompt: input.prompt,
    n: 1,
    size: input.size,
    resolution: input.resolution
  };

  if (input.imageUrls.length > 0) {
    payload.image_urls = input.imageUrls;
  }

  return payload;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError"
  );
}

function toDragonRequestError(
  error: unknown,
  action: string,
  timeoutMs: number
): DragonCodeRequestError {
  if (isAbortError(error)) {
    return new DragonCodeRequestError(`${action} timed out after ${timeoutMs}ms`, {
      retriable: true
    });
  }

  if (error instanceof DragonCodeRequestError) {
    return error;
  }

  return new DragonCodeRequestError(
    `${action} failed: ${error instanceof Error ? error.message : "network error"}`,
    { retriable: true }
  );
}

function assertDragonResponseCode(
  response: { code?: number },
  action: string
): void {
  if (typeof response.code === "number" && response.code !== 200) {
    throw new DragonCodeRequestError(`${action} failed with DragonCode code ${response.code}`, {
      retriable: response.code === 429 || response.code >= 500,
      status: response.code
    });
  }
}

function parseDragonEnvelope<T extends { code?: number }>(response: T, action: string): T {
  assertDragonResponseCode(response, action);

  return response;
}

async function requestDragonJson<T>(
  path: string,
  init: RequestInit,
  action: string,
  options: Required<DragonRequestOptions>
): Promise<T> {
  let lastError: DragonCodeRequestError | null = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`${DRAGON_BASE_URL}${path}`, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new DragonCodeRequestError(`${action} failed with HTTP ${response.status}`, {
          retriable: response.status === 429 || response.status >= 500,
          status: response.status
        });
      }

      return parseDragonEnvelope((await response.json()) as T & { code?: number }, action) as T;
    } catch (error) {
      lastError = toDragonRequestError(error, action, options.timeoutMs);

      if (!lastError.retriable || attempt >= options.retries) {
        throw lastError;
      }

      console.warn("[dragon-client] transient DragonCode request failure", {
        action,
        attempt: attempt + 1,
        error: lastError.message,
        nextRetryDelayMs: options.retryDelayMs,
        status: lastError.status
      });
      await delay(options.retryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new DragonCodeRequestError(`${action} failed`, { retriable: true });
}

export function parseDragonTask(response: DragonTaskResponse): NormalizedDragonTask {
  assertDragonResponseCode(response, "DragonCode task query");

  if (!response.data?.id) {
    throw new DragonCodeRequestError("DragonCode task query response did not include task id", {
      retriable: true
    });
  }

  const rawStatus = response.data.status;
  const status: DragonTaskStatus =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "submitted"
      ? rawStatus
      : "pending";
  const outputUrls =
    response.data.result?.images?.flatMap((image) => image.url ?? []).filter(Boolean) ?? [];

  return {
    dragonTaskId: response.data.id,
    status,
    progress: response.data.progress ?? (status === "completed" ? 100 : 0),
    outputUrls,
    errorMessage: normalizeDragonTaskError(response.data.error?.message)
  };
}

export async function submitDragonGeneration(
  apiKey: string,
  input: DragonGenerationInput,
  options: DragonRequestOptions = {}
): Promise<string> {
  const json = await requestDragonJson<DragonSubmitResponse>(
    "/images/generations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildDragonGenerationPayload(input))
    },
    "DragonCode submit",
    {
      retries: options.retries ?? DEFAULT_SUBMIT_RETRIES,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS
    }
  );
  const taskId = json.data?.[0]?.task_id;

  if (!taskId) {
    throw new Error("DragonCode submit response did not include task_id");
  }

  return taskId;
}

export async function fetchDragonTask(
  apiKey: string,
  dragonTaskId: string,
  options: DragonRequestOptions = {}
): Promise<NormalizedDragonTask> {
  return parseDragonTask(
    await requestDragonJson<DragonTaskResponse>(
      `/tasks/${dragonTaskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      },
      "DragonCode task query",
      {
        retries: options.retries ?? DEFAULT_TASK_RETRIES,
        retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
      }
    )
  );
}
