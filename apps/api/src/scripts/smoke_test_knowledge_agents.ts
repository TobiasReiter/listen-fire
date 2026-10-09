import { randomUUID } from 'node:crypto';

import type { TeamId } from '../generated/kysely/core/Team';
import type { NodeTypeId } from '../generated/kysely/knowledge/NodeType';

import { getCoreQb, getKnowledgeQb } from '../lib/kysely';
import { materializeTemplate } from '../lib/knowledge/templates/materialize';
import { runOntologyAgent } from '../lib/knowledge/ontology_agent';
import { Context } from '../services/context';
import { userPrincipal } from '../services/principal';

// -- Helpers --

let stepCounter = 0;

function log(message: string) {
  stepCounter++;
  console.log(`\n${stepCounter}. ${message}`);
}

function indent(message: string) {
  console.log(`   ${message}`);
}

function pass(test: string) {
  console.log(`   ✓ ${test}`);
}

function fail(test: string) {
  console.log(`   ✗ ${test}`);
}

function assert(condition: boolean, test: string) {
  if (condition) pass(test);
  else fail(test);
}

async function createTestTeam(name: string): Promise<TeamId> {
  const teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name })
    .execute();
  return teamId;
}

async function seedKnowledgeData(teamId: TeamId) {
  const kqb = getKnowledgeQb([
    'node_type',
    'edge_type',
    'extraction_graph',
    'extraction_graph_edge',
    'node',
    'edge',
  ]);

  // Materialize VC dealflow template
  const matQb = getKnowledgeQb(['node_type', 'property_type', 'edge_type', 'extraction_graph', 'extraction_graph_node', 'extraction_graph_edge']);
  const result = await (matQb as any).transaction().execute((trx: any) =>
    materializeTemplate(trx, teamId, 'vc-dealflow'),
  );
  indent(`Template: ${result.nodeTypesCreated} node types, ${result.propertyTypesCreated} property types, ${result.edgeTypesCreated} edge types`);

  // Look up node type IDs
  const nodeTypes = await kqb
    .selectFrom('node_type')
    .where('team_id', '=', teamId)
    .select(['id', 'name', 'category'])
    .execute();

  const ntByName = new Map(nodeTypes.map((nt) => [nt.name, nt]));

  const edgeTypes = await kqb
    .selectFrom('edge_type')
    .where('team_id', '=', teamId)
    .select(['id', 'outbound_name', 'source_node_type_id', 'target_node_type_id'])
    .execute();

  const etByName = new Map(edgeTypes.map((et) => [et.outbound_name, et]));

  // Seed some test nodes using consolidate + apply (like the real pipeline)
  const companyNt = ntByName.get('Company')!;
  const personNt = ntByName.get('Person')!;
  const fundingRoundNt = ntByName.get('Funding Round')!;
  const teamMembershipNt = ntByName.get('Team Membership')!;

  // Create nodes directly for speed
  const acmeId = randomUUID();
  const janeId = randomUUID();
  const roundId = randomUUID();
  const membershipId = randomUUID();

  await kqb
    .insertInto('node')
    .values([
      { id: acmeId, team_id: teamId, node_type_id: companyNt.id as NodeTypeId },
      { id: janeId, team_id: teamId, node_type_id: personNt.id as NodeTypeId },
      { id: roundId, team_id: teamId, node_type_id: fundingRoundNt.id as NodeTypeId },
      { id: membershipId, team_id: teamId, node_type_id: teamMembershipNt.id as NodeTypeId },
    ] as any)
    .execute();

  // Create edges — scoped objects point to their scoping parents
  const membershipMemberEt = etByName.get('member');
  const membershipAtCompanyEt = etByName.get('team_membership_at_company');
  const fundingRoundAtCompanyEt = etByName.get('funding_round_at_company');

  // team_membership → person (member)
  if (membershipMemberEt) {
    await kqb
      .insertInto('edge')
      .values({
        team_id: teamId,
        edge_type_id: membershipMemberEt.id,
        source_node_id: membershipId,
        target_node_id: janeId,
      } as any)
      .execute();
  }

  // team_membership → company (scoping edge)
  if (membershipAtCompanyEt) {
    await kqb
      .insertInto('edge')
      .values({
        team_id: teamId,
        edge_type_id: membershipAtCompanyEt.id,
        source_node_id: membershipId,
        target_node_id: acmeId,
      } as any)
      .execute();
  }

  // funding_round → company (scoping edge)
  if (fundingRoundAtCompanyEt) {
    await kqb
      .insertInto('edge')
      .values({
        team_id: teamId,
        edge_type_id: fundingRoundAtCompanyEt.id,
        source_node_id: roundId,
        target_node_id: acmeId,
      } as any)
      .execute();
  }

  indent(`Seeded: Acme Corp, Jane Smith, Acme Series A, Team Membership + edges`);
  return { nodeTypes, edgeTypes };
}

async function cleanupTeam(teamId: TeamId) {
  const kqb = getKnowledgeQb([
    'node_resource',
    'evidence',
    'property',
    'edge',
    'node',
    'extraction_graph_edge',
    'extraction_graph',
    'edge_type',
    'property_type',
    'node_type',
  ]);

  await kqb.deleteFrom('node_resource').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('evidence').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('property').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('edge').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('node').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('extraction_graph_edge').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('extraction_graph').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('edge_type').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('property_type').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('node_type').where('team_id', '=', teamId).execute();

  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
}

