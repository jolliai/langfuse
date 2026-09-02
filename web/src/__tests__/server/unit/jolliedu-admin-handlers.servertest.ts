import { createMocks, type RequestMethod, type Body } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import type * as SharedDb from "@langfuse/shared/src/db";
import type * as SharedServer from "@langfuse/shared/src/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "a".repeat(64);

const mocks = vi.hoisted(() => ({
  env: { SELF_ADMIN_API_KEY: "a".repeat(64) as string | undefined },
  prisma: {
    organization: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    project: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    apiKey: { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
  },
  auditLog: vi.fn(),
  createAndAddApiKeysToDb: vi.fn(),
  getInstance: vi.fn(),
  queueAdd: vi.fn(),
  shouldSkipDeletionFor: vi.fn(),
  traceDeletionProcessor: vi.fn(),
  invalidateCachedOrgApiKeys: vi.fn(),
  invalidateCachedProjectApiKeys: vi.fn(),
  deleteApiKey: vi.fn(),
}));

vi.mock("@/src/env.mjs", () => ({ env: mocks.env }));

// Keep the real enums/types (AuditLogRecordType etc.), swap only prisma.
vi.mock("@langfuse/shared/src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedDb>();
  return { ...actual, prisma: mocks.prisma };
});

// Keep the real QueueJobs enum and logger, swap the queue + deletion helpers.
vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedServer>();
  return {
    ...actual,
    ProjectDeleteQueue: { getInstance: mocks.getInstance },
    shouldSkipDeletionFor: mocks.shouldSkipDeletionFor,
    traceDeletionProcessor: mocks.traceDeletionProcessor,
  };
});

vi.mock("@langfuse/shared/src/server/auth/apiKeys", () => ({
  createAndAddApiKeysToDb: mocks.createAndAddApiKeysToDb,
}));

vi.mock("@/src/features/audit-logs/auditLog", () => ({
  auditLog: mocks.auditLog,
}));

vi.mock("@/src/features/public-api/server/apiAuth", () => ({
  ApiAuthService: class {
    invalidateCachedOrgApiKeys = mocks.invalidateCachedOrgApiKeys;
    invalidateCachedProjectApiKeys = mocks.invalidateCachedProjectApiKeys;
    deleteApiKey = mocks.deleteApiKey;
  },
}));

import { AuditLogRecordType } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { handleJolliEduOrganizations } from "@/src/jolliedu/admin/organizations";
import { handleJolliEduProjects } from "@/src/jolliedu/admin/projects";
import {
  handleJolliEduApiKeys,
  handleJolliEduApiKeyById,
} from "@/src/jolliedu/admin/apiKeys";
import { handleJolliEduAuditLogs } from "@/src/jolliedu/audit-log/auditLogs";
import { handleJolliEduOrgDeletion } from "@/src/jolliedu/data-deletion/orgDeletion";
import { handleJolliEduProjectDeletion } from "@/src/jolliedu/data-deletion/projectDeletion";
import { handleJolliEduTraceDeletion } from "@/src/jolliedu/data-deletion/traceDeletion";

vi.spyOn(logger, "error").mockImplementation((() => {}) as never);
vi.spyOn(logger, "warn").mockImplementation((() => {}) as never);

type Handler = (
  req: NextApiRequest,
  res: NextApiResponse,
) => unknown | Promise<unknown>;

async function call(
  handler: Handler,
  {
    method = "GET" as RequestMethod,
    query = {} as Record<string, string | string[]>,
    body = undefined as Body | undefined,
    token = TOKEN as string | null,
  } = {},
) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method,
    query,
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  await handler(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.SELF_ADMIN_API_KEY = TOKEN;
});

