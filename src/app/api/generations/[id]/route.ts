import { NextResponse, type NextRequest } from "next/server";
import { pollGenerationJobOnce, startGenerationPolling } from "@/lib/generation-poller";
import { normalizeGenerationJobForResponse } from "@/lib/generation-response";
import { getCurrentUser } from "@/lib/server-auth";
import { deleteGenerationJob, getGenerationJob } from "@/lib/store";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function unauthorized() {
  return NextResponse.json({ error: "请先登录。" }, { status: 401 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  const { id } = await context.params;
  const job = await getGenerationJob(id);

  if (!job) {
    return NextResponse.json({ error: "没有找到这条生成记录。" }, { status: 404 });
  }

  if ((job.status === "pending" || job.status === "submitted") && job.dragonTaskId) {
    const result = await pollGenerationJobOnce(job.id);

    if (result.shouldContinue) {
      startGenerationPolling(job);
    }

    return NextResponse.json({ job: normalizeGenerationJobForResponse(result.job ?? job) });
  }

  return NextResponse.json({ job: normalizeGenerationJobForResponse(job) });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!getCurrentUser(request)) {
    return unauthorized();
  }

  const { id } = await context.params;
  const job = await getGenerationJob(id);

  if (!job) {
    return NextResponse.json({ error: "没有找到这条生成记录。" }, { status: 404 });
  }

  if (job.status === "pending" || job.status === "submitted") {
    return NextResponse.json(
      { error: "生成中的任务不能删除，请等待完成或失败后再删除。" },
      { status: 409 }
    );
  }

  const deleted = await deleteGenerationJob(id);

  if (!deleted) {
    return NextResponse.json({ error: "没有找到这条生成记录。" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
