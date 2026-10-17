// ## NavigationState — integration tests
//
// Exercises the service end-to-end against the real test DB:
//   - schema migration applied cleanly (we can read/write the new columns)
//   - navigateTo REPLACES (orthogonal keys from prior state get wiped)
//   - extendNavigation MERGES (orthogonal keys carry through)
//   - getNavigation reads what was written
//   - resolveByName finds same-team entities by name with recency
//     disambiguation (team-recency for now)
//   - cross-handoff carrying: state written by "agent A" is visible
//     to "agent B" via the same conversation id
//   - sanity-revert sketch: documents the contract by demonstrating
//     what changes if navigateTo were a merge (we don't actually flip
//     the code — the unit + integration tests above pin the behavior)

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { AgentConversationId } from '../../generated/kysely/public/AgentConversation';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { PipelineConfigurationId } from '../../generated/kysely/public/PipelineConfiguration';

import { cleanupTeam } from '../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb, getQb } from '../../lib/kysely';
import {
  getNavigation,
  navigateTo,
  extendNavigation,
  resolveByName,
} from '../navigation_state';

interface Seeded {
  teamId: TeamId;
  userId: UserId;
  conversationId: AgentConversationId;
}

async function seedTeamAndConversation(): Promise<Seeded> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  const conversationId = randomUUID() as AgentConversationId;

  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `n1-${teamId.slice(0, 8)}` } as any)
    .execute();

  await getCoreQb(['user'])
    .insertInto('user')
    .values({
      id: userId,
      default_team_id: teamId,
      username: `n1-${userId.slice(0, 8)}`,
    } as any)
    .execute();

  await getQb(['agent_conversation'])
    .insertInto('agent_conversation')
    .values({
      id: conversationId,
      team_id: teamId,
      user_id: userId,
    } as any)
    .execute();

  return { teamId, userId, conversationId };
}

/** A trigger needs a pipeline_configuration FK — provision one per team
 *  on demand, idempotently (the first trigger seed creates it). */
async function pipelineConfigurationFor(teamId: TeamId): Promise<PipelineConfigurationId> {
  const existing = await getQb(['pipeline_configuration'])
    .selectFrom('pipeline_configuration')
    .where('team_id', '=', teamId)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return existing.id as PipelineConfigurationId;
  const id = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    .values({ id, team_id: teamId, name: `cfg-${id.slice(0, 8)}` } as any)
    .execute();
  return id;
}

async function seedTrigger(teamId: TeamId, name: string, updatedAt?: Date): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  const pipelineConfigurationId = await pipelineConfigurationFor(teamId);
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id,
      team_id: teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name,
      kind: 'web',
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    } as any)
    .execute();
  return id;
}

