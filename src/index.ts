import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === "") throw new Error(`[R2] Missing required env var: ${key}`);
  return val.trim();
}

function getConfig() {
  return {
    accountId: requireEnv("R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    bucketName: requireEnv("R2_BUCKET_NAME"),
    publicUrl: requireEnv("R2_PUBLIC_URL").replace(/\/$/, ""),
  };
}

type R2Config = ReturnType<typeof getConfig>;

// ─── R2 helpers ───────────────────────────────────────────────────────────────

function makeClient(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: "auto",
    service: "s3",
  });
}

function storageEndpoint(cfg: R2Config, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucketName}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function publicUrl(cfg: R2Config, key: string): string {
  return `${cfg.publicUrl}/${key}`;
}

async function uploadFile(
  key: string,
  data: Buffer,
  contentType: string,
  cacheControl?: string,
): Promise<{ key: string; url: string; size: number; content_type: string }> {
  const cfg = getConfig();
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(data.byteLength),
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;

  const res = await makeClient(cfg).fetch(storageEndpoint(cfg, key), {
    method: "PUT",
    headers,
    body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[R2] Upload failed for "${key}": HTTP ${res.status} — ${body}`);
  }

  return { key, url: publicUrl(cfg, key), size: data.byteLength, content_type: contentType };
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "r2-mcp-server", version: "1.0.0" });

// @ts-expect-error - registerTool type inference too deep with zod@3.25 + @modelcontextprotocol/sdk@1.29
server.registerTool(
  "r2_file",
  {
    title: "R2 File — Upload or Get URL",
    description: `Upload a file to Cloudflare R2, or get the public URL for an existing key.

UPLOAD  (action="upload"):
  Requires: key, data (base64), content_type.
  Optional: cache_control.
  Returns: { key, url, size, content_type }

GET URL (action="download"):
  Requires: key only — no R2 request is made, URL is constructed from R2_PUBLIC_URL + key.
  Returns: { key, url }`,
    inputSchema: z
      .object({
        action: z.enum(["upload", "download"]),
        key: z.string().min(1).describe('Storage path, e.g. "images/hero.png"'),
        data: z.string().optional().describe("Base64-encoded file contents (upload only)"),
        content_type: z.string().optional().describe('MIME type (upload only), e.g. "image/png"'),
        cache_control: z.string().optional().describe('Cache-Control header (upload only), e.g. "public, max-age=31536000, immutable"'),
      }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ action, key, data, content_type, cache_control }: { action: "upload" | "download"; key: string; data?: string; content_type?: string; cache_control?: string }) => {
    let output: object;

    if (action === "upload") {
      if (!data) throw new Error('[r2_file] "data" is required for upload');
      if (!content_type) throw new Error('[r2_file] "content_type" is required for upload');
      output = await uploadFile(key, Buffer.from(data, "base64"), content_type, cache_control);
    } else {
      const cfg = getConfig();
      output = { key, url: publicUrl(cfg, key) };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output as Record<string, unknown>,
    };
  },
);

// @ts-expect-error - registerTool type inference too deep with zod@3.25 + @modelcontextprotocol/sdk@1.29
server.registerTool(
  "r2_batch",
  {
    title: "R2 Batch — Upload or Get URLs",
    description: `Upload multiple files to Cloudflare R2, or get public URLs for multiple existing keys. Max 100 per call.

BATCH UPLOAD  (action="upload"):
  Each file: { key, data (base64), content_type, cache_control? }
  Returns array of { key, url, size, content_type }.
  Runs with up to \`concurrency\` parallel requests. Per-file errors included as { key, error }.

BATCH GET URL (action="download"):
  Each file: { key } only — no R2 requests made.
  Returns array of { key, url }.`,
    inputSchema: z
      .object({
        action: z.enum(["upload", "download"]),
        files: z
          .array(
            z.object({
              key: z.string().min(1),
              data: z.string().optional(),
              content_type: z.string().optional(),
              cache_control: z.string().optional(),
            }),
          )
          .min(1)
          .max(100),
        concurrency: z.number().int().min(1).max(10).default(5),
      }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ action, files, concurrency }: { action: "upload" | "download"; files: Array<{ key: string; data?: string; content_type?: string; cache_control?: string }>; concurrency: number }) => {
    type UploadResult = { key: string; url: string; size: number; content_type: string };
    type UrlResult = { key: string; url: string };
    type ErrorResult = { key: string; error: string };
    type FileResult = UploadResult | UrlResult | ErrorResult;

    let results: FileResult[];

    if (action === "download") {
      const cfg = getConfig();
      results = files.map((f: { key: string; data?: string; content_type?: string; cache_control?: string }) => ({ key: f.key, url: publicUrl(cfg, f.key) }));
    } else {
      const tasks = files.map(
        (file: { key: string; data?: string; content_type?: string; cache_control?: string }) => async (): Promise<FileResult> => {
          try {
            if (!file.data) throw new Error(`"data" is required for upload (key: "${file.key}")`);
            if (!file.content_type) throw new Error(`"content_type" is required for upload (key: "${file.key}")`);
            return await uploadFile(file.key, Buffer.from(file.data, "base64"), file.content_type, file.cache_control);
          } catch (err: unknown) {
            return { key: file.key, error: err instanceof Error ? err.message : String(err) };
          }
        },
      );
      results = await runWithConcurrency(tasks, concurrency);
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => !("error" in r)).length,
      failed: results.filter((r) => "error" in r).length,
      results,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary as Record<string, unknown>,
    };
  },
);

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "r2-mcp-server", version: "1.0.0" });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({ name: "r2-mcp-server", version: "1.0.0", tools: ["r2_file", "r2_batch"], mcp_endpoint: "/mcp" });
});

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
    if (!res.headersSent) res.status(500).json({ error: message });
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`r2-mcp-server listening on http://0.0.0.0:${PORT}/mcp`);

  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
  } else {
    console.log(`Bucket: ${process.env.R2_BUCKET_NAME} — Public URL: ${process.env.R2_PUBLIC_URL}`);
  }
});
