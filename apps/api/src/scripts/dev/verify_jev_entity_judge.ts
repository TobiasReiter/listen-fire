/**
 * Live check for the Jev entity-match judge (`judgeEntityMatchViaJev`,
 * `services/translation_graph/engine/entity_match.ts`) against the real Jev
 * API. Synthetic data only — no adapters, no fake channels, no DB; this
 * calls the Jev judge path directly rather than going through a movement
 * run. `[tg_entity_match] decision` log lines below each result carry the
 * per-candidate `{ same, evidence }` scores.
 *
 * Usage: JEV_KEY=... npx tsx apps/api/src/scripts/dev/verify_jev_entity_judge.ts
 */
import type { ExternalRecordRef } from 'movement-engine/services/translation_graph/adapter';

import { judgeEntityMatchViaJev } from '../../services/translation_graph/engine/entity_match';

function candidate(data: Record<string, unknown>, externalId: string): ExternalRecordRef {
  return { adapterType: 'attio', externalId, recordType: 'attio:companies', data };
}

async function scenario(
  label: string,
  input: { asserted: Record<string, unknown>; candidates: ExternalRecordRef[] },
): Promise<void> {
  console.log(`\n── ${label}`);
  const index = await judgeEntityMatchViaJev({ ...input, recordType: 'company' });
  console.log(`   decision: ${index === null ? 'none (create)' : `matched candidate ${index}`}`);
}

async function main(): Promise<void> {
  if (!process.env.JEV_KEY) {
    throw new Error('JEV_KEY must be set in the environment to run this probe');
  }

  await scenario('(a) two different companies sharing no distinguishing field — expect none', {
    asserted: { name: 'Pavo AI', website: 'https://pavoai.com' },
    candidates: [candidate({ name: 'OriqX', website: 'https://oriqx.com' }, 'cand-a')],
  });

  await scenario('(b) the same company, punctuation/protocol differences only — expect a match', {
    asserted: { name: 'Lumen Robotics', website: 'lumenrobotics.pl' },
    candidates: [
      candidate(
        { name: 'Lumen Robotics Sp. z o.o.', website: 'https://www.lumenrobotics.pl/' },
        'cand-b',
      ),
    ],
  });

  await scenario('(c) three candidates, one clear match on distinguishing fields — expect candidate 0', {
    asserted: { name: 'Jon Smith', company: 'Acme Analytics', title: 'Founder' },
    candidates: [
      candidate({ name: 'Jonathan Smith', company: 'Acme Analytics Ltd', title: 'CEO' }, 'cand-c0'),
      candidate({ name: 'John Smith', company: 'Acme Corp', title: 'VP Sales' }, 'cand-c1'),
      candidate({ name: 'Jon Smythe', company: 'Beacon Health', title: 'Founder' }, 'cand-c2'),
    ],
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
