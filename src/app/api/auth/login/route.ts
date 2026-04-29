import { NextResponse, type NextRequest } from "next/server";
import { isTestAccountEnabled, verifyCredentials } from "@/lib/account-auth";
import { createSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { getOptionalEnv, getSessionSecret } from "@/lib/env";
import {
  clearLoginRateLimit,
  isLoginRateLimited,
  recordFailedLoginAttempt
} from "@/lib/login-rate-limit";
import { shouldUseSecureCookies } from "@/lib/server-auth";
import { getOwnerAccount } from "@/lib/store";

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容格式不正确。" }, { status: 400 });
  }

  const username = typeof (body as { username?: unknown }).username === "string"
    ? (body as { username: string }).username
    : "";
  const password = typeof (body as { password?: unknown }).password === "string"
    ? (body as { password: string }).password
    : "";

  if (isLoginRateLimited(request, username)) {
    return NextResponse.json(
      { error: "登录尝试次数过多，请稍后再试。" },
      { status: 429 }
    );
  }

  const envUsername = getOptionalEnv("APP_USERNAME");
  const envPasswordHash = getOptionalEnv("APP_PASSWORD_HASH");
  const authenticatedUsername = await verifyCredentials({
    username,
    password,
    ownerAccount: await getOwnerAccount(),
    envAccount: envUsername && envPasswordHash ? { username: envUsername, passwordHash: envPasswordHash } : null,
    allowTestAccount: isTestAccountEnabled()
  });

  if (!authenticatedUsername) {
    recordFailedLoginAttempt(request, username);
    return NextResponse.json({ error: "用户名或密码不正确。" }, { status: 401 });
  }

  clearLoginRateLimit(request, username);

  const response = NextResponse.json({ ok: true, username: authenticatedUsername });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionCookie(authenticatedUsername, getSessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });

  return response;
}
