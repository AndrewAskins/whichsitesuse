import type { z } from "zod";
import type { Config } from "../config.js";
import type { Snapshot } from "../data/snapshot.js";

export interface OperationContext {
  config: Config;
  /** The loaded monthly snapshot, or null while none is available. */
  snapshot: Snapshot | null;
}

export interface OperationResult<T> {
  data: T;
  /** WhichSitesUse credits this call spent. */
  credits_used: number;
}

/**
 * One operation, served both as an MCP tool and as a REST endpoint. MCP and
 * REST are two doors onto the same list, so there is one definition of each
 * tool's name, input, description and cost.
 */
export interface Operation<S extends z.ZodRawShape = z.ZodRawShape, T = unknown> {
  /** MCP tool name. */
  name: string;
  title: string;
  /** Written for agents: what it does, when to call it, what it costs. */
  description: string;
  rest: { method: "get" | "post"; path: string };
  input: z.ZodObject<S>;
  run(input: z.infer<z.ZodObject<S>>, ctx: OperationContext): Promise<OperationResult<T>>;
}

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "insufficient_credits"
  | "not_found"
  | "rate_limited"
  | "snapshot_unavailable"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  insufficient_credits: 402,
  not_found: 404,
  rate_limited: 429,
  snapshot_unavailable: 503,
  internal: 500,
};

export class OperationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}
