// An awaited hop's WHERE (`await q-[r:Replies WHERE …]->`) decides each
// candidate landing the way a hop WHERE decides a landed record: an AND stops at
// its first false conjunct, and no field is read before the conjunct that needs
// it is reached. A candidate that has already failed is never asked for a field
// it may not have — the adapter would rightly refuse it as drift.

import { parseTraversalPath } from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import { awaitLandingMatches } from '../run';
import type { Adapter, RuntimeCapabilities } from '../../translation_graph/adapter';
import { AdapterNameDriftError } from '../../translation_graph/adapters/name_resolution';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';

function filterOf(where: string): Expression {
  const steps = parseTraversalPath(`-[r:Replies WHERE ${where}]->`);
  const filter = steps?.[0]?.type === 'edge' ? steps[0].expressionFilter : undefined;
  if (!filter) throw new Error(`test setup: no filter parsed out of \`${where}\``);
  return filter;
}

/** An awaitable-side reader that drifts on a field the landing does not carry,
 *  and records every field it was asked for. */
function makeReader() {
  const reads: string[] = [];
  const caps: RuntimeCapabilities = {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  };
  const adapter: Adapter = {
    adapterType: 'chat',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => caps,
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      reads.push(fieldId);
      const data = positionData(position);
      if (typeof data !== 'object' || data === null || !(fieldId in data)) {
        throw new AdapterNameDriftError(
          `'${fieldId}' is not a known field of '${position.recordType}' in this connection — its schema has changed (drift).`,
        );
      }
      return Object.entries(data).find(([key]) => key === fieldId)?.[1] ?? null;
    },
    async getRelated() {
      return [];
    },
    async createRecord() {
      return { adapterType: 'chat', externalId: 'x', data: {} };
    },
    async updateRecord(update) {
      return {
        adapterType: 'chat',
        externalId: update.externalId,
        data: {},
        association: containerAssociation(update),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, reads };
}

const WHERE = '`kind` == "answer" AND `Verdict` == "yes"';

describe('an awaited WHERE decides each candidate left to right', () => {
  it('a candidate failing the first conjunct is never asked for the second field', async () => {
    const { adapter, reads } = makeReader();
    const matched = await awaitLandingMatches({
      filter: filterOf(WHERE),
      adapter,
      adapterType: 'chat',
      // A reaction, not an answer: it has no `Verdict` at all.
      landing: { recordType: 'Reaction', fields: { kind: 'reaction' } },
    });
    expect(matched).toBe(false);
    expect(reads).toEqual(['kind']);
  });

  it('a candidate passing the first conjunct is decided by the rest', async () => {
    const { adapter } = makeReader();
    const answer = (verdict: string) =>
      awaitLandingMatches({
        filter: filterOf(WHERE),
        adapter,
        adapterType: 'chat',
        landing: { recordType: 'Answer', fields: { kind: 'answer', Verdict: verdict } },
      });
    expect(await answer('yes')).toBe(true);
    expect(await answer('no')).toBe(false);
  });

  it('a conjunct the candidate REACHES still raises its missing-field error', async () => {
    const { adapter } = makeReader();
    await expect(
      awaitLandingMatches({
        filter: filterOf(WHERE),
        adapter,
        adapterType: 'chat',
        landing: { recordType: 'Answer', fields: { kind: 'answer' } },
      }),
    ).rejects.toThrow(/drift/);
  });
});
