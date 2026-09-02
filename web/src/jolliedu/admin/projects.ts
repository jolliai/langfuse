import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { StringNoHTMLNonEmpty, JSONObjectSchema } from "@langfuse/shared";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";
import { respondJolliEduError, jolliEduPagination } from "@/src/jolliedu/http";

const CreateProjectBody = z.object({
  // Mirror the MIT projects.create name schema (StringNoHTMLNonEmpty, min 1).
  name: StringNoHTMLNonEmpty.max(60),
  metadata: JSONObjectSchema.optional(),
});

const ListProjectsQuery = z.object(jolliEduPagination);

/**
 * Self-built (non-EE) admin handler. Mirrors the MIT tRPC `projects.create`
 * flow (duplicate-name guard + `prisma.project.create`), scoped to the org in
 * the path.
 *
 *   POST /api/jolliedu/admin/organizations/{orgId}/projects  -> create project
 *   GET  /api/jolliedu/admin/organizations/{orgId}/projects  -> list projects
 */
export async function handleJolliEduProjects(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  const orgId = z.string().safeParse(req.query.orgId);
  if (!orgId.success) {
    return res.status(400).json({ error: "Missing orgId in path" });
  }

  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId.data },
    });
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    if (req.method === "POST") {
      const body = CreateProjectBody.parse(req.body);

      const existing = await prisma.project.findFirst({
        where: { name: body.name, orgId: orgId.data, deletedAt: null },
      });
      if (existing) {
        return res.status(409).json({
          error: "A project with this name already exists in this organization",
        });
      }

      const project = await prisma.project.create({
        data: {
          name: body.name,
          orgId: orgId.data,
          ...(body.metadata
            ? { metadata: body.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });

      await auditLog({
        apiKeyId: "JOLLIEDU_ADMIN",
        orgId: orgId.data,
        projectId: project.id,
        resourceType: "project",
        resourceId: project.id,
        action: "create",
        after: project,
      });

      return res.status(201).json({
        id: project.id,
        name: project.name,
        orgId: project.orgId,
        metadata: project.metadata,
      });
    }

    if (req.method === "GET") {
      const q = ListProjectsQuery.parse(req.query);
      const where = { orgId: orgId.data, deletedAt: null };
      const [projects, totalCount] = await Promise.all([
        prisma.project.findMany({
          where,
          select: { id: true, name: true, orgId: true, metadata: true },
          orderBy: { createdAt: "desc" },
          skip: q.page * q.limit,
          take: q.limit,
        }),
        prisma.project.count({ where }),
      ]);
      return res
        .status(200)
        .json({ projects, totalCount, page: q.page, limit: q.limit });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return respondJolliEduError(res, e, "jolliedu project endpoint failed");
  }
}
