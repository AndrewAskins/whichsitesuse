import { buyCredits } from "./buyCredits.js";
import { countSites } from "./countSites.js";
import { findTechnologies } from "./findTechnologies.js";
import { getBalance } from "./getBalance.js";
import { lookupDomain } from "./lookupDomain.js";
import { searchSites } from "./searchSites.js";
import type { Operation } from "./types.js";

/** Every MCP tool and REST endpoint, in the order agents should see them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const operations: Operation<any, any>[] = [
  findTechnologies,
  countSites,
  searchSites,
  lookupDomain,
  getBalance,
  buyCredits,
];
