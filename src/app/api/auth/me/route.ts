import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/server-auth";
import { getOwnerAccount } from "@/lib/store";

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request);
  const setupRequired = !(await getOwnerAccount());

  if (!user) {
    return NextResponse.json({ authenticated: false, setupRequired });
  }

  return NextResponse.json({ authenticated: true, username: user.username, setupRequired });
}
