import { NextResponse, type NextRequest } from "next/server";
import { hashPassword, isTestAccountEnabled } from "@/lib/account-auth";
import { createSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { getOptionalEnv, getSessionSecret } from "@/lib/env";
import { isProduction } from "@/lib/server-auth";
import { createOwnerAccount, getOwnerAccount } from "@/lib/store";

function isPublicSetupDisabledInProduction(): boolean {
  if (!isProduction() || process.env.ALLOW_OWNER_SETUP_IN_PRODUCTION === "true") {
    return false;
  }

  return Boolean(
    isTestAccountEnabled() ||
      getOptionalEnv("APP_USERNAME") ||
      getOptionalEnv("APP_PASSWORD_HASH")
  );
}

export async function POST(request: NextRequest) {
  if (isPublicSetupDisabledInProduction()) {
    return NextResponse.json(
      { error: "生产环境已启用内部账号登录，公开创建账号入口已关闭。" },
      { status: 403 }
    );
  }

  if (await getOwnerAccount()) {
    return NextResponse.json({ error: "专属账号已经存在。" }, { status: 409 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容格式不正确。" }, { status: 400 });
  }

  const username =
    typeof (body as { username?: unknown }).username === "string"
      ? (body as { username: string }).username.trim()
      : "";
  const password =
    typeof (body as { password?: unknown }).password === "string"
      ? (body as { password: string }).password
      : "";

  if (username.length < 3) {
    return NextResponse.json({ error: "用户名至少需要 3 个字符。" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "密码至少需要 8 个字符。" }, { status: 400 });
  }

  const ownerAccount = await createOwnerAccount({
    username,
    passwordHash: await hashPassword(password)
  });
  const response = NextResponse.json({ ok: true, username: ownerAccount.username }, { status: 201 });

  response.cookies.set(SESSION_COOKIE_NAME, createSessionCookie(ownerAccount.username, getSessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });

  return response;
}
