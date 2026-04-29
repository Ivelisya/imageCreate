import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);

    if (!process.env[name]) {
      process.env[name] = value;
    }
  }
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generation_jobs (
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS generation_jobs_created_at_idx
    ON generation_jobs (created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS generation_jobs_active_idx
    ON generation_jobs (status, created_at DESC)
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
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoOrNow(value) {
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

loadDotEnv(resolve(".env.local"));

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Missing DATABASE_URL. Set it in .env.local before running this migration.");
  process.exit(1);
}

const jsonPath = resolve(process.argv[2] || process.env.DATABASE_PATH || "./data/private-image-studio.json");

if (!existsSync(jsonPath)) {
  console.error(`JSON store not found: ${jsonPath}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const jobs = Array.isArray(data.jobs) ? data.jobs : [];
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await ensureSchema(client);
  await client.query("BEGIN");

  for (const job of jobs) {
    const id = nullableString(job.id);

    if (!id) {
      continue;
    }

    await client.query(
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
        ON CONFLICT (id) DO UPDATE SET
          dragon_task_id = EXCLUDED.dragon_task_id,
          client_request_id = EXCLUDED.client_request_id,
          mode = EXCLUDED.mode,
          prompt = EXCLUDED.prompt,
          resolution = EXCLUDED.resolution,
          size = EXCLUDED.size,
          status = EXCLUDED.status,
          progress = EXCLUDED.progress,
          input_images = EXCLUDED.input_images,
          output_images = EXCLUDED.output_images,
          error_message = EXCLUDED.error_message,
          retry_count = EXCLUDED.retry_count,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at
      `,
      [
        id,
        nullableString(job.dragonTaskId),
        nullableString(job.clientRequestId),
        job.mode === "image" ? "image" : "text",
        typeof job.prompt === "string" ? job.prompt : "",
        typeof job.resolution === "string" ? job.resolution : "2k",
        typeof job.size === "string" ? job.size : "1:1",
        ["pending", "submitted", "completed", "failed"].includes(job.status) ? job.status : "failed",
        Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
        JSON.stringify(stringArray(job.inputImages)),
        JSON.stringify(stringArray(job.outputImages)),
        typeof job.errorMessage === "string" ? job.errorMessage : null,
        Number.isFinite(Number(job.retryCount)) ? Number(job.retryCount) : 0,
        isoOrNow(job.createdAt),
        isoOrNow(job.updatedAt),
        job.completedAt ? isoOrNow(job.completedAt) : null
      ]
    );
  }

  if (
    data.ownerAccount &&
    typeof data.ownerAccount.username === "string" &&
    typeof data.ownerAccount.passwordHash === "string"
  ) {
    await client.query(
      `
        INSERT INTO owner_account (singleton_key, username, password_hash, created_at)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (singleton_key) DO UPDATE SET
          username = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          created_at = EXCLUDED.created_at
      `,
      [
        data.ownerAccount.username,
        data.ownerAccount.passwordHash,
        isoOrNow(data.ownerAccount.createdAt)
      ]
    );
  }

  await client.query("COMMIT");

  const countResult = await pool.query("SELECT COUNT(*) AS total FROM generation_jobs");
  const ownerResult = await pool.query("SELECT COUNT(*) AS total FROM owner_account");

  console.log(JSON.stringify({
    jsonPath,
    importedJobs: jobs.length,
    databaseJobs: Number(countResult.rows[0]?.total ?? 0),
    ownerAccounts: Number(ownerResult.rows[0]?.total ?? 0)
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
