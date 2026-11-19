import { findTechnologies } from "./findTechnologies.js";
import type { Operation } from "./types.js";

/** Every MCP tool and REST endpoint, in the order agents should see them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const operations: Operation<any, any>[] = [findTechnologies];
