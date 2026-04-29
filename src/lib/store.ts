import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool, type QueryResultRow } from "pg";
import type { GenerationMode } from "./dragon-client";
import type { ImageResolution, ImageSize } from "./image-options";

export type GenerationStatus = "pending" | "submitted" | "completed" | "failed";

export type GenerationJob = {
  id: string;
  dragonTaskId: string | null;
  clientRequestId?: string | null;
  mode: GenerationMode;
  prompt: string;
  resolution: ImageResolution;
  size: ImageSize;
  status: GenerationStatus;
  progress: number;
  inputImages: string[];
  outputImages: string[];
  errorMessage: string | null;
  retryCount?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type NewGenerationJob = Omit<GenerationJob, "id" | "createdAt" | "updatedAt" | "completedAt">;
export type ReservedGenerationJob = {
  job: GenerationJob;
  created: boolean;
};

export type GenerationJobsPage = {
  jobs: GenerationJob[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type GenerationJobStatusFilter = GenerationStatus | "active" | "terminal";

export type GenerationJobListOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: GenerationJobStatusFilter;
  mode?: GenerationMode;
};

export type DeleteGenerationJobsScope = "completed" | "failed" | "all";

export type DeleteGenerationJobsOptions = {
  ids?: string[];
  scope?: DeleteGenerationJobsScope;
  includeActive?: boolean;
};

export type DeleteGenerationJobsResult = {
  deletedCount: number;
  skippedActive: number;
  notFoundIds: string[];
};

export type OwnerAccount = {
  username: string;
  passwordHash: string;
  createdAt: string;
};

export type NewOwnerAccount = Omit<OwnerAccount, "createdAt">;

type StoreData = {
  jobs: GenerationJob[];
  ownerAccount: OwnerAccount | null;
};

const EMPTY_STORE: StoreData = {
  jobs: [],
  ownerAccount: null
};

const storeWriteLocks = new Map<string, Promise<void>>();
const postgresSchemaLocks = new Map<string, Promise<void>>();
let postgresPool: Pool | null = null;
let postgresPoolConnectionString: string | null = null;

export function getDatabasePath(): string {
  return resolve(process.env.DATABASE_PATH || "./data/private-image-studio.json");
}

function resolveDatabasePath(databasePath?: string): string {
  return databasePath ? resolve(databasePath) : getDatabasePath();
}

function getDatabaseUrl(): string | null {
  return process.env.DATABASE_URL || null;
}

function shouldUsePostgres(databasePath?: string): boolean {
  return !databasePath && Boolean(getDatabaseUrl());
}

async function withStoreWriteLock<T>(
  databasePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = storeWriteLocks.get(databasePath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const pending = previous.catch(() => undefined).then(() => current);

  storeWriteLocks.set(databasePath, pending);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (storeWriteLocks.get(databasePath) === pending) {
      storeWriteLocks.delete(databasePath);
    }
  }
}

async function readStore(databasePath = getDatabasePath()): Promise<StoreData> {
  try {
    const raw = await readFile(databasePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreData>;

    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      ownerAccount:
        parsed.ownerAccount &&
        typeof parsed.ownerAccount === "object" &&
        typeof parsed.ownerAccount.username === "string" &&
        typeof parsed.ownerAccount.passwordHash === "string" &&
        typeof parsed.ownerAccount.createdAt === "string"
          ? parsed.ownerAccount
          : null
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ...EMPTY_STORE, jobs: [] };
    }

    throw error;
  }
}

async function writeStore(data: StoreData, databasePath = getDatabasePath()): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true });

  const tempPath = `${databasePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, databasePath);
}

function sortNewestFirst(jobs: GenerationJob[]): GenerationJob[] {
  return [...jobs].sort((left, right) => {
    const createdAtOrder = right.createdAt.localeCompare(left.createdAt);

    return createdAtOrder === 0 ? right.id.localeCompare(left.id) : createdAtOrder;
  });
}

function normalizeSearchQuery(value: string | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function isActiveGenerationStatus(status: GenerationStatus): boolean {
  return status === "pending" || status === "submitted";
}

function matchesStatusFilter(job: GenerationJob, status?: GenerationJobStatusFilter): boolean {
  if (!status) {
    return true;
  }

  if (status === "active") {
    return isActiveGenerationStatus(job.status);
  }

  if (status === "terminal") {
    return job.status === "completed" || job.status === "failed";
  }

  return job.status === status;
}

function matchesGenerationJobFilters(
  job: GenerationJob,
  filters: Pick<GenerationJobListOptions, "mode" | "query" | "status">
): boolean {
  const query = normalizeSearchQuery(filters.query).toLowerCase();

  return (
    (!query || job.prompt.toLowerCase().includes(query)) &&
    (!filters.mode || job.mode === filters.mode) &&
    matchesStatusFilter(job, filters.status)
  );
}

function filterGenerationJobs(
  jobs: GenerationJob[],
  filters: Pick<GenerationJobListOptions, "mode" | "query" | "status">
): GenerationJob[] {
  return jobs.filter((job) => matchesGenerationJobFilters(job, filters));
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => typeof id === "string" && id.length > 0))];
}

function shouldDeleteJobByScope(job: GenerationJob, scope: DeleteGenerationJobsScope): boolean {
  if (scope === "all") {
    return true;
  }

  return job.status === scope;
}

function buildDeleteResult(input: {
  deletedCount: number;
  notFoundIds?: string[];
  skippedActive?: number;
}): DeleteGenerationJobsResult {
  return {
    deletedCount: input.deletedCount,
    notFoundIds: input.notFoundIds ?? [],
    skippedActive: input.skippedActive ?? 0
  };
}

function getPostgresPool(): Pool {
  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    throw new Error("Missing DATABASE_URL for PostgreSQL store");
  }

  if (!postgresPool || postgresPoolConnectionString !== connectionString) {
    void postgresPool?.end();
    postgresPool = new Pool({ connectionString });
    postgresPoolConnectionString = connectionString;
  }

  return postgresPool;
}

async function postgresTableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

async function postgresColumnExists(
  pool: Pool,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

async function addPostgresColumnIfMissing(
  pool: Pool,
  tableName: string,
  columnName: string,
  definition: string
): Promise<void> {
  if (await postgresColumnExists(pool, tableName, columnName)) {
    return;
  }

  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensurePostgresSchema(): Promise<void> {
  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    return;
  }

  const existing = postgresSchemaLocks.get(connectionString);

  if (existing) {
    return existing;
  }

  const pending = (async () => {
    const pool = getPostgresPool();

    if (!(await postgresTableExists(pool, "generation_jobs"))) {
      await pool.query(`
        CREATE TABLE generation_jobs (
          id text PRIMARY KEY,
          dragon_task_id text,
          client_request_id text UNIQUE,
          mode text NOT NULL,
          prompt text NOT NULL,
          resolution text NOT NULL,
          size text NOT NULL,
          status text NOT NULL,
          progress integer NOT NULL,
          input_images jsonb NOT NULL DEFAULT '[]'::jsonb,
          output_images jsonb NOT NULL DEFAULT '[]'::jsonb,
          error_message text,
          retry_count integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          completed_at timestamptz
        )
      `);
    }
    await addPostgresColumnIfMissing(pool, "generation_jobs", "dragon_task_id", "text");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "client_request_id", "text");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "mode", "text NOT NULL DEFAULT 'text'");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "prompt", "text NOT NULL DEFAULT ''");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "resolution", "text NOT NULL DEFAULT '2k'");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "size", "text NOT NULL DEFAULT '1:1'");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "status", "text NOT NULL DEFAULT 'submitted'");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "progress", "integer NOT NULL DEFAULT 0");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "input_images", "jsonb NOT NULL DEFAULT '[]'::jsonb");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "output_images", "jsonb NOT NULL DEFAULT '[]'::jsonb");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "error_message", "text");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "retry_count", "integer NOT NULL DEFAULT 0");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "created_at", "timestamptz NOT NULL DEFAULT now()");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "updated_at", "timestamptz NOT NULL DEFAULT now()");
    await addPostgresColumnIfMissing(pool, "generation_jobs", "completed_at", "timestamptz");
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_client_request_id_key
      ON generation_jobs (client_request_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS generation_jobs_created_at_idx
      ON generation_jobs (created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS generation_jobs_created_at_id_idx
      ON generation_jobs (created_at DESC, id DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS generation_jobs_active_idx
      ON generation_jobs (status, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS generation_jobs_status_mode_created_at_idx
      ON generation_jobs (status, mode, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS generation_jobs_dragon_task_id_idx
      ON generation_jobs (dragon_task_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS owner_account (
        singleton_key integer PRIMARY KEY DEFAULT 1 CHECK (singleton_key = 1),
        username text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
  })();

  postgresSchemaLocks.set(connectionString, pending);

  try {
    await pending;
  } catch (error) {
    postgresSchemaLocks.delete(connectionString);
    throw error;
  }
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function rowToGenerationJob(row: QueryResultRow): GenerationJob {
  return {
    id: String(row.id),
    dragonTaskId: typeof row.dragon_task_id === "string" ? row.dragon_task_id : null,
    clientRequestId: typeof row.client_request_id === "string" ? row.client_request_id : null,
    mode: row.mode as GenerationMode,
    prompt: String(row.prompt),
    resolution: row.resolution as ImageResolution,
    size: row.size as ImageSize,
    status: row.status as GenerationStatus,
    progress: Number(row.progress),
    inputImages: parseJsonArray(row.input_images),
    outputImages: parseJsonArray(row.output_images),
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
    retryCount: Number(row.retry_count ?? 0),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : null
  };
}

function rowToOwnerAccount(row: QueryResultRow): OwnerAccount {
  return {
    username: String(row.username),
    passwordHash: String(row.password_hash),
    createdAt: toIsoString(row.created_at)
  };
}

function buildGenerationJob(input: NewGenerationJob): GenerationJob {
  const now = new Date().toISOString();

  return {
    ...input,
    clientRequestId: input.clientRequestId ?? null,
    retryCount: input.retryCount ?? 0,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === "completed" || input.status === "failed" ? now : null
  };
}

function isTerminalGenerationStatus(status: GenerationStatus): boolean {
  return status === "completed" || status === "failed";
}

async function insertPostgresGenerationJob(
  job: GenerationJob,
  conflictClause = ""
): Promise<GenerationJob | null> {
  const result = await getPostgresPool().query(
    `
      INSERT INTO generation_jobs (
        id,
        dragon_task_id,
        client_request_id,
        mode,
        prompt,
        resolution,
        size,
        status,
        progress,
        input_images,
        output_images,
        error_message,
        retry_count,
        created_at,
        updated_at,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)
      ${conflictClause}
      RETURNING *
    `,
    [
      job.id,
      job.dragonTaskId,
      job.clientRequestId,
      job.mode,
      job.prompt,
      job.resolution,
      job.size,
      job.status,
      job.progress,
      JSON.stringify(job.inputImages),
      JSON.stringify(job.outputImages),
      job.errorMessage,
      job.retryCount,
      job.createdAt,
      job.updatedAt,
      job.completedAt
    ]
  );

  return result.rows[0] ? rowToGenerationJob(result.rows[0]) : null;
}

async function listPostgresGenerationJobs(): Promise<GenerationJob[]> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query(
    "SELECT * FROM generation_jobs ORDER BY created_at DESC"
  );

  return result.rows.map(rowToGenerationJob);
}

async function listPostgresGenerationJobsPage(options: {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: GenerationJobStatusFilter;
  mode?: GenerationMode;
} = {}): Promise<GenerationJobsPage> {
  await ensurePostgresSchema();
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 10));
  const clauses: string[] = [];
  const params: unknown[] = [];
  const query = normalizeSearchQuery(options.query);

  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    clauses.push(`LOWER(prompt) LIKE $${params.length}`);
  }

  if (options.status === "active") {
    clauses.push("status IN ('pending', 'submitted')");
  } else if (options.status === "terminal") {
    clauses.push("status IN ('completed', 'failed')");
  } else if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }

  if (options.mode) {
    params.push(options.mode);
    clauses.push(`mode = $${params.length}`);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const countResult = await getPostgresPool().query(
    `SELECT COUNT(*) AS total FROM generation_jobs ${whereSql}`,
    params
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), totalPages);
  const offset = (page - 1) * pageSize;
  const result = await getPostgresPool().query(
    `
      SELECT *
      FROM generation_jobs
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, pageSize, offset]
  );

  return {
    jobs: result.rows.map(rowToGenerationJob),
    page,
    pageSize,
    total,
    totalPages
  };
}

