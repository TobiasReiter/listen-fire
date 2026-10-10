// Aliased imports through the streaming chain — a bug found in production.
//
// A workspace credential whose ORIGINAL import name equals the adapter
// name (`attio` the credential vs `attio` the adapter type) FORCES an
// alias to import both: `import { attio as AttioCred } from credentials`.
// Every stage of the catalog-streaming chain keys on ORIGINAL
// (catalog-side) names — the describeInstance request, the snapshot's
// per-credential `schemas` map, and the checker's `instantiate` lookup —
// so construction detection must resolve the alias back to the original
// name. When it returned the LOCAL alias instead, the schema request 404'd
// server-side, nothing merged, and the instance silently went untyped
// (hover "No schema available", no write-target completions).

import type { InstanceSchema } from '../../checker/catalog';
import type { CatalogSnapshot } from '../snapshot';
import { mergeInstanceSchema } from '../snapshot';
import { referencedConstructions } from '../constructions';
import {
  getHoverInfo,
  getMovementCompletions,
  getMovementDiagnostics,
} from '../service';

const SAMPLE_SOURCE = `import { slack, attio } from adapters
import { slack_main, attio as AttioCred } from credentials

slackSource = slack(credentials: slack_main)
attioTarget = attio(credentials: AttioCred)
`;

const SLACK_SCHEMA: InstanceSchema = {
  positions: {
    message: { properties: { text: 'text', channel: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: {
      fields: { channel: 'text', text: 'text' },
      resultShape: { externalId: 'text' },
    },
  },
};

const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', url: 'text' }, edges: {} },
    person: { properties: { name: 'text', email: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, people: { target: 'person' } },
  writableRoots: {
    company: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', url: 'text', name: 'text' },
    },
    person: {
      fields: { name: 'text', email: 'text' },
      resultShape: { externalId: 'text', url: 'text' },
    },
  },
};

const SCHEMAS: Record<string, InstanceSchema> = {
  slack: SLACK_SCHEMA,
  attio: ATTIO_SCHEMA,
};

// The skeleton the catalog route serves: credentials keyed by their
// ORIGINAL (row-derived) import names; no instance schemas yet.
const SKELETON: CatalogSnapshot = {
  adapters: {
    slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schemas: {} },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schemas: {} },
  },
  credentials: {
    slack_main: { adapter: 'slack' },
    attio: { adapter: 'attio' },
  },
  plugins: {},
};

/** The workbench's streaming loop: detect pairs, "fetch" each schema by
 *  the detected credential name, merge. The server only knows ORIGINAL
 *  credential names — a request under a local alias yields nothing. */
function streamSchemas(source: string, skeleton: CatalogSnapshot): CatalogSnapshot {
  let snapshot = skeleton;
  for (const ref of referencedConstructions(source)) {
    if (!skeleton.adapters[ref.adapter]) continue;
    const served =
      ref.credential !== undefined && skeleton.credentials[ref.credential] !== undefined
        ? SCHEMAS[ref.adapter]
        : undefined;
    if (!served) continue;
    snapshot = mergeInstanceSchema(snapshot, {
      adapter: ref.adapter,
      ...(ref.credential !== undefined ? { credentialName: ref.credential } : {}),
      schema: served,
    });
  }
  return snapshot;
}

