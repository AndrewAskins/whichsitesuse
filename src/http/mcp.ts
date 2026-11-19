import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import type { Operation } from "../operations/types.js";
import { credentialFrom, runOperation, type CallInfo, type GateDeps } from "./gate.js";
import { wwwAuthenticate } from "../web/oauth.js";
import { parseInput, toOperationError } from "./rest.js";

export const MCP_INSTRUCTIONS =
  "WhichSitesUse answers two questions: which sites use a technology, and what a domain runs. " +
  "Start with find_technologies to get canonical slugs. count_sites is free and shows what a full " +
  "list would cost before you spend anything; pass max_credits on paid calls to cap spend. " +
  "Every response includes the crawl date, credits used and left, and an attribution line to keep. " +
  "Sign in with OAuth or send an API key as a Bearer token. When credits run out, call buy_credits and give the " +
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
        // Directories check these. No tool deletes or overwrites anything: buy_credits only
        // makes a checkout link that a human opens and pays.
        annotations: {
          readOnlyHint: op.rest.method === "get",
          destructiveHint: false,
          idempotentHint: op.rest.method === "get",
          openWorldHint: false,
        },
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
    // With accounts on, MCP needs a credential. Claude, ChatGPT and other clients only start
    // OAuth when the transport answers 401 with WWW-Authenticate, so this can't be a tool error.
    if (deps.services) {
      const found = call.credential ? await deps.services.accounts.authenticate(call.credential) : null;
      if (!found) {
        res
          .status(401)
          .set("WWW-Authenticate", wwwAuthenticate(deps.services, call.credential ? "invalid_token" : undefined))
          .json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Sign in to WhichSitesUse (OAuth) or send an API key as a Bearer token." },
            id: null,
          });
        return;
      }
      call.caller = found;
    }
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
