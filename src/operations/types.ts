import type { z } from "zod";
import type { Account, ApiKey } from "../auth/accounts.js";
import type { Config } from "../config.js";
import type { Snapshot } from "../data/snapshot.js";
import type { Services } from "../services.js";

/** The signed-in caller: an account and the API key it called with. */
export interface Caller {
  account: Account;
  key: ApiKey;
}

/**
 * What this call may spend. Built by the REST/MCP gate before the handler runs;
 * the gate charges the handler's `credits_used` after it returns.
 */
export interface Billing {
  /** Credits this call may spend: balance, capped by the key's monthly cap and the call's max_credits. */
  readonly available: number;
  /** Most results one call may return (trial accounts), or null for no cap. */
  readonly maxResults: number | null;
  /** CSV export is for accounts that have paid. */
  readonly canExport: boolean;
  /** Throws insufficient_credits (HTTP 402, with checkout links) unless `credits` fit `available`. */
  require(credits: number): void;
}

export interface OperationContext {
  config: Config;
  /** The loaded monthly snapshot, or null while none is available. */
  snapshot: Snapshot | null;
  /** The signed-in caller, or null for an anonymous call (free operations only). */
  caller: Caller | null;
  billing: Billing;
  /** App database services, or null when the service runs without DATABASE_URL. */
  services: Services | null;
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
  /**
   * "paid" operations need a signed-in caller; "account" ones need one but are
   * free; "free" ones (the default) also answer anonymous, rate-limited calls.
   */
  pricing?: "free" | "account" | "paid";
  input: z.ZodObject<S>;
  run(input: z.infer<z.ZodObject<S>>, ctx: OperationContext): Promise<OperationResult<T>>;
  /** REST only: renders the result as CSV when the call passes format=csv. */
  csv?: { filename: string; render(data: T): string };
}

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "account_suspended"
  | "export_not_allowed"
  | "insufficient_credits"
  | "not_found"
  | "rate_limited"
  | "billing_unavailable"
  | "snapshot_unavailable"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  account_suspended: 403,
  export_not_allowed: 403,
  insufficient_credits: 402,
  not_found: 404,
  rate_limited: 429,
  billing_unavailable: 503,
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