describe("jolliedu organizations handler", () => {
  it("rejects a missing token with 401 before any DB work", async () => {
    const res = await call(handleJolliEduOrganizations, {
      method: "POST",
      body: { name: "Valid Name" },
      token: null,
    });
    expect(res._getStatusCode()).toBe(401);
    expect(mocks.prisma.organization.create).not.toHaveBeenCalled();
  });

  it("creates a headless org and audits it", async () => {
    mocks.prisma.organization.create.mockResolvedValue({
      id: "org-1",
      name: "Valid Name",
      createdAt: new Date(),
      metadata: { a: 1 },
    });
    const res = await call(handleJolliEduOrganizations, {
      method: "POST",
      body: { name: "Valid Name", metadata: { a: 1, nested: { b: [1, 2] } } },
    });
    expect(res._getStatusCode()).toBe(201);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "organization",
        action: "create",
      }),
    );
  });

  it("rejects an HTML name with 400", async () => {
    const res = await call(handleJolliEduOrganizations, {
      method: "POST",
      body: { name: "<b>evil</b>" },
    });
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.prisma.organization.create).not.toHaveBeenCalled();
  });

  it("rejects a name shorter than 3 chars with 400", async () => {
    const res = await call(handleJolliEduOrganizations, {
      method: "POST",
      body: { name: "ab" },
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("400s when ownerEmail resolves to no user", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    const res = await call(handleJolliEduOrganizations, {
      method: "POST",
      body: { name: "Valid Name", ownerEmail: "nobody@example.com" },
    });
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.prisma.organization.create).not.toHaveBeenCalled();
  });

  it("paginates the list with skip/take and returns totalCount", async () => {
    mocks.prisma.organization.findMany.mockResolvedValue([]);
    mocks.prisma.organization.count.mockResolvedValue(42);
    const res = await call(handleJolliEduOrganizations, {
      method: "GET",
      query: { page: "2", limit: "10" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().totalCount).toBe(42);
    expect(mocks.prisma.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it("405s an unsupported method", async () => {
    const res = await call(handleJolliEduOrganizations, { method: "PUT" });
    expect(res._getStatusCode()).toBe(405);
  });
});

describe("jolliedu projects handler", () => {
  beforeEach(() => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-1" });
  });

  it("404s when the org is missing", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue(null);
    const res = await call(handleJolliEduProjects, {
      method: "POST",
      query: { orgId: "org-1" },
      body: { name: "Proj" },
    });
    expect(res._getStatusCode()).toBe(404);
  });

  it("409s a duplicate project name", async () => {
    mocks.prisma.project.findFirst.mockResolvedValue({ id: "existing" });
    const res = await call(handleJolliEduProjects, {
      method: "POST",
      query: { orgId: "org-1" },
      body: { name: "Proj" },
    });
    expect(res._getStatusCode()).toBe(409);
    expect(mocks.prisma.project.create).not.toHaveBeenCalled();
  });

  it("rejects an HTML name with 400", async () => {
    const res = await call(handleJolliEduProjects, {
      method: "POST",
      query: { orgId: "org-1" },
      body: { name: "<script>x</script>" },
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("creates and audits a project", async () => {
    mocks.prisma.project.findFirst.mockResolvedValue(null);
    mocks.prisma.project.create.mockResolvedValue({
      id: "proj-1",
      name: "Proj",
      orgId: "org-1",
      metadata: {},
    });
    const res = await call(handleJolliEduProjects, {
      method: "POST",
      query: { orgId: "org-1" },
      body: { name: "Proj" },
    });
    expect(res._getStatusCode()).toBe(201);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "project", action: "create" }),
    );
  });
});

describe("jolliedu apiKeys handler", () => {
  beforeEach(() => {
    mocks.prisma.project.findFirst.mockResolvedValue({
      id: "proj-1",
      orgId: "org-1",
    });
  });

  it("excludes in-app-agent keys from the listing", async () => {
    mocks.prisma.apiKey.findMany.mockResolvedValue([]);
    const res = await call(handleJolliEduApiKeys, {
      method: "GET",
      query: { projectId: "proj-1" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isInAppAgentKey: false }),
      }),
    );
  });

  it("mints a key, returns the secret once, and audits masked fields only", async () => {
    mocks.createAndAddApiKeysToDb.mockResolvedValue({
      id: "key-1",
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-secret",
      displaySecretKey: "sk-lf-...abc",
      note: null,
      createdAt: new Date(),
    });
    const res = await call(handleJolliEduApiKeys, {
      method: "POST",
      query: { projectId: "proj-1" },
      body: {},
    });
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData().secretKey).toBe("sk-lf-secret");
    const auditArg = mocks.auditLog.mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("sk-lf-secret");
  });
});

describe("jolliedu apiKey revoke handler", () => {
  beforeEach(() => {
    mocks.prisma.project.findFirst.mockResolvedValue({
      id: "proj-1",
      orgId: "org-1",
    });
  });

  it("405s a non-DELETE method", async () => {
    const res = await call(handleJolliEduApiKeyById, {
      method: "GET",
      query: { projectId: "proj-1", apiKeyId: "key-1" },
    });
    expect(res._getStatusCode()).toBe(405);
  });

  it("404s an unknown key", async () => {
    mocks.prisma.apiKey.findFirst.mockResolvedValue(null);
    const res = await call(handleJolliEduApiKeyById, {
      method: "DELETE",
      query: { projectId: "proj-1", apiKeyId: "key-1" },
    });
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.deleteApiKey).not.toHaveBeenCalled();
  });

  it("revokes a key and audits the deletion", async () => {
    mocks.prisma.apiKey.findFirst.mockResolvedValue({
      id: "key-1",
      publicKey: "pk-lf-1",
      displaySecretKey: "sk-lf-...abc",
      note: null,
    });
    mocks.deleteApiKey.mockResolvedValue(true);
    const res = await call(handleJolliEduApiKeyById, {
      method: "DELETE",
      query: { projectId: "proj-1", apiKeyId: "key-1" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.deleteApiKey).toHaveBeenCalledWith(
      "key-1",
      "proj-1",
      "PROJECT",
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "apiKey", action: "delete" }),
    );
  });
});

