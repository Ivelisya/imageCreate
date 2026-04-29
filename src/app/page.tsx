"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function routeBySession() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const session = (await response.json()) as { authenticated?: boolean };

        if (!cancelled) {
          router.replace(session.authenticated ? "/generate" : "/login");
        }
      } catch {
        if (!cancelled) {
          router.replace("/login");
        }
      }
    }

    void routeBySession();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="center-screen">
      <div className="loading-mark" aria-live="polite">
        正在检查登录状态...
      </div>
    </main>
  );
}
