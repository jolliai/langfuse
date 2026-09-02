import { type NextApiResponse } from "next";
import * as z from "zod";
import { logger } from "@langfuse/shared/src/server";

/**
 * Shared error responder for the jolliedu handlers. Zod validation failures
 * become 400s (with issue details); anything else is logged and returned as a
 * generic 500. Keeps the handlers free of a duplicated catch block without
 * coupling this self-built surface to the public-API middleware stack.
 */
export function respondJolliEduError(
  res: NextApiResponse,
  e: unknown,
  logContext: string,
): void {
  if (e instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: e.issues });
    return;
  }
  logger.error(logContext, e);
  res.status(500).json({ error: "Internal server error" });
}

/**
 * Pagination inputs shared by the jolliedu list endpoints. `page` is
 * 0-indexed; `limit` is capped so a single call cannot return an unbounded set.
 */
export const jolliEduPagination = {
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
