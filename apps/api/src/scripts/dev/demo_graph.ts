/**
 * The demo's knowledge entities.
 *
 *   pnpm dev:demo-graph
 *
 * `ensureDevLoopTeam` materialises the `vc-dealflow` ontology but no instances,
 * so a demo graph opens on an empty table and looks broken. This writes a
 * handful of Organisations onto the ontology's OWN type ids — nothing here
 * invents a schema — and is idempotent by name, so re-running the demo seed
 * adds nothing.
 */
import './_profile_loader';
import { getKnowledgeQb } from '../../lib/kysely';
import { createNode, openKnowledgeStore } from '../../lib/knowledge/store';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import ChangeSource from '../../generated/kysely/knowledge/ChangeSource';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';

import { ensureDevLoopTeam } from './_lib';

const DEMO_COMPANIES = [
  'Northwind Robotics',
  'Halcyon Bio',
  'Kestrel Logistics',
  'Marlowe Analytics',
  'Verdant Energy',
] as const;

/** The one property every demo Organisation carries. Split out so the shape is
 *  checkable without a database. */
function demoPropertyWrites(propertyTypeId: string, name: string) {
  return [{ propertyTypeId, value: name }];
}

async function ensureDemoGraph(): Promise<{ created: number }> {
  const { teamId } = await ensureDevLoopTeam();
  const team = teamId as TeamId;
  const db = openKnowledgeStore();
  const qb = getKnowledgeQb(['node_type', 'property_type', 'property']);

  const nodeType = await qb
    .selectFrom('node_type')
    .where('team_id', '=', team)
    .where('name', '=', 'Organisation')
    .select(['id'])
    .executeTakeFirstOrThrow();

  const nameProperty = await qb
    .selectFrom('property_type')
    .where('team_id', '=', team)
    .where('node_type_id', '=', nodeType.id)
    .where('name', '=', 'Name')
    .select(['id'])
    .executeTakeFirstOrThrow();

  // Idempotent by the NAME already written, not by a marker of our own: a
  // second demo seed must add nothing, and the graph's own values are the only
  // honest record of what is there.
  const existing = await qb
    .selectFrom('property')
    .where('team_id', '=', team)
    .where('property_type_id', '=', nameProperty.id)
    .select(['value_text'])
    .execute();
  const present = new Set(existing.map((row) => row.value_text));

  let created = 0;
  for (const name of DEMO_COMPANIES) {
    if (present.has(name)) continue;
    await createNode(db, {
      context: {
        teamId: team,
        evidenceType: EvidenceType.user_edit,
        changeSource: ChangeSource.user_edit,
        description: 'demo dataset',
      },
      nodeTypeId: nodeType.id as NodeTypeId,
      properties: demoPropertyWrites(nameProperty.id as PropertyTypeId, name),
    });
    created += 1;
  }

  return { created };
}

export { DEMO_COMPANIES, demoPropertyWrites, ensureDemoGraph };

if (require.main === module) {
  ensureDemoGraph()
    .then(({ created }) => {
      console.log(`Demo graph ready (${created} organisation(s) created)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
