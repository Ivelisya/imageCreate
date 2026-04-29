import type { NextRequest } from "next/server";
import { readSessionCookie, SESSION_COOKIE_NAME } from "./auth";
import { getSessionSecret } from "./env";

export type CurrentUser = {
  username: string;
};

export function getCurrentUser(request: NextRequest): CurrentUser | null {
  const session = readSessionCookie(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
    getSessionSecret()
  );

  return session ? { username: session.username } : null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function shouldUseSecureCookies(): boolean {
  return isProduction() && process.env.COOKIE_SECURE !== "false";
}
