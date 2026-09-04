#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CortexifyClient } from './client.js';

const cx = new CortexifyClient();
const server = new McpServer({ name: 'cortexify', version: '1.0.0' });

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
const tool = (name, desc, schema, fn) =>
  server.registerTool(name, { description: desc, inputSchema: schema }, async (args) => {
    try { return ok(await fn(args)); } catch (e) { return fail(e); }
  });

// ---------- Library (saved links) ----------

tool('cortexify_list_items', 'List saved links in the Cortexify library (AI-summarized URLs).', {
  limit: z.number().int().min(1).max(100).default(20),
  unread_only: z.boolean().default(false),
  content_type: z.string().optional().describe('Filter by AI-assigned type, e.g. "Article"'),
}, async ({ limit, unread_only, content_type }) => {
  let q = `content?select=id,url,title,summary,tags,categories,content_type,is_read,created_at,estimated_read_time,parse_status&order=created_at.desc&limit=${limit}`;
  if (unread_only) q += '&is_read=eq.false';
  if (content_type) q += `&content_type=eq.${encodeURIComponent(content_type)}`;
  return cx.rest(q);
});

tool('cortexify_get_item', 'Get one library item in full, including extracted text content.', {
  id: z.string().uuid(),
}, async ({ id }) => (await cx.rest(`content?select=*&id=eq.${id}`))[0] || { error: 'not found' });

tool('cortexify_search_library', 'Full-text-ish search over library items, documents and notes (matches title/summary/tags).', {
  query: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
}, async ({ query, limit }) => {
  const q = encodeURIComponent(`*${query}*`);
  const [content, documents, notes] = await Promise.all([
    cx.rest(`content?select=id,url,title,summary,tags,content_type,is_read,created_at&or=(title.ilike.${q},summary.ilike.${q})&limit=${limit}`),
    cx.rest(`documents?select=id,title,file_name,summary,tags,is_read,created_at&or=(title.ilike.${q},summary.ilike.${q},file_name.ilike.${q})&limit=${limit}`),
    cx.rest(`notes?select=id,title,created_at,updated_at&title=ilike.${q}&limit=${limit}`),
  ]);
  return {
    links: content.map((c) => ({ ...c, type: 'content' })),
    documents: documents.map((d) => ({ ...d, type: 'document' })),
    notes: notes.map((n) => ({ ...n, type: 'note' })),
  };
});

tool('cortexify_save_url', 'Save a URL to Cortexify. Triggers AI processing (summary, tags, categories). Returns the new item id.', {
  url: z.string().url(),
  collection_id: z.string().uuid().optional().describe('Optionally file it straight into a collection'),
}, async ({ url, collection_id }) => {
  const dupe = await cx.rest(`content?select=id,title,url&url=eq.${encodeURIComponent(url)}&limit=1`);
  if (dupe[0]) return { duplicate: true, item: dupe[0] };
  const id = crypto.randomUUID();
  const res = await cx.api('/api/process-content', { method: 'POST', body: { type: 'url', payload: { url }, id } });
  const body = await res.json().catch(() => ({}));
  if (collection_id) {
    await cx.rest('collection_content?on_conflict=collection_id,content_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ collection_id, content_id: id }),
    });
  }
  return { id, duplicate: false, processing_started: true, detail: body };
});

