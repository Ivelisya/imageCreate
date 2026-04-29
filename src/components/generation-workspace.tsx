"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter } from "next/navigation";
import {
  BATCH_PROMPT_LIMIT,
  buildBatchPromptValidation,
  createGenerationFingerprint
} from "@/lib/batch-generation";
import { IMAGE_INPUT_LIMITS, validateClientImageFiles } from "@/lib/client-upload-validation";
import { groupJobsByLocalDay } from "@/lib/history-groups";
import {
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  type ImageResolution,
  type ImageSize,
  isSupportedImageOption,
  supportedSizesForResolution
} from "@/lib/image-options";

type GenerationMode = "text" | "image";
type JobStatus =
  | "queued"
  | "submitted"
  | "pending"
  | "running"
  | "processing"
  | "completed"
  | "failed"
  | string;

type ImageLike = string | { url?: string; imageUrl?: string; src?: string };

type GenerationJob = {
  id: string;
  clientRequestId?: string | null;
  prompt?: string;
  mode?: GenerationMode | string;
  resolution?: ImageResolution | string;
  size?: ImageSize | string;
  status?: JobStatus;
  progress?: number;
  error?: string;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
  inputImages?: string[];
  outputImages?: string[];
  images?: ImageLike[];
  resultImages?: ImageLike[];
  resultUrls?: string[];
  output?: ImageLike[] | { images?: ImageLike[]; urls?: string[] };
};

type HistoryPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type HistoryStatusFilter = "all" | "active" | "completed" | "failed";
type HistoryModeFilter = "all" | GenerationMode;
type BulkDeleteScope = "all" | "completed" | "failed";
type HistoryFilters = {
  mode: HistoryModeFilter;
  query: string;
  status: HistoryStatusFilter;
};

const terminalStatuses = new Set(["completed", "failed"]);
const activeStatuses = new Set(["queued", "submitted", "pending", "running", "processing"]);
const HISTORY_PAGE_SIZE = 8;
const BATCH_SUBMIT_DELAY_MS = 600;
const statusText: Record<string, string> = {
  queued: "排队中",
  submitted: "已提交",
  pending: "生成中",
  running: "生成中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败"
};
const AMBIGUOUS_SUBMISSION_MESSAGE = "请求可能已提交，请先刷新历史记录确认，避免重复提交。";
const defaultHistoryFilters: HistoryFilters = {
  mode: "all",
  query: "",
  status: "all"
};

function createClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function extractImageUrls(job?: GenerationJob | null): string[] {
  if (!job) {
    return [];
  }

  const outputImages = Array.isArray(job.output) ? job.output : job.output?.images;
  const outputUrls = Array.isArray(job.output) ? undefined : job.output?.urls;
  const buckets: unknown[] = [
    job.images,
    job.resultImages,
    job.resultUrls,
    job.outputImages,
    outputImages,
    outputUrls
  ];

  return buckets
    .flatMap((bucket) => (Array.isArray(bucket) ? bucket : []))
    .map((image) => {
      if (typeof image === "string") {
        return image;
      }

      return image.url ?? image.imageUrl ?? image.src ?? "";
    })
    .filter(Boolean);
}

