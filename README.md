# cortexify-mcp

MCP server for [Cortexify](https://www.cortexify.in) - your AI knowledge library.
Lets any MCP client (Claude Desktop, Cursor, Claude Code, etc.) read and write your
Cortexify library: saved links, documents, notes, collections, and the Cortex AI copilot.

## What it exposes

**Library (saved links)**
- `cortexify_list_items` - list saved links (filter unread / content type)
- `cortexify_get_item` - full item incl. extracted text
- `cortexify_search_library` - search links + documents + notes by title/summary/tags
- `cortexify_save_url` - save a URL; triggers AI processing (summary, tags, categories)
- `cortexify_mark_read` / `cortexify_delete_item`

**Documents**
- `cortexify_list_documents` / `cortexify_get_document`

**Notes**
- `cortexify_list_notes` / `cortexify_get_note` / `cortexify_create_note` / `cortexify_update_note` / `cortexify_delete_note`

**Collections**
- `cortexify_list_collections` (as a tree) / `cortexify_create_collection` / `cortexify_update_collection` / `cortexify_delete_collection`
- `cortexify_collection_contents` / `cortexify_add_to_collection` / `cortexify_remove_from_collection`

**Cortex AI**
- `cortexify_ask` - chat with the Copilot grounded in your library (optional collection scope, model: auto/gemini/openrouter)
- `cortexify_list_chats` / `cortexify_get_chat`

**Web + account**
- `cortexify_web_search` / `cortexify_web_extract` (Parallel integration)
- `cortexify_get_stats` (inbox count, weekly reads, completion rate)
- `cortexify_key_status` (which BYOK keys are set)


## Run it as a remote (hosted) server

The repo also ships a Vercel serverless endpoint at `api/mcp.js`, so you can use
Cortexify from Claude web / ChatGPT web (or any MCP client that supports remote
servers) without running anything locally.

Endpoint once deployed:

```
https://<your-vercel-deployment>/api/mcp
```

Auth: every request must carry the shared secret in `MCP_AUTH_TOKEN`, either as
an `Authorization: Bearer <token>` header or a `?token=<token>` query parameter.
Requests without a valid token get a 401.

### Deploy on Vercel

1. Import this repo in Vercel (Add New > Project > Import `cortexify-mcp`). No
   build step or framework preset needed - the function in `api/` is picked up
   automatically.
2. Set environment variables (Project Settings > Environment Variables):
   - `CORTEXIFY_EMAIL` + `CORTEXIFY_PASSWORD` (or `CORTEXIFY_ACCESS_TOKEN`)
   - `MCP_AUTH_TOKEN` - a long random string you generate; this is the token
     you paste into your MCP clients
3. Deploy. The MCP URL is `https://<project-domain>/api/mcp`.

### Connect from Claude web

Settings > Connectors > Add custom connector. URL:
`https://<project-domain>/api/mcp?token=<MCP_AUTH_TOKEN>` (or set the
`Authorization: Bearer` header under advanced settings if offered).

### Connect from ChatGPT web

Settings > Apps > Advanced > Developer mode, then create a custom connector with
the same URL and token.

The stdio server (below) keeps working unchanged - both modes share the same
tool implementations in `src/tools.js`.

## Setup

```bash
npm install
cp .env.example .env   # fill in CORTEXIFY_EMAIL / CORTEXIFY_PASSWORD
```

### Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "cortexify": {
      "command": "node",
      "args": ["/absolute/path/to/cortexify-mcp/src/index.js"],
      "env": {
        "CORTEXIFY_EMAIL": "you@example.com",
        "CORTEXIFY_PASSWORD": "your-password"
      }
    }
  }
}
```

## How it works

Cortexify's stack is a Vercel app over Supabase. This server talks to the same
backend the web app and the Chrome extension use:

- Supabase REST (row-level-security scoped to your user) for library/notes/collections.
- `POST /api/process-content` for AI ingest of URLs (same call the extension makes).
- `POST /api/cortex-ai` for the Copilot (SSE stream, aggregated for you).
- `POST /api/parallel-search` / `parallel-extract` for web tools (uses your Parallel key).

Auth is the standard Supabase password grant; the token auto-refreshes while the
server runs. Your password never leaves your machine except to Supabase's auth endpoint.

AI features (save_url processing, cortexify_ask, web_search) consume the BYOK keys
configured in Cortexify Settings - check `cortexify_key_status` if something errors
with `*_API_KEY_REQUIRED`.