async function listPostgresActiveGenerationJobs(): Promise<GenerationJob[]> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query(
    `
      SELECT *
      FROM generation_jobs
      WHERE dragon_task_id IS NOT NULL AND status IN ('pending', 'submitted')
      ORDER BY created_at DESC
    `
  );

  return result.rows.map(rowToGenerationJob);
}

async function getPostgresGenerationJob(id: string): Promise<GenerationJob | null> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query(
    "SELECT * FROM generation_jobs WHERE id = $1 LIMIT 1",
    [id]
  );

  return result.rows[0] ? rowToGenerationJob(result.rows[0]) : null;
}

async function getPostgresGenerationJobByClientRequestId(
  clientRequestId: string
): Promise<GenerationJob | null> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query(
    "SELECT * FROM generation_jobs WHERE client_request_id = $1 LIMIT 1",
    [clientRequestId]
  );

  return result.rows[0] ? rowToGenerationJob(result.rows[0]) : null;
}

async function listPostgresGenerationJobsByIds(ids: string[]): Promise<GenerationJob[]> {
  await ensurePostgresSchema();
  const normalizedIds = uniqueIds(ids);

  if (normalizedIds.length === 0) {
    return [];
  }

  const placeholders = normalizedIds.map((_id, index) => `$${index + 1}`).join(", ");
  const result = await getPostgresPool().query(
    `
      SELECT *
      FROM generation_jobs
      WHERE id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
    `,
    normalizedIds
  );

  return result.rows.map(rowToGenerationJob);
}

