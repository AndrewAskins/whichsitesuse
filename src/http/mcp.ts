import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import { envelope } from "../operations/envelope.js";
import type { Operation, OperationContext } from "../operations/types.js";
import { parseInput, toOperationError } from "./rest.js";

export const MCP_INSTRUCTIONS =
  "WhichSitesUse answers two questions: which sites use a technology, and what a domain runs. " +
  "Start with find_technologies to get canonical slugs. count_sites is free and shows what a full " +
  "list would cost before you spend anything; pass max_credits on paid calls to cap spend. " +
  "Every response includes the crawl date, credits used and left, and an attribution line to keep.";

export function buildMcpServer(
  operations: Operation<z.ZodRawShape, unknown>[],
  ctx: OperationContext,
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
          const result = await op.run(parseInput(op, args), ctx);
          const body = envelope(result, ctx);
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
  getContext: () => OperationContext,
  version: string,
) {
  return async (req: Request, res: Response) => {
    const server = buildMcpServer(operations, getContext(), version);
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
