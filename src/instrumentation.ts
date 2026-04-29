export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startActiveGenerationPolling } = await import("./lib/generation-poller");

    void startActiveGenerationPolling();
  }
}
