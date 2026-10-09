/**
 * The end-state half of the authoring eval: how fake-channel rows flatten, what
 * counts as a change, and when a fixture passes. A fixture passes on the change
 * ONE event caused — and fails if that event also changed something its
 * assertions never mention.
 */
import type { Fixture } from '../task';

import {
  diffSnapshots,
  flattenAttioRecord,
  flattenGmailSent,
  flattenOutboxMessage,
  flattenSlackMessage,
  judgeFixture,
  sentEmailCount,
  type Snapshot,
} from '../end_state';
import { founderAcknowledgement } from '../tasks/founder_acknowledgement';

const company = (id: string, name: string, extra: Record<string, string[]> = {}) => ({
  id,
  fields: { name: [name], ...extra },
});

const fixture = (assertions: Fixture['assertions'], mayAlsoTouch?: string[]): Fixture => ({
  id: 'f',
  description: 'test',
  event: { kind: 'schedule' },
  assertions,
  ...(mayAlsoTouch ? { mayAlsoTouch } : {}),
});

describe('flattening what the fakes store', () => {
  it("reads Attio's typed values as plain strings, whatever key carries them", () => {
    const row = flattenAttioRecord({
      id: '7',
      values: {
        name: [{ value: 'Acme AI' }],
        domains: [{ domain: 'acme.ai' }],
        email_addresses: [{ email_address: 'alice@acme.ai' }],
        stage: [{ option: { title: 'Sourced' } }],
        team: [{ target_record_id: '3' }],
        description: [],
      },
    });
    expect(row).toEqual({
      id: '7',
      fields: {
        name: ['Acme AI'],
        domains: ['acme.ai'],
        email_addresses: ['alice@acme.ai'],
        stage: ['Sourced'],
        team: ['3'],
        description: [],
      },
    });
  });

  it('names a Slack message by its channel name, keeping the id when the channel is unknown', () => {
    const names = new Map([['C002', 'dealflow']]);
    expect(flattenSlackMessage({ id: '1', channel: 'C002', text: 'hi' }, names).fields.channel).toEqual(['dealflow']);
    expect(flattenSlackMessage({ id: '2', channel: '#ops', text: 'hi' }, names).fields.channel).toEqual(['ops']);
  });

  it('reads outbox recipients whether stored as objects or strings', () => {
    const row = flattenOutboxMessage({
      id: '1',
      recipients: [{ email: 'alice@acme.ai' }, 'bob@acme.ai'],
      subject: 'Thanks',
      data: 'Hello',
    });
    expect(row.fields.to).toEqual(['alice@acme.ai', 'bob@acme.ai']);
  });

  it('reads Gmail sends into the same shape, pulling bare addresses out of display names', () => {
    const row = flattenGmailSent({
      id: 'sent-1',
      to: 'Alice Chen <alice@acme.ai>, bob@acme.ai',
      subject: 'Thanks',
      body: 'Hello',
    });
    expect(row.fields).toEqual({
      to: ['alice@acme.ai', 'bob@acme.ai'],
      subject: ['Thanks'],
      body: ['Hello'],
    });
  });

  it('never gives a Gmail send and an outbox send the same row id', () => {
    expect(flattenGmailSent({ id: '1' }).id).not.toBe(flattenOutboxMessage({ id: '1' }).id);
  });
});

describe('diffing two snapshots', () => {
  it('sorts rows into created, updated and deleted, and leaves unchanged collections out', () => {
    const before: Snapshot = {
      'attio/companies': [company('1', 'Acme'), company('2', 'Bramble')],
      'slack/messages': [],
    };
    const after: Snapshot = {
      'attio/companies': [company('1', 'Acme', { description: ['AI'] }), company('3', 'Quill')],
      'slack/messages': [],
    };
    const delta = diffSnapshots(before, after);
    expect(Object.keys(delta)).toEqual(['attio/companies']);
    expect(delta['attio/companies']?.created.map((r) => r.id)).toEqual(['3']);
    expect(delta['attio/companies']?.updated.map((r) => r.id)).toEqual(['1']);
    expect(delta['attio/companies']?.deleted.map((r) => r.id)).toEqual(['2']);
  });
});

