export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const canRecoverPolling =
      Boolean(process.env.DATABASE_URL) ||
      process.env.NODE_ENV !== "production" ||
      process.env.ALLOW_JSON_STORE_IN_PRODUCTION === "true";

    if (!canRecoverPolling) {
      return;
    }

    const { startActiveGenerationPolling } = await import("./lib/generation-poller");

    void startActiveGenerationPolling().catch((error) => {
      console.error("[instrumentation] active polling recovery failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}