async function deletePostgresGenerationJobs(
  options: DeleteGenerationJobsOptions
): Promise<DeleteGenerationJobsResult> {
  await ensurePostgresSchema();
  const ids = uniqueIds(options.ids);

  if (ids.length > 0) {
    const existing = await listPostgresGenerationJobsByIds(ids);
    const existingIds = new Set(existing.map((job) => job.id));
    const notFoundIds = ids.filter((id) => !existingIds.has(id));
    const deletable = existing.filter(
      (job) => options.includeActive || !isActiveGenerationStatus(job.status)
    );
    const skippedActive = existing.length - deletable.length;

    if (deletable.length > 0) {
      const placeholders = deletable.map((_job, index) => `$${index + 1}`).join(", ");

      await getPostgresPool().query(
        `DELETE FROM generation_jobs WHERE id IN (${placeholders})`,
        deletable.map((job) => job.id)
      );
    }

    return buildDeleteResult({
      deletedCount: deletable.length,
      notFoundIds,
      skippedActive
    });
  }

  if (!options.scope) {
    return buildDeleteResult({ deletedCount: 0 });
  }

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.scope !== "all") {
    params.push(options.scope);
    clauses.push(`status = $${params.length}`);
  }

  if (!options.includeActive) {
    clauses.push("status NOT IN ('pending', 'submitted')");
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  let skippedActive = 0;

  if (options.scope === "all" && !options.includeActive) {
    const skippedResult = await getPostgresPool().query(
      "SELECT COUNT(*) AS total FROM generation_jobs WHERE status IN ('pending', 'submitted')"
    );

    skippedActive = Number(skippedResult.rows[0]?.total ?? 0);
  }

  const result = await getPostgresPool().query(
    `DELETE FROM generation_jobs ${whereSql}`,
    params
  );

  return buildDeleteResult({
    deletedCount: result.rowCount ?? 0,
    skippedActive
  });
}

