export function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getOptionalEnv(name: string): string | null {
  return process.env[name] || null;
}

export function getSessionSecret(): string {
  return getRequiredEnv("SESSION_SECRET");
}

export function getDragonApiKey(): string {
  return getRequiredEnv("DRAGON_API_KEY");
}
