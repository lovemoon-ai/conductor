import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";

interface ProjectMetadata {
  localPaths?: Record<string, string>;
  [key: string]: unknown;
}

function getBoundPath(localPaths: Record<string, string>, hostname: string): string | null {
  const direct = localPaths[hostname];
  if (typeof direct === "string" && direct.trim()) return direct;

  const defaultPath = localPaths.default;
  if (typeof defaultPath === "string" && defaultPath.trim()) return defaultPath;

  const wildcardPath = localPaths["*"];
  if (typeof wildcardPath === "string" && wildcardPath.trim()) return wildcardPath;

  return null;
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json();
  const { hostname, path: requestPath } = body;

  if (!hostname || !requestPath) {
    return NextResponse.json({ error: "hostname and path are required" }, { status: 400 });
  }

  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
  });

  // Find project where the requestPath starts with or equals the bound path for this hostname
  for (const project of projects) {
    if (!project.metadata) continue;

    let metadata: ProjectMetadata;
    try {
      metadata = JSON.parse(project.metadata);
    } catch {
      continue;
    }

    const localPaths = metadata.localPaths;
    if (!localPaths || typeof localPaths !== "object") continue;

    const boundPath = getBoundPath(localPaths, hostname);
    if (!boundPath) continue;

    // Normalize paths for comparison
    const normalizedBoundPath = boundPath.replace(/\/+$/, "");
    const normalizedRequestPath = requestPath.replace(/\/+$/, "");

    // Check if requestPath equals or is a subdirectory of boundPath
    if (
      normalizedRequestPath === normalizedBoundPath ||
      normalizedRequestPath.startsWith(normalizedBoundPath + "/")
    ) {
      return NextResponse.json({
        project: {
          id: project.id,
          name: project.name,
          metadata,
          created_at: project.createdAt.toISOString(),
        },
        matched_path: boundPath,
      });
    }
  }

  return NextResponse.json({ project: null, matched_path: null });
}