async function createPostgresGenerationJob(input: NewGenerationJob): Promise<GenerationJob> {
  await ensurePostgresSchema();
  const inserted = await insertPostgresGenerationJob(buildGenerationJob(input));

  if (!inserted) {
    throw new Error("Generation job was not created");
  }

  return inserted;
}

async function reservePostgresGenerationJob(
  input: NewGenerationJob
): Promise<ReservedGenerationJob> {
  await ensurePostgresSchema();

  if (!input.clientRequestId) {
    return {
      job: await createPostgresGenerationJob(input),
      created: true
    };
  }

  const existingBeforeInsert = await getPostgresGenerationJobByClientRequestId(input.clientRequestId);

  if (existingBeforeInsert) {
    return { job: existingBeforeInsert, created: false };
  }

  const inserted = await insertPostgresGenerationJob(
    buildGenerationJob(input),
    "ON CONFLICT (client_request_id) DO NOTHING"
  );

  if (inserted) {
    return { job: inserted, created: true };
  }

  const existing = await getPostgresGenerationJobByClientRequestId(input.clientRequestId);

  if (!existing) {
    throw new Error("Idempotent generation job reservation conflicted but no existing job was found");
  }

  return { job: existing, created: false };
}

async function updatePostgresGenerationJob(
  id: string,
  updates: Partial<Omit<GenerationJob, "id" | "createdAt">>
): Promise<GenerationJob | null> {
  await ensurePostgresSchema();
  const existing = await getPostgresGenerationJob(id);

  if (!existing) {
    return null;
  }

  if (isTerminalGenerationStatus(existing.status)) {
    return existing;
  }

  const now = new Date().toISOString();
  const status = updates.status ?? existing.status;
  const job: GenerationJob = {
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now,
    completedAt:
      updates.completedAt !== undefined
        ? updates.completedAt
        : status === "completed" || status === "failed"
          ? existing.completedAt ?? now
          : existing.completedAt
  };
  const result = await getPostgresPool().query(
    `
      UPDATE generation_jobs
      SET
        dragon_task_id = $2,
        client_request_id = $3,
        mode = $4,
        prompt = $5,
        resolution = $6,
        size = $7,
        status = $8,
        progress = $9,
        input_images = $10::jsonb,
        output_images = $11::jsonb,
        error_message = $12,
        retry_count = $13,
        updated_at = $14,
        completed_at = $15
      WHERE id = $1 AND status NOT IN ('completed', 'failed')
      RETURNING *
    `,
    [
      job.id,
      job.dragonTaskId,
      job.clientRequestId,
      job.mode,
      job.prompt,
      job.resolution,
      job.size,
      job.status,
      job.progress,
      JSON.stringify(job.inputImages),
      JSON.stringify(job.outputImages),
      job.errorMessage,
      job.retryCount,
      job.updatedAt,
      job.completedAt
    ]
  );

  return result.rows[0] ? rowToGenerationJob(result.rows[0]) : getPostgresGenerationJob(id);
}

