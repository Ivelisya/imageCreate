import type { NextRequest } from "next/server";

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 8;

type LoginAttemptBucket = {
  failedAttempts: number;
  resetAt: number;
};

const loginAttemptBuckets = new Map<string, LoginAttemptBucket>();

function nowMs(): number {
  return Date.now();
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, 160);
}

function getRequestIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();

  return forwardedFor || realIp || "unknown";
}

function bucketKey(request: NextRequest, username: string): string {
  return `${getRequestIp(request)}:${normalizeUsername(username)}`;
}

function getActiveBucket(key: string, now = nowMs()): LoginAttemptBucket {
  const existing = loginAttemptBuckets.get(key);

  if (existing && existing.resetAt > now) {
    return existing;
  }

  const fresh = {
    failedAttempts: 0,
    resetAt: now + DEFAULT_WINDOW_MS
  };

  loginAttemptBuckets.set(key, fresh);

  return fresh;
}

export function isLoginRateLimited(request: NextRequest, username: string): boolean {
  const bucket = getActiveBucket(bucketKey(request, username));

  return bucket.failedAttempts >= DEFAULT_MAX_FAILED_ATTEMPTS;
}

export function recordFailedLoginAttempt(request: NextRequest, username: string): void {
  const bucket = getActiveBucket(bucketKey(request, username));

  bucket.failedAttempts += 1;
}

export function clearLoginRateLimit(request: NextRequest, username: string): void {
  loginAttemptBuckets.delete(bucketKey(request, username));
}

export function resetLoginRateLimitForTests(): void {
  loginAttemptBuckets.clear();
}