describe("jolliedu audit-log handler", () => {
  beforeEach(() => {
    mocks.prisma.auditLog.findMany.mockResolvedValue([]);
    mocks.prisma.auditLog.count.mockResolvedValue(0);
    mocks.prisma.user.findMany.mockResolvedValue([]);
    mocks.prisma.apiKey.findMany.mockResolvedValue([]);
  });

  it("400s when no scope is given", async () => {
    const res = await call(handleJolliEduAuditLogs, {
      method: "GET",
      query: {},
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("400s when both scopes are given", async () => {
    const res = await call(handleJolliEduAuditLogs, {
      method: "GET",
      query: { orgId: "org-1", projectId: "proj-1" },
    });
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("scopes the user lookup to the project's org for a project query", async () => {
    const res = await call(handleJolliEduAuditLogs, {
      method: "GET",
      query: { projectId: "proj-1" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationMemberships: {
            some: { organization: { projects: { some: { id: "proj-1" } } } },
          },
        }),
      }),
    );
  });

  it("scopes the user lookup to the org for an org query", async () => {
    const res = await call(handleJolliEduAuditLogs, {
      method: "GET",
      query: { orgId: "org-1" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationMemberships: { some: { orgId: "org-1" } },
        }),
      }),
    );
  });

  it("maps a USER actor from the scoped user map", async () => {
    mocks.prisma.auditLog.findMany.mockResolvedValue([
      { id: "a1", type: AuditLogRecordType.USER, userId: "u1", apiKeyId: null },
    ]);
    mocks.prisma.user.findMany.mockResolvedValue([
      { id: "u1", name: "Alice", email: "a@x.z", image: null },
    ]);
    const res = await call(handleJolliEduAuditLogs, {
      method: "GET",
      query: { orgId: "org-1" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().auditLogs[0].actor.body.name).toBe("Alice");
  });
});

describe("jolliedu org deletion handler", () => {
  beforeEach(() => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-1" });
  });

  it("400s without confirm=true", async () => {
    const res = await call(handleJolliEduOrgDeletion, {
      method: "DELETE",
      query: { orgId: "org-1" },
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("409s while non-deleted projects remain", async () => {
    mocks.prisma.project.count.mockResolvedValueOnce(2);
    const res = await call(handleJolliEduOrgDeletion, {
      method: "DELETE",
      query: { orgId: "org-1", confirm: "true" },
    });
    expect(res._getStatusCode()).toBe(409);
    expect(mocks.prisma.organization.delete).not.toHaveBeenCalled();
  });

  it("409s while soft-deleted projects are still being purged", async () => {
    // First count (non-deleted) is 0, second count (all projects) is > 0.
    mocks.prisma.project.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const res = await call(handleJolliEduOrgDeletion, {
      method: "DELETE",
      query: { orgId: "org-1", confirm: "true" },
    });
    expect(res._getStatusCode()).toBe(409);
    expect(mocks.prisma.organization.delete).not.toHaveBeenCalled();
  });

  it("deletes, invalidates cache, and audits when no projects remain", async () => {
    mocks.prisma.project.count.mockResolvedValue(0);
    mocks.prisma.organization.delete.mockResolvedValue({ id: "org-1" });
    const res = await call(handleJolliEduOrgDeletion, {
      method: "DELETE",
      query: { orgId: "org-1", confirm: "true" },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.invalidateCachedOrgApiKeys).toHaveBeenCalledWith("org-1");
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "organization",
        action: "delete",
      }),
    );
  });
});

describe("jolliedu project deletion handler", () => {
  beforeEach(() => {
    mocks.prisma.project.findFirst.mockResolvedValue({
      id: "proj-1",
      orgId: "org-1",
    });
  });

  it("returns 503 and performs no destructive step when the queue is unavailable", async () => {
    mocks.getInstance.mockReturnValue(null);
    const res = await call(handleJolliEduProjectDeletion, {
      method: "DELETE",
      query: { projectId: "proj-1", confirm: "true" },
    });
    expect(res._getStatusCode()).toBe(503);
    expect(mocks.invalidateCachedProjectApiKeys).not.toHaveBeenCalled();
    expect(mocks.prisma.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it("soft-deletes, enqueues, and audits when the queue is available", async () => {
    mocks.getInstance.mockReturnValue({ add: mocks.queueAdd });
    const res = await call(handleJolliEduProjectDeletion, {
      method: "DELETE",
      query: { projectId: "proj-1", confirm: "true" },
    });
    expect(res._getStatusCode()).toBe(202);
    expect(mocks.prisma.project.update).toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "project", action: "delete" }),
    );
  });
});

describe("jolliedu trace deletion handler", () => {
  beforeEach(() => {
    mocks.prisma.project.findFirst.mockResolvedValue({
      id: "proj-1",
      orgId: "org-1",
    });
  });

  it("reports skipped (200) and neither processes nor audits when the project is skip-listed", async () => {
    mocks.shouldSkipDeletionFor.mockResolvedValue(true);
    const res = await call(handleJolliEduTraceDeletion, {
      method: "POST",
      query: { projectId: "proj-1" },
      body: { traceIds: ["t1"] },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().status).toBe("skipped");
    expect(mocks.traceDeletionProcessor).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("enqueues (202) and audits when the project is not skip-listed", async () => {
    mocks.shouldSkipDeletionFor.mockResolvedValue(false);
    const res = await call(handleJolliEduTraceDeletion, {
      method: "POST",
      query: { projectId: "proj-1" },
      body: { traceIds: ["t1", "t2"] },
    });
    expect(res._getStatusCode()).toBe(202);
    expect(mocks.traceDeletionProcessor).toHaveBeenCalledWith("proj-1", [
      "t1",
      "t2",
    ]);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "trace", action: "delete" }),
    );
  });
});
