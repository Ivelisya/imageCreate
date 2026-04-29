import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { verifyCredentials } from "./account-auth";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs") as {
  hash(password: string, rounds: number): Promise<string>;
};

describe("credential verification", () => {
  it("keeps the development test account admin/admin", async () => {
    await expect(
      verifyCredentials({
        username: "admin",
        password: "admin",
        ownerAccount: null,
        envAccount: null,
        allowTestAccount: true
      })
    ).resolves.toBe("admin");
  });

  it("accepts a locally created owner account", async () => {
    const passwordHash = await bcrypt.hash("private-pass", 12);

    await expect(
      verifyCredentials({
        username: "creator",
        password: "private-pass",
        ownerAccount: {
          username: "creator",
          passwordHash,
          createdAt: "2026-04-29T00:00:00.000Z"
        },
        envAccount: null,
        allowTestAccount: false
      })
    ).resolves.toBe("creator");
  });

  it("rejects unknown credentials", async () => {
    await expect(
      verifyCredentials({
        username: "admin",
        password: "wrong",
        ownerAccount: null,
        envAccount: null,
        allowTestAccount: true
      })
    ).resolves.toBeNull();
  });
});
