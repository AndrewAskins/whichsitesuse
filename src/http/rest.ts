import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { log } from "../log.js";
import { OperationError, type Operation } from "../operations/types.js";
import { wwwAuthenticate } from "../web/oauth.js";
import { credentialFrom, runOperation, type GateDeps } from "./gate.js";

/** Mounts each operation at /v1<path>, sharing its schema, handler and billing gate with MCP. */
export function restRouter(operations: Operation<z.ZodRawShape, unknown>[], deps: GateDeps): Router {
  const router = Router();
  for (const op of operations) {
    router[op.rest.method](op.rest.path, async (req: Request, res: Response) => {
      const raw = op.rest.method === "get" ? { ...req.query, ...req.params } : { ...req.body, ...req.params };
      try {
        const input = parseInput(op, raw);
        const body = await runOperation(
          op,
          input,
          { channel: "rest", credential: credentialFrom(req.headers), ip: req.ip ?? "unknown" },
          deps,
        );
        if (op.csv && input.format === "csv") {
          // Same charge as JSON; the meta the envelope carries moves to headers.
          res
            .type("text/csv")
            .set("Content-Disposition", `attachment; filename="${op.csv.filename}"`)
            .set("X-Credits-Used", String(body.meta.credits_used))
            .set("X-Credits-Remaining", body.meta.credits_remaining === null ? "" : String(body.meta.credits_remaining))
            .set("X-Crawl-Date", body.meta.crawl_date ?? "")
            .set("X-Attribution", body.meta.attribution);
          const next = (body.data as { next_cursor?: string | null }).next_cursor;
          if (next) res.set("X-Next-Cursor", next);
          res.send(op.csv.render(body.data));
          return;
        }
        res.json(body);
      } catch (err) {
        sendError(res, err, op.name, deps);
      }
    });
  }
  return router;
}

export function parseInput(op: Operation<z.ZodRawShape, unknown>, raw: unknown): Record<string, unknown> {
  const parsed = op.input.safeParse(raw);
  if (!parsed.success) {
    throw new OperationError("invalid_input", "Some inputs are missing or invalid.", {
      issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data as Record<string, unknown>;
}

export function toOperationError(err: unknown, opName: string): OperationError {
  if (err instanceof OperationError) return err;
  log.error({ err, op: opName }, "operation failed");
  return new OperationError("internal", "Something went wrong on our side.");
}

export function sendError(res: Response, err: unknown, opName: string, deps?: GateDeps) {
  const opErr = toOperationError(err, opName);
  // Points clients at OAuth discovery (RFC 9728), as MCP does.
  if (opErr.code === "unauthorized" && deps?.services) res.set("WWW-Authenticate", wwwAuthenticate(deps.services));
  if (opErr.code === "rate_limited") res.set("Retry-After", String(opErr.details.retry_after_seconds ?? 60));
  res.status(opErr.httpStatus).json(opErr.toJSON());
}
