# r2-mcp-server

Cloudflare R2 MCP server. Two tools. Deploy to Railway. Done.

## Tools

### `r2_file` — Single file upload or download

**Upload** → pass `action="upload"`, `key`, `data` (base64), `content_type` → returns `{ key, url, size, content_type }`

**Download** → pass `action="download"`, `key` → returns `{ key, data (base64), content_type, size, etag }`

---

### `r2_batch` — Batch upload or download (up to 100 files)

Same as `r2_file` but takes `files: []` array. Runs up to 5 concurrent requests (configurable). Per-file errors don't abort the batch — failed files get an `error` field in the result.

---

## Deploy to Railway

### 1. Create Railway project

```bash
railway new
railway link
```

### 2. Set environment variables in Railway dashboard

```
R2_ACCOUNT_ID        = your cloudflare account id
R2_ACCESS_KEY_ID     = your r2 api token access key
R2_SECRET_ACCESS_KEY = your r2 api token secret
R2_BUCKET_NAME       = your-bucket-name
R2_PUBLIC_URL        = https://assets.yourdomain.com   (no trailing slash)
```

### 3. Deploy

```bash
railway up
```

Railway auto-detects the Dockerfile. `PORT` is set automatically.

---

## MCP Endpoint

```
POST https://your-railway-app.up.railway.app/mcp
```

### Add to Claude / any MCP client

```json
{
  "mcpServers": {
    "r2": {
      "url": "https://your-railway-app.up.railway.app/mcp"
    }
  }
}
```

---

## R2 API Token Setup

1. Cloudflare Dashboard → **R2** → **Manage R2 API Tokens**
2. Create token with **Object Read & Write** on your bucket
3. Copy **Access Key ID** and **Secret Access Key** → set as env vars

---

## Local Dev

```bash
cp .env.example .env
# fill in your values

npm install
npm run build
npm start
```

---

## Health Check

```
GET /health → { status: "ok", server: "r2-mcp-server", version: "1.0.0" }
```