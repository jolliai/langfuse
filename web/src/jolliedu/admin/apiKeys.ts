import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma } from "@langfuse/shared/src/db";
import { redis } from "@langfuse/shared/src/server";
import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";
import { respondJolliEduError } from "@/src/jolliedu/http";

const CreateApiKeyBody = z.object({
  note: z.string().max(200).optional(),
});

/**
 * Self-built (non-EE) admin handler. Mints a PROJECT-scoped ingestion key
 * pair (pk-lf-… / sk-lf-…) via the MIT shared primitive
 * `createAndAddApiKeysToDb`. The plaintext secret is returned exactly once.
 *
 *   POST /api/jolliedu/admin/projects/{projectId}/apiKeys  -> create key
 *   GET  /api/jolliedu/admin/projects/{projectId}/apiKeys  -> list (masked)
 */
export async function handleJolliEduApiKeys(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  const projectId = z.string().safeParse(req.query.projectId);
  if (!projectId.success) {
    return res.status(400).json({ error: "Missing projectId in path" });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, deletedAt: null },
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (req.method === "POST") {
      const body = CreateApiKeyBody.parse(req.body ?? {});
      const key = await createAndAddApiKeysToDb({
        prisma,
        entityId: projectId.data,
        scope: "PROJECT",
        note: body.note,
      });
      // Audit the mint with masked fields only — never the plaintext secret.
      await auditLog({
        apiKeyId: "JOLLIEDU_ADMIN",
        orgId: project.orgId,
        projectId: projectId.data,
        resourceType: "apiKey",
        resourceId: key.id,
        action: "create",
        after: {
          id: key.id,
          publicKey: key.publicKey,
          displaySecretKey: key.displaySecretKey,
          note: key.note,
        },
      });

      // secretKey is returned ONLY here and never retrievable again.
      return res.status(201).json({
        id: key.id,
        publicKey: key.publicKey,
        secretKey: key.secretKey,
        displaySecretKey: key.displaySecretKey,
        note: key.note,
        createdAt: key.createdAt,
      });
    }

    if (req.method === "GET") {
      const keys = await prisma.apiKey.findMany({
        // Exclude in-app-agent MCP session keys — they are not user-managed
        // credentials and must not surface in this listing.
        where: {
          projectId: projectId.data,
          scope: "PROJECT",
          isInAppAgentKey: false,
        },
        select: {
          id: true,
          publicKey: true,
          displaySecretKey: true,
          note: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json({ apiKeys: keys });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return respondJolliEduError(res, e, "jolliedu apiKey endpoint failed");
  }
}

/**
 * Self-built (non-EE) API-key revocation handler. Mirrors the EE
 * delete-key-by-id shape over the MIT `ApiAuthService.deleteApiKey` wrapper
 * (which invalidates the cache and hard-deletes the row). Only project-scoped,
 * non-agent keys are revocable here.
 *
 *   DELETE /api/jolliedu/admin/projects/{projectId}/apiKeys/{apiKeyId}
 */
export async function handleJolliEduApiKeyById(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const projectId = z.string().safeParse(req.query.projectId);
  const apiKeyId = z.string().safeParse(req.query.apiKeyId);
  if (!projectId.success) {
    return res.status(400).json({ error: "Missing projectId in path" });
  }
  if (!apiKeyId.success) {
    return res.status(400).json({ error: "Missing apiKeyId in path" });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, deletedAt: null },
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: apiKeyId.data,
        projectId: projectId.data,
        scope: "PROJECT",
        isInAppAgentKey: false,
      },
    });
    if (!apiKey) {
      return res.status(404).json({ error: "API key not found" });
    }

    const deleted = await new ApiAuthService(prisma, redis).deleteApiKey(
      apiKeyId.data,
      projectId.data,
      "PROJECT",
    );
    if (!deleted) {
      return res.status(500).json({ error: "Failed to delete API key" });
    }

    // Audit with masked fields only — never the plaintext secret.
    await auditLog({
      apiKeyId: "JOLLIEDU_ADMIN",
      orgId: project.orgId,
      projectId: projectId.data,
      resourceType: "apiKey",
      resourceId: apiKeyId.data,
      action: "delete",
      before: {
        id: apiKey.id,
        publicKey: apiKey.publicKey,
        displaySecretKey: apiKey.displaySecretKey,
        note: apiKey.note,
      },
    });

    return res.status(200).json({ id: apiKeyId.data, status: "deleted" });
  } catch (e) {
    return respondJolliEduError(
      res,
      e,
      "jolliedu apiKey delete endpoint failed",
    );
  }
}
