import { normalizeDragonTaskError } from "./dragon-client";
import type { GenerationJob } from "./store";

export type GenerationJobResponse = Omit<GenerationJob, "inputImages">;

export function normalizeGenerationJobForResponse(job: GenerationJob): GenerationJobResponse {
  const errorMessage = normalizeDragonTaskError(job.errorMessage);

  return {
    id: job.id,
    dragonTaskId: job.dragonTaskId,
    clientRequestId: job.clientRequestId ?? null,
    mode: job.mode,
    prompt: job.prompt,
    resolution: job.resolution,
    size: job.size,
    status: job.status,
    progress: job.progress,
    outputImages: job.outputImages,
    retryCount: job.retryCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    errorMessage
  };
}
