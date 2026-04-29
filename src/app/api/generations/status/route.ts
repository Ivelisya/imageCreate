import { NextResponse, type NextRequest } from "next/server";
import { normalizeGenerationJobForResponse } from "@/lib/generation-response";
import { scheduleActiveGenerationPollingRecovery } from "@/lib/generation-poller";
import { getCurrentUser } from "@/lib/server-auth";
import { listGenerationJobsByIds } from "@/lib/store";

const MAX_STATUS_IDS = 50;

function unauthorized() {
  return NextResponse.json({ error: "请先登录。" }, { status: 401 });
}

function parseIds(request: NextRequest): string[] {
  const repeated = request.nextUrl.searchParams.getAll("id");
  const commaSeparated = request.nextUrl.searchParams.get("ids")?.split(",") ?? [];

  return [...new Set([...repeated, ...commaSeparated].map((id) => id.trim()).filter(Boolean))].slice(
    0,
    MAX_STATUS_IDS
  );
}

export async function GET(request: NextRequest) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  const ids = parseIds(request);

  if (ids.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  const jobs = await listGenerationJobsByIds(ids);
  scheduleActiveGenerationPollingRecovery();

  return NextResponse.json({
    jobs: jobs.map(normalizeGenerationJobForResponse)
  });
}
