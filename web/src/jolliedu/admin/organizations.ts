import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { StringNoHTML, JSONObjectSchema } from "@langfuse/shared";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";
import { respondJolliEduError, jolliEduPagination } from "@/src/jolliedu/http";

const CreateOrgBody = z.object({
  // Mirror the MIT UI's organization name schema (StringNoHTML.min(3).max(60)).
  name: StringNoHTML.min(3).max(60),
  metadata: JSONObjectSchema.optional(),
  // Optional: attach this existing user as OWNER in the same transaction, so
  // the org is visible in their UI. Omit for a headless org (machine
  // provisioning) that no user can see until a membership is added.
  ownerEmail: z.email().optional(),
});

const ListOrgsQuery = z.object(jolliEduPagination);

/**
 * Self-built (non-EE) admin handler. Mirrors the MIT tRPC
 * `organizations.create` flow, authenticated by a static bearer token instead
 * of a user session. Does NOT depend on the EE `admin-api` entitlement.
 *
 *   POST /api/jolliedu/admin/organizations   -> create an organization
 *   GET  /api/jolliedu/admin/organizations   -> list organizations
 *
 * A static bearer token has no "creator" user, so orgs are headless by
 * default. Pass `ownerEmail` to attach an existing user as OWNER (the MIT
 * router does this implicitly for the session user) and make the org visible
 * in that user's UI.
 */
export async function handleJolliEduOrganizations(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  try {
    if (req.method === "POST") {
      const body = CreateOrgBody.parse(req.body);

      let ownerUserId: string | undefined;
      if (body.ownerEmail) {
        const user = await prisma.user.findUnique({
          where: { email: body.ownerEmail },
          select: { id: true },
        });
        if (!user) {
          return res
            .status(400)
            .json({ error: `No user found with email ${body.ownerEmail}` });
        }
        ownerUserId = user.id;
      }

      const organization = await prisma.organization.create({
        data: {
          name: body.name,
          ...(body.metadata
            ? { metadata: body.metadata as Prisma.InputJsonValue }
            : {}),
          ...(ownerUserId
            ? {
                organizationMemberships: {
                  create: { userId: ownerUserId, role: "OWNER" },
                },
              }
            : {}),
        },
      });

      await auditLog({
        apiKeyId: "JOLLIEDU_ADMIN",
        orgId: organization.id,
        resourceType: "organization",
        resourceId: organization.id,
        action: "create",
        after: organization,
      });

      return res.status(201).json({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        metadata: organization.metadata,
        owner: body.ownerEmail ?? null,
      });
    }

    if (req.method === "GET") {
      const q = ListOrgsQuery.parse(req.query);
      const [organizations, totalCount] = await Promise.all([
        prisma.organization.findMany({
          select: { id: true, name: true, createdAt: true, metadata: true },
          orderBy: { createdAt: "desc" },
          skip: q.page * q.limit,
          take: q.limit,
        }),
        prisma.organization.count(),
      ]);
      return res
        .status(200)
        .json({ organizations, totalCount, page: q.page, limit: q.limit });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return respondJolliEduError(res, e, "jolliedu org endpoint failed");
  }
}
