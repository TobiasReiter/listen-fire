// Linear as a TARS remote adapter: one POST endpoint speaking the remote
// adapter wire protocol (apps/api/src/services/translation_graph/protocol),
// translated to Linear's GraphQL API. No dependencies; Node 20+.
//
// Graph:  linear -[:Team]-> Team { Name, Key } -[:Issues]-> Issue
//         (Issues is create-only; nothing is read back from Linear but teams.)
//
// Env: ADAPTER_SECRET (the bearer TARS sends), LINEAR_API_KEY (a personal
// `lin_api_…` key, or an OAuth access token), PORT.

import http from 'node:http';

const ADAPTER = process.env.ADAPTER_TYPE ?? 'linear';
const SECRET = process.env.ADAPTER_SECRET;
const LINEAR_KEY = process.env.LINEAR_API_KEY;
const LINEAR_URL = process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql';

const str = (fieldId, extra = {}) => ({ fieldId, displayName: fieldId, kind: 'string', writable: false, required: false, ...extra });

const TYPES = {
  Team: {
    typeId: 'Team',
    displayName: 'Team',
    fields: [str('Name'), str('Key')],
    references: [{ fieldId: 'Issues', targetTypeId: 'Issue', cardinality: 'many', readable: false, writable: true }],
  },
  Issue: {
    typeId: 'Issue',
    displayName: 'Issue',
    fields: [
      str('Title', { writable: true, required: true }),
      str('Description', { writable: true }),
      str('Labels', { writable: true, cardinality: 'many' }),
      str('Identifier'),
      str('URL'),
    ],
    references: [],
  },
};

const ENTRY_POINTS = [
  { typeId: 'Team', displayName: 'Team', scope: 'self-configured', readable: true, writable: false },
  { typeId: 'Issue', displayName: 'Issue', scope: 'self-configured', readable: false, writable: false },
];

class AdapterError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function linear(query, variables) {
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Personal keys go bare; OAuth tokens are bearer.
      authorization: LINEAR_KEY.startsWith('lin_api_') ? LINEAR_KEY : `Bearer ${LINEAR_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const message = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new AdapterError('adapter_error', `Linear: ${message}`, res.status >= 500 || res.status === 429);
  }
  return body.data;
}

const teamPosition = (t) => ({
  adapterType: ADAPTER,
  recordType: 'Team',
  identity: { kind: 'stable', recordId: t.id, data: { Name: t.name, Key: t.key } },
});

// Label names → ids, over the team's labels and the workspace's. A name that
// matches nothing fails the write: an issue silently missing its asset-class
// tag is worse than no issue.
async function labelIds(teamId, names) {
  if (names.length === 0) return [];
  const data = await linear(
    `query($team: ID!) { issueLabels(first: 250, filter: { or: [{ team: { id: { eq: $team } } }, { team: { null: true } }] }) { nodes { id name isGroup } } }`,
    { team: teamId },
  );
  const byName = new Map(data.issueLabels.nodes.filter((l) => !l.isGroup).map((l) => [l.name.toLowerCase(), l.id]));
  const missing = names.filter((n) => !byName.has(n.toLowerCase()));
  if (missing.length > 0) throw new AdapterError('adapter_error', `Linear has no label named ${missing.map((n) => `"${n}"`).join(', ')} for this team`);
  return names.map((n) => byName.get(n.toLowerCase()));
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String).filter((s) => s.trim() !== '');

const methods = {
  listEntryPoints: async () => ENTRY_POINTS,
  describe: async ({ typeId }) => TYPES[typeId] ?? null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async ({ position, fieldId }) => position?.identity?.data?.[fieldId] ?? null,

  getRelated: async ({ position, fieldId }) => {
    if (position?.recordType === 'meta' && fieldId === 'Team') {
      const data = await linear(`query { teams(first: 250) { nodes { id name key } } }`);
      return data.teams.nodes.map((t) => ({ position: teamPosition(t) }));
    }
    return [];
  },

  createRecord: async ({ recordType, fields, parentLinks }) => {
    if (recordType !== 'Issue') throw new AdapterError('bad_request', `cannot create a ${recordType}`);
    const teamId = parentLinks?.find((p) => p.recordType === 'Team')?.externalId;
    if (!teamId) throw new AdapterError('bad_request', 'an Issue is created under a Team: write team-[:Issues]-> { … }');
    if (!fields.Title) throw new AdapterError('bad_request', 'an Issue needs a Title');

    const data = await linear(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      {
        input: {
          teamId,
          title: String(fields.Title),
          ...(fields.Description ? { description: String(fields.Description) } : {}),
          labelIds: await labelIds(teamId, asList(fields.Labels)),
        },
      },
    );
    const issue = data.issueCreate.issue;
    return {
      adapterType: ADAPTER,
      externalId: issue.id,
      recordType: 'Issue',
      url: issue.url,
      data: { Identifier: issue.identifier, URL: issue.url },
    };
  },
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handle(req, res) {
  if (req.method === 'GET') return send(res, 200, { ok: true, adapter: ADAPTER });
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  if (req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { ok: false });

  let envelope;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { ok: false });
  }

  const method = methods[envelope?.method];
  if (!method) {
    return send(res, 200, { ok: false, error: { code: 'method_not_implemented', message: `${envelope?.method} is not supported`, retryable: false } });
  }
  try {
    send(res, 200, { ok: true, result: await method(envelope.params ?? {}) });
  } catch (err) {
    const known = err instanceof AdapterError;
    if (!known) console.error(err);
    send(res, 200, {
      ok: false,
      error: { code: known ? err.code : 'adapter_error', message: err.message, retryable: known ? err.retryable : true },
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!SECRET || !LINEAR_KEY) {
    console.error('ADAPTER_SECRET and LINEAR_API_KEY must both be set');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 10000);
  http.createServer(handle).listen(port, () => console.log(`linear adapter on :${port}`));
}
