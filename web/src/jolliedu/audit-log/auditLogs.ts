import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import {
  prisma,
  type AuditLog,
  AuditLogRecordType,
} from "@langfuse/shared/src/db";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";
import { respondJolliEduError, jolliEduPagination } from "@/src/jolliedu/http";

type UserActor = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/**
 * Attach the acting user/API key to each audit log row. Mirrors the MIT
 * `mapAuditLogsWithActors` helper (web/src/server/api/routers/auditLogs.ts).
 */
function mapAuditLogsWithActors(
  auditLogs: AuditLog[],
  userMap: Map<string, UserActor>,
  apiKeyMap: Map<string, { id: string; publicKey: string }>,
) {
  return auditLogs.map((log) => {
    switch (log.type) {
      case AuditLogRecordType.API_KEY:
        return {
          ...log,
          actor: {
            type: log.type,
            body: apiKeyMap.get(log.apiKeyId ?? "") ?? {
              id: log.apiKeyId,
              publicKey: null,
            },
          },
        };
      case AuditLogRecordType.USER:
        return {
          ...log,
          actor: {
            type: log.type,
            body: userMap.get(log.userId ?? "") ?? {
              id: log.userId,
              name: null,
              email: null,
              image: null,
            },
          },
        };
      default: {
        // Exhaustiveness guard: a new AuditLogRecordType member must be handled
        // here rather than being silently coerced to a USER actor.
        const _exhaustive: never = log.type;
        throw new Error(
          `Unhandled audit log actor type: ${String(_exhaustive)}`,
        );
      }
    }
  });
}

const ListQuery = z.object({
  // Exactly one scope is required; enforced below.
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  ...jolliEduPagination,
});

/**
 * Self-built (non-EE) audit-log read endpoint. Plain Prisma over the MIT
 * `audit_logs` table — the query shape mirrors the MIT
 * `auditLogsRouter` (web/src/server/api/routers/auditLogs.ts), NOT the EE
 * viewer (which is only a React table wrapper). Read-only.
 *
 *   GET /api/jolliedu/audit-log?orgId=&projectId=&page=&limit=
 *
 * Scope rules (match the MIT router):
 *   - projectId given            -> project-level events for that project
 *   - orgId given, no projectId  -> org-level events only (projectId IS NULL)
 */
export async function handleJolliEduAuditLogs(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const q = ListQuery.parse(req.query);
    if (!q.orgId && !q.projectId) {
      return res
        .status(400)
        .json({ error: "Provide at least one of orgId or projectId" });
    }
    if (q.orgId && q.projectId) {
      // The two scopes select different event sets; passing both is ambiguous
      // (projectId -> project-level events, orgId -> org-level events).
      return res.status(400).json({
        error:
          "Provide only one of orgId or projectId, not both (projectId for project-level events, orgId for org-level events)",
      });
    }

    const where = q.projectId
      ? { projectId: q.projectId }
      : { orgId: q.orgId!, projectId: null };

    const [auditLogs, totalCount] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: q.page * q.limit,
        take: q.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Resolve actors (user / API key) for display, scoped to the same
    // project or org as the query so we never leak identities across tenants.
    const userIds = [
      ...new Set(auditLogs.flatMap((log) => (log.userId ? [log.userId] : []))),
    ];
    const apiKeyIds = [
      ...new Set(
        auditLogs.flatMap((log) => (log.apiKeyId ? [log.apiKeyId] : [])),
      ),
    ];
    const apiKeyWhere = q.projectId
      ? { id: { in: apiKeyIds }, projectId: q.projectId }
      : {
          id: { in: apiKeyIds },
          orgId: q.orgId!,
          scope: "ORGANIZATION" as const,
        };
    // Scope the user lookup to members of the queried tenant, matching the MIT
    // auditLogs router: a user who has left the org resolves to a bare id
    // rather than leaking a name/email across tenants.
    const userWhere = q.projectId
      ? {
          id: { in: userIds },
          organizationMemberships: {
            some: {
              organization: { projects: { some: { id: q.projectId } } },
            },
          },
        }
      : {
          id: { in: userIds },
          organizationMemberships: { some: { orgId: q.orgId! } },
        };

    const [users, apiKeys] = await Promise.all([
      prisma.user.findMany({
        where: userWhere,
        select: { id: true, name: true, email: true, image: true },
      }),
      prisma.apiKey.findMany({
        where: apiKeyWhere,
        select: { id: true, publicKey: true },
      }),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const apiKeyMap = new Map(apiKeys.map((k) => [k.id, k]));

    return res.status(200).json({
      auditLogs: mapAuditLogsWithActors(auditLogs, userMap, apiKeyMap),
      totalCount,
      page: q.page,
      limit: q.limit,
    });
  } catch (e) {
    return respondJolliEduError(res, e, "jolliedu audit-log endpoint failed");
  }
}
