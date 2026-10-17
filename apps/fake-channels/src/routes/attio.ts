import express, { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'attio';

// Real Attio returns each field value as an array of typed objects, e.g.
//   { name: [{ value: 'Acme' }], domains: [{ domain: 'acme.com' }] }
// Tests / dev:inject post simple values for ergonomics, e.g.
//   { name: 'Acme', domains: ['acme.com'] }
// Wrap them up so consumers (record fetcher → buildRecordData) parse
// the same way as against real Attio.
function wrapValue(key: string, v: unknown): { [k: string]: unknown } {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    if (key === 'domains' || key === 'domain') return { domain: v };
    if (key === 'email_addresses' || key === 'email') return { email_address: v };
    return { value: v };
  }
  return v as { [k: string]: unknown };
}

/**
 * Minimal Attio-shaped filter matcher. Supports the shapes the TG Attio
 * adapter sends via `queryRecordsWithFilter`, plus the comparators an author's
 * WHERE can reach through it:
 *   - `{ slug: { $eq: value } }`         — equality
 *   - `{ slug: { $in: [values] } }`      — membership
 *   - `{ slug: { $contains: substr } }`  — case-insensitive substring
 *   - `{ slug: scalar }`                  — shorthand for $eq
 *   - `{ $or: [...] }` / `{ $and: [...] }` / `{ $not: {...} }`
 *   - multiple slug keys in one object    — implicit AND
 *
 * Attio's actual filter API supports a richer grammar (range comparators,
 * parent_record_id, etc.) — extend this when tests need it.
 */
function matchesAttioFilter(record: unknown, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return true;
  const f = filter as Record<string, unknown>;
  if (Array.isArray(f.$or) && !f.$or.some((sub) => matchesAttioFilter(record, sub))) return false;
  if (Array.isArray(f.$and) && !f.$and.every((sub) => matchesAttioFilter(record, sub))) return false;
  if (f.$not !== undefined && matchesAttioFilter(record, f.$not)) return false;
  for (const [slug, predicate] of Object.entries(f)) {
    if (slug.startsWith('$')) continue; // already handled
    if (!matchesValuePredicate(record, slug, predicate)) return false;
  }
  return true;
}

/** The strings one stored value compares as. Real Attio filters a status or
 *  select by its title, so `{ status: { title: 'Passed' } }` and
 *  `{ option: { title: 'Passed' } }` compare as "Passed"; scalar-wrapped
 *  values (`{ value }`, `{ domain }`, …) compare as their scalar. */
function comparableStrings(item: unknown): string[] {
  if (item == null) return [];
  if (typeof item !== 'object') return [String(item)];
  return Object.values(item as Record<string, unknown>).flatMap((c) => {
    if (c == null) return [];
    if (typeof c !== 'object') return [String(c)];
    const title = (c as Record<string, unknown>).title;
    return typeof title === 'string' ? [title] : [];
  });
}

function matchesValuePredicate(
  record: unknown,
  slug: string,
  predicate: unknown,
): boolean {
  const values =
    (record as { values?: Record<string, unknown> } | null)?.values?.[slug];
  const items: unknown[] = Array.isArray(values) ? values : [values];
  const candidates = items.flatMap(comparableStrings).map((s) => s.toLowerCase());

  const p =
    predicate && typeof predicate === 'object' && !Array.isArray(predicate)
      ? (predicate as Record<string, unknown>)
      : { $eq: predicate };
  if ('$in' in p) {
    const targets = (Array.isArray(p.$in) ? p.$in : [p.$in]).map((t) => String(t ?? '').toLowerCase());
    return candidates.some((c) => targets.includes(c));
  }
  if ('$contains' in p) {
    const target = String(p.$contains ?? '').toLowerCase();
    return candidates.some((c) => c.includes(target));
  }
  // `$eq`, or an unknown wrapper treated as the shorthand's value.
  const target = String(('$eq' in p ? p.$eq : predicate) ?? '').toLowerCase();
  return candidates.some((c) => c === target);
}

