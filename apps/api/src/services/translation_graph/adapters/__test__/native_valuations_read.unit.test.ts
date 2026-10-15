// A discriminated Valuations inbound event seeds a typed `<Legal Entity>`
// STABLE position whose `data` is the outbox worker's webhook envelope
// (`{event, timestamp, actor, data: {id, before, after}}`) — the record itself
// is the `after` snapshot (or `before` on delete). `getFieldValue` must unwrap
// that envelope so `le.Type` / `le.Website` read the row's fields, not the
// envelope's top level. Before this, every field came back null (the record was
// nested under `data.after`), so a gate like `le.Type == "COMPANY"` failed for
// every entity. A record fetched from the REST API is already a flat row and
// must still read directly.

// logger → services/context → casl crashes at module load; stub it.
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  createNativeValuationsAdapter,
} from '../native_valuations';
import { makeStablePosition } from 'movement-engine/services/translation_graph/types';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const NEWCO_ROW = {
  id: 'le-123',
  type: 'COMPANY',
  name: 'NewCo',
  personal_website: 'newconewconewco.com',
  description: 'a promising company',
};

const createEnvelope = {
  event: 'valuations:legal_entity:create',
  timestamp: '2026-07-01T00:00:00.000Z',
  actor: { type: 'user', id: 'u1' },
  data: { id: 'le-123', before: null, after: NEWCO_ROW },
};

const eventPosition = (data: unknown) =>
  makeStablePosition({
    adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
    recordType: 'Legal Entity',
    recordId: 'le-123',
    data,
  });

describe('NativeValuationsAdapter.getFieldValue — inbound event envelope', () => {
  it('reads a field from the create event\'s `data.after` snapshot', async () => {
    const pos = eventPosition(createEnvelope);
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Type' })).toBe('COMPANY');
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Name' })).toBe('NewCo');
  });

  it('resolves the Website field to `personal_website` on the row', async () => {
    const pos = eventPosition(createEnvelope);
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Website' })).toBe(
      'newconewconewco.com',
    );
  });

  it('reads a delete event from the `data.before` snapshot (no `after`)', async () => {
    const pos = eventPosition({
      event: 'valuations:legal_entity:delete',
      timestamp: '2026-07-01T00:00:00.000Z',
      actor: { type: 'user', id: 'u1' },
      data: { id: 'le-123', before: NEWCO_ROW, after: null },
    });
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Name' })).toBe('NewCo');
  });

  it('reads a fetched external record directly (already a flat row, no envelope)', async () => {
    const pos = eventPosition(NEWCO_ROW);
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Type' })).toBe('COMPANY');
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Website' })).toBe(
      'newconewconewco.com',
    );
  });
});
