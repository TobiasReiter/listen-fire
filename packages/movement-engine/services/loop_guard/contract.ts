// The loop guard slot's contract suite: one set of cases every guard is held
// to — the built-in in this process (FingerprintGuard), lf's Rust one over
// the guard wire (`lf --contract-guard`, a file and a Postgres database), and
// a guard module lf drives as a process (`lf --contract-guard-slot`), all in
// apps/cli's tests. How long a guard remembers is its own business, so no
// case waits on it.
//
// Runner-agnostic, as the run host's suite is: each case is a name and an
// async body that throws on failure (node:assert). Every case uses records
// of its own, so one guard can serve the whole list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EchoQuestion, LoopGuard } from './loop_guard';

export interface LoopGuardContractCase {
  name: string;
  run(guard: LoopGuard): Promise<void>;
}

const WRITER = 'listen:sync:stamp';

function aRecord() {
  return { adapter: 'attio', recordType: 'Companies', externalId: `rec-${randomUUID()}` };
}

const seen = { name: 'Acme', description: 'Seen by lf' };
const edited = { name: 'Acme', description: 'Edited by Bob' };

async function isEcho(guard: LoopGuard, question: EchoQuestion): Promise<unknown> {
  return guard.isEcho(question);
}

export const loopGuardContractCases: LoopGuardContractCase[] = [
  {
    name: 'a record nothing was written to is no echo, and needs no read',
    async run(guard) {
      const { adapter, externalId } = aRecord();
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER }), { echo: false });
    },
  },
  {
    name: 'a written record asks to be read, and unchanged is the writer\'s echo',
    async run(guard) {
      const one = aRecord();
      await guard.recordWrite({ ...one, writer: WRITER, record: seen });
      const { adapter, externalId } = one;
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER }), { read: { recordType: 'Companies' } });
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: { recordType: 'Companies', record: structuredClone(seen) } }), { echo: true });
    },
  },
  {
    name: 'a record changed since the write is not an echo',
    async run(guard) {
      const one = aRecord();
      await guard.recordWrite({ ...one, writer: WRITER, record: seen });
      const { adapter, externalId } = one;
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: { recordType: 'Companies', record: edited } }), { echo: false });
    },
  },
  {
    name: 'the write is the echo for its writer only, on its record only',
    async run(guard) {
      const one = aRecord();
      await guard.recordWrite({ ...one, writer: WRITER, record: seen });
      const { adapter, externalId } = one;
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: 'listen:audit:log' }), { echo: false });
      assert.deepEqual(await isEcho(guard, { adapter, externalId: `${externalId}-other`, writer: WRITER }), { echo: false });
      assert.deepEqual(await isEcho(guard, { adapter: 'airtable', externalId, writer: WRITER }), { echo: false });
    },
  },
  {
    name: 'the same writer\'s later write replaces the earlier one, and a writer\'s own writes do not touch another\'s',
    async run(guard) {
      const one = aRecord();
      const { adapter, externalId } = one;
      await guard.recordWrite({ ...one, writer: WRITER, record: seen });
      await guard.recordWrite({ ...one, writer: 'listen:audit:log', record: edited });
      await guard.recordWrite({ ...one, writer: WRITER, record: edited });
      const now = { recordType: 'Companies', record: structuredClone(seen) };
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: now }), { echo: false });
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: { ...now, record: edited } }), { echo: true });
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: 'listen:audit:log', current: { ...now, record: edited } }), { echo: true });
    },
  },
  {
    name: 'a record that is gone can be the echo of its own deletion',
    async run(guard) {
      const one = aRecord();
      const { adapter, externalId } = one;
      await guard.recordWrite({ ...one, writer: WRITER, record: null });
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: { recordType: 'Companies', record: null } }), { echo: true });
      assert.deepEqual(await isEcho(guard, { adapter, externalId, writer: WRITER, current: { recordType: 'Companies', record: seen } }), { echo: false });
    },
  },
];
