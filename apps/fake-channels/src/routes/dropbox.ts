// Fake Dropbox (API v2 subset) — one host serves both the RPC endpoints
// (api.dropboxapi.com in prod) and the content endpoints
// (content.dropboxapi.com in prod); the api client's baseUrl override points
// both here. Entities: one 'entry' per item, keyed by PATH (Dropbox's stable
// identity): { path, name, isFolder, size, content }.

import { Router } from 'express';
import express from 'express';
import type { EntityStore } from '../store';
import { bearerOf, isRefusedBearer } from './oauth';

const SVC = 'dropbox';

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

function toApiEntry(data: Record<string, unknown>): Record<string, unknown> {
  return {
    '.tag': data.isFolder ? 'folder' : 'file',
    name: data.name,
    path_display: data.path,
    path_lower: String(data.path ?? '').toLowerCase(),
    ...(data.isFolder ? {} : { size: data.size ?? 0 }),
  };
}

export function dropboxRoutes(store: EntityStore): Router {
  const r = Router();

  // Like the real API, refuse an access token the fake OAuth provider has
  // expired; a token it never issued is a fixture credential and passes.
  r.use((req, res, next) => {
    if (isRefusedBearer(store, bearerOf(req))) {
      return res.status(401).json({ error_summary: 'expired_access_token/' });
    }
    next();
  });

  r.post('/2/files/list_folder', (req, res) => {
    const path = String(req.body.path ?? '');
    const entries = store
      .list(SVC, 'entry')
      .filter((e) => parentOf(String(e.data.path)) === path)
      .map((e) => toApiEntry(e.data));
    res.json({ entries, cursor: 'fake-cursor', has_more: false });
  });

  r.post('/2/files/create_folder_v2', (req, res) => {
    const path = String(req.body.path ?? '');
    if (!path) return res.status(400).json({ error_summary: 'path/missing' });
    const existing = store.get(SVC, 'entry', path);
    if (existing) {
      return res.status(409).json({ error_summary: 'path/conflict/folder' });
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    store.create(SVC, 'entry', { path, name, isFolder: true, size: null, content: null }, path);
    res.json({ metadata: { name, path_display: path, path_lower: path.toLowerCase() } });
  });

  const rawBody = express.raw({ type: '*/*', limit: '50mb' });

  r.post('/2/files/upload', rawBody, (req, res) => {
    let arg: { path?: string };
    try {
      arg = JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}'));
    } catch {
      return res.status(400).json({ error_summary: 'bad Dropbox-API-Arg' });
    }
    const path = arg.path ?? '';
    if (!path) return res.status(400).json({ error_summary: 'path/missing' });
    const content = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body ?? '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    const data = { path, name, isFolder: false, size: Buffer.byteLength(content), content };
    if (store.get(SVC, 'entry', path)) store.update(SVC, 'entry', path, data);
    else store.create(SVC, 'entry', data, path);
    res.json({ name, path_display: path, path_lower: path.toLowerCase(), size: data.size });
  });

  r.post('/2/files/download', (req, res) => {
    let arg: { path?: string };
    try {
      arg = JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}'));
    } catch {
      return res.status(400).json({ error_summary: 'bad Dropbox-API-Arg' });
    }
    const entry = arg.path ? store.get(SVC, 'entry', arg.path) : null;
    if (!entry || entry.data.isFolder) {
      return res.status(409).json({ error_summary: 'path/not_found' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(String(entry.data.content ?? ''));
  });

  return r;
}
