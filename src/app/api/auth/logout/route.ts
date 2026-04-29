import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { shouldUseSecureCookies } from "@/lib/server-auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    maxAge: 0
  });

  return response;
}
