import type { AdapterManifest } from '../../adapter';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { deriveCapabilityNote, deriveIdentityNote } from '../adapter_notes';

function manifest(overrides: Partial<AdapterManifest>): AdapterManifest {
  return {
    adapterType: 'x',
    displayName: 'X',
    supportedTriggers: ['webhook'],
    methods: [],
    ...overrides,
  };
}

describe('deriveIdentityNote', () => {
  it('a globally-addressable inbound system states BOTH runs-as and the needs-an-account gate', () => {
    const note = deriveIdentityNote(
      manifest({
        displayName: 'Slack',
        requiredCredentialType: ExternalServiceType.SLACK,
        inboundRequiresRegisteredActor: true,
        methods: ['createRecord'],
      }),
    );
    expect(note).toContain('runs with the Slack account that connected it');
    expect(note).toContain('set up on this team');
    expect(note).toContain('not set up on the team yet');
  });

  it('a credentialed system with no registered-actor gate states runs-as only', () => {
    const note = deriveIdentityNote(
      manifest({ displayName: 'Attio', requiredCredentialType: ExternalServiceType.ATTIO, methods: ['createRecord', 'updateRecord', 'deleteRecord'] }),
    );
    expect(note).toContain('runs with the Attio account that connected it');
    expect(note).not.toContain('set up on this team');
  });

  it('an intrinsic (no credential, no gate) has no identity note', () => {
    expect(deriveIdentityNote(manifest({ displayName: 'Knowledge Graph', methods: ['createRecord'] }))).toBeUndefined();
  });

  it('the needs-an-account sentence comes from the flag alone — no hand-written prose required', () => {
    // The regression guarantee: a future gated adapter that only sets the flag
    // still surfaces the gate, without an author re-typing Slack's triggerExpectation.
    const note = deriveIdentityNote(manifest({ inboundRequiresRegisteredActor: true, methods: [] }));
    expect(note).toContain('set up on this team');
  });
});

describe('deriveCapabilityNote', () => {
  it('a system with no write methods is source-only', () => {
    expect(deriveCapabilityNote(manifest({ methods: [] }))).toContain('Source only');
  });

  it('create without update/delete is add-only', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord'] }));
    expect(note).toContain('added here, not updated or deleted');
  });

  it('create+update without delete says no delete', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord', 'updateRecord'] }));
    expect(note).toContain('added and updated, but not deleted');
  });

  it('a system with no triggers says so (a write/read target, not a source)', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord'], supportedTriggers: [] }));
    expect(note).toContain('no event triggers');
  });

  it('full read/write with triggers has nothing limiting to say', () => {
    expect(
      deriveCapabilityNote(manifest({ methods: ['createRecord', 'updateRecord', 'deleteRecord'] })),
    ).toBeUndefined();
  });
});
