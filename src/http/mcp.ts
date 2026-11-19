import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import type { Operation } from "../operations/types.js";
import { credentialFrom, runOperation, type CallInfo, type GateDeps } from "./gate.js";
import { parseInput, toOperationError } from "./rest.js";

export const MCP_INSTRUCTIONS =
  "WhichSitesUse answers two questions: which sites use a technology, and what a domain runs. " +
  "Start with find_technologies to get canonical slugs. count_sites is free and shows what a full " +
  "list would cost before you spend anything; pass max_credits on paid calls to cap spend. " +
  "Every response includes the crawl date, credits used and left, and an attribution line to keep. " +
  "Paid tools need an API key (Authorization: Bearer). When credits run out, call buy_credits and give the " +
  "person you're working for the checkout link: a human pays, and the credits show on the next get_balance.";

export function buildMcpServer(
  operations: Operation<z.ZodRawShape, unknown>[],
  deps: GateDeps,
  call: CallInfo,
  version: string,
): McpServer {
  const server = new McpServer(
    { name: "whichsitesuse", title: "WhichSitesUse", version },
    { instructions: MCP_INSTRUCTIONS },
  );
  for (const op of operations) {
    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.input.shape,
        annotations: { readOnlyHint: op.rest.method === "get", openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const body = await runOperation(op, parseInput(op, args), call, deps);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(body) }],
            structuredContent: body as unknown as Record<string, unknown>,
          };
        } catch (err) {
          const opErr = toOperationError(err, op.name);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(opErr.toJSON()) }] };
        }
      },
    );
  }
  return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request. */
export function mcpHandler(
  operations: Operation<z.ZodRawShape, unknown>[],
  deps: GateDeps,
  version: string,
) {
  return async (req: Request, res: Response) => {
    const call: CallInfo = { channel: "mcp", credential: credentialFrom(req.headers), ip: req.ip ?? "unknown" };
    const server = buildMcpServer(operations, deps, call, version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