async function deletePostgresGenerationJob(id: string): Promise<boolean> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query("DELETE FROM generation_jobs WHERE id = $1", [id]);

  return (result.rowCount ?? 0) > 0;
}

async function getPostgresOwnerAccount(): Promise<OwnerAccount | null> {
  await ensurePostgresSchema();
  const result = await getPostgresPool().query(
    "SELECT username, password_hash, created_at FROM owner_account WHERE singleton_key = 1 LIMIT 1"
  );

  return result.rows[0] ? rowToOwnerAccount(result.rows[0]) : null;
}

async function createPostgresOwnerAccount(input: NewOwnerAccount): Promise<OwnerAccount> {
  await ensurePostgresSchema();
  const ownerAccount: OwnerAccount = {
    ...input,
    createdAt: new Date().toISOString()
  };

  try {
    const result = await getPostgresPool().query(
      `
        INSERT INTO owner_account (singleton_key, username, password_hash, created_at)
        VALUES (1, $1, $2, $3)
        RETURNING username, password_hash, created_at
      `,
      [ownerAccount.username, ownerAccount.passwordHash, ownerAccount.createdAt]
    );

    return rowToOwnerAccount(result.rows[0]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new Error("Owner account already exists");
    }

    throw error;
  }
}

export async function listGenerationJobs(databasePath?: string): Promise<GenerationJob[]> {
  if (shouldUsePostgres(databasePath)) {
    return listPostgresGenerationJobs();
  }

  const data = await readStore(databasePath);

  return sortNewestFirst(data.jobs);
}

