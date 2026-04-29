"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

const terminalStatuses = new Set(["completed", "failed"]);
const activeStatuses = new Set(["queued", "submitted", "pending", "running", "processing"]);
const HISTORY_PAGE_SIZE = 5;
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

type PendingSubmission = {
  fingerprint: string;
  clientRequestId: string;
};

function createClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createSubmissionFingerprint(input: {
  files: File[];
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

export function GenerationWorkspace() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<GenerationMode>("text");
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
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const supportedSizes = useMemo(() => supportedSizesForResolution(resolution), [resolution]);
  const historyGroups = useMemo(() => groupJobsByLocalDay(jobs), [jobs]);
  const activeImages = extractImageUrls(activeJob);
  const isActiveJobGenerating = Boolean(
    activeJob?.status && activeStatuses.has(String(activeJob.status)) && !terminalStatuses.has(String(activeJob.status))
  );
  const canSubmit =
    prompt.trim().length > 0 && !isSubmitting && isSupportedImageOption({ resolution, size });

  const loadHistoryPage = useCallback(async (page: number, options?: { selectFirst?: boolean }) => {
    setIsHistoryPageLoading(true);
    setLoadingHistoryPage(page);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(HISTORY_PAGE_SIZE)
    });

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

      setJobs(loadedJobs);
      setHistoryPagination(pagination);
      setActiveJob((currentJob) => {
        if (options?.selectFirst) {
          return loadedJobs[0] ?? null;
        }

        return loadedJobs.find((job) => job.id === currentJob?.id) ?? currentJob;
      });
    } finally {
      setIsHistoryPageLoading(false);
      setLoadingHistoryPage(null);
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
    if (!activeJob?.id || terminalStatuses.has(String(activeJob.status))) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/generations/${activeJob.id}`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { job?: GenerationJob; warning?: string };
        if (!payload.job) {
          return;
        }

        setActiveJob(payload.job);
        setMessage((currentMessage) => {
          if (payload.warning) {
            return payload.warning;
          }

          return currentMessage.startsWith("DragonCode 任务查询暂时失败") ? "" : currentMessage;
        });
        setJobs((currentJobs) => {
          const exists = currentJobs.some((job) => job.id === payload.job?.id);
          if (!exists) {
            return [payload.job as GenerationJob, ...currentJobs];
          }

          return currentJobs.map((job) => (job.id === payload.job?.id ? (payload.job as GenerationJob) : job));
        });
      } catch {
        // 下一轮轮询会继续尝试。
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeJob?.id, activeJob?.status]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (!canSubmit) {
      setMessage("请先选择支持的分辨率和画幅比例。");
      return;
    }

    if (mode === "image" && files.length === 0) {
      setMessage("图 + 文模式至少需要上传一张参考图。");
      return;
    }

    if (submitInFlightRef.current) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);

    const formData = new FormData();
    const submissionFingerprint = createSubmissionFingerprint({
      files,
      mode,
      prompt,
      resolution,
      size
    });
    const reusableSubmission = pendingSubmissionRef.current;
    const clientRequestId =
      reusableSubmission?.fingerprint === submissionFingerprint
        ? reusableSubmission.clientRequestId
        : createClientRequestId();

    pendingSubmissionRef.current = {
      fingerprint: submissionFingerprint,
      clientRequestId
    };
    formData.set("prompt", prompt.trim());
    formData.set("resolution", resolution);
    formData.set("size", size);
    formData.set("mode", mode);
    formData.set("clientRequestId", clientRequestId);
    files.forEach((file) => formData.append("images", file));

    try {
      const response = await fetch("/api/generations", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json().catch(() => ({}))) as {
        job?: GenerationJob;
        error?: string;
      };

      if (!response.ok) {
        setMessage(payload.error ?? AMBIGUOUS_SUBMISSION_MESSAGE);
        return;
      }

      if (!payload.job) {
        await loadHistoryPage(1, { selectFirst: true }).catch(() => undefined);
        setMessage(AMBIGUOUS_SUBMISSION_MESSAGE);
        return;
      }

      pendingSubmissionRef.current = null;
      setActiveJob(payload.job);
      if (response.status === 201) {
        setHistoryPagination((current) => {
          const total = current.total + 1;

          return {
            ...current,
            page: 1,
            total,
            totalPages: Math.max(1, Math.ceil(total / current.pageSize))
          };
        });
      }
      setJobs((currentJobs) =>
        [payload.job as GenerationJob, ...currentJobs.filter((job) => job.id !== payload.job?.id)].slice(
          0,
          HISTORY_PAGE_SIZE
        )
      );
    } catch {
      await loadHistoryPage(1, { selectFirst: true }).catch(() => undefined);
      setMessage(AMBIGUOUS_SUBMISSION_MESSAGE);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
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

      setJobs((currentJobs) => {
        const remainingJobs = currentJobs.filter((item) => item.id !== job.id);

        if (activeJob?.id === job.id) {
          setActiveJob(remainingJobs[0] ?? null);
        }

        return remainingJobs;
      });
      setHistoryPagination((current) => {
        const total = Math.max(0, current.total - 1);
        const totalPages = Math.max(1, Math.ceil(total / current.pageSize));

        return {
          ...current,
          total,
          totalPages,
          page: Math.min(current.page, totalPages)
        };
      });
    } catch {
      setMessage("删除请求失败，请稍后重试。");
    } finally {
      setDeletingJobId(null);
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
          <span className="user-chip">{username || "..."}</span>
          <button className="secondary-button" onClick={handleLogout} type="button">
            退出登录
          </button>
        </div>
      </header>

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
                onClick={() => setMode("text")}
                type="button"
              >
                文生图
              </button>
              <button
                aria-pressed={mode === "image"}
                className={mode === "image" ? "active" : ""}
                onClick={() => setMode("image")}
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
                <p>{mode === "image" ? "上传一张或多张参考图，最多建议 16 张。" : "切换到图 + 文模式后可上传参考图。"}</p>
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
                accept="image/*"
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

            {message ? <p className="form-error">{message}</p> : null}

            <button className="primary-button" disabled={!canSubmit} type="submit">
              {isSubmitting ? "正在提交..." : "开始生成"}
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