function createContext(teamId: string): Context {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId }));
  return ctx;
}


// -- Test: Ontology Agent --

async function testOntologyAgent() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TEST: Ontology Configuration Agent');
  console.log(`${'='.repeat(60)}`);

  const teamId = await createTestTeam('Ontology Agent Smoke Test');
  indent(`Team: ${teamId}`);

  try {
    // Test 1: Template materialization via agent
    log('Test 1: Ask agent to set up a VC dealflow ontology...');
    const ctx1 = createContext(teamId);
    const r1 = await ctx1.runAsync(async () => {
      return runOntologyAgent(
        'Set up a VC dealflow ontology. Use the vc-dealflow template.',
        { teamId },
      );
    });
    indent(`Response length: ${r1.text.length} chars`);
    indent(`Response preview: ${r1.text.substring(0, 200)}...`);
    assert(r1.text.length > 50, 'Response is substantive');

    // Check that types were actually created
    const nodeTypes = await getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .select(['id', 'name', 'category'])
      .execute();
    indent(`Node types created: ${nodeTypes.length}`);
    assert(nodeTypes.length > 0, 'Agent created node types');

    const edgeTypes = await getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId)
      .select(['id', 'outbound_name'])
      .execute();
    indent(`Edge types created: ${edgeTypes.length}`);
    assert(edgeTypes.length > 0, 'Agent created edge types');

    if (nodeTypes.length > 0) {
      indent(`Sample types: ${nodeTypes.slice(0, 5).map((nt) => nt.name).join(', ')}`);
    }

    log('Ontology Agent tests complete.');
  } finally {
    log('Cleaning up ontology agent test data...');
    await cleanupTeam(teamId);
    indent('Done.');
  }
}

// -- Test: Ontology Agent free-form --

async function testOntologyAgentFreeform() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TEST: Ontology Agent (Free-form)');
  console.log(`${'='.repeat(60)}`);

  const teamId = await createTestTeam('Ontology Agent Freeform Test');
  indent(`Team: ${teamId}`);

  try {
    log('Test: Ask agent to build an ontology from a description...');
    const ctx = createContext(teamId);
    const r = await ctx.runAsync(async () => {
      return runOntologyAgent(
        'I want to track real estate properties and their tenants. Each property has an address, square footage, and a property type (commercial, residential, industrial). Tenants have a name and lease start date. Properties can have multiple tenants. Please create this ontology now — don\'t ask me any questions, just build it.',
        { teamId },
      );
    });
    indent(`Response length: ${r.text.length} chars`);
    indent(`Response preview: ${r.text.substring(0, 300)}...`);

    const nodeTypes = await getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId)
      .select(['id', 'name', 'category'])
      .execute();

    indent(`Node types created: ${nodeTypes.length}`);
    for (const nt of nodeTypes) {
      indent(`  ${nt.category}: ${nt.name}`);
    }

    const edgeTypes = await getKnowledgeQb(['edge_type', 'node_type'])
      .selectFrom('edge_type as et')
      .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
      .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
      .where('et.team_id', '=', teamId)
      .select(['et.outbound_name', 'snt.name as source', 'tnt.name as target'])
      .execute();

    indent(`Edge types created: ${edgeTypes.length}`);
    for (const et of edgeTypes) {
      indent(`  ${et.outbound_name}: ${et.source} → ${et.target}`);
    }

    assert(nodeTypes.length >= 2, 'At least 2 node types created (Property + Tenant at minimum)');
    assert(edgeTypes.length >= 1, 'At least 1 edge type created');

    const hasPropertyType = nodeTypes.some(
      (nt) => nt.name.toLowerCase().includes('property'),
    );
    assert(hasPropertyType, 'Created a Property node type');

    const hasTenantType = nodeTypes.some(
      (nt) => nt.name.toLowerCase().includes('tenant'),
    );
    assert(hasTenantType, 'Created a Tenant node type');

    log('Free-form Ontology Agent tests complete.');
  } finally {
    log('Cleaning up freeform test data...');
    await cleanupTeam(teamId);
    indent('Done.');
  }
}

// -- Main --

async function main() {
  const testArg = process.argv[2];

  const tests: Record<string, () => Promise<void>> = {
    ontology: testOntologyAgent,
    freeform: testOntologyAgentFreeform,
  };

  const testsToRun = testArg
    ? testArg.split(',').map((t) => t.trim())
    : Object.keys(tests);

  for (const name of testsToRun) {
    const testFn = tests[name];
    if (!testFn) {
      console.error(`Unknown test: ${name}`);
      console.error(`Available: ${Object.keys(tests).join(', ')}`);
      process.exit(1);
    }
  }

  console.log('=== Knowledge Agents Smoke Test ===');
  console.log(`Tests: ${testsToRun.join(', ')}`);

  for (const name of testsToRun) {
    await tests[name]();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  ALL TESTS COMPLETE');
  console.log(`${'='.repeat(60)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nSmoke test failed:', error);
    process.exit(1);
  });
