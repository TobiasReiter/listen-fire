import type { Chapter } from '../types';

export const overview: Chapter = {
  id: 'overview',
  title: 'What a remote adapter is',
  content: `## What a remote adapter is

A remote adapter lets Listen-Fire read from and write to a data store you
host — a homespun CRM, an internal tool, any HTTP-reachable system — as
if it were a built-in integration. You do not need anything from Listen-Fire's
codebase to build one. An adapter is just an HTTP server you host that
speaks a small JSON protocol; any language works.

### The two halves

Building an adapter is two separate pieces of work:

1. **Build a protocol server.** One HTTP endpoint that answers
   JSON-RPC-style calls — introspecting your data model, matching
   records, and reading and writing them. This is the bulk of the work,
   and it lives entirely in your stack against your own system's API.
2. **Install it in Listen-Fire.** Register a small manifest (which names the
   adapter and points at your server's URL) and give it its secret.
   Once installed, the adapter appears in your automations and behaves
   like any built-in integration.

### What Listen-Fire calls it for

Listen-Fire calls your single endpoint to introspect your data model
(\`describe\`, \`listEntryPoints\`), to match existing records against
incoming ones so it updates rather than duplicates (\`resolveEntity\`),
and to read and write records (\`getFieldValue\`, \`getRelated\`,
\`createRecord\`, \`updateRecord\`, \`deleteRecord\`). In the other
direction, your system tells Listen-Fire when something happens — a new
record, or the thing an automation is waiting on — through two push doors
or through webhooks Listen-Fire subscribes to.

### Speaking your natural names

You describe your data in Listen-Fire's neutral shape: **types** (e.g.
\`Company\`, \`Deal\`), each with **fields** (e.g. \`Name\`, \`Stage\`)
and optional **references** (edges to other types). Listen-Fire speaks your
*natural* names on the wire — the human-readable display names you
choose — and your server maps them to whatever your system uses
internally. Keeping the wire names equal to your system's field names,
where you can, makes that mapping the identity function.

### Read, write, or both

An adapter can be a write target (Listen-Fire pushes records into it), a read
source (Listen-Fire reads and traverses from it), or both. You implement only
the methods that make sense for your system and declare exactly that set
in the manifest; Listen-Fire never calls a method you did not declare. The
next chapters cover the protocol, the schema shapes, and a runnable
reference server you can start from.`,
};
