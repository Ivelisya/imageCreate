import { describe, expect, it } from "vitest";
import { createSessionCookie, readSessionCookie } from "./auth";

describe("session cookies", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("round-trips a signed session", () => {
    const cookie = createSessionCookie("admin", secret, 60);

    expect(readSessionCookie(cookie, secret)?.username).toBe("admin");
  });

  it("rejects tampered sessions", () => {
    const cookie = createSessionCookie("admin", secret, 60);
    const tampered = cookie.replace("admin", "owner");

    expect(readSessionCookie(tampered, secret)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const cookie = createSessionCookie("admin", secret, -1);

    expect(readSessionCookie(cookie, secret)).toBeNull();
  });
});
