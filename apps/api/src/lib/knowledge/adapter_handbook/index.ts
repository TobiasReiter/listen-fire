// The adapter-authoring handbook — chapters teaching how to build a
// remote adapter: an HTTP server that speaks Listen-Fire's small JSON
// protocol so a self-hosted system reads and writes like a built-in
// integration. Mirrors the query_handbook registry pattern:
// consumer-neutral chapter bodies behind a thin index/lookup surface.
//
// This handbook IS the canonical builder kit — the single source, served
// over MCP (`readHandbook`). The intended distribution is: a user connects
// the MCP and points their own agent at this book, rather than us sharing a
// doc. (Future: generate public docs pages from the handbooks.)

import type { Handbook, ChapterId, Chapter, IntentEntry } from './types';

import { overview } from './chapters/overview';
import { protocol } from './chapters/protocol';
import { schema } from './chapters/schema';
import { events } from './chapters/events';
import { files } from './chapters/files';
import { reference } from './chapters/reference';

const PREFACE = `## Building a remote adapter

A remote adapter is an HTTP server you host that lets Listen-Fire read from and
write to your own system — a homespun CRM, an internal tool, any
HTTP-reachable data store — as if it were a built-in integration. You do
not need anything from Listen-Fire's codebase: the adapter just speaks a small
JSON protocol, and any language works. These chapters cover what an
adapter is, the wire protocol, how to describe your data model, how your
system announces events and wakes waiting automations, and a runnable
reference server with the manifest that registers it.`;

const CONVENTIONS = `## Conventions (always in play)

- One HTTP endpoint answers every method; the method name is in the
  request body, not the path.
- Application results and application errors both return HTTP 200 — an
  envelope's \`ok\` flag says which. Reserve non-200 for transport
  faults (401 auth, 400 malformed).
- Listen-Fire speaks your natural type and field names on the wire; your
  server maps them to whatever your system uses internally.
- Declare exactly the methods you implement — Listen-Fire never calls one you
  did not declare.
- The secret is entered into Listen-Fire separately and stored encrypted; it
  never lives in the manifest.`;

const INTENT_INDEX: IntentEntry[] = [
  { intent: 'Understand what a remote adapter is and where to start', chapter: 'overview' },
  { intent: 'Learn how requests, responses, and errors are framed', chapter: 'protocol' },
  { intent: 'Know which methods to implement and what they return', chapter: 'protocol' },
  { intent: 'Authenticate incoming requests', chapter: 'protocol' },
  { intent: 'Prevent duplicate records when Listen-Fire pushes data in', chapter: 'protocol' },
  { intent: 'Describe your types, fields, and relationships to Listen-Fire', chapter: 'schema' },
  { intent: 'Get the listEntryPoints and describe shapes exactly right', chapter: 'schema' },
  { intent: 'Run automations when something is created in your system', chapter: 'events' },
  { intent: 'Let an automation wait for something to happen in your system', chapter: 'events' },
  { intent: 'Push events or wakes to Listen-Fire, or receive webhooks through it', chapter: 'events' },
  { intent: 'Read files or attachments out of your system', chapter: 'files' },
  { intent: 'Expose a document to Listen-Fire via resolveFileRef', chapter: 'files' },
  { intent: 'Understand whether Listen-Fire can write a file into your system', chapter: 'files' },
  { intent: 'Start from a runnable server skeleton', chapter: 'reference' },
  { intent: 'Write the manifest and install the adapter in Listen-Fire', chapter: 'reference' },
  { intent: 'Hand the build to a coding agent', chapter: 'reference' },
];

const CHAPTERS: Record<ChapterId, Chapter> = {
  overview,
  protocol,
  schema,
  events,
  files,
  reference,
};

export const adapterHandbook: Handbook = {
  preface: PREFACE,
  conventions: CONVENTIONS,
  intentIndex: INTENT_INDEX,
  chapters: CHAPTERS,
};
