// Phase 3 close-out acceptance — the five seams, driven through the real stack.
//
// One script rather than five because they share a seeded team and a running
// API, and because "does the phase hold together" is one question.
//
//   (v)  asks        — a settle reaches the engine through the notifier seam in
//                      composed mode, and enqueues NOTHING (one active path).
//   (vi) valuations  — a REST-registered destination receives a signed POST
//                      through the NEW pair, and the legacy pair is gone.
//   (vii) summary    — a kg node's summary quotes the persisted excerpt.
//   (viii) audit     — an automations write lands in automations' own log,
//                      attributed off automations' own GUCs.
//
// Run: pnpm dev:verify_phase3_closeout   (needs `pnpm dev:loop:agent` + dev:seed)

import './_profile_loader';
import '../../services';

import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

import { getAsksQb, getAutomationsQb, getKnowledgeQb, getValuationsQb } from '../../lib/kysely';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import ResourceType from '../../generated/kysely/knowledge/ResourceType';
import { createAsk, getAsk } from '../../services/translation_graph/adapters/ask/store';
import { answerAskByToken } from '../../services/translation_graph/adapters/ask/answer_door';
import { notifyEngineOfSettledAsks } from '../../services/asks/in_process_notifier';
import { askSettleDelivery } from '../../services/translation_graph/adapters/ask/delivery_mode';
import { deliverOnce, signPayload } from '../../services/valuations_outbox/delivery';
import { summarizeNodes } from '../../lib/knowledge/store';
import { openKnowledgeStore } from '../../lib/knowledge/store/write';
import { sessionContextArgs as automationsSessionContextArgs } from '../../lib/automations/session';
import { sql } from 'kysely';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeId } from '../../generated/kysely/knowledge/Node';

