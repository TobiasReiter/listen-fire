// Phase 5.4 e2e — the source-material family after its move into `knowledge`.
//
// The move is only as good as the paths that read and write these tables, so
// this exercises them through their real modules rather than asserting on
// catalogue rows: the movement engine's raw-text store, the KG adapter's
// resource-provenance writer, the graph API route that adapter posts to, the
// summariser that quotes the excerpt, and the MCP node-detail tool.
//
// Run against a booted dev-loop stack on `listenfire_dev`.

import './_profile_loader';
import '../../services';

import { randomUUID } from 'node:crypto';

import { getCoreQb, getKnowledgeQb } from '../../lib/kysely';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import ResourceType from '../../generated/kysely/knowledge/ResourceType';
import { ApiKeyService } from '../../services/api_key';
import { postgresRawTextStore } from '../../services/translation_graph/movement/raw_text_store';
import { summarizeNodes } from '../../lib/knowledge/store';
import { openKnowledgeStore } from '../../lib/knowledge/store/write';
import { getNodeDetail } from '../../lib/knowledge/knowledge_query';
import { runInSystemContext } from '../../services/context/utils';
import { LlmUsageContext } from '../../lib/llm_usage';

const TEAM = (process.env.DEV_TEAM_ID ?? '00000000-0000-4000-8000-000000000001') as TeamId;
const API = process.env.DEV_API_BASE ?? 'http://localhost:3500';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail)?.slice(0, 400));
  }
}

async function main(): Promise<void> {
  console.log('phase 5.4 — source material in `knowledge`\n');

  await runInSystemContext(async () =>
    // The ambient LLM-usage context a movement firing establishes, so every
    // call below sees the team a firing's would.
    new LlmUsageContext({ teamId: TEAM }).runAsync(async () => {
    const store = openKnowledgeStore();
    const rawText = postgresRawTextStore(TEAM);

    // 1. Every table answers from `knowledge`, and from nowhere else.
    const placement = await getKnowledgeQb(['resource'])
      .selectFrom('resource')
      .select(({ fn }) => fn.count<number>('resource.id').as('n'))
      .executeTakeFirst();
    check('`knowledge.resource` is queryable through getKnowledgeQb', placement !== undefined, placement);

    // 2. The movement engine's file-text path writes `knowledge.raw_text`.
    const CONTENT = `phase 5.4 source body ${randomUUID()}`;
    const rawTextId = (await rawText.getOrCreateId(CONTENT)) as string;
    const rawRow = await getKnowledgeQb(['raw_text'])
      .selectFrom('raw_text')
      .where('id', '=', rawTextId as never)
      .select(['content', 'team_id'])
      .executeTakeFirst();
    check('the engine raw-text store lands in `knowledge.raw_text`', rawRow?.content === CONTENT, rawRow?.content);

    // Idempotent by (team, checksum), unchanged by the move.
    const again = await rawText.getOrCreateId(CONTENT);
    check('raw-text dedup by (team, checksum) still collapses', again === rawTextId, { rawTextId, again });

    // 3. A resource carrying that body, the shape the KG adapter writes.
    const resourceId = randomUUID() as ResourceId;
    await getKnowledgeQb(['resource'])
      .insertInto('resource')
      .values({
        id: resourceId,
        team_id: TEAM,
        type: ResourceType.TEXT,
        name: 'phase 5.4 probe source',
        raw_text_id: rawTextId as never,
      })
      .execute();

    const joined = await getKnowledgeQb(['resource', 'raw_text'])
      .selectFrom('resource')
      .innerJoin('raw_text', 'raw_text.id', 'resource.raw_text_id')
      .where('resource.id', '=', resourceId)
      .select(['raw_text.content'])
      .executeTakeFirst();
    check('resource → raw_text joins inside one schema', joined?.content === CONTENT, joined);

    // 4. A node to hang provenance off (fixture, not the subject).
    const nodeType = await getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', TEAM)
      .select(['id'])
      .executeTakeFirst();
    if (!nodeType) {
      check('a seeded node type exists', false);
      return;
    }
    const existingNode = await getKnowledgeQb(['node'])
      .selectFrom('node')
      .where('team_id', '=', TEAM)
      .select(['id'])
      .executeTakeFirst();
    const nodeId = (existingNode?.id ??
      (
        await getKnowledgeQb(['node'])
          .insertInto('node')
          .values({ team_id: TEAM, node_type_id: nodeType.id } as never)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id) as NodeId;

    // An API key with the `knowledge` scope — the graph routes sit behind it.
    const owner = await getCoreQb(['user'])
      .selectFrom('user')
      .where('default_team_id', '=', TEAM)
      .select(['id'])
      .executeTakeFirstOrThrow();
    // Through the service: a local generator carries its own copy of the key
    // prefix, and `validateKey` refuses anything not minted with the current one.
    const { key: plaintext } = await ApiKeyService.createForOwner({
      name: `phase54-probe-${Date.now()}`,
      scopes: ['knowledge'],
      teamId: TEAM,
      createdBy: owner.id,
    });

    // 5. The link, and the restored FK's refusal. Both through the REAL route
    //    the KG adapter posts to.
    const post = (body: unknown) =>
      fetch(`${API}/api/v1/knowledge/graph/nodes/${nodeId}/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(body),
      });

    const EXCERPT = CONTENT;
    const good = await post({ resourceId, excerpt: EXCERPT, facts: [] });
    check('POST /nodes/:id/resources accepts a real resource', good.status === 200, {
      status: good.status,
      body: (await good.text()).slice(0, 200),
    });

    const dangling = await post({ resourceId: randomUUID(), excerpt: null, facts: [] });
    check(
      'POST /nodes/:id/resources answers 404 for an id naming no resource (restored FK, guarded)',
      dangling.status === 404,
      { status: dangling.status, body: (await dangling.text()).slice(0, 200) },
    );

    const link = await getKnowledgeQb(['node_resource'])
      .selectFrom('node_resource')
      .where('node_id', '=', nodeId)
      .where('resource_id', '=', resourceId)
      .select(['excerpt'])
      .executeTakeFirst();
    check('the link carries its excerpt', link?.excerpt === EXCERPT, link?.excerpt?.slice(0, 80));

    // 6. The summarize path — the one this move was forbidden to break.
    await summarizeNodes(store, { teamId: TEAM, nodeIds: [nodeId] });
    const summarised = await getKnowledgeQb(['node'])
      .selectFrom('node')
      .where('id', '=', nodeId)
      .select(['summary'])
      .executeTakeFirst();
    check(
      'the summary still quotes the source excerpt',
      summarised?.summary?.includes(EXCERPT) === true,
      summarised?.summary?.slice(0, 200),
    );

    // 7. MCP getNodeDetail returns the source refs and their text.
    const detail = await getNodeDetail(nodeId, TEAM);
    const serialised = JSON.stringify(detail);
    check('getNodeDetail returns the resource', serialised.includes(resourceId), undefined);
    check('getNodeDetail returns the source text', serialised.includes(CONTENT), undefined);

    // 8. The FK really is enforced, not merely declared.
    let refused = false;
    try {
      await getKnowledgeQb(['node_resource'])
        .insertInto('node_resource')
        .values({ team_id: TEAM, node_id: nodeId, resource_id: randomUUID() as ResourceId })
        .execute();
    } catch {
      refused = true;
    }
    check('a dangling node_resource insert is refused by the database', refused);
    }),
  );

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
