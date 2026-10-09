// describeConnection answers compact text by default: the digest's notation,
// scoped to one place, with its edges and their landings one level deep. The
// fixtures are real full-JSON answers from a dev-loop eval run, so the size
// comparison is against what agents were actually paying.

import type { WalkedDescribedNode, WalkedNode } from '../walk';
import type { DescribedInstance } from '../catalog';

const snapshotMock = jest.fn();
const describeMock = jest.fn();
const landingsMock = jest.fn();
jest.mock('../catalog', () => ({
  movementCatalogSnapshotForTeam: (...args: unknown[]) => snapshotMock(...args),
  describeMovementInstance: (...args: unknown[]) => describeMock(...args),
  describeMovementLandings: (...args: unknown[]) => landingsMock(...args),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { renderConnectionDescription } from '../connection_digest';
import { describeConnectionCompact } from '../describe_connection';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const companiesFull: DescribedInstance = require('./__fixtures__/attio_companies_describe.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const peopleFull: DescribedInstance = require('./__fixtures__/attio_people_describe.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const batchFull: { connections: Array<DescribedInstance & { system: string }> } = require('./__fixtures__/attio_gmail_slack_describe.json');

const TEAM = 'team-1' as TeamId;

const ATTIO_SPEC = {
  constructionArgs: [{ name: 'credentials', kind: 'credential' as const, required: true }],
  triggerConfig: ['events'],
  triggerConfigOptions: { events: ['record.created', 'record.updated', 'record.deleted'] },
};

function landingOf(described: DescribedInstance): WalkedDescribedNode {
  const node = described.node as WalkedNode;
  return { name: node.name, properties: node.properties };
}

beforeEach(() => {
  snapshotMock.mockReset();
  describeMock.mockReset();
  landingsMock.mockReset();
  snapshotMock.mockResolvedValue({
    snapshot: { adapters: { attio: ATTIO_SPEC }, credentials: { 'Dev Loop Attio': { adapters: ['attio'] } } },
  });
  landingsMock.mockResolvedValue({ Companies: landingOf(companiesFull), People: landingOf(peopleFull) });
});

describe('describeConnection, compact', () => {
  it('spells one position: its fields, then each edge with what it lands on', async () => {
    describeMock.mockResolvedValue(companiesFull);
    const text = await describeConnectionCompact({ teamId: TEAM, system: 'attio', position: '-[:Companies]->' });

    expect(describeMock).toHaveBeenCalledWith({
      teamId: TEAM,
      adapter: 'attio',
      forceRefresh: true,
      position: '-[:Companies]->',
    });
    expect(text).toContain('### attio at -[:Companies]->');
    expect(text).toContain(
      'Companies: Name text!, Domains text, Description text, Categories enum(Lead|Customer|Open|Snoozed|…+2)[], `Team Size` number, `Created At` date~',
    );
    expect(text).toContain('- -[:Team]-> People (many) [rw]: Name text!, Email text, `Job Title` text, `Created At` date~');
    expect(text).toContain('- -[:`VC Deal Flow`]-> `VC Deal Flow` (many) [rw]: Stage enum(Sourced|Diligence|Term Sheet|Passed), `Added to list at` date~');
    expect(text).toContain('listName enum(VC Deal Flow)! (write-only)');
    expect(text).toContain('  - "VC Deal Flow": -[:Lists WHERE `Name` == "VC Deal Flow"]->');
    expect(text).toContain('position: "-[:Companies]->-[:`Team`]->"');
    expect(text).toContain('detail: "full"');
    // No root material away from the root.
    expect(text).not.toContain('listen {');
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('is a fraction of the full JSON it replaces', async () => {
    describeMock.mockResolvedValue(companiesFull);
    const text = await describeConnectionCompact({ teamId: TEAM, system: 'attio', position: '-[:Companies]->' });
    const full = JSON.stringify(companiesFull);
    expect(full.length).toBeGreaterThan(6_000);
    expect(text.length).toBeLessThan(full.length / 3);
  });

  it("at the root, says how to construct and listen, and describes the root's stubbed record types", async () => {
    // The fixture predates the adapter declaring its object edges writable, as
    // its entry points always did; say it as the adapter now does.
    const attioRoot = batchFull.connections[0];
    const objects = new Set(['Companies', 'People', 'Deals', 'Funds']);
    describeMock.mockResolvedValue({
      ...attioRoot,
      node: {
        ...attioRoot.node,
        edges: attioRoot.node!.edges.map((e) => (objects.has(e.name) ? { ...e, writable: true } : e)),
      },
    });
    const text = await describeConnectionCompact({ teamId: TEAM, system: 'attio' });

    expect(text).toContain('### attio — `attio(credentials: Dev Loop Attio)`');
    expect(text).toContain('- listen { events: record.created|record.updated|record.deleted }');
    expect(text).toContain('- What a listen fires on: ');
    expect(text).toContain('- Hint: For any owner field');
    expect(landingsMock).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'attio', types: expect.arrayContaining(['Companies', 'People']) }));
    expect(text).toContain('- -[:Companies]-> Companies (many) [rw]: Name text!');
    expect(text).toContain('- -[:People]-> People (many) [rw]: Name text!');
    // A stub nothing described stays named, with the hop that resolves it.
    expect(text).toContain('- -[:Deals]-> Deals (many) [rw]: fields not loaded — describe position "-[:`Deals`]->"');
    expect(text).toContain('- -[:`Webhook Event`]-> `Webhook Event` (one) [fires]: action enum(record.created|record.updated|record.deleted)');
  });

  it('describes several systems at their roots, far smaller than the full batch', async () => {
    describeMock.mockImplementation(async ({ adapter }: { adapter: string }) =>
      batchFull.connections.find((c) => c.system === adapter),
    );
    const blocks = await Promise.all(
      ['attio', 'gmail', 'slack'].map((system) => describeConnectionCompact({ teamId: TEAM, system })),
    );
    const text = blocks.join('\n\n');
    const full = JSON.stringify(batchFull);
    expect(full.length).toBeGreaterThan(30_000);
    expect(text.length).toBeLessThan(full.length / 3);
    expect(text).toContain('### gmail');
    expect(text).toContain('### slack');
  });

  it('answers with the notes when there is no node to describe', () => {
    const text = renderConnectionDescription({
      system: 'acme_crm',
      schema: null,
      notes: ['acme_crm: no acme credential on this team — instance untyped'],
    });
    expect(text).toContain('### acme_crm');
    expect(text).toContain('Note: acme_crm: no acme credential on this team — instance untyped');
  });

  it('marks identity from the landing itself', () => {
    const text = renderConnectionDescription({
      system: 'crm',
      notes: [],
      node: {
        name: 'Companies',
        position: '-[:Companies]->',
        properties: {
          Name: { type: 'text', readable: true, writable: true, required: true },
          Domain: { type: 'text', readable: true, writable: true, required: false },
        },
        unique: [['Domain']],
        edges: [],
      },
    });
    expect(text).toContain('Companies: Name text!, Domain text*');
    expect(text).toContain('No edges leave this node.');
  });
});
