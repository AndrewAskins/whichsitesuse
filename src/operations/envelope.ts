import { ATTRIBUTION } from "../config.js";
import type { OperationContext, OperationResult } from "./types.js";

export interface Envelope<T> {
  data: T;
  meta: {
    crawl_date: string | null;
    credits_used: number;
    /** The caller's balance after this call; null for anonymous calls. */
    credits_remaining: number | null;
    attribution: string;
  };
}

/** Every response, MCP or REST, carries the crawl date, credits and attribution. */
export function envelope<T>(
  result: OperationResult<T>,
  ctx: Pick<OperationContext, "snapshot">,
  creditsRemaining: number | null = null,
): Envelope<T> {
  return {
    data: result.data,
    meta: {
      crawl_date: ctx.snapshot?.manifest.crawl_date ?? null,
      credits_used: result.credits_used,
      credits_remaining: creditsRemaining,
      attribution: ATTRIBUTION,
    },
  };
}
