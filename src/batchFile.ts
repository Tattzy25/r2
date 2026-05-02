import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uploadFile, downloadFile } from "../r2Client.js";

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export function registerBatchFileTool(server: McpServer): void {
  server.registerTool(
    "r2_batch",
    {
      title: "R2 Batch Upload / Download",
      description: `Upload or download multiple files from Cloudflare R2 in parallel.

BATCH UPLOAD:
  Pass action="upload" and an array of files, each with key, base64 data, and content_type.
  Returns an array of results — each with key, public URL, size, and content_type.
  Files are processed with up to 5 concurrent requests.

BATCH DOWNLOAD:
  Pass action="download" and an array of files, each with just a key.
  Returns an array of results — each with key, base64 data, content_type, size, and etag.
  Per-file errors do NOT abort the batch — failed items include an "error" field.

Args:
  - action ("upload" | "download"): Operation for all files in the batch
  - files (array): List of file descriptors:
      For upload: { key, data, content_type, cache_control? }
      For download: { key }
  - concurrency (number, optional): Max parallel requests, 1–10, default 5

Returns:
  Array of per-file results in the same order as input.
  Upload result: { key, url, size, content_type }
  Download result: { key, data, content_type, size, etag }
  Error result: { key, error } — partial failure, other files still processed

Max batch size: 100 files per call. Split larger batches across multiple calls.

Errors:
  - Throws immediately if batch exceeds 100 files (use multiple calls)
  - Throws if env vars are missing
  - Per-file failures are captured in the result array, not thrown`,
      inputSchema: z
        .object({
          action: z
            .enum(["upload", "download"])
            .describe("Operation for all files in the batch"),
          files: z
            .array(
              z
                .object({
                  key: z
                    .string()
                    .min(1)
                    .describe('Storage key, e.g. "images/photo-01.jpg"'),
                  data: z
                    .string()
                    .optional()
                    .describe("Base64-encoded file contents (upload only)"),
                  content_type: z
                    .string()
                    .optional()
                    .describe('MIME type (upload only), e.g. "image/jpeg"'),
                  cache_control: z
                    .string()
                    .optional()
                    .describe("Cache-Control header (upload only)"),
                })
                .strict(),
            )
            .min(1)
            .max(100)
            .describe("Files to upload or download. Max 100 per call."),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(10)
            .default(5)
            .describe("Max parallel requests (default 5, max 10)"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ action, files, concurrency }) => {
      type FileResult =
        | { key: string; url: string; size: number; content_type: string }
        | {
            key: string;
            data: string;
            content_type: string;
            size: number;
            etag: string | null;
          }
        | { key: string; error: string };

      if (files.length > 100) {
        throw new Error(
          `[r2_batch] Batch size ${files.length} exceeds limit of 100. Split into multiple calls.`,
        );
      }

      const tasks = files.map((file) => async (): Promise<FileResult> => {
        try {
          if (action === "upload") {
            if (!file.data) {
              throw new Error(
                `"data" is required for upload (key: "${file.key}")`,
              );
            }
            if (!file.content_type) {
              throw new Error(
                `"content_type" is required for upload (key: "${file.key}")`,
              );
            }
            const buffer = Buffer.from(file.data, "base64");
            const result = await uploadFile(
              file.key,
              buffer,
              file.content_type,
              file.cache_control,
            );
            return {
              key: result.key,
              url: result.url,
              size: result.size,
              content_type: result.contentType,
            };
          } else {
            const result = await downloadFile(file.key);
            const { getConfig } = await import("../r2Client.js");
            const cfg = getConfig();
            return {
              key: result.key,
              url: `${cfg.publicUrl.replace(/\/$/, "")}/${result.key}`,
              content_type: result.contentType,
              size: result.size,
              etag: result.etag,
            };
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { key: file.key, error: message };
        }
      });

      const results = await runWithConcurrency(tasks, concurrency);

      const summary = {
        total: results.length,
        succeeded: results.filter((r) => !("error" in r)).length,
        failed: results.filter((r) => "error" in r).length,
        results,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
        structuredContent: summary,
      };
    },
  );
}
