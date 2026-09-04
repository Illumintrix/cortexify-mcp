// Remote (HTTP) MCP endpoint for Vercel serverless.
// Exposes the same Cortexify tools as the stdio server over the MCP
// Streamable HTTP transport, protected by a shared secret token.
//
// Auth: clients must send the token as either
//   - an `Authorization: Bearer <token>` header, or
//   - a `?token=<token>` query parameter (for clients that cannot set headers)
// The token is set via the MCP_AUTH_TOKEN env var on Vercel.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCortexifyMcpServer } from '../src/tools.js';

function checkAuth(req) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return { ok: false, status: 500, error: 'MCP_AUTH_TOKEN is not configured on the server' };
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const url = new URL(req.url, 'https://localhost');
  const queryToken = url.searchParams.get('token');
  const provided = bearer || queryToken;
  if (!provided || provided !== expected) return { ok: false, status: 401, error: 'Unauthorized: valid token required' };
  return { ok: true };
}

export default async function handler(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Stateless mode: a fresh server + transport per request (serverless-safe).
  const server = createCortexifyMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP request failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal MCP server error' });
  }
}
