import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLoginRateLimitForTests } from "@/lib/login-rate-limit";
import { POST } from "./route";

function loginRequest(username: string, password: string, forwardedFor = "203.0.113.10") {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor
    },
    body: JSON.stringify({ username, password })
  });
}

beforeEach(() => {
  process.env.ENABLE_TEST_ACCOUNT = "true";
  process.env.SESSION_SECRET = "test-session-secret-with-at-least-thirty-two-characters";
  resetLoginRateLimitForTests();
});

afterEach(() => {
  delete process.env.ENABLE_TEST_ACCOUNT;
  delete process.env.SESSION_SECRET;
  resetLoginRateLimitForTests();
});

describe("login API route", () => {
  it("rate limits repeated failed login attempts by username and IP", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await POST(loginRequest("admin", "wrong-password"));

      expect(response.status).toBe(401);
    }

    const limited = await POST(loginRequest("admin", "wrong-password"));
    const payload = await limited.json();

    expect(limited.status).toBe(429);
    expect(payload.error).toContain("尝试次数过多");
  });

  it("allows the internal test account when credentials are correct", async () => {
    const response = await POST(loginRequest("admin", "admin"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, username: "admin" });
  });
});
