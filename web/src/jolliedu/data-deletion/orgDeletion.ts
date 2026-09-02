import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma } from "@langfuse/shared/src/db";
import { redis } from "@langfuse/shared/src/server";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";
import { respondJolliEduError } from "@/src/jolliedu/http";

/**
 * Self-built (non-EE) organization deletion endpoint. Mirrors the MIT tRPC
 * `organization.delete` flow: refuse while any project still exists (the MIT
 * flow relies on Prisma cascade and requires every project to be
 * hard-deleted first via ProjectDeleteQueue), then delete the org row,
 * invalidate its cached API keys, and write an audit log. Cloud billing
 * cancellation is intentionally omitted (self-hosted only).
 *
 *   DELETE /api/jolliedu/data-deletion/organizations/{orgId}?confirm=true
 *
 * Irreversible. The `confirm=true` guard prevents accidental calls.
 */
export async function handleJolliEduOrgDeletion(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const orgId = z.string().safeParse(req.query.orgId);
  if (!orgId.success) {
    return res.status(400).json({ error: "Missing orgId in path" });
  }
  if (req.query.confirm !== "true") {
    return res.status(400).json({
      error: "Refusing to delete without confirm=true query parameter",
    });
  }

  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId.data },
    });
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const nonDeletedProjects = await prisma.project.count({
      where: { orgId: orgId.data, deletedAt: null },
    });
    if (nonDeletedProjects > 0) {
      return res.status(409).json({
        error:
          "Delete or transfer all projects before deleting the organization.",
      });
    }

    // Soft-deleted projects whose async hard-delete has not finished yet.
    const anyProjects = await prisma.project.count({
      where: { orgId: orgId.data },
    });
    if (anyProjects > 0) {
      return res.status(409).json({
        error:
          "Project deletion is still processing; retry the organization deletion later.",
      });
    }

    const organization = await prisma.organization.delete({
      where: { id: orgId.data },
    });

    // API keys carry their org, so drop the cached entries.
    await new ApiAuthService(prisma, redis).invalidateCachedOrgApiKeys(
      orgId.data,
    );

    await auditLog({
      apiKeyId: "JOLLIEDU_ADMIN",
      orgId: orgId.data,
      resourceType: "organization",
      resourceId: orgId.data,
      action: "delete",
      before: organization,
    });

    return res.status(200).json({ orgId: orgId.data, status: "deleted" });
  } catch (e) {
    return respondJolliEduError(
      res,
      e,
      "jolliedu org-deletion endpoint failed",
    );
  }
}
