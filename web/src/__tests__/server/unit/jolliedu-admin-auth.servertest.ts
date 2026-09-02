import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { vi } from "vitest";

// A high-entropy, fixed-length token (32 bytes hex-like).
const TOKEN = "a".repeat(64);

// Control the configured token through a mocked env object rather than
// mutating the real one, so the test cannot leak global state into others.
const mocks = vi.hoisted(() => ({
  env: {
    SELF_ADMIN_API_KEY: undefined as string | undefined,
    NEXT_PUBLIC_LANGFUSE_CLOUD_REGION: undefined as string | undefined,
  },
}));
vi.mock("@/src/env.mjs", () => ({ env: mocks.env }));

import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

function mockReqRes(headers?: Record<string, string>) {
  return createMocks<NextApiRequest, NextApiResponse>({ headers });
}

describe("verifyJolliEduAdminAuth", () => {
  beforeEach(() => {
    mocks.env.SELF_ADMIN_API_KEY = TOKEN;
    mocks.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION = undefined;
  });

  it("returns 403 on Langfuse Cloud even with a valid token and configured key", () => {
    mocks.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION = "us";
    const { req, res } = mockReqRes({ authorization: `Bearer ${TOKEN}` });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/cloud/i);
  });

  it("fails closed with 503 when SELF_ADMIN_API_KEY is not configured", () => {
    mocks.env.SELF_ADMIN_API_KEY = undefined;
    const { req, res } = mockReqRes({ authorization: `Bearer ${TOKEN}` });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().error).toMatch(/disabled/i);
  });

  it("returns 401 when the Authorization header is missing", () => {
    const { req, res } = mockReqRes();

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 401 when the Authorization header is not a Bearer token", () => {
    const { req, res } = mockReqRes({ authorization: `Basic ${TOKEN}` });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(401);
  });

  it("accepts a case-insensitive Bearer scheme (RFC 7235)", () => {
    const { req, res } = mockReqRes({ authorization: `bEaReR ${TOKEN}` });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(true);
    expect(res._isEndCalled()).toBe(false);
  });

  it("returns 401 for a wrong token of equal length", () => {
    const { req, res } = mockReqRes({
      authorization: `Bearer ${"b".repeat(64)}`,
    });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 401 for a wrong token of different length (length guard short-circuits timingSafeEqual)", () => {
    const { req, res } = mockReqRes({ authorization: "Bearer short" });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(false);
    expect(res._getStatusCode()).toBe(401);
  });

  it("authorizes a valid token without writing a response", () => {
    const { req, res } = mockReqRes({ authorization: `Bearer ${TOKEN}` });

    const ok = verifyJolliEduAdminAuth(req, res);

    expect(ok).toBe(true);
    expect(res._isEndCalled()).toBe(false);
  });
});
