import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/app.js";

const serverJson = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("server.json for the MCP registry", () => {
  it("carries the same version as the service", () => {
    expect(serverJson.version).toBe(VERSION);
    expect(pkg.version).toBe(VERSION);
  });

  it("stays inside the official registry's limits", () => {
    expect(serverJson.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    for (const remote of serverJson.remotes) {
      expect(remote.type).toBe("streamable-http");
      expect(remote.url).toMatch(/^https:\/\/.+\/mcp$/);
    }
  });
});
