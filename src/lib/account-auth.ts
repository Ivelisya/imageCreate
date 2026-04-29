import { createRequire } from "node:module";
import type { OwnerAccount } from "./store";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs") as {
  compare(password: string, hash: string): Promise<boolean>;
  hash(password: string, rounds: number): Promise<string>;
};

export type LoginAccount = {
  username: string;
  passwordHash: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function isTestAccountEnabled(): boolean {
  return process.env.ENABLE_TEST_ACCOUNT === "true" || process.env.NODE_ENV !== "production";
}

export async function verifyCredentials(input: {
  username: string;
  password: string;
  ownerAccount: OwnerAccount | null;
  envAccount: LoginAccount | null;
  allowTestAccount: boolean;
}): Promise<string | null> {
  if (input.allowTestAccount && input.username === "admin" && input.password === "admin") {
    return "admin";
  }

  const accounts = [input.ownerAccount, input.envAccount].filter(
    (account): account is LoginAccount => Boolean(account)
  );

  for (const account of accounts) {
    if (input.username === account.username && (await bcrypt.compare(input.password, account.passwordHash))) {
      return account.username;
    }
  }

  return null;
}