export async function listGenerationJobsPage(
  databasePath?: string,
  options: GenerationJobListOptions = {}
): Promise<GenerationJobsPage> {
  if (shouldUsePostgres(databasePath)) {
    return listPostgresGenerationJobsPage(options);
  }

  const jobs = filterGenerationJobs(await listGenerationJobs(databasePath), options);
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 10));
  const total = jobs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), totalPages);
  const start = (page - 1) * pageSize;

  return {
    jobs: jobs.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages
  };
}

export async function listGenerationJobsByIds(
  ids: string[],
  databasePath?: string
): Promise<GenerationJob[]> {
  if (shouldUsePostgres(databasePath)) {
    return listPostgresGenerationJobsByIds(ids);
  }

  const idSet = new Set(uniqueIds(ids));

  if (idSet.size === 0) {
    return [];
  }

  return (await listGenerationJobs(databasePath)).filter((job) => idSet.has(job.id));
}

export async function listActiveGenerationJobs(databasePath?: string): Promise<GenerationJob[]> {
  if (shouldUsePostgres(databasePath)) {
    return listPostgresActiveGenerationJobs();
  }

  const data = await readStore(databasePath);

  return sortNewestFirst(
    data.jobs.filter(
      (job) => Boolean(job.dragonTaskId) && (job.status === "pending" || job.status === "submitted")
    )
  );
}

export async function getGenerationJob(
  id: string,
  databasePath?: string
): Promise<GenerationJob | null> {
  if (shouldUsePostgres(databasePath)) {
    return getPostgresGenerationJob(id);
  }

  const data = await readStore(databasePath);

  return data.jobs.find((job) => job.id === id) ?? null;
}

export async function getGenerationJobByClientRequestId(
  clientRequestId: string,
  databasePath?: string
): Promise<GenerationJob | null> {
  if (shouldUsePostgres(databasePath)) {
    return getPostgresGenerationJobByClientRequestId(clientRequestId);
  }

  const data = await readStore(databasePath);

  return data.jobs.find((job) => job.clientRequestId === clientRequestId) ?? null;
}

export async function createGenerationJob(
  input: NewGenerationJob,
  databasePath?: string
): Promise<GenerationJob> {
  if (shouldUsePostgres(databasePath)) {
    return createPostgresGenerationJob(input);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);
    const job = buildGenerationJob(input);

    await writeStore({ ...data, jobs: [...data.jobs, job] }, resolvedPath);

    return job;
  });
}

export async function reserveGenerationJob(
  input: NewGenerationJob,
  databasePath?: string
): Promise<ReservedGenerationJob> {
  if (shouldUsePostgres(databasePath)) {
    return reservePostgresGenerationJob(input);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);
    const existing = input.clientRequestId
      ? data.jobs.find((job) => job.clientRequestId === input.clientRequestId)
      : null;

    if (existing) {
      return { job: existing, created: false };
    }

    const job = buildGenerationJob(input);

    await writeStore({ ...data, jobs: [...data.jobs, job] }, resolvedPath);

    return { job, created: true };
  });
}