const TEAM = (process.env.DEV_TEAM_ID ?? '00000000-0000-4000-8000-000000000001') as TeamId;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.warn(`  ok    ${name}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  console.warn(`\n── ${title}`);
  await fn();
}

// ── (v) asks ───────────────────────────────────────────────────────────────
async function asks(): Promise<void> {
  check('delivery mode is `local` for the composed deployment', askSettleDelivery() === 'local');

  let nudged = 0;
  // Register the composed notifier, wrapping a counter instead of the engine so
  // the seam itself is what is observed.
  const { registerAskSettledNotifier } = await import(
    '../../services/translation_graph/adapters/ask/notifier'
  );
  registerAskSettledNotifier({
    async notify() {
      nudged += 1;
    },
    async cancelled() {},
  });

  const ask = await createAsk({
    teamId: TEAM,
    family: 'Check',
    prompt: 'Phase 3 close-out probe — approve?',
    callbackUrl: 'https://receiver.invalid/hook',
  });
  const outcome = await answerAskByToken(ask.token, true);
  check('the ask answers through the door', outcome.kind === 'answered', outcome.kind);
  check('the settle reached the notifier seam exactly once', nudged === 1, { nudged });

  const settled = await getAsk(ask.id);
  check('the answer is durable before any notification', settled?.state === 'answered' && settled.answer === true, settled?.state);

  const queued = await getAsksQb(['ask_webhook_delivery'])
    .selectFrom('ask_webhook_delivery')
    .where('ask_id', '=', ask.id)
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .executeTakeFirst();
  check('and NOTHING was enqueued — one active path (D39c)', Number(queued?.count ?? 0) === 0, queued);

  // Restore the real wiring so the rest of the process is not left stubbed.
  notifyEngineOfSettledAsks();
}

// ── (vi) valuations ────────────────────────────────────────────────────────
async function valuations(): Promise<void> {
  const legacy = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM information_schema.tables
    WHERE table_schema = 'valuations' AND table_name IN ('webhook', 'outbound_webhook_request')
  `.execute(getValuationsQb());
  check('the legacy pair is dropped', legacy.rows[0]?.n === '0', legacy.rows[0]);

  const received: Array<{ body: string; signature: string | undefined }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, signature: req.headers['x-webhook-signature'] as string | undefined });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const secret = 'phase3-closeout-secret';

  const subscription = await getValuationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      team_id: TEAM,
      url: `http://127.0.0.1:${port}/hook`,
      event_type: 'valuations:legal_entity:update',
      name: 'phase3 probe',
      secret,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const payload = { event: 'valuations:legal_entity:update', probe: true };
  await getValuationsQb(['outbound_delivery'])
    .insertInto('outbound_delivery')
    .values({
      subscription_id: subscription.id,
      team_id: TEAM,
      event_type: 'valuations:legal_entity:update',
      payload: JSON.stringify(payload),
    })
    .execute();

  const result = await deliverOnce();
  check('the delivery worker delivered through the new pair', result.delivered >= 1, result);
  check('the receiver got the payload', received.length === 1 && JSON.parse(received[0]!.body).probe === true, received[0]?.body);
  check(
    'signed HMAC-SHA256 over the raw body, as integrators already verify',
    received[0]?.signature === signPayload(received[0]!.body, secret),
    received[0]?.signature,
  );

  const delivered = await getValuationsQb(['outbound_delivery'])
    .selectFrom('outbound_delivery')
    .where('subscription_id', '=', subscription.id)
    .select(['delivered_at', 'attempts'])
    .executeTakeFirst();
  check('and the row is marked delivered', delivered?.delivered_at !== null, delivered);

  // A soft-deleted destination stops its queue rather than retrying to death.
  await getValuationsQb(['webhook_subscription'])
    .updateTable('webhook_subscription')
    .set({ deleted_at: new Date() })
    .where('id', '=', subscription.id)
    .execute();
  await getValuationsQb(['outbound_delivery'])
    .insertInto('outbound_delivery')
    .values({
      subscription_id: subscription.id,
      team_id: TEAM,
      event_type: 'valuations:legal_entity:update',
      payload: JSON.stringify(payload),
    })
    .execute();
  const afterDelete = await deliverOnce();
  check('a removed destination stops its queued deliveries', afterDelete.delivered === 0 && received.length === 1, {
    afterDelete,
    received: received.length,
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── (vii) summary excerpts ─────────────────────────────────────────────────
async function summaries(): Promise<void> {
  const store = openKnowledgeStore();
  const node = await getKnowledgeQb(['node'])
    .selectFrom('node')
    .where('team_id', '=', TEAM)
    .select(['id'])
    .executeTakeFirst();
  if (!node) {
    check('a seeded knowledge node exists to summarise', false);
    return;
  }

  const EXCERPT = 'Phase 3 close-out excerpt — persisted knowledge-side.';
  // The link's FK came back with the phase 5.4 source-material move, so the
  // resource has to exist before it can be pointed at — a random uuid is no
  // longer a stand-in.
  const resourceId = randomUUID() as ResourceId;
  await getKnowledgeQb(['resource'])
    .insertInto('resource')
    .values({
      id: resourceId,
      team_id: TEAM,
      type: ResourceType.TEXT,
      name: 'Phase 3 close-out source',
    })
    .execute();

  await getKnowledgeQb(['node_resource'])
    .insertInto('node_resource')
    .values({ team_id: TEAM, node_id: node.id, resource_id: resourceId, excerpt: EXCERPT })
    .execute();

  await summarizeNodes(store, { teamId: TEAM, nodeIds: [node.id as NodeId] });

  const after = await getKnowledgeQb(['node'])
    .selectFrom('node')
    .where('id', '=', node.id)
    .select(['summary'])
    .executeTakeFirst();
  check('the summary quotes the persisted excerpt', after?.summary?.includes(EXCERPT) === true, after?.summary?.slice(0, 160));
  check('…under the Source Material heading, unchanged in shape', after?.summary?.includes('### Source Material') === true);
  check('…and still opens with the node type', after?.summary?.startsWith('## ') === true, after?.summary?.slice(0, 40));

  const backwards = await getKnowledgeQb(['node_resource'])
    .selectFrom('node_resource')
    .where('team_id', '=', TEAM)
    .where('excerpt', 'is', null)
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .executeTakeFirst();
  check('every link carries its own text — nothing left to read backwards for', Number(backwards?.count ?? 0) === 0, backwards);
}

// ── (viii) automations audit ───────────────────────────────────────────────
async function automationsAudit(): Promise<void> {
  const movement = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', '=', TEAM)
    .select(['id'])
    .executeTakeFirst();
  if (!movement) {
    check('a seeded movement exists to audit', false);
    return;
  }

  const actorId = randomUUID();
  const contextId = randomUUID();
  const [aTeam, aType, aId, aCtx] = automationsSessionContextArgs({
    teamId: TEAM,
    userId: actorId,
    contextId,
  });

  await getAutomationsQb(['movement', 'audit_log'])
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT automations.set_session_context(${aTeam}, ${aType}, ${aId}, ${aCtx})`.execute(trx);
      await trx.updateTable('movement').set({ updated_at: new Date() }).where('id', '=', movement.id).execute();

      const row = await trx
        .selectFrom('audit_log')
        .where('table_name', '=', 'movement')
        .where('model_id', '=', movement.id)
        .orderBy('version', 'desc')
        .select(['op', 'created_by', 'team_id', 'context_id'])
        .executeTakeFirst();
      check('the write lands in automations.audit_log', row !== undefined, row);
      check('attributed off automations own GUCs', row?.created_by === actorId && row?.context_id === contextId, row);
      check('and tenanted to the team', row?.team_id === TEAM, row?.team_id);

      const leaked = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM public.audit_log
        WHERE table_name = 'movement' AND created_at > now() - interval '1 minute'
      `.execute(trx);
      check('and NOTHING reached the residual public.audit_log', leaked.rows[0]?.n === '0', leaked.rows[0]);

      // A probe, not a change: the movement's timestamp is not the point.
      throw new RollbackProbe();
    })
    .catch((err) => {
      if (!(err instanceof RollbackProbe)) throw err;
    });
}

class RollbackProbe extends Error {}

async function main(): Promise<void> {
  await section('(v) asks settle notification', asks);
  await section('(vi) valuations delivery pair', valuations);
  await section('(vii) summary excerpts', summaries);
  await section('(viii) automations audit', automationsAudit);

  console.warn(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} checks passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
