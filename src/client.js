// Cortexify API client.
// Cortexify = Vercel app (www.cortexify.in) + Supabase backend.
// Reads/writes go to Supabase REST (RLS-scoped to the user); AI ingest/chat go
// through the app's /api/* endpoints with the user's Supabase access token.

const SUPABASE_URL = process.env.CORTEXIFY_SUPABASE_URL || 'https://tfbujtucezcpxdzlhqrj.supabase.co';
const SUPABASE_ANON_KEY = process.env.CORTEXIFY_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmYnVqdHVjZXpjcHhkemxocXJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYwNTEyOTMsImV4cCI6MjA3MTYyNzI5M30.NZpjHHCd9Mj2nQxVd_fGMXVXiY6xrLleLIyfqkdCiJU';
const APP_URL = (process.env.CORTEXIFY_APP_URL || 'https://www.cortexify.in').replace(/\/$/, '');

export class CortexifyClient {
  constructor() {
    this._token = process.env.CORTEXIFY_ACCESS_TOKEN || null; // escape hatch: paste a session token
    this._refreshToken = null;
    this._expiresAt = this._token ? Number.POSITIVE_INFINITY : 0;
  }

  async token() {
    if (this._token && Date.now() < this._expiresAt - 30000) return this._token;
    const email = process.env.CORTEXIFY_EMAIL;
    const password = process.env.CORTEXIFY_PASSWORD;
    let body;
    if (this._refreshToken) {
      body = { refresh_token: this._refreshToken };
      return this._grant('refresh_token', body);
    }
    if (!email || !password) {
      throw new Error('Not authenticated. Set CORTEXIFY_EMAIL + CORTEXIFY_PASSWORD (or CORTEXIFY_ACCESS_TOKEN).');
    }
    return this._grant('password', { email, password });
  }

  async _grant(grantType, body) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      this._refreshToken = null;
      throw new Error(data.error_description || data.msg || `Auth failed (${res.status})`);
    }
    this._token = data.access_token;
    this._refreshToken = data.refresh_token || null;
    this._expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this._token;
  }

  async _headers(json = true) {
    const t = await this.token();
    return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${t}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  // Supabase PostgREST helper. path e.g. 'content?select=*&limit=10'
  async rest(path, init = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { ...(await this._headers()), Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error((await res.text()) || `Supabase error ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  // App serverless endpoint helper (Vercel /api/*).
  async api(path, { method = 'GET', body } = {}) {
    const t = await this.token();
    const res = await fetch(`${APP_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Cortexify API error ${res.status}`);
    }
    return res;
  }

  // POST /api/cortex-ai streams SSE "data: {chunk}" lines; aggregate them.
  async ask({ query, chatHistory = [], manifest = [], selectedCollectionId = null, model = 'auto' }) {
    const res = await this.api('/api/cortex-ai', {
      method: 'POST',
      body: { query, chatHistory, manifest, selectedCollectionId, model },
    });
    const text = await res.text();
    let answer = '';
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (typeof obj.chunk === 'string') answer += obj.chunk;
        else events.push(obj);
      } catch { /* ignore partial lines */ }
    }
    return { answer, events };
  }

  // Build the library "manifest" the Copilot expects: compact {id,title,tags,type} rows.
  async buildManifest() {
    const [content, documents, notes] = await Promise.all([
      this.rest('content?select=id,title,tags&order=created_at.desc'),
      this.rest('documents?select=id,title,file_name,tags&order=created_at.desc'),
      this.rest('notes?select=id,title&order=updated_at.desc'),
    ]);
    return [
      ...content.map((c) => ({ id: c.id, title: c.title, tags: c.tags || [], type: 'content' })),
      ...documents.map((d) => ({ id: d.id, title: d.title || d.file_name, tags: d.tags || [], type: 'document' })),
      ...notes.map((n) => ({ id: n.id, title: n.title || 'Untitled Note', tags: [], type: 'note' })),
    ];
  }
}
