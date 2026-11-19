import type { Config } from "../../src/config.js";
import type { Snapshot } from "../../src/data/snapshot.js";
import type { Billing, OperationContext } from "../../src/operations/types.js";

/** An anonymous caller's context: free operations only. */
export function anonymousContext(config: Config, snapshot: Snapshot | null): OperationContext {
  return { config, snapshot, caller: null, billing: fixedBilling(0), services: null };
}

/** Billing with a fixed budget, for unit-testing paid operations without a database. */
export function fixedBilling(available: number, opts: { maxResults?: number | null; canExport?: boolean } = {}): Billing {
  return {
    available,
    maxResults: opts.maxResults ?? null,
    canExport: opts.canExport ?? true,
    require(credits: number) {
      if (credits > available) throw new Error(`insufficient credits: ${credits} > ${available}`);
    },
  };
}
