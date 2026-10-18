// The loop guard slot: a module that keeps a run's own writes from firing it
// again (plans/cloud-native-2026-10-06/22_everywhere_plan.md, Henry
// 2026-10-18). Empty unless a project names one in `core:`; with none, a
// movement that writes to a source it listens to hears its own write come
// back and runs again. The platform's opt-in `suppress_self` listen flag is
// separate and unchanged.
//
// The host reads a record back after a run writes it (`recordWrite`) and,
// when an inbound event names a record, asks whether the event is the echo
// of that listen's own write (`isEcho`). Everything else is the guard's: how
// long it remembers, what "unchanged" means, where its memory lives. The
// contract is docs/contracts/loop-guard-slot.md; the built-in,
// `@lf/fingerprint-guard`, is `FingerprintGuard` here and in lf
// (crates/lf/src/loop_guard.rs).

import { createHash } from 'node:crypto';

/** A record write, with the record as the source answered it right after
 *  (`null`: the record is gone). `writer` is the listen that wrote it. */
export interface RecordWrite {
  adapter: string;
  recordType: string;
  externalId: string;
  writer: string;
  record: unknown;
}

/** Whether an event naming `externalId` is the echo of `writer`'s write.
 *  `current` is the record as it stands now, sent once the guard has said
 *  which type to read. */
export interface EchoQuestion {
  adapter: string;
  externalId: string;
  writer: string;
  current?: { recordType: string; record: unknown };
}

/** `echo`: the answer. `read`: the guard needs `current` of this type to say. */
export type EchoAnswer = { echo: boolean } | { read: { recordType: string } };

export interface LoopGuard {
  /** `writer`'s write, remembered; its later write to the same record replaces it. */
  recordWrite(write: RecordWrite): Promise<void>;
  isEcho(question: EchoQuestion): Promise<EchoAnswer>;
}

/** How long the built-in remembers a write. */
export const REMEMBERED_MS = 3_600_000;

function fingerprint(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record) ?? 'null').digest('hex');
}

/** The built-in, in this process. */
export class FingerprintGuard implements LoopGuard {
  private readonly remembered = new Map<string, { recordType: string; fingerprint: string; expiresAt: number }>();

  async recordWrite(write: RecordWrite): Promise<void> {
    const now = Date.now();
    for (const [key, one] of this.remembered) if (one.expiresAt <= now) this.remembered.delete(key);
    this.remembered.set(JSON.stringify([write.adapter, write.externalId, write.writer]), {
      recordType: write.recordType,
      fingerprint: fingerprint(write.record),
      expiresAt: now + REMEMBERED_MS,
    });
  }

  async isEcho(question: EchoQuestion): Promise<EchoAnswer> {
    const one = this.remembered.get(JSON.stringify([question.adapter, question.externalId, question.writer]));
    if (one === undefined || one.expiresAt <= Date.now()) return { echo: false };
    if (question.current === undefined) return { read: { recordType: one.recordType } };
    return { echo: fingerprint(question.current.record) === one.fingerprint };
  }
}