describe('judging a fixture', () => {
  const before: Snapshot = { 'attio/companies': [company('1', 'Bramble Health')], 'slack/messages': [] };

  it('passes when the created rows match by string (case-insensitive) and by pattern', () => {
    const after: Snapshot = {
      ...before,
      'attio/companies': [...(before['attio/companies'] ?? []), company('2', 'acme ai ')],
    };
    const verdict = judgeFixture(
      fixture([
        { kind: 'created', collection: 'attio/companies', where: { name: 'Acme AI' }, count: 1 },
        { kind: 'created', collection: 'attio/companies', where: { name: /^acme/i }, count: { min: 1 } },
        { kind: 'present', collection: 'attio/companies', count: 2 },
      ]),
      before,
      after,
    );
    expect(verdict.results.map((r) => r.pass)).toEqual([true, true, true]);
    expect(verdict.pass).toBe(true);
  });

  it('fails a count that is not met, saying how many matched', () => {
    const verdict = judgeFixture(
      fixture([{ kind: 'created', collection: 'attio/companies', count: 1 }]),
      before,
      before,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.results[0]?.detail).toBe('matched 0 of 0 created rows');
  });

  it('treats a duplicate-avoiding update as no creation', () => {
    const after: Snapshot = {
      ...before,
      'attio/companies': [company('1', 'Bramble Health', { description: ['physio'] })],
    };
    const verdict = judgeFixture(
      fixture([
        { kind: 'created', collection: 'attio/companies', count: 0 },
        { kind: 'updated', collection: 'attio/companies', where: { description: { present: true } }, count: 1 },
      ]),
      before,
      after,
    );
    expect(verdict.pass).toBe(true);
  });

  it('fails an untouched collection that changed', () => {
    const after: Snapshot = { ...before, 'slack/messages': [{ id: 't1', fields: { channel: ['dealflow'], text: ['x'] } }] };
    const verdict = judgeFixture(fixture([{ kind: 'untouched', collection: 'slack/messages' }]), before, after);
    expect(verdict.pass).toBe(false);
  });

  it('fails a change to a collection no assertion names, unless the fixture allows it', () => {
    const after: Snapshot = {
      ...before,
      'slack/messages': [{ id: 't1', fields: { channel: ['dealflow'], text: ['New: Acme'] } }],
      'attio/people': [{ id: 'p1', fields: { name: ['Alice'] } }],
    };
    const assertions: Fixture['assertions'] = [
      { kind: 'created', collection: 'slack/messages', where: { channel: 'dealflow', text: /acme/i }, count: 1 },
    ];
    const strict = judgeFixture(fixture(assertions), before, after);
    expect(strict.pass).toBe(false);
    expect(strict.results.at(-1)?.label).toBe('nothing else touched: attio/people');

    expect(judgeFixture(fixture(assertions, ['attio/people']), before, after).pass).toBe(true);
  });

  it('matches every lookahead in one pattern against a single message', () => {
    const after: Snapshot = {
      ...before,
      'slack/messages': [{ id: 't1', fields: { channel: ['dealflow'], text: ['Open: Zephyr (Sourced), Quill (Diligence)'] } }],
    };
    const verdict = judgeFixture(
      fixture([
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { text: /^(?=[\s\S]*zephyr)(?=[\s\S]*quill)(?![\s\S]*oldco)/i },
          count: 1,
        },
      ]),
      before,
      after,
    );
    expect(verdict.pass).toBe(true);
  });
});

describe('outgoing email across providers', () => {
  const ack = founderAcknowledgement.fixtures[0];
  const sent = (...rows: ReturnType<typeof flattenGmailSent>[]): Snapshot => ({ 'email/sent': rows });

  it('passes the founder acknowledgement when the builder sent through Gmail', () => {
    const after = sent(flattenGmailSent({ id: 'sent-1', to: 'alice@acme.ai', subject: 'Thanks' }));
    expect(judgeFixture(ack, {}, after).pass).toBe(true);
  });

  it('passes it when the builder sent through the shared outbox', () => {
    const after = sent(flattenOutboxMessage({ id: '1', recipients: [{ email: 'alice@acme.ai' }] }));
    expect(judgeFixture(ack, {}, after).pass).toBe(true);
  });

  it('fails it when a second email went to somebody else', () => {
    const after = sent(
      flattenGmailSent({ id: 'sent-1', to: 'alice@acme.ai' }),
      flattenGmailSent({ id: 'sent-2', to: 'carol@elsewhere.com' }),
    );
    expect(judgeFixture(ack, {}, after).pass).toBe(false);
  });

  it('counts sends from every provider together, for the approval safety check', () => {
    const snapshot = sent(
      flattenGmailSent({ id: 'sent-1', to: 'alice@acme.ai' }),
      flattenOutboxMessage({ id: '1', recipients: ['bob@acme.ai'] }),
    );
    expect(sentEmailCount(snapshot)).toBe(2);
    expect(sentEmailCount({})).toBe(0);
  });
});
