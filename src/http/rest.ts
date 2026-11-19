import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { log } from "../log.js";
import { envelope } from "../operations/envelope.js";
import { OperationError, type Operation, type OperationContext } from "../operations/types.js";

/** Mounts each operation at /v1<path>, sharing its schema and handler with MCP. */
export function restRouter(
  operations: Operation<z.ZodRawShape, unknown>[],
  getContext: () => OperationContext,
): Router {
  const router = Router();
  for (const op of operations) {
    router[op.rest.method](op.rest.path, async (req: Request, res: Response) => {
      const raw = op.rest.method === "get" ? { ...req.query, ...req.params } : { ...req.body, ...req.params };
      const ctx = getContext();
      try {
        const input = parseInput(op, raw);
        const result = await op.run(input, ctx);
        res.json(envelope(result, ctx));
      } catch (err) {
        sendError(res, err, op.name);
      }
    });
  }
  return router;
}

export function parseInput(op: Operation<z.ZodRawShape, unknown>, raw: unknown) {
  const parsed = op.input.safeParse(raw);
  if (!parsed.success) {
    throw new OperationError("invalid_input", "Some inputs are missing or invalid.", {
      issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export function toOperationError(err: unknown, opName: string): OperationError {
  if (err instanceof OperationError) return err;
  log.error({ err, op: opName }, "operation failed");
  return new OperationError("internal", "Something went wrong on our side.");
}

function sendError(res: Response, err: unknown, opName: string) {
  const opErr = toOperationError(err, opName);
  res.status(opErr.httpStatus).json(opErr.toJSON());
}