function formatDate(value?: string) {
  if (!value) {
    return "刚刚";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    localeMatcher: "best fit",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function statusLabel(status?: string) {
  if (!status) {
    return "生成中";
  }

  return statusText[status] ?? status.replaceAll("_", " ");
}

function modeLabel(mode?: string) {
  return mode === "image" ? "图 + 文" : "文生图";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function historyFilterKey(filters: HistoryFilters): string {
  return `${filters.query}::${filters.status}::${filters.mode}`;
}

export function GenerationWorkspace() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);
  const pendingSubmissionIdsRef = useRef(new Map<string, string>());
  const historyFiltersRef = useRef<HistoryFilters>(defaultHistoryFilters);
  const historyRequestIdRef = useRef(0);
  const hasLoadedHistoryRef = useRef(false);
  const lastLoadedFilterKeyRef = useRef("");
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<GenerationMode>("text");
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<ImageResolution>("2k");
  const [size, setSize] = useState<ImageSize>("1:1");
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [activeJob, setActiveJob] = useState<GenerationJob | null>(null);
  const [historyPagination, setHistoryPagination] = useState<HistoryPagination>({
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    total: 0,
    totalPages: 1
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isHistoryPageLoading, setIsHistoryPageLoading] = useState(false);
  const [loadingHistoryPage, setLoadingHistoryPage] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const deferredHistorySearch = useDeferredValue(historySearch);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<HistoryStatusFilter>("all");
  const [historyModeFilter, setHistoryModeFilter] = useState<HistoryModeFilter>("all");
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");

  const supportedSizes = useMemo(() => supportedSizesForResolution(resolution), [resolution]);
  const historyGroups = useMemo(() => groupJobsByLocalDay(jobs), [jobs]);
  const promptValidation = useMemo(
    () => buildBatchPromptValidation(prompt, isBatchMode),
    [isBatchMode, prompt]
  );
  const activeImages = extractImageUrls(activeJob);
  const isActiveJobGenerating = Boolean(
    activeJob?.status && activeStatuses.has(String(activeJob.status)) && !terminalStatuses.has(String(activeJob.status))
  );
  const visibleActiveJobIds = useMemo(
    () =>
      jobs
        .filter((job) => job.status && activeStatuses.has(String(job.status)) && !terminalStatuses.has(String(job.status)))
        .map((job) => job.id),
    [jobs]
  );
  const visibleActiveJobKey = visibleActiveJobIds.join(",");
  const hasActiveGeneration = Boolean(
    isActiveJobGenerating ||
      jobs.some((job) => job.status && activeStatuses.has(String(job.status)) && !terminalStatuses.has(String(job.status)))
  );
  const activeGenerationCount = visibleActiveJobIds.length + (isActiveJobGenerating && !visibleActiveJobIds.includes(activeJob?.id ?? "") ? 1 : 0);
  const fileValidationError = mode === "image" ? validateClientImageFiles(files) : null;
  const canSubmit =
    promptValidation.prompts.length > 0 &&
    !promptValidation.error &&
    !isSubmitting &&
    !fileValidationError &&
    (mode !== "image" || files.length > 0) &&
    isSupportedImageOption({ resolution, size });

  const loadHistoryPage = useCallback(async (page: number, options?: { filters?: HistoryFilters; selectFirst?: boolean }) => {
    const requestId = historyRequestIdRef.current + 1;
    const filters = options?.filters ?? historyFiltersRef.current;

    historyRequestIdRef.current = requestId;
    setIsHistoryPageLoading(true);
    setLoadingHistoryPage(page);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(HISTORY_PAGE_SIZE)
    });

    if (filters.query) {
      params.set("q", filters.query);
    }
    if (filters.status !== "all") {
      params.set("status", filters.status);
    }
    if (filters.mode !== "all") {
      params.set("mode", filters.mode);
    }

    try {
      const jobsResponse = await fetch(`/api/generations?${params.toString()}`, { cache: "no-store" });
      if (!jobsResponse.ok) {
        throw new Error("无法加载生成历史。");
      }

      const payload = (await jobsResponse.json()) as {
        jobs?: GenerationJob[];
        pagination?: HistoryPagination;
      };
      const loadedJobs = payload.jobs ?? [];
      const pagination = payload.pagination ?? {
        page,
        pageSize: HISTORY_PAGE_SIZE,
        total: loadedJobs.length,
        totalPages: 1
      };

      if (requestId !== historyRequestIdRef.current) {
        return;
      }

      setJobs(loadedJobs);
      setHistoryPagination(pagination);
      setSelectedJobIds((current) => {
        const visibleIds = new Set(loadedJobs.map((job) => job.id));
        const next = new Set([...current].filter((id) => visibleIds.has(id)));

        return next.size === current.size ? current : next;
      });
      setActiveJob((currentJob) => {
        if (options?.selectFirst) {
          return loadedJobs[0] ?? null;
        }

        return loadedJobs.find((job) => job.id === currentJob?.id) ?? currentJob;
      });
      hasLoadedHistoryRef.current = true;
      lastLoadedFilterKeyRef.current = historyFilterKey(filters);
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setIsHistoryPageLoading(false);
        setLoadingHistoryPage(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!supportedSizes.includes(size)) {
      setSize(supportedSizes[0]);
    }
  }, [size, supportedSizes]);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      try {
        const sessionResponse = await fetch("/api/auth/me", { cache: "no-store" });
        const session = (await sessionResponse.json()) as {
          authenticated?: boolean;
          username?: string;
        };

        if (!session.authenticated) {
          router.replace("/login");
          return;
        }

        if (!cancelled) {
          setUsername(session.username ?? "私人用户");
        }

        await loadHistoryPage(1, { selectFirst: true });
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "无法加载工作台。");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [loadHistoryPage, router]);

  useEffect(() => {
    const filters: HistoryFilters = {
      mode: historyModeFilter,
      query: deferredHistorySearch.trim(),
      status: historyStatusFilter
    };
    const nextFilterKey = historyFilterKey(filters);

    historyFiltersRef.current = filters;
    if (!hasLoadedHistoryRef.current || isLoading || lastLoadedFilterKeyRef.current === nextFilterKey) {
      return;
    }

    setMessage("");
    void loadHistoryPage(1, { filters, selectFirst: true }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "无法加载生成历史。");
    });
  }, [
    deferredHistorySearch,
    historyModeFilter,
    historyStatusFilter,
    isLoading,
    loadHistoryPage
  ]);

  useEffect(() => {
    if (!visibleActiveJobKey) {
      return;
    }

    const refreshVisibleActiveJobs = async () => {
      try {
        const response = await fetch(
          `/api/generations/status?ids=${encodeURIComponent(visibleActiveJobKey)}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { jobs?: GenerationJob[] };
        const refreshedJobs = payload.jobs ?? [];
        if (refreshedJobs.length === 0) {
          return;
        }

        const byId = new Map(refreshedJobs.map((job) => [job.id, job]));
        setJobs((currentJobs) => {
          return currentJobs.map((job) => byId.get(job.id) ?? job);
        });
        setActiveJob((currentJob) =>
          currentJob?.id ? byId.get(currentJob.id) ?? currentJob : currentJob
        );
      } catch {
        // 下一轮会继续尝试，避免用短暂网络抖动打扰用户。
      }
    };

    void refreshVisibleActiveJobs();
    const interval = window.setInterval(refreshVisibleActiveJobs, 3500);

    return () => window.clearInterval(interval);
  }, [visibleActiveJobKey]);

  function clearSelectedFiles() {
    setFiles([]);
    pendingSubmissionIdsRef.current.clear();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleModeChange(nextMode: GenerationMode) {
    setMode(nextMode);
    setMessage("");

    if (nextMode === "text") {
      clearSelectedFiles();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    const validationError = validateClientImageFiles(nextFiles);

    pendingSubmissionIdsRef.current.clear();

    if (validationError) {
      setFiles([]);
      event.target.value = "";
      setMessage(validationError);
      return;
    }

    setFiles(nextFiles);
    setMessage("");
  }

  function getClientRequestIdForFingerprint(fingerprint: string): string {
    const existing = pendingSubmissionIdsRef.current.get(fingerprint);

    if (existing) {
      return existing;
    }

    const clientRequestId = createClientRequestId();

    pendingSubmissionIdsRef.current.set(fingerprint, clientRequestId);

    return clientRequestId;
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (!canSubmit) {
      setMessage(promptValidation.error ?? fileValidationError ?? "请先选择支持的分辨率和画幅比例。");
      return;
    }

    if (mode === "image" && files.length === 0) {
      setMessage("图 + 文模式至少需要上传一张参考图。");
      return;
    }

    if (fileValidationError) {
      setMessage(fileValidationError);
      return;
    }

    if (submitInFlightRef.current) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setBatchProgress({ completed: 0, total: promptValidation.prompts.length });
    const filesForSubmission = mode === "image" ? files : [];
    let submittedCount = 0;
    let firstError = "";

    try {
      for (const [index, promptText] of promptValidation.prompts.entries()) {
        const formData = new FormData();
        const submissionFingerprint = createGenerationFingerprint({
          files: filesForSubmission,
          mode,
          prompt: promptText,
          resolution,
          size
        });
        const clientRequestId = getClientRequestIdForFingerprint(submissionFingerprint);

        formData.set("prompt", promptText);
        formData.set("resolution", resolution);
        formData.set("size", size);
        formData.set("mode", mode);
        formData.set("clientRequestId", clientRequestId);
        filesForSubmission.forEach((file) => formData.append("images", file));

        const response = await fetch("/api/generations", {
          method: "POST",
          body: formData
        });
        const payload = (await response.json().catch(() => ({}))) as {
          job?: GenerationJob;
          error?: string;
        };

        if (payload.job) {
          setActiveJob(payload.job);
          setJobs((currentJobs) =>
            [payload.job as GenerationJob, ...currentJobs.filter((job) => job.id !== payload.job?.id)].slice(
              0,
              HISTORY_PAGE_SIZE
            )
          );
        }

        if (!response.ok || !payload.job) {
          firstError = `第 ${index + 1} 条提交失败：${payload.error ?? AMBIGUOUS_SUBMISSION_MESSAGE}`;
          break;
        }

        pendingSubmissionIdsRef.current.delete(submissionFingerprint);
        submittedCount += 1;
        setBatchProgress({ completed: submittedCount, total: promptValidation.prompts.length });

        if (index < promptValidation.prompts.length - 1) {
          await delay(BATCH_SUBMIT_DELAY_MS);
        }
      }

      await loadHistoryPage(1, { selectFirst: true }).catch(() => undefined);
      if (firstError) {
        setMessage(
          submittedCount > 0
            ? `已提交 ${submittedCount}/${promptValidation.prompts.length} 个任务，${firstError}`
            : firstError
        );
      } else if (isBatchMode) {
        setMessage(`已提交 ${submittedCount} 个任务，结果会自动刷新。`);
      }
    } catch {
      await loadHistoryPage(1, { selectFirst: true }).catch(() => undefined);
      setMessage(AMBIGUOUS_SUBMISSION_MESSAGE);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      setBatchProgress(null);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
  }

  async function handleDeleteJob(job: GenerationJob) {
    const confirmed = window.confirm("确定要删除这条历史记录吗？这会从本地历史中移除该任务和图片链接。");

    if (!confirmed) {
      return;
    }

    setDeletingJobId(job.id);
    setMessage("");

    try {
      const response = await fetch(`/api/generations/${job.id}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        setMessage(payload.error ?? "删除失败，请稍后重试。");
        return;
      }

      const total = Math.max(0, historyPagination.total - 1);
      const totalPages = Math.max(1, Math.ceil(total / historyPagination.pageSize));
      const page = Math.min(historyPagination.page, totalPages);

      try {
        await loadHistoryPage(page, { selectFirst: true });
      } catch {
        const remainingJobs = jobs.filter((item) => item.id !== job.id);

        setJobs(remainingJobs);
        setActiveJob((currentJob) =>
          currentJob?.id === job.id ? remainingJobs[0] ?? null : currentJob
        );
        setHistoryPagination((current) => ({
          ...current,
          page,
          total,
          totalPages
        }));
        setMessage("已删除，但刷新历史失败，请稍后再试。");
      }
    } catch {
      setMessage("删除请求失败，请稍后重试。");
    } finally {
      setDeletingJobId(null);
    }
  }

  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) => {
      const next = new Set(current);

      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }

      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedJobIds((current) => {
      const visibleIds = jobs.map((job) => job.id);
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => current.has(id));
      const next = new Set(current);

      for (const id of visibleIds) {
        if (allVisibleSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }

      return next;
    });
  }

  async function handleBulkDelete(input: {
    ids?: string[];
    scope?: BulkDeleteScope;
    title: string;
  }) {
    const targetCount = input.ids?.length ?? historyPagination.total;
    const confirmed = window.confirm(
      `${input.title}？生成中的任务会自动保留。预计影响 ${targetCount} 条以内的历史记录。`
    );

    if (!confirmed) {
      return;
    }

    setIsBulkDeleting(true);
    setMessage("");

    try {
      const response = await fetch("/api/generations/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ids: input.ids,
          scope: input.scope
        })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        deletedCount?: number;
        error?: string;
        skippedActive?: number;
      };

      if (!response.ok) {
        setMessage(payload.error ?? "删除失败，请稍后重试。");
        return;
      }

      setSelectedJobIds(new Set());
      await loadHistoryPage(1, { selectFirst: true });
      setMessage(
        `已删除 ${payload.deletedCount ?? 0} 条历史${
          payload.skippedActive ? `，保留 ${payload.skippedActive} 条生成中任务` : ""
        }。`
      );
    } catch {
      setMessage("删除请求失败，请稍后重试。");
    } finally {
      setIsBulkDeleting(false);
    }
  }

  async function handleHistoryPageChange(page: number) {
    if (
      page < 1 ||
      page > historyPagination.totalPages ||
      page === historyPagination.page ||
      isHistoryPageLoading
    ) {
      return;
    }

    setMessage("");

    try {
      await loadHistoryPage(page, { selectFirst: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法加载生成历史。");
    }
  }

  return (
    <main className="studio-shell">
      <div className="nailong-scene" aria-hidden="true">
        <span className="nailong-sticker nailong-sticker-a">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src="/nailoong-logo.png" />
        </span>
        <span className="nailong-sticker nailong-sticker-b">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src="/nailoong-logo.png" />
        </span>
        <span className="nailong-sticker nailong-sticker-c">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src="/nailoong-logo.png" />
        </span>
      </div>
      <header className="studio-header">
        <div className="studio-brand">
          <span className="brand-logo" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src="/nailoong-logo.png" />
          </span>
          <div className="studio-title">
            <p className="eyebrow">奶龙志</p>
            <h1>奶龙志的妙妙画室</h1>
          </div>
        </div>
        <div className="header-actions">
          {activeGenerationCount > 0 ? <span className="status-pill status-pending">{activeGenerationCount} 个生成中</span> : null}
          <span className="user-chip">{username || "..."}</span>
          <button className="secondary-button" onClick={handleLogout} type="button">
            退出登录
          </button>
        </div>
      </header>
      <nav className="mobile-quick-nav" aria-label="工作台快捷导航">
        <a href="#composer-title">创作</a>
        <a href="#result-title">结果</a>
        <a href="#history-title">历史</a>
      </nav>

      <div className="workspace-grid">
        <section className="panel composer-panel" aria-labelledby="composer-title">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">创作输入</p>
              <h2 id="composer-title">创作参数</h2>
            </div>
            <div className="segmented-control" aria-label="生成模式">
              <button
                aria-pressed={mode === "text"}
                className={mode === "text" ? "active" : ""}
                onClick={() => handleModeChange("text")}
                type="button"
              >
                文生图
              </button>
              <button
                aria-pressed={mode === "image"}
                className={mode === "image" ? "active" : ""}
                onClick={() => handleModeChange("image")}
                type="button"
              >
                图 + 文
              </button>
            </div>
          </div>

          <form className="stack" onSubmit={handleGenerate}>
            <label>
              <span>提示词</span>
              <textarea
                name="prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述画面主体、构图、材质、光线、风格和你想要的情绪。"
                required
                rows={9}
                value={prompt}
              />
            </label>
            <div className="batch-row">
              <label className="checkbox-line">
                <input
                  checked={isBatchMode}
                  onChange={(event) => setIsBatchMode(event.target.checked)}
                  type="checkbox"
                />
                <span>批量生成</span>
              </label>
              <small>
                {isBatchMode
                  ? `一行一张，最多 ${BATCH_PROMPT_LIMIT} 条；参考图会应用到每条任务。`
                  : "开启后可一次提交多条提示词，系统会按稳妥节奏排队提交。"}
              </small>
            </div>

            <div className="control-row">
              <label>
                <span>分辨率</span>
                <select
                  name="resolution"
                  onChange={(event) => setResolution(event.target.value as ImageResolution)}
                  value={resolution}
                >
                  {IMAGE_RESOLUTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>画幅比例</span>
                <select name="size" onChange={(event) => setSize(event.target.value as ImageSize)} value={size}>
                  {IMAGE_SIZES.map((item) => (
                    <option disabled={!supportedSizes.includes(item)} key={item} value={item}>
                      {item}
                      {!supportedSizes.includes(item) ? "（4k 不支持）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={mode === "image" ? "upload-zone active" : "upload-zone"}>
              <div>
                <span>参考图</span>
                <p>
                  {mode === "image"
                    ? `上传 PNG、JPEG、WebP 或 GIF，最多 ${IMAGE_INPUT_LIMITS.maxImageCount} 张。`
                    : "切换到图 + 文模式后可上传参考图。"}
                </p>
              </div>
              <div className="upload-actions">
                <button
                  className="secondary-button"
                  disabled={mode !== "image"}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  选择图片
                </button>
                <small>{files.length > 0 ? `已选择 ${files.length} 张` : "尚未选择图片"}</small>
              </div>
              <input
                accept={IMAGE_INPUT_LIMITS.allowedMimeTypes.join(",")}
                className="visually-hidden-input"
                disabled={mode !== "image"}
                multiple
                onChange={handleFileChange}
                ref={fileInputRef}
                type="file"
              />
              {files.length > 0 ? (
                <ul className="file-list">
                  {files.map((file) => (
                    <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {resolution === "4k" ? (
              <p className="hint">4k 仅支持宽屏或竖屏比例，不兼容的比例已自动禁用。</p>
            ) : null}
            {hasActiveGeneration ? (
              <p className="hint">当前有任务生成中，新任务会受控提交并自动刷新结果。</p>
            ) : null}

            {message ? <p className="form-error">{message}</p> : null}

            <button className="primary-button" disabled={!canSubmit} type="submit">
              {isSubmitting
                ? batchProgress
                  ? `正在提交 ${batchProgress.completed}/${batchProgress.total}`
                  : "正在提交..."
                : isBatchMode
                  ? `批量生成 ${promptValidation.prompts.length || ""}`
                  : "开始生成"}
            </button>
          </form>
        </section>

        <section className="panel result-panel" aria-labelledby="result-title">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">生成结果</p>
              <h2 id="result-title">当前任务</h2>
            </div>
            {activeJob ? <span className={`status-pill status-${activeJob.status ?? "pending"}`}>{statusLabel(activeJob.status)}</span> : null}
          </div>

          {isLoading ? (
            <div className="empty-state">正在加载工作台...</div>
          ) : activeJob ? (
            <div className="result-stack">
              <div className="task-meta">
                <p>{activeJob.prompt ?? "未命名生成"}</p>
                <span>
                  {modeLabel(activeJob.mode)} / {activeJob.resolution ?? resolution} / {activeJob.size ?? size} /{" "}
                  {formatDate(activeJob.createdAt)}
                </span>
              </div>

              {isActiveJobGenerating ? (
                <div className="generation-loader" aria-live="polite">
                  <div className="loader-canvas" aria-hidden="true">
                    <span className="loader-orbit loader-orbit-one" />
                    <span className="loader-orbit loader-orbit-two" />
                    <span className="loader-core" />
                  </div>
                  <div>
                    <strong>正在生成图片</strong>
                    <p>任务已提交给 DragonCode，完成后会自动展示结果。</p>
                  </div>
                  <div className="progress-track" aria-label="生成进度">
                    <span style={{ width: `${Math.max(8, Math.min(100, activeJob.progress ?? 28))}%` }} />
                  </div>
                </div>
              ) : null}

              {activeJob.error || activeJob.errorMessage ? (
                <p className="form-error">{activeJob.errorMessage ?? activeJob.error}</p>
              ) : null}

              {activeImages.length > 0 ? (
                <div className="image-grid">
                  {activeImages.map((url) => (
                    <a href={url} key={url} rel="noreferrer" target="_blank">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img alt={activeJob.prompt ?? "生成图片"} src={url} />
                    </a>
                  ))}
                </div>
              ) : (
                <div className="preview-well">
                  {activeJob.status === "failed" ? "这次没有生成图片。" : "生成结果会显示在这里。"}
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">还没有生成记录。</div>
          )}
        </section>

        <aside className="panel history-panel" aria-labelledby="history-title">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">历史归档</p>
              <h2 id="history-title">历史记录</h2>
            </div>
            <span className="count-chip">{historyPagination.total}</span>
          </div>
          <div className="history-tools" aria-label="历史筛选与批量操作">
            <label className="history-search">
              <span>搜索</span>
              <input
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="按提示词搜索"
                type="search"
                value={historySearch}
              />
            </label>
            <div className="history-filter-row">
              <label>
                <span>状态</span>
                <select
                  onChange={(event) => setHistoryStatusFilter(event.target.value as HistoryStatusFilter)}
                  value={historyStatusFilter}
                >
                  <option value="all">全部状态</option>
                  <option value="active">生成中</option>
                  <option value="completed">已完成</option>
                  <option value="failed">失败</option>
                </select>
              </label>
              <label>
                <span>模式</span>
                <select
                  onChange={(event) => setHistoryModeFilter(event.target.value as HistoryModeFilter)}
                  value={historyModeFilter}
                >
                  <option value="all">全部模式</option>
                  <option value="text">文生图</option>
                  <option value="image">图 + 文</option>
                </select>
              </label>
            </div>
            <div className="history-bulk-actions">
              <button
                className="secondary-button"
                disabled={jobs.length === 0 || isBulkDeleting}
                onClick={toggleVisibleSelection}
                type="button"
              >
                {jobs.length > 0 && jobs.every((job) => selectedJobIds.has(job.id)) ? "取消全选" : "全选本页"}
              </button>
              <button
                className="secondary-button"
                disabled={selectedJobIds.size === 0 || isBulkDeleting}
                onClick={() =>
                  void handleBulkDelete({
                    ids: [...selectedJobIds],
                    title: `删除选中的 ${selectedJobIds.size} 条历史`
                  })
                }
                type="button"
              >
                删除选中
              </button>
              <button
                className="secondary-button"
                disabled={isBulkDeleting}
                onClick={() => void handleBulkDelete({ scope: "failed", title: "清空失败历史" })}
                type="button"
              >
                清空失败
              </button>
              <button
                className="secondary-button"
                disabled={isBulkDeleting}
                onClick={() => void handleBulkDelete({ scope: "completed", title: "清空已完成历史" })}
                type="button"
              >
                清空已完成
              </button>
              <button
                className="secondary-button danger-action"
                disabled={isBulkDeleting}
                onClick={() => void handleBulkDelete({ scope: "all", title: "一键清空非生成中历史" })}
                type="button"
              >
                一键清空
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="empty-state">正在加载历史...</div>
          ) : historyGroups.length > 0 ? (
            <>
              {isHistoryPageLoading ? (
                <p className="history-status">正在加载第 {loadingHistoryPage ?? historyPagination.page} 页...</p>
              ) : null}
              <div className="history-list">
              {historyGroups.map((group) => (
                <section className="history-day" key={group.key} aria-label={group.label}>
                  <div className="history-day-heading">
                    <span>{group.label}</span>
                    <small>{group.jobs.length} 条</small>
                  </div>
                  <div className="history-day-list">
                    {group.jobs.map((job) => {
                      const imageUrl = extractImageUrls(job)[0];

                      return (
                        <div
                          className={activeJob?.id === job.id ? "history-item selected" : "history-item"}
                          key={job.id}
                        >
                          <label className="history-select">
                            <input
                              aria-label={`选择 ${job.prompt || "未命名生成"}`}
                              checked={selectedJobIds.has(job.id)}
                              onChange={() => toggleJobSelection(job.id)}
                              type="checkbox"
                            />
                          </label>
                          <button className="history-open" onClick={() => setActiveJob(job)} type="button">
                            <span className="history-thumb">
                              {imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img alt="" decoding="async" loading="lazy" src={imageUrl} />
                              ) : (
                                statusLabel(job.status).slice(0, 2)
                              )}
                            </span>
                            <span className="history-copy">
                              <strong>{job.prompt || "未命名生成"}</strong>
                              <small>
                                {formatDate(job.createdAt)} · {statusLabel(job.status)} · {job.resolution ?? "2k"} ·{" "}
                                {job.size ?? "1:1"}
                              </small>
                            </span>
                          </button>
                          <button
                            aria-label={`删除 ${job.prompt || "未命名生成"}`}
                            className="history-delete"
                            disabled={deletingJobId === job.id}
                            onClick={() => void handleDeleteJob(job)}
                            title="删除历史记录"
                            type="button"
                          >
                            {deletingJobId === job.id ? "..." : "×"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              </div>
              {historyPagination.totalPages > 1 ? (
                <div className="history-pagination" aria-label="历史记录分页">
                  <button
                    className="secondary-button"
                    disabled={historyPagination.page <= 1 || isHistoryPageLoading}
                    onClick={() => void handleHistoryPageChange(historyPagination.page - 1)}
                    type="button"
                  >
                    上一页
                  </button>
                  <span>
                    第 {historyPagination.page} / {historyPagination.totalPages} 页
                  </span>
                  <button
                    className="secondary-button"
                    disabled={historyPagination.page >= historyPagination.totalPages || isHistoryPageLoading}
                    onClick={() => void handleHistoryPageChange(historyPagination.page + 1)}
                    type="button"
                  >
                    下一页
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">生成历史会按时间收纳在这里。</div>
          )}
        </aside>
      </div>
    </main>
  );
}