tool('cortexify_mark_read', 'Mark a library item or document as read/unread.', {
  id: z.string().uuid(),
  kind: z.enum(['content', 'document']).default('content'),
  read: z.boolean().default(true),
}, async ({ id, kind, read }) => {
  const table = kind === 'document' ? 'documents' : 'content';
  return cx.rest(`${table}?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(read ? { is_read: true, read_at: new Date().toISOString() } : { is_read: false, read_at: null }),
  });
});

tool('cortexify_delete_item', 'Permanently delete a library item or document.', {
  id: z.string().uuid(),
  kind: z.enum(['content', 'document']).default('content'),
}, async ({ id, kind }) => {
  const table = kind === 'document' ? 'documents' : 'content';
  await cx.rest(`${table}?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { deleted: id, kind };
});

// ---------- Documents ----------

tool('cortexify_list_documents', 'List uploaded documents (PDFs/DOCX) with their AI summaries.', {
  limit: z.number().int().min(1).max(100).default(20),
  unread_only: z.boolean().default(false),
}, async ({ limit, unread_only }) => {
  let q = `documents?select=id,title,file_name,summary,tags,categories,is_read,status,image_url,created_at&order=created_at.desc&limit=${limit}`;
  if (unread_only) q += '&is_read=eq.false';
  return cx.rest(q);
});

tool('cortexify_get_document', 'Get one document in full, including extracted text.', {
  id: z.string().uuid(),
}, async ({ id }) => (await cx.rest(`documents?select=*&id=eq.${id}`))[0] || { error: 'not found' });

// ---------- Notes ----------

tool('cortexify_list_notes', 'List notes (titles + timestamps).', {
  limit: z.number().int().min(1).max(100).default(20),
}, async ({ limit }) => cx.rest(`notes?select=id,title,created_at,updated_at&order=updated_at.desc&limit=${limit}`));

tool('cortexify_get_note', 'Get one note with its full content.', {
  id: z.string().uuid(),
}, async ({ id }) => (await cx.rest(`notes?select=*&id=eq.${id}`))[0] || { error: 'not found' });

tool('cortexify_create_note', 'Create a note. Content is plain text or markdown-ish text.', {
  title: z.string(),
  content: z.string().default(''),
}, async ({ title, content }) => {
  const me = await cx.rest('notes?select=id&limit=0'); // validates auth
  const token = await cx.token();
  const payload = atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
  const user_id = JSON.parse(payload).sub;
  return (await cx.rest('notes', { method: 'POST', body: JSON.stringify({ title, content, user_id }) }))[0];
});

tool('cortexify_update_note', 'Update a note title and/or content.', {
  id: z.string().uuid(),
  title: z.string().optional(),
  content: z.string().optional(),
}, async ({ id, title, content }) => {
  const patch = { updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title;
  if (content !== undefined) patch.content = content;
  return cx.rest(`notes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
});

tool('cortexify_delete_note', 'Delete a note.', { id: z.string().uuid() }, async ({ id }) => {
  await cx.rest(`notes?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { deleted: id };
});

// ---------- Collections ----------

tool('cortexify_list_collections', 'List collections as a tree (collections can nest via parent_id).', {}, async () => {
  const rows = await cx.rest('collections?select=id,name,description,emoji,parent_id,created_at&order=created_at.desc');
  const byId = Object.fromEntries(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const r of Object.values(byId)) {
    if (r.parent_id && byId[r.parent_id]) byId[r.parent_id].children.push(r);
    else roots.push(r);
  }
  return roots;
});

tool('cortexify_create_collection', 'Create a collection (optionally nested under a parent).', {
  name: z.string(),
  description: z.string().default(''),
  emoji: z.string().default('📁'),
  parent_id: z.string().uuid().nullable().default(null),
}, async (args) => cx.rest('collections', { method: 'POST', body: JSON.stringify(args) }));

tool('cortexify_update_collection', 'Rename/re-emoji/re-parent a collection.', {
  id: z.string().uuid(),
  name: z.string().optional(),
  description: z.string().optional(),
  emoji: z.string().optional(),
  parent_id: z.string().uuid().nullable().optional(),
}, async ({ id, ...patch }) => {
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
  return cx.rest(`collections?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
});

tool('cortexify_delete_collection', 'Delete a collection (items inside are not deleted).', {
  id: z.string().uuid(),
}, async ({ id }) => {
  await cx.rest(`collections?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { deleted: id };
});

tool('cortexify_collection_contents', 'List everything inside a collection: links, documents, and the collection note.', {
  collection_id: z.string().uuid(),
}, async ({ collection_id }) => {
  const [links, docs, note] = await Promise.all([
    cx.rest(`collection_content?select=content(id,url,title,summary,tags,content_type,is_read,created_at)&collection_id=eq.${collection_id}`),
    cx.rest(`collection_documents?select=documents(id,title,file_name,summary,tags,is_read,created_at)&collection_id=eq.${collection_id}`),
    cx.rest(`collection_notes?select=id,content,updated_at&collection_id=eq.${collection_id}&limit=1`),
  ]);
  return {
    links: links.map((r) => r.content).filter(Boolean),
    documents: docs.map((r) => r.documents).filter(Boolean),
    collection_note: note[0] || null,
  };
});

tool('cortexify_add_to_collection', 'File a library item or document into a collection.', {
  collection_id: z.string().uuid(),
  item_id: z.string().uuid(),
  kind: z.enum(['content', 'document']).default('content'),
}, async ({ collection_id, item_id, kind }) => {
  const table = kind === 'document' ? 'collection_documents' : 'collection_content';
  const col = kind === 'document' ? 'document_id' : 'content_id';
  await cx.rest(`${table}?on_conflict=collection_id,${col}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ collection_id, [col]: item_id }),
  });
  return { added: item_id, to: collection_id, kind };
});

tool('cortexify_remove_from_collection', 'Remove an item or document from a collection (does not delete the item).', {
  collection_id: z.string().uuid(),
  item_id: z.string().uuid(),
  kind: z.enum(['content', 'document']).default('content'),
}, async ({ collection_id, item_id, kind }) => {
  const table = kind === 'document' ? 'collection_documents' : 'collection_content';
  const col = kind === 'document' ? 'document_id' : 'content_id';
  await cx.rest(`${table}?collection_id=eq.${collection_id}&${col}=eq.${item_id}`, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' },
  });
  return { removed: item_id, from: collection_id };
});

// ---------- Cortex AI (Copilot) ----------

tool('cortexify_ask', 'Ask Cortex AI (the Copilot) a question grounded in your library. Pass scoped_to_collection to limit context.', {
  query: z.string(),
  collection_id: z.string().uuid().nullable().default(null),
  model: z.enum(['auto', 'gemini', 'openrouter']).default('auto'),
  chat_history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
}, async ({ query, collection_id, model, chat_history }) => {
  const manifest = await cx.buildManifest();
  return cx.ask({ query, chatHistory: chat_history, manifest, selectedCollectionId: collection_id, model });
});

tool('cortexify_list_chats', 'List past Cortex AI conversations.', {
  limit: z.number().int().min(1).max(50).default(10),
}, async ({ limit }) => cx.rest(`ai_conversations?select=id,title,created_at,updated_at&order=updated_at.desc&limit=${limit}`));

tool('cortexify_get_chat', 'Get a full Cortex AI conversation transcript.', {
  id: z.string().uuid(),
}, async ({ id }) => (await cx.rest(`ai_conversations?select=*&id=eq.${id}`))[0] || { error: 'not found' });

// ---------- Web search/extract (Parallel) ----------

tool('cortexify_web_search', 'Web search via Cortexify’s Parallel integration.', {
  query: z.string(),
}, async ({ query }) => (await (await cx.api('/api/parallel-search', { method: 'POST', body: { query } })).json()));

tool('cortexify_web_extract', 'Extract structured content from a URL via Cortexify’s Parallel integration.', {
  url: z.string().url(),
  objective: z.string(),
}, async ({ url, objective }) => (await (await cx.api('/api/parallel-extract', { method: 'POST', body: { url, objective } })).json()));

// ---------- Account / stats ----------

tool('cortexify_get_stats', 'Library stats: inbox (unread) count, items read this week, completion rate.', {}, async () => {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const count = async (table, extra = '') => {
    const res = await fetch(`${process.env.CORTEXIFY_SUPABASE_URL || 'https://tfbujtucezcpxdzlhqrj.supabase.co'}/rest/v1/${table}?select=id${extra}`, {
      headers: { ...(await cx._headers()), Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = res.headers.get('content-range') || '*/0';
    return parseInt(cr.split('/')[1] || '0', 10);
  };
  const [links, docs, unreadLinks, unreadDocs, readThisWeek] = await Promise.all([
    count('content'), count('documents'),
    count('content', '&is_read=eq.false'), count('documents', '&is_read=eq.false'),
    count('content', `&read_at=gte.${weekAgo}`),
  ]);
  const total = links + docs;
  const inbox = unreadLinks + unreadDocs;
  return { total_items: total, links, documents: docs, inbox_unread: inbox, read_this_week: readThisWeek, completion_rate: total ? Math.round(((total - inbox) / total) * 100) : 0 };
});

tool('cortexify_key_status', 'Check which BYOK AI keys (Gemini/OpenRouter/Parallel) are configured on the account.', {}, async () =>
  (await cx.api('/api/user-api-keys')).json());

await server.connect(new StdioServerTransport());
console.error('cortexify-mcp running on stdio');