function normalizeValues(values: Record<string, unknown>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, val] of Object.entries(values)) {
    if (Array.isArray(val)) {
      // already an array — wrap any primitive entries as typed objects
      out[key] = val.map((v) => wrapValue(key, v));
    } else if (val == null) {
      out[key] = [];
    } else {
      out[key] = [wrapValue(key, val)];
    }
  }
  return out;
}

export function attioRoutes(store: EntityStore): Router {
  const r = Router();

  // Self
  r.get('/v2/self', (_req, res) => {
    res.json({ workspace_slug: 'test-workspace' });
  });

  // Lists
  r.get('/v2/lists', (_req, res) => {
    const lists = store.list(SVC, 'list');
    res.json({ data: lists.map((l) => l.data) });
  });

  // Objects
  r.get('/v2/objects', (_req, res) => {
    const objects = store.list(SVC, 'object');
    res.json({ data: objects.map((o) => o.data) });
  });

  // Attributes
  r.get('/v2/objects/:objectId/attributes', (req, res) => {
    const attrs = store.list(SVC, `attribute:${req.params.objectId}`);
    res.json({ data: attrs.map((a) => a.data) });
  });

  r.get('/v2/lists/:listId/attributes', (req, res) => {
    const attrs = store.list(SVC, `attribute:list:${req.params.listId}`);
    res.json({ data: attrs.map((a) => a.data) });
  });

  // Options & Statuses
  r.get('/v2/objects/:objectId/attributes/:attrId/options', (req, res) => {
    const options = store.list(SVC, `option:${req.params.objectId}:${req.params.attrId}`);
    res.json({ data: options.map((o) => o.data) });
  });

  r.get('/v2/lists/:listId/attributes/:attrId/options', (req, res) => {
    const options = store.list(SVC, `option:list:${req.params.listId}:${req.params.attrId}`);
    res.json({ data: options.map((o) => o.data) });
  });

  r.get('/v2/objects/:objectId/attributes/:attrId/statuses', (req, res) => {
    const statuses = store.list(SVC, `status:${req.params.objectId}:${req.params.attrId}`);
    res.json({ data: statuses.map((s) => s.data) });
  });

  r.get('/v2/lists/:listId/attributes/:attrId/statuses', (req, res) => {
    const statuses = store.list(SVC, `status:list:${req.params.listId}:${req.params.attrId}`);
    res.json({ data: statuses.map((s) => s.data) });
  });

  // Workspace Members
  r.get('/v2/workspace_members', (_req, res) => {
    const members = store.list(SVC, 'workspace_member');
    res.json({ data: members.map((m) => m.data) });
  });

  r.get('/v2/workspace_members/:memberId', (req, res) => {
    const member = store
      .list(SVC, 'workspace_member')
      .find((m) => (m.data.id as { workspace_member_id?: string } | undefined)?.workspace_member_id === req.params.memberId);
    if (!member) return res.status(404).json({ status_code: 404, type: 'invalid_request_error', code: 'not_found', message: 'Workspace member not found' });
    res.json({ data: member.data });
  });

  r.delete('/v2/objects/:objectId/records/:recordId', (req, res) => {
    const key = `record:${req.params.objectId}`;
    if (!store.get(SVC, key, req.params.recordId)) return res.status(404).json({ status_code: 404, code: 'not_found', message: 'Record not found' });
    store.delete(SVC, key, req.params.recordId);
    res.json({});
  });

  // Records
  r.get('/v2/objects/:objectId/records/:recordId', (req, res) => {
    const record = store.get(SVC, `record:${req.params.objectId}`, req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json({ data: record.data });
  });

  r.post('/v2/objects/:objectId/records', (req, res) => {
    const id = store.nextId(SVC, `record:${req.params.objectId}`);
    const recordData = {
      id: { workspace_id: 'test', object_id: req.params.objectId, record_id: id },
      values: normalizeValues(req.body.data?.values || {}),
    };
    store.create(SVC, `record:${req.params.objectId}`, recordData, id);
    res.json({ data: recordData });
  });

  r.patch('/v2/objects/:objectId/records/:recordId', (req, res) => {
    const record = store.get(SVC, `record:${req.params.objectId}`, req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Not found' });
    const values = {
      ...(record.data.values as Record<string, unknown>),
      ...normalizeValues(req.body.data?.values || {}),
    };
    store.update(SVC, `record:${req.params.objectId}`, req.params.recordId, { ...record.data, values });
    res.json({ data: { ...record.data, values } });
  });

  r.post('/v2/objects/:objectId/records/query', (req, res) => {
    const records = store.list(SVC, `record:${req.params.objectId}`);
    const limit = req.body.limit || 5;
    const filter = req.body.filter;
    const matched = filter
      ? records.filter((r) => matchesAttioFilter(r.data, filter))
      : records;
    res.json({ data: matched.slice(0, limit).map((r) => r.data) });
  });

  // Search
  r.post('/v2/objects/records/search', (req, res) => {
    const query = (req.body.query as string)?.toLowerCase() || '';
    const objectIds = req.body.objects as string[] | undefined;

    let allRecords: { data: Record<string, unknown> }[] = [];
    if (objectIds) {
      for (const oid of objectIds) {
        allRecords.push(...store.list(SVC, `record:${oid}`).map((r) => ({ data: r.data })));
      }
    }

    const matched = allRecords.filter((r) => JSON.stringify(r.data).toLowerCase().includes(query));
    res.json({ data: matched.slice(0, req.body.limit || 5).map((r) => r.data) });
  });

  // List Entries
  r.get('/v2/lists/:listId/entries/:entryId', (req, res) => {
    const entry = store.get(SVC, `entry:${req.params.listId}`, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ data: entry.data });
  });

  r.post('/v2/lists/:listId/entries', (req, res) => {
    const id = store.nextId(SVC, `entry:${req.params.listId}`);
    const entryData = {
      id: { workspace_id: 'test', list_id: req.params.listId, entry_id: id },
      // Real Attio returns `entry_values` in the SAME array-of-typed-objects
      // envelope as record `values` (`{ stage: [{ value: "Diligence" }] }`), so
      // wrap the flat values a write posts — otherwise the adapter's read-side
      // `extractAttioValue` (which unwraps that envelope) reads nothing back.
      entry_values: normalizeValues(req.body.data?.entry_values || {}),
      parent_record_id: req.body.data?.parent_record_id,
      parent_object: req.body.data?.parent_object,
    };
    store.create(SVC, `entry:${req.params.listId}`, entryData, id);
    res.json({ data: entryData });
  });

  r.patch('/v2/lists/:listId/entries/:entryId', (req, res) => {
    const entry = store.get(SVC, `entry:${req.params.listId}`, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const entryValues = {
      ...(entry.data.entry_values as Record<string, unknown>),
      ...normalizeValues(req.body.data?.entry_values || {}),
    };
    store.update(SVC, `entry:${req.params.listId}`, req.params.entryId, { ...entry.data, entry_values: entryValues });
    res.json({ data: { ...entry.data, entry_values: entryValues } });
  });

  r.post('/v2/lists/:listId/entries/query', (req, res) => {
    const entries = store.list(SVC, `entry:${req.params.listId}`);
    const limit = req.body.limit || 5;
    res.json({ data: entries.slice(0, limit).map((e) => e.data) });
  });

  r.get('/v2/objects/:objectId/records/:recordId/entries', (req, res) => {
    // Find all list entries that reference this record
    const allEntities = store.listAll(SVC);
    const entries = allEntities
      .filter((e) => e.entity_type.startsWith('entry:') && (e.data as any).parent_record_id === req.params.recordId)
      .map((e) => ({
        list_id: (e.data as any).id?.list_id,
        entry_id: (e.data as any).id?.entry_id,
        created_at: e.created_at,
      }));
    res.json({ data: entries });
  });

  // Notes — GET /v2/notes lists workspace notes (parent filters optional,
  // mirroring the real API where both params are non-required). Stored notes
  // hold whatever POST /v2/notes received (`content` + `format`); shape each
  // row like the real list response (`content_plaintext`/`content_markdown`).
  r.get('/v2/notes', (req, res) => {
    const parentObject = req.query.parent_object as string | undefined;
    const parentRecordId = req.query.parent_record_id as string | undefined;
    const limit = Number(req.query.limit ?? 10);
    const offset = Number(req.query.offset ?? 0);
    const rows = store
      .list(SVC, 'note')
      .map((n) => n.data as Record<string, unknown>)
      .filter((d) => (parentObject ? d.parent_object === parentObject : true))
      .filter((d) => (parentRecordId ? d.parent_record_id === parentRecordId : true))
      .slice(offset, offset + limit)
      .map((d) => ({
        id: d.id,
        parent_object: d.parent_object ?? null,
        parent_record_id: d.parent_record_id ?? null,
        title: d.title ?? null,
        content_plaintext:
          d.content_plaintext ?? (d.format !== 'markdown' ? d.content ?? null : null),
        content_markdown:
          d.content_markdown ?? (d.format === 'markdown' ? d.content ?? null : null),
        created_at: d.created_at ?? null,
      }));
    res.json({ data: rows });
  });

  // Tasks — GET /v2/tasks lists workspace tasks (all filters optional).
  // `linked_object` + `linked_record_id` mirror the real API's optional
  // record scope (a task's linked_records name the records it attaches to).
  r.get('/v2/tasks', (req, res) => {
    const limit = Number(req.query.limit ?? 500);
    const offset = Number(req.query.offset ?? 0);
    const linkedObject = req.query.linked_object as string | undefined;
    const linkedRecordId = req.query.linked_record_id as string | undefined;
    const linkedTo = (d: Record<string, unknown>): boolean => {
      if (!linkedObject && !linkedRecordId) return true;
      const links = Array.isArray(d.linked_records) ? d.linked_records : [];
      return links.some((l) => {
        const link = (l ?? {}) as Record<string, unknown>;
        // POST /v2/tasks sends `target_object`; the real list response emits
        // `target_object_id`. Accept either spelling from the store.
        const obj = link.target_object_id ?? link.target_object;
        const rec = link.target_record_id;
        return (
          (linkedObject ? obj === linkedObject : true) &&
          (linkedRecordId ? rec === linkedRecordId : true)
        );
      });
    };
    const rows = store
      .list(SVC, 'task')
      .map((t) => t.data as Record<string, unknown>)
      .filter(linkedTo)
      .slice(offset, offset + limit)
      .map((d) => ({
        id: d.id,
        content_plaintext: d.content_plaintext ?? d.content ?? null,
        deadline_at: d.deadline_at ?? null,
        is_completed: d.is_completed ?? null,
        completed_at: d.completed_at ?? null,
        created_at: d.created_at ?? null,
        linked_records: d.linked_records ?? [],
      }));
    res.json({ data: rows });
  });

  // Single-entity GETs — the event-hop reads (webhook event → Task/Note/
  // Comment) fetch by id. Shape each response like its list counterpart.
  r.get('/v2/tasks/:taskId', (req, res) => {
    const task = store.get(SVC, 'task', req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const d = task.data as Record<string, unknown>;
    res.json({
      data: {
        id: d.id,
        content_plaintext: d.content_plaintext ?? d.content ?? null,
        deadline_at: d.deadline_at ?? null,
        is_completed: d.is_completed ?? null,
        completed_at: d.completed_at ?? null,
        created_at: d.created_at ?? null,
        linked_records: d.linked_records ?? [],
      },
    });
  });

  r.get('/v2/notes/:noteId', (req, res) => {
    const note = store.get(SVC, 'note', req.params.noteId);
    if (!note) return res.status(404).json({ error: 'Not found' });
    const d = note.data as Record<string, unknown>;
    res.json({
      data: {
        id: d.id,
        parent_object: d.parent_object ?? null,
        parent_record_id: d.parent_record_id ?? null,
        title: d.title ?? null,
        content_plaintext:
          d.content_plaintext ?? (d.format !== 'markdown' ? d.content ?? null : null),
        content_markdown:
          d.content_markdown ?? (d.format === 'markdown' ? d.content ?? null : null),
        created_at: d.created_at ?? null,
      },
    });
  });

  r.get('/v2/comments/:commentId', (req, res) => {
    const comment = store.get(SVC, 'comment', req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Not found' });
    res.json({ data: comment.data });
  });

  // Threads — GET /v2/threads lists comment threads on a record
  // (record_id + object) or a list entry (entry_id + list), mirroring the
  // real API's scoping params. Threads are derived from the stored comments
  // grouped by thread_id, each thread carrying its comments INLINE sorted by
  // created_at — the same shape the real endpoint returns (there is no
  // list-comments endpoint; threads are the only comment enumeration).
  r.get('/v2/threads', (req, res) => {
    const recordId = req.query.record_id as string | undefined;
    const object = req.query.object as string | undefined;
    const entryId = req.query.entry_id as string | undefined;
    const list = req.query.list as string | undefined;
    const limit = Number(req.query.limit ?? 10);
    const offset = Number(req.query.offset ?? 0);

    const comments = store.list(SVC, 'comment').map((c) => c.data as Record<string, unknown>);
    const inScope = comments.filter((d) => {
      const rec = (d.record ?? {}) as Record<string, unknown>;
      const ent = (d.entry ?? {}) as Record<string, unknown>;
      if (recordId && rec.record_id !== recordId) return false;
      if (object && rec.object !== object && rec.object_id !== object) return false;
      if (entryId && ent.entry_id !== entryId) return false;
      if (list && ent.list !== list && ent.list_id !== list) return false;
      return true;
    });

    const byThread = new Map<string, Record<string, unknown>[]>();
    for (const c of inScope) {
      const threadId = String(c.thread_id ?? 'thread_unknown');
      const bucket = byThread.get(threadId) ?? [];
      bucket.push(c);
      byThread.set(threadId, bucket);
    }
    const threads = Array.from(byThread.entries())
      .map(([threadId, threadComments]) => {
        const sorted = [...threadComments].sort((a, b) =>
          String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
        );
        return {
          id: { workspace_id: 'test', thread_id: threadId },
          comments: sorted,
          created_at: sorted[0]?.created_at ?? null,
        };
      })
      .slice(offset, offset + limit);
    res.json({ data: threads });
  });

  // Notes
  r.post('/v2/notes', (req, res) => {
    const id = store.nextId(SVC, 'note');
    const noteData = {
      id: { workspace_id: 'test', note_id: id },
      ...req.body.data,
    };
    store.create(SVC, 'note', noteData, id);
    res.json({ data: noteData });
  });

  // Tasks
  r.post('/v2/tasks', (req, res) => {
    const id = store.nextId(SVC, 'task');
    const taskData = {
      id: { workspace_id: 'test', task_id: id },
      ...req.body.data,
    };
    store.create(SVC, 'task', taskData, id);
    res.json({ data: taskData });
  });

  // Comments — mirrors the real API's shape: author + content, targeting
  // either an existing thread (thread_id) or a record (starts a new thread).
  r.post('/v2/comments', (req, res) => {
    const id = store.nextId(SVC, 'comment');
    const d = (req.body?.data ?? {}) as Record<string, unknown>;
    const commentData = {
      id: { workspace_id: 'test', comment_id: id },
      thread_id: (d.thread_id as string | undefined) ?? `thread_${id}`,
      content_plaintext: (d.content as string | undefined) ?? '',
      resolved_at: null,
      created_at: new Date().toISOString(),
      author: d.author,
      ...(d.record !== undefined ? { record: d.record } : {}),
      // The real API's third create variant targets a list entry
      // (`entry: { list, entry_id }`) — stored so GET /v2/threads can scope
      // by entry.
      ...(d.entry !== undefined ? { entry: d.entry } : {}),
    };
    store.create(SVC, 'comment', commentData, id);
    res.json({ data: commentData });
  });

  // File upload — POST /v2/files/upload (multipart: file + object + record_id).
  // Mirrors the real response envelope; stored so dev:inspect / admin state
  // can prove a movement attached a file to a record.
  const fileUploadRaw = express.raw({ type: 'multipart/form-data', limit: '50mb' });
  r.post('/v2/files/upload', fileUploadRaw, (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '');
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
    const bound = (boundary?.[1] ?? boundary?.[2] ?? '').trim();
    if (!bound) return res.status(400).json({ error: 'missing multipart boundary' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const text = raw.toString('latin1');
    const fields: Record<string, { filename?: string; body: string }> = {};
    for (const part of text.split(`--${bound}`)) {
      const trimmed = part.replace(/^\r\n/, '');
      const headerEnd = trimmed.indexOf('\r\n\r\n');
      if (headerEnd < 0) continue;
      const headers = trimmed.slice(0, headerEnd);
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      if (!name) continue;
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      const body = trimmed.slice(headerEnd + 4).replace(/\r\n$/, '');
      fields[name] = { filename, body };
    }
    if (!fields.file) return res.status(400).json({ error: 'missing file part' });
    if (!fields.object || !fields.record_id) {
      return res.status(400).json({ error: 'missing object / record_id parts' });
    }
    const name = fields.file.filename ?? 'file';
    const objectSlug = fields.object.body;
    const recordId = fields.record_id.body;
    // Attio scopes file names uniquely per record — a duplicate upload 409s
    // rather than silently overwriting or duplicating. Mirrors the real
    // envelope byte-for-byte so `uploadFile`'s conflict-retry logic can be
    // exercised against the fake.
    const nameTaken = store
      .list(SVC, 'file')
      .map((f) => f.data as Record<string, unknown>)
      .some((d) => d.object === objectSlug && d.record_id === recordId && d.name === name);
    if (nameTaken) {
      return res.status(409).json({
        status_code: 409,
        type: 'invalid_request_error',
        code: 'uniqueness_conflict',
        message: `There is already a file with name "${name}".`,
      });
    }
    const id = store.nextId(SVC, 'file');
    const fileData = {
      id: { workspace_id: 'test', file_id: id },
      file_type: 'file',
      name,
      content_type: null,
      content_size: Buffer.byteLength(fields.file.body, 'latin1'),
      object: objectSlug,
      record_id: recordId,
      created_at: new Date().toISOString(),
    };
    store.create(SVC, 'file', fileData, id);
    res.json({ data: fileData });
  });

  // Files — GET /v2/files REQUIRES object + record_id (mirrors the real API,
  // where a file exists only on its record — the reason the Attio File root
  // is write-only). Rows carry the `file_type: 'file'` discriminator the
  // real endpoint uses to mix files with folders/connected items.
  r.get('/v2/files', (req, res) => {
    const object = req.query.object as string | undefined;
    const recordId = req.query.record_id as string | undefined;
    if (!object || !recordId) {
      return res.status(400).json({ error: 'object and record_id are required' });
    }
    const rows = store
      .list(SVC, 'file')
      .map((f) => f.data as Record<string, unknown>)
      .filter((d) => d.object === object && d.record_id === recordId)
      .map((d) => ({
        id: d.id,
        file_type: d.file_type ?? 'file',
        name: d.name ?? null,
        content_type: d.content_type ?? null,
        content_size: d.content_size ?? null,
        created_at: d.created_at ?? null,
      }));
    res.json({ data: rows, pagination: { next_cursor: null } });
  });

  // Webhooks (no-op for test)
  r.post('/v2/webhooks', (_req, res) => {
    res.json({ data: { id: { workspace_id: 'test', webhook_id: 'fake' }, status: 'active', secret: 'fake-secret' } });
  });

  r.patch('/v2/webhooks/:webhookId', (req, res) => {
    res.json({ data: { id: { workspace_id: 'test', webhook_id: req.params.webhookId }, status: 'active', subscriptions: req.body?.data?.subscriptions ?? [] } });
  });

  r.delete('/v2/webhooks/:webhookId', (_req, res) => {
    res.json({});
  });

  return r;
}