describe('NavigationState — integration', () => {
  let seeded: Seeded | undefined;

  afterEach(async () => {
    if (seeded) {
      await cleanupTeam(seeded.teamId);
      seeded = undefined;
    }
  });

  describe('schema migration', () => {
    it('exposes navigation_state defaulting to {} on a fresh conversation', async () => {
      seeded = await seedTeamAndConversation();
      const state = await getNavigation(seeded.conversationId);
      expect(state).toEqual({});
    });
  });

  describe('navigateTo — replaces', () => {
    it('writes the state and is observable via getNavigation', async () => {
      seeded = await seedTeamAndConversation();
      await navigateTo(seeded.conversationId, { tgName: 'Dealflow', destinationName: 'Attio' });
      expect(await getNavigation(seeded.conversationId)).toEqual({
        tgName: 'Dealflow',
        destinationName: 'Attio',
      });
    });

    it('WIPES orthogonal keys from prior navigation (the principle-3 contract)', async () => {
      seeded = await seedTeamAndConversation();

      // Prior context: Translation editing a TG against a pinned destination
      await navigateTo(seeded.conversationId, {
        tgName: 'Dealflow',
        destinationName: 'Attio',
      });

      // Setup pivots to a different context: preview-by-inbound
      await navigateTo(seeded.conversationId, {
        tgName: 'Dealflow',
        inboundName: 'Inbound email',
      });

      const after = await getNavigation(seeded.conversationId);

      // `destinationName` from the prior context must NOT leak through.
      // This is the test that catches the sanity-revert from the brief.
      expect(after).toEqual({
        tgName: 'Dealflow',
        inboundName: 'Inbound email',
      });
      expect(after).not.toHaveProperty('destinationName');
    });

    it('accepts an empty object (resets to the funnel-just-started state)', async () => {
      seeded = await seedTeamAndConversation();
      await navigateTo(seeded.conversationId, { tgName: 'Dealflow' });
      await navigateTo(seeded.conversationId, {});
      expect(await getNavigation(seeded.conversationId)).toEqual({});
    });
  });

  describe('extendNavigation — merges', () => {
    it('adds new keys without wiping existing keys', async () => {
      seeded = await seedTeamAndConversation();
      await navigateTo(seeded.conversationId, { tgName: 'Dealflow' });
      await extendNavigation(seeded.conversationId, { destinationName: 'Attio' });
      expect(await getNavigation(seeded.conversationId)).toEqual({
        tgName: 'Dealflow',
        destinationName: 'Attio',
      });
    });

    it('overwrites existing keys with the supplied value', async () => {
      seeded = await seedTeamAndConversation();
      await navigateTo(seeded.conversationId, { tgName: 'Old', destinationName: 'Attio' });
      await extendNavigation(seeded.conversationId, { tgName: 'New' });
      expect(await getNavigation(seeded.conversationId)).toEqual({
        tgName: 'New',
        destinationName: 'Attio',
      });
    });
  });

  describe('resolveByName', () => {
    it('returns null when no entity in the team matches the name', async () => {
      seeded = await seedTeamAndConversation();
      const result = await resolveByName(
        seeded.conversationId,
        'trigger',
        'Nonexistent',
      );
      expect(result).toBeNull();
    });

    it('returns the only matching entity when name is unique', async () => {
      seeded = await seedTeamAndConversation();
      const triggerId = await seedTrigger(seeded.teamId, 'Dealflow');
      const result = await resolveByName(seeded.conversationId, 'trigger', 'Dealflow');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(triggerId);
      expect(result!.name).toBe('Dealflow');
      expect(result!.kind).toBe('trigger');
    });

    it('disambiguates by most-recent updated_at when two entities share a name', async () => {
      seeded = await seedTeamAndConversation();
      const older = new Date('2025-01-01T00:00:00Z');
      const newer = new Date('2026-01-01T00:00:00Z');
      const olderId = await seedTrigger(seeded.teamId, 'Dealflow', older);
      const newerId = await seedTrigger(seeded.teamId, 'Dealflow', newer);

      const result = await resolveByName(seeded.conversationId, 'trigger', 'Dealflow');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(newerId);
      expect(result!.id).not.toBe(olderId);
    });

    it('scopes results to the conversation\'s team', async () => {
      seeded = await seedTeamAndConversation();
      // Seed a trigger in a different team with the same name — must NOT
      // be returned.
      const otherTeamId = randomUUID() as TeamId;
      await getCoreQb(['team'])
        .insertInto('team')
        .values({ id: otherTeamId, name: `other-${otherTeamId.slice(0, 8)}` } as any)
        .execute();
      try {
        await seedTrigger(otherTeamId, 'Dealflow');

        const result = await resolveByName(
          seeded.conversationId,
          'trigger',
          'Dealflow',
        );
        expect(result).toBeNull();
      } finally {
        await cleanupTeam(otherTeamId);
      }
    });
  });

  describe('cross-handoff carrying', () => {
    it('state written by one agent is visible to the next agent on the same conversation', async () => {
      seeded = await seedTeamAndConversation();

      // Simulate "agent A" pinning context mid-turn
      await navigateTo(seeded.conversationId, {
        tgName: 'Dealflow extraction',
        destinationName: 'Attio',
      });

      // Simulate "agent B" reading at the start of its turn (no extra
      // plumbing needed — the conversation row IS the protocol)
      const visibleToB = await getNavigation(seeded.conversationId);
      expect(visibleToB).toEqual({
        tgName: 'Dealflow extraction',
        destinationName: 'Attio',
      });
    });

    it('replaces survive across multiple handoffs (no quiet merging)', async () => {
      seeded = await seedTeamAndConversation();

      // A → B: A leaves Translation context
      await navigateTo(seeded.conversationId, {
        tgName: 'Dealflow extraction',
        destinationName: 'Attio',
      });

      // B → C: B pivots to a Setup preview context (different keys)
      await navigateTo(seeded.conversationId, {
        tgName: 'Dealflow extraction',
        inboundName: 'Inbound email',
      });

      // C sees only B's context, never A's orthogonal keys
      const visibleToC = await getNavigation(seeded.conversationId);
      expect(visibleToC).not.toHaveProperty('destinationName');
      expect(visibleToC).toHaveProperty('inboundName', 'Inbound email');
    });
  });

  describe('history recording', () => {
    it('records each pinned name in navigation_history', async () => {
      seeded = await seedTeamAndConversation();
      await navigateTo(seeded.conversationId, { triggerName: 'Dealflow' });
      await navigateTo(seeded.conversationId, { triggerName: 'Dealflow v2' });

      const row = await getQb(['agent_conversation'])
        .selectFrom('agent_conversation')
        .select(['navigation_history'])
        .where('id', '=', seeded.conversationId)
        .executeTakeFirstOrThrow();

      const history = row.navigation_history as Array<{ kind: string; name: string; at: string }>;
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ kind: 'trigger', name: 'Dealflow' });
      expect(history[1]).toMatchObject({ kind: 'trigger', name: 'Dealflow v2' });
    });
  });
});
