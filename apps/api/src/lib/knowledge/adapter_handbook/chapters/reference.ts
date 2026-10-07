import type { Chapter } from '../types';

export const reference: Chapter = {
  id: 'reference',
  title: 'Reference: skeleton, manifest, install, and agent prompt',
  content: `## Reference: skeleton, manifest, install, and agent prompt

Everything you need to stand up a working adapter end to end: a runnable
server skeleton, the manifest that registers it, the install steps, and
a copy-paste prompt you can hand to a coding agent.

### Reference skeleton (Node/Express — translate to any stack)

\`\`\`js
import express from 'express';
const app = express();
app.use(express.json());

const SECRET = process.env.ADAPTER_SECRET;
const COMPANY = {
  typeId: 'Company', displayName: 'Company',
  fields: [
    { fieldId: 'Name', displayName: 'Name', kind: 'text', writable: true, required: true },
    { fieldId: 'Description', displayName: 'Description', kind: 'text', writable: true, required: false },
  ],
  references: [],
};

const handlers = {
  manifest: () => ({
    protocolVersion: 2, adapterType: 'acme_crm', supportedTriggers: [],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['listEntryPoints','describe','resolveEntity','getFieldValue','getRelated','createRecord','updateRecord','deleteRecord'],
  }),
  listEntryPoints: () => [{ typeId: 'Company', displayName: 'Company', writable: true, readable: true }],
  describe: ({ typeId }) => (typeId === 'Company' ? COMPANY : null),
  resolveEntity: () => ({ candidates: [] }),            // always-create; add real matching later
  getFieldValue: () => null,
  getRelated: () => [],
  createRecord: ({ recordType, fields }) => {
    const externalId = myCrm.create(recordType, fields);  // ← your system
    return { adapterType: 'acme_crm', externalId, recordType, data: {} };
  },
  updateRecord: ({ recordType, externalId, fields, parentLinks }) => {
    if (!myCrm.exists(externalId)) return { notFound: true };
    myCrm.update(externalId, fields);                     // ← your system
    // Say what became of the parent: Company has no parent edges here, so a
    // write that named one asked for something this connector cannot do.
    const association = (parentLinks ?? []).length === 0 ? 'none' : 'unsupported';
    return { adapterType: 'acme_crm', externalId, recordType, data: {}, association };
  },
  deleteRecord: ({ externalId }) => { myCrm.delete(externalId); return {}; },
};

app.post('/', async (req, res) => {
  if (req.headers.authorization !== \`Bearer \${SECRET}\`) {
    return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'bad secret', retryable: false } });
  }
  const { protocolVersion, method, params } = req.body ?? {};
  if (protocolVersion !== '2') {
    return res.json({ ok: false, error: { code: 'protocol_version', message: 'expected protocol version 2', retryable: false } });
  }
  const fn = handlers[method];
  if (!fn) return res.json({ ok: false, error: { code: 'method_not_implemented', message: method, retryable: false } });
  try {
    res.json({ ok: true, result: (await fn(params)) ?? null });
  } catch (e) {
    res.json({ ok: false, error: { code: 'adapter_error', message: String(e), retryable: true } });
  }
});

app.listen(process.env.PORT ?? 8080);
\`\`\`

### The manifest

A JSON file that registers the adapter with Listen-Fire. **No secret goes in
here.**

\`\`\`json
{
  "protocolVersion": 2,
  "adapterType": "acme_crm",
  "displayName": "Acme CRM",
  "description": "Our internal CRM.",
  "baseUrl": "https://crm.acme.example/listen-fire-adapter",
  "authStrategy": { "kind": "bearer" },
  "supportedTriggers": [],
  "runtimeCapabilities": { "traversal": { "incoming": false, "edgeProperties": false }, "resources": false },
  "methods": ["listEntryPoints","describe","resolveEntity","getFieldValue","getRelated","createRecord","updateRecord","deleteRecord"]
}
\`\`\`
- \`adapterType\` is the slug you import in an automation
  (\`import { acme_crm } from adapters\`). One install per slug per team.
- \`authStrategy\` matches the auth section of the protocol chapter. For
  \`shared_secret\` add \`"header": "X-Your-Header"\`.
- \`methods\` must equal what your server implements.
- \`protocolVersion\` is \`2\`; installing asks your server's
  \`manifest\` and refuses anything else.

### Installing it in Listen-Fire

1. Host your server at a stable \`baseUrl\`.
2. In Listen-Fire, open the **Adapters** page and import the manifest
   JSON, entering your adapter's **secret** in the same step (stored
   encrypted, bound to this adapter). That is it — the adapter now
   appears in your automations.
   - Or, if an agent is setting this up for you, it gives you a browser
     link to paste the secret into out-of-band; the chat never sees it.
3. Use it in an automation exactly like a built-in:
   \`\`\`
   import { acme_crm } from adapters
   crm = acme_crm()
   movement push(e: <inbox-[:\`Email Received\`]->>) {
     e-[m:record]-> {
       write crm-[:Company]-> { Name: m.\`Subject\` }
     }
   }
   \`\`\`

### Prompt to hand your coding agent

Give your agent this whole handbook plus the brief below (fill in the
bracketed parts for your deployment):

> You are building a "remote adapter" — an HTTP server that lets the
> Listen-Fire automation platform read from and write to our CRM. Follow the
> adapter handbook exactly. Deliverables:
> 1. An HTTP server (in <our stack>) implementing the protocol against
>    our CRM's API: \`manifest\`, \`listEntryPoints\`, \`describe\`,
>    \`resolveEntity\`, \`getFieldValue\`, \`getRelated\`,
>    \`createRecord\`, \`updateRecord\`, \`deleteRecord\`. Map our CRM's
>    objects to Listen-Fire types (start with <Company/Deal/…>) and our fields
>    to their \`displayName\`s. Authenticate every request. Implement
>    real \`resolveEntity\` matching on <our unique fields> so records
>    dedupe instead of duplicating. Return \`{ notFound: true }\` from
>    \`updateRecord\` for a missing id.
> 2. The \`manifest.json\`, filled in for our deployment (\`baseUrl\`,
>    \`authStrategy\`, the exact \`methods\` you implemented).
> If our CRM can tell us when records are created or change, also follow
> the events chapter.
> Confirm both \`ok:true\` and \`ok:false\` responses use HTTP 200, and
> that the \`manifest.methods\` array matches the implemented handlers.
> Do not put the secret in the manifest.`,
};
