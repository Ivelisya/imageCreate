import { NextResponse, type NextRequest } from "next/server";
import { submitDragonGeneration, type GenerationMode } from "@/lib/dragon-client";
import { getDragonApiKey } from "@/lib/env";
import {
  isImageResolution,
  isImageSize,
  isSupportedImageOption,
  type ImageResolution,
  type ImageSize
} from "@/lib/image-options";
import { normalizeGenerationJobForResponse } from "@/lib/generation-response";
import {
  scheduleActiveGenerationPollingRecovery,
  startGenerationPolling
} from "@/lib/generation-poller";
import { getCurrentUser } from "@/lib/server-auth";
import { withSubmissionConcurrencyLimit } from "@/lib/submission-limiter";
import {
  createGenerationJob,
  listGenerationJobsPage,
  reserveGenerationJob,
  updateGenerationJob,
  type GenerationJob,
  type GenerationJobStatusFilter
} from "@/lib/store";
import {
  fileToDataUri,
  isUploadedFile,
  validateImageUrlInputs,
  validateUploadedImageFiles
} from "@/lib/uploaded-file";

const DEFAULT_HISTORY_PAGE_SIZE = 5;
const MAX_HISTORY_PAGE_SIZE = 30;
const STALE_RESERVED_JOB_MS = 2 * 60 * 1000;
const validStatusFilters = new Set<GenerationJobStatusFilter>([
  "active",
  "completed",
  "failed",
  "pending",
  "submitted",
  "terminal"
]);

type ParsedGenerationRequest = {
  prompt: string;
  resolution: ImageResolution;
  size: ImageSize;
  mode: GenerationMode;
  imageUrls: string[];
  clientRequestId: string | null;
};

const submissionLocks = new Map<string, Promise<void>>();

function unauthorized() {
  return NextResponse.json({ error: "请先登录。" }, { status: 401 });
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeClientRequestId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

function parseStatusFilter(value: string | null): GenerationJobStatusFilter | undefined {
  return value && validStatusFilters.has(value as GenerationJobStatusFilter)
    ? (value as GenerationJobStatusFilter)
    : undefined;
}

function parseModeFilter(value: string | null): GenerationMode | undefined {
  return value === "text" || value === "image" ? value : undefined;
}

function parseSearchQuery(value: string | null): string | undefined {
  const trimmed = value?.trim().slice(0, 160) ?? "";

  return trimmed || undefined;
}

async function withSubmissionLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = submissionLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const pending = previous.catch(() => undefined).then(() => current);

  submissionLocks.set(key, pending);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (submissionLocks.get(key) === pending) {
      submissionLocks.delete(key);
    }
  }
}

function validateOptions(input: {
  prompt: unknown;
  resolution: unknown;
  size: unknown;
  mode: unknown;
  imageUrls: string[];
  clientRequestId?: unknown;
}): ParsedGenerationRequest | { error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";

  if (!prompt) {
    return { error: "请填写提示词。" };
  }

  if (!isImageResolution(input.resolution) || !isImageSize(input.size)) {
    return { error: "分辨率或画幅比例无效。" };
  }

  if (!isSupportedImageOption({ resolution: input.resolution, size: input.size })) {
    return { error: "当前分辨率不支持这个画幅比例。" };
  }

  const mode: GenerationMode =
    input.mode === "text" || input.mode === "image"
      ? input.mode
      : input.imageUrls.length > 0
        ? "image"
        : "text";

  return {
    prompt,
    resolution: input.resolution,
    size: input.size,
    mode,
    imageUrls: input.imageUrls,
    clientRequestId: normalizeClientRequestId("clientRequestId" in input ? input.clientRequestId : null)
  };
}

async function parseGenerationRequest(request: NextRequest): Promise<ParsedGenerationRequest | {
  error: string;
}> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data") || !contentType.includes("application/json")) {
    let form: FormData;

    try {
      form = await request.formData();
    } catch {
      if (contentType.includes("multipart/form-data")) {
        return { error: "请求格式不正确。" };
      }
      form = new FormData();
    }

    const files = ([...form.getAll("images"), ...form.getAll("images[]")] as unknown[]).filter(
      isUploadedFile
    );
    const fileValidationError = validateUploadedImageFiles(files);

    if (fileValidationError) {
      return { error: fileValidationError };
    }

    const imageUrls = await Promise.all(files.map(fileToDataUri));

    return validateOptions({
      prompt: form.get("prompt"),
      resolution: form.get("resolution"),
      size: form.get("size"),
      mode: form.get("mode"),
      imageUrls,
      clientRequestId: form.get("clientRequestId") ?? form.get("client_request_id")
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: "请求格式不正确。" };
  }

  const raw = body as {
    prompt?: unknown;
    resolution?: unknown;
    size?: unknown;
    mode?: unknown;
    imageUrls?: unknown;
    image_urls?: unknown;
    clientRequestId?: unknown;
    client_request_id?: unknown;
  };
  const rawImageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : raw.image_urls;
  const imageUrls = Array.isArray(rawImageUrls)
    ? rawImageUrls.filter((value): value is string => typeof value === "string")
    : [];
  const imageUrlValidationError = validateImageUrlInputs(imageUrls);

  if (imageUrlValidationError) {
    return { error: imageUrlValidationError };
  }

  return validateOptions({
    prompt: raw.prompt,
    resolution: raw.resolution,
    size: raw.size,
    mode: raw.mode,
    imageUrls,
    clientRequestId: raw.clientRequestId ?? raw.client_request_id
  });
}

