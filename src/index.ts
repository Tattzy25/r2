import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { registerSingleFileTool } from "./tools/singleFile.js";
import { registerBatchFileTool } from "./tools/batchFile.js";

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "r2-mcp-server",
  version: "1.0.0",
});

registerSingleFileTool(server);
registerBatchFileTool(server);

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "50mb" })); // Large payloads for image data

// Health check — Railway uses this
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "r2-mcp-server", version: "1.0.0" });
});

// Root info
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "r2-mcp-server",
    version: "1.0.0",
    tools: ["r2_file", "r2_batch"],
    mcp_endpoint: "/mcp",
  });
});

// MCP endpoint — new transport per request (stateless, scales on Railway)
app.post("/mcp", async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP] Request error:", message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`r2-mcp-server listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Tools: r2_file, r2_batch`);

  // Fail fast on missing env at startup — no silent surprises at request time
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_URL",
  ];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
    console.error(
      "Server will start but ALL tool calls will fail until env vars are set.",
    );
  } else {
    console.log(`R2 bucket: ${process.env.R2_BUCKET_NAME}`);
    console.log(`Public URL: ${process.env.R2_PUBLIC_URL}`);
  }
});
