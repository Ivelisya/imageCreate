import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOwnerAccount } from "@/lib/store";
import { POST } from "./route";

const tempDirs: string[] = [];

async function createDatabasePath() {
  const dir = await mkdtemp(join(tmpdir(), "pis-setup-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

function setupRequest(username = "owner", password = "secure-password") {
  return new NextRequest("http://localhost/api/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ username, password })
  });
}

beforeEach(async () => {
  process.env.DATABASE_PATH = await createDatabasePath();
  process.env.SESSION_SECRET = "test-session-secret-with-at-least-thirty-two-characters";
  process.env.ALLOW_JSON_STORE_IN_PRODUCTION = "true";
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.DATABASE_PATH;
  delete process.env.SESSION_SECRET;
  delete process.env.ENABLE_TEST_ACCOUNT;
  delete process.env.ALLOW_OWNER_SETUP_IN_PRODUCTION;
});

describe("setup API route", () => {
  it("blocks public owner setup in production when the internal test account is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ENABLE_TEST_ACCOUNT = "true";

    const response = await POST(setupRequest());
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toContain("公开创建账号入口已关闭");
    expect(await getOwnerAccount()).toBeNull();
  });

  it("allows owner setup in production only when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ENABLE_TEST_ACCOUNT = "true";
    process.env.ALLOW_OWNER_SETUP_IN_PRODUCTION = "true";

    const response = await POST(setupRequest());
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ ok: true, username: "owner" });
    expect(await getOwnerAccount()).toMatchObject({ username: "owner" });
  });
});