describe('aliased credential import (original name = adapter name)', () => {
  it('detection resolves the alias to the ORIGINAL credential name', () => {
    expect(referencedConstructions(SAMPLE_SOURCE)).toEqual([
      { adapter: 'slack', credential: 'slack_main' },
      { adapter: 'attio', credential: 'attio' },
    ]);
  });

  it('detection resolves aliases in the mid-edit lexical fallback too', () => {
    const midEdit = `${SAMPLE_SOURCE}
movement broken(m: <slackSource-[:message]->>) {
  write attioTarget.
`;
    expect(referencedConstructions(midEdit)).toContainEqual({
      adapter: 'attio',
      credential: 'attio',
    });
  });

  it('detection resolves adapter aliases to the adapter slug', () => {
    const refs = referencedConstructions(`import { attio as crm_type } from adapters
import { attio as AttioCred } from credentials
crm = crm_type(credentials: AttioCred)
`);
    expect(refs).toEqual([{ adapter: 'attio', credential: 'attio' }]);
  });

  it('the streamed snapshot types the instance: hover shows its schema', () => {
    const snapshot = streamSchemas(SAMPLE_SOURCE, SKELETON);
    expect(snapshot.adapters.attio.schemas.attio).toBe(ATTIO_SCHEMA);

    const hover = getHoverInfo(
      SAMPLE_SOURCE,
      SAMPLE_SOURCE.lastIndexOf('attioTarget') + 1,
      snapshot,
    );
    expect(hover).toBeDefined();
    const text = hover!.contents.join('\n');
    expect(text).toContain('attio instance');
    expect(text).toContain('Reads: company, person');
    expect(text).toContain('Writes: company, person');
    expect(text).not.toContain('No schema available');
  });

  it('write-target completions appear after `write attioTarget.`', () => {
    const snapshot = streamSchemas(SAMPLE_SOURCE, SKELETON);
    const cursorLine = '  company = write attioTarget.';
    const body = `${SAMPLE_SOURCE}
movement intake(msg: <slackSource-[:message]->>) {
${cursorLine}
}
`;
    const offset = body.indexOf(cursorLine) + cursorLine.length;
    const result = getMovementCompletions(body, offset, snapshot);
    expect(result.items.map((i) => i.label)).toEqual(['company', 'person']);
  });

  it('the checker resolves the schema: a bad field in a write is flagged', () => {
    const snapshot = streamSchemas(SAMPLE_SOURCE, SKELETON);
    const program = `${SAMPLE_SOURCE}
movement intake(msg: <slackSource-[:message]->>) {
  write attioTarget-[:companies]-> {
    name: msg.\`text\`
    nonsense_field: msg.\`text\`
  }
}
`;
    const diagnostics = getMovementDiagnostics(program, snapshot);
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(/nonsense_field/);
  });
});

describe('honest hover when a schema cannot load', () => {
  it('mergeInstanceSchema records describe-failure notes; hover surfaces them', () => {
    const failed = mergeInstanceSchema(SKELETON, {
      adapter: 'attio',
      credentialName: 'attio',
      schema: null,
      notes: ['attio: introspection failed (workspace unreachable) — instance untyped'],
    });
    expect(failed.adapters.attio.schemas).toEqual({});

    const hover = getHoverInfo(
      SAMPLE_SOURCE,
      SAMPLE_SOURCE.lastIndexOf('attioTarget') + 1,
      failed,
    );
    expect(hover).toBeDefined();
    const text = hover!.contents.join('\n');
    expect(text).toContain("Couldn't load this instance's schema");
    expect(text).toContain('workspace unreachable');
    expect(text).not.toContain('No schema available');
  });

  it('a later successful merge clears the failure note', () => {
    const failed = mergeInstanceSchema(SKELETON, {
      adapter: 'attio',
      credentialName: 'attio',
      schema: null,
      notes: ['attio: introspection failed (boom) — instance untyped'],
    });
    const recovered = mergeInstanceSchema(failed, {
      adapter: 'attio',
      credentialName: 'attio',
      schema: ATTIO_SCHEMA,
    });
    expect(recovered.adapters.attio.schemas.attio).toBe(ATTIO_SCHEMA);
    expect(recovered.adapters.attio.schemaNotes?.attio).toBeUndefined();

    const hover = getHoverInfo(
      SAMPLE_SOURCE,
      SAMPLE_SOURCE.lastIndexOf('attioTarget') + 1,
      recovered,
    );
    expect(hover!.contents.join('\n')).toContain('Reads: company, person');
  });
});