class GenerationSubmissionError extends Error {
  readonly job: GenerationJob;
  readonly statusCode: number;

  constructor(message: string, job: GenerationJob, statusCode = 502) {
    super(message);
    this.name = "GenerationSubmissionError";
    this.job = job;
    this.statusCode = statusCode;
  }
}

function generationSubmissionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("timed out")) {
    return "DragonCode 响应超时，生成任务未能启动。请稍后重试。";
  }

  return error instanceof Error ? error.message : "生成任务提交失败。";
}

function isStaleReservedJobWithoutDragonTask(job: GenerationJob): boolean {
  if (job.status !== "pending" || job.dragonTaskId) {
    return false;
  }

  const createdAtMs = Date.parse(job.createdAt);

  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs > STALE_RESERVED_JOB_MS;
}

async function submitAndCreateGenerationJob(
  parsed: ParsedGenerationRequest
): Promise<GenerationJob> {
  const dragonTaskId = await withSubmissionConcurrencyLimit(() =>
    submitDragonGeneration(getDragonApiKey(), {
      prompt: parsed.prompt,
      resolution: parsed.resolution,
      size: parsed.size,
      imageUrls: parsed.imageUrls
    })
  );

  return createGenerationJob({
    clientRequestId: parsed.clientRequestId,
    dragonTaskId,
    mode: parsed.mode,
    prompt: parsed.prompt,
    resolution: parsed.resolution,
    size: parsed.size,
    status: "submitted",
    progress: 0,
    inputImages: [],
    outputImages: [],
    errorMessage: null
  });
}

async function reserveSubmitAndUpdateGenerationJob(
  parsed: ParsedGenerationRequest
): Promise<{ job: GenerationJob; created: boolean }> {
  const reserved = await reserveGenerationJob({
    clientRequestId: parsed.clientRequestId,
    dragonTaskId: null,
    mode: parsed.mode,
    prompt: parsed.prompt,
    resolution: parsed.resolution,
    size: parsed.size,
    status: "pending",
    progress: 0,
    inputImages: [],
    outputImages: [],
    errorMessage: null
  });

  if (!reserved.created) {
    if (isStaleReservedJobWithoutDragonTask(reserved.job)) {
      return {
        job: await submitAndUpdateReservedGenerationJob(reserved.job, parsed),
        created: false
      };
    }

    return reserved;
  }

  return {
    job: await submitAndUpdateReservedGenerationJob(reserved.job, parsed),
    created: true
  };
}

async function submitAndUpdateReservedGenerationJob(
  job: GenerationJob,
  parsed: ParsedGenerationRequest
): Promise<GenerationJob> {
  try {
    const dragonTaskId = await withSubmissionConcurrencyLimit(() =>
      submitDragonGeneration(getDragonApiKey(), {
        prompt: parsed.prompt,
        resolution: parsed.resolution,
        size: parsed.size,
        imageUrls: parsed.imageUrls
      })
    );
    const submitted = await updateGenerationJob(job.id, {
      dragonTaskId,
      status: "submitted",
      progress: 0,
      errorMessage: null
    });

    return submitted ?? job;
  } catch (error) {
    const message = generationSubmissionErrorMessage(error);
    const failed = await updateGenerationJob(job.id, {
      status: "failed",
      progress: 100,
      errorMessage: message
    });

    throw new GenerationSubmissionError(message, failed ?? job);
  }
}

async function createOrReuseGenerationJob(
  parsed: ParsedGenerationRequest
): Promise<{ job: GenerationJob; created: boolean }> {
  if (!parsed.clientRequestId) {
    return {
      job: await submitAndCreateGenerationJob(parsed),
      created: true
    };
  }

  return withSubmissionLock(parsed.clientRequestId, async () => {
    return reserveSubmitAndUpdateGenerationJob(parsed);
  });
}

export async function GET(request: NextRequest) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  const page = parsePositiveInteger(request.nextUrl.searchParams.get("page"), 1);
  const pageSize = Math.min(
    parsePositiveInteger(request.nextUrl.searchParams.get("pageSize"), DEFAULT_HISTORY_PAGE_SIZE),
    MAX_HISTORY_PAGE_SIZE
  );
  const status = parseStatusFilter(request.nextUrl.searchParams.get("status"));
  const mode = parseModeFilter(request.nextUrl.searchParams.get("mode"));
  const query = parseSearchQuery(request.nextUrl.searchParams.get("q"));
  const result = await listGenerationJobsPage(undefined, {
    mode,
    page,
    pageSize,
    query,
    status
  });
  const jobs = result.jobs.map(normalizeGenerationJobForResponse);
  scheduleActiveGenerationPollingRecovery();

  return NextResponse.json({
    jobs,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages
    }
  });
}

export async function POST(request: NextRequest) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  const parsed = await parseGenerationRequest(request);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const { job, created } = await createOrReuseGenerationJob(parsed);
    startGenerationPolling(job);

    return NextResponse.json(
      { job: normalizeGenerationJobForResponse(job) },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof GenerationSubmissionError) {
      return NextResponse.json(
        { error: error.message, job: normalizeGenerationJobForResponse(error.job) },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成任务提交失败。" },
      { status: 502 }
    );
  }
}
