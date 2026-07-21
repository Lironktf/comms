#!/usr/bin/env node
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {ActpClient} from "@actp/sdk";
import {ACTP_TOOLS} from "./tools.js";

/**
 * Wire ACTP's tools onto an MCP server. Each tool calls a running ACTP backend via the SDK,
 * so the MCP process is a thin adapter — agents get merchant checks and purchase decisions
 * as native tools.
 */
export function buildMcpServer(client: ActpClient): McpServer {
  const server = new McpServer({name: "actp", version: "0.1.0"});
  for (const tool of ACTP_TOOLS) {
    server.tool(tool.name, tool.description, tool.schema.shape, async (args: Record<string, unknown>) => {
      try {
        const {summary, data} = await tool.handler(client, args);
        return {
          content: [{type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}`}],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{type: "text" as const, text: `ACTP error: ${(e as Error).message}`}],
        };
      }
    });
  }
  return server;
}

async function main(): Promise<void> {
  const apiUrl = process.env.ACTP_API_URL ?? "http://localhost:8402";
  const client = new ActpClient({
    apiUrl,
    ...(process.env.ACTP_API_KEY ? {apiKey: process.env.ACTP_API_KEY} : {}),
    ...(process.env.RPC_URL ? {rpcUrl: process.env.RPC_URL} : {}),
  });
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(`[actp-mcp] serving ${ACTP_TOOLS.length} tools against ${apiUrl}`);
}

// run only when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
