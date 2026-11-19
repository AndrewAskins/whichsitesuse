import type { Snapshot } from "../data/snapshot.js";
import { OperationError, type OperationContext } from "./types.js";

export function requireSnapshot(ctx: OperationContext): Snapshot {
  if (!ctx.snapshot) {
    throw new OperationError(
      "snapshot_unavailable",
      "The dataset is loading or not built yet. Try again in a few minutes.",
    );
  }
  return ctx.snapshot;
}