export async function updateGenerationJob(
  id: string,
  updates: Partial<Omit<GenerationJob, "id" | "createdAt">>,
  databasePath?: string
): Promise<GenerationJob | null> {
  if (shouldUsePostgres(databasePath)) {
    return updatePostgresGenerationJob(id, updates);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);
    const index = data.jobs.findIndex((job) => job.id === id);

    if (index === -1) {
      return null;
    }

    const now = new Date().toISOString();
    const existing = data.jobs[index];

    if (isTerminalGenerationStatus(existing.status)) {
      return existing;
    }

    const status = updates.status ?? existing.status;
    const job: GenerationJob = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      completedAt:
        updates.completedAt !== undefined
          ? updates.completedAt
          : status === "completed" || status === "failed"
            ? existing.completedAt ?? now
            : existing.completedAt
    };

    data.jobs[index] = job;
    await writeStore(data, resolvedPath);

    return job;
  });
}

export async function deleteGenerationJob(id: string, databasePath?: string): Promise<boolean> {
  if (shouldUsePostgres(databasePath)) {
    return deletePostgresGenerationJob(id);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);
    const remainingJobs = data.jobs.filter((job) => job.id !== id);

    if (remainingJobs.length === data.jobs.length) {
      return false;
    }

    await writeStore({ ...data, jobs: remainingJobs }, resolvedPath);

    return true;
  });
}

export async function deleteGenerationJobs(
  options: DeleteGenerationJobsOptions,
  databasePath?: string
): Promise<DeleteGenerationJobsResult> {
  if (shouldUsePostgres(databasePath)) {
    return deletePostgresGenerationJobs(options);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);
    const ids = uniqueIds(options.ids);
    const idSet = new Set(ids);
    const existing = ids.length > 0 ? data.jobs.filter((job) => idSet.has(job.id)) : data.jobs;
    const existingIds = new Set(existing.map((job) => job.id));
    const notFoundIds = ids.length > 0 ? ids.filter((id) => !existingIds.has(id)) : [];
    const candidates =
      ids.length > 0
        ? existing
        : options.scope
          ? existing.filter((job) => shouldDeleteJobByScope(job, options.scope as DeleteGenerationJobsScope))
          : [];
    const deletable = candidates.filter(
      (job) => options.includeActive || !isActiveGenerationStatus(job.status)
    );
    const skippedActive = candidates.length - deletable.length;

    if (deletable.length === 0) {
      return buildDeleteResult({
        deletedCount: 0,
        notFoundIds,
        skippedActive
      });
    }

    const deleteIds = new Set(deletable.map((job) => job.id));

    await writeStore(
      {
        ...data,
        jobs: data.jobs.filter((job) => !deleteIds.has(job.id))
      },
      resolvedPath
    );

    return buildDeleteResult({
      deletedCount: deletable.length,
      notFoundIds,
      skippedActive
    });
  });
}

export async function getOwnerAccount(databasePath?: string): Promise<OwnerAccount | null> {
  if (shouldUsePostgres(databasePath)) {
    return getPostgresOwnerAccount();
  }

  const data = await readStore(databasePath);

  return data.ownerAccount;
}

export async function createOwnerAccount(
  input: NewOwnerAccount,
  databasePath?: string
): Promise<OwnerAccount> {
  if (shouldUsePostgres(databasePath)) {
    return createPostgresOwnerAccount(input);
  }

  const resolvedPath = resolveDatabasePath(databasePath);

  return withStoreWriteLock(resolvedPath, async () => {
    const data = await readStore(resolvedPath);

    if (data.ownerAccount) {
      throw new Error("Owner account already exists");
    }

    const ownerAccount: OwnerAccount = {
      ...input,
      createdAt: new Date().toISOString()
    };

    await writeStore({ ...data, ownerAccount }, resolvedPath);

    return ownerAccount;
  });
}

export async function closeStoreForTests() {
  if (postgresPool) {
    await postgresPool.end();
  }

  postgresPool = null;
  postgresPoolConnectionString = null;
  postgresSchemaLocks.clear();
  storeWriteLocks.clear();
}
