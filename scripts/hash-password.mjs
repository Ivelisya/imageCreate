import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });

try {
  const password = await rl.question("Password to hash: ");

  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const hash = await bcrypt.hash(password, 12);
  console.log(hash);
} finally {
  rl.close();
}
