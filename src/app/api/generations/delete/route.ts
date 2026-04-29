import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/server-auth";
import {
  deleteGenerationJobs,
  type DeleteGenerationJobsScope
} from "@/lib/store";

const MAX_BULK_DELETE_IDS = 100;
const validScopes = new Set<DeleteGenerationJobsScope>(["all", "completed", "failed"]);

function unauthorized() {
  return NextResponse.json({ error: "请先登录。" }, { status: 401 });
}

function normalizeIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function normalizeScope(value: unknown): DeleteGenerationJobsScope | undefined {
  return typeof value === "string" && validScopes.has(value as DeleteGenerationJobsScope)
    ? (value as DeleteGenerationJobsScope)
    : undefined;
}

export async function POST(request: NextRequest) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式不正确。" }, { status: 400 });
  }

  const raw = body as {
    ids?: unknown;
    scope?: unknown;
  };
  const ids = normalizeIds(raw.ids).slice(0, MAX_BULK_DELETE_IDS);
  const scope = normalizeScope(raw.scope);

  if (ids.length === 0 && !scope) {
    return NextResponse.json({ error: "请选择要删除的历史记录。" }, { status: 400 });
  }

  const result = await deleteGenerationJobs({
    ids: ids.length > 0 ? ids : undefined,
    scope,
    includeActive: false
  });

  return NextResponse.json(result);
}
