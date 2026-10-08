// Unit tests for the engine-side resource resolution helper —
// `resolvePositionResources` walks an adapter's `_resources` reference and
// reads the `Resource` off each result, applying the author `ResourceFilter`.
//
// NOTE (Layer 5): `_resources` is extracted-node provenance now, NOT an
// input-side bundle. Input/source adapters (email/whatsapp/slack/…) no longer
// declare a `_resources` reference, so walking one off an input position
// drifts — the function is unchanged, the adapters stopped exposing the edge.
// The filter/stamp behaviour is still covered directly below via
// `matchesResourceFilter` / `stampResourceIds`.

import { EmailAdapter, EMAIL_ADAPTER_TYPE, EMAIL_RECORD_TYPE_ID } from '../../../adapters/email';
import type { EmailPayload } from '../../../adapters/email';
import { makeStablePosition } from '../../../types';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { matchesResourceFilter, resolvePositionResources, stampResourceIds } from '../resources';
import type { Resource } from '../../../adapter';
import type { ResourceId } from '../../../../../generated/kysely/knowledge/Resource';

const TEAM_ID = 'team-1' as TeamId;

const PAYLOAD: EmailPayload = {
  messageId: 'm-1@example.com',
  subject: 'Deck attached',
  sender: 'a@x',
  recipient: 'b@x',
  bodyText: 'See attached.',
  attachments: [
    { key: 'handle-1', filename: 'deck.pdf', contentType: 'application/pdf', size: 10 },
    { key: 'handle-2', filename: 'logo.png', contentType: 'image/png' },
  ],
};

function position() {
  return makeStablePosition({
    adapterType: EMAIL_ADAPTER_TYPE,
    recordType: EMAIL_RECORD_TYPE_ID,
    recordId: 'rec-1',
    data: PAYLOAD,
  });
}

describe('resolvePositionResources over an input adapter', () => {
  it('no longer resolves `_resources` off an input email position (the adapter dropped the reference)', async () => {
    // Input content is read explicitly now (the `Body` field + the
    // `attachments` edge). `_resources` is reachable only off an extracted
    // node, so walking it off an input position drifts.
    const adapter = new EmailAdapter(TEAM_ID);
    await expect(
      resolvePositionResources({ adapter, position: position(), mintIds: async () => [] }),
    ).rejects.toThrow();
  });
});

describe('stampResourceIds', () => {
  it('stamps each resource with no id from one mint, in order', async () => {
    const mint = jest.fn(async (count: number) => Array.from({ length: count }, (_, i) => `id-${i + 1}`));
    const kept: Resource = { id: 'existing-uuid' as ResourceId, type: 'TEXT' };
    const stamped = await stampResourceIds(
      [{ externalId: 'ext-1', type: 'TEXT' }, kept, { externalId: 'ext-2', type: 'TEXT' }],
      mint,
    );
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(2);
    expect(stamped.map((r) => r.id)).toEqual(['id-1', 'existing-uuid', 'id-2']);
    expect(stamped[0]?.externalId).toBe('ext-1');
    expect(stamped[1]).toBe(kept);
  });

  it('mints nothing when every resource carries an id', async () => {
    const mint = jest.fn(async () => []);
    const r: Resource = { id: 'existing-uuid' as ResourceId, type: 'TEXT' };
    expect(await stampResourceIds([r], mint)).toEqual([r]);
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('matchesResourceFilter', () => {
  const file = { type: 'FILE' as const, name: 'deck.pdf', contentType: 'application/pdf', url: 'u' };

  it('passes when no filter is supplied', () => {
    expect(matchesResourceFilter(file, undefined)).toBe(true);
  });

  it('narrows by resourceType / mimeType / namePattern / hasDocument', () => {
    expect(matchesResourceFilter(file, { resourceType: 'TEXT' })).toBe(false);
    expect(matchesResourceFilter(file, { mimeType: 'application/pdf' })).toBe(true);
    expect(matchesResourceFilter(file, { namePattern: '\\.pdf$' })).toBe(true);
    expect(matchesResourceFilter(file, { namePattern: '\\.png$' })).toBe(false);
    expect(matchesResourceFilter({ ...file, url: null }, { hasDocument: true })).toBe(false);
  });
});
