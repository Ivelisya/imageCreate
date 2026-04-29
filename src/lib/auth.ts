import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "pis_session";

type SessionPayload = {
  username: string;
  expiresAt: number;
};

type Session = {
  username: string;
  expiresAt: number;
};

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function createSessionCookie(
  username: string,
  secret: string,
  maxAgeSeconds = 60 * 60 * 24 * 7
): string {
  const payload: SessionPayload = {
    username,
    expiresAt: Date.now() + maxAgeSeconds * 1000
  };
  const body = encodeURIComponent(JSON.stringify(payload));

  return `${body}.${sign(body, secret)}`;
}

export function readSessionCookie(cookieValue: string | undefined, secret: string): Session | null {
  if (!cookieValue) {
    return null;
  }

  const separator = cookieValue.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const body = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);

  if (!safeEqual(signature, sign(body, secret))) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(body)) as SessionPayload;

    if (!payload.username || payload.expiresAt <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
