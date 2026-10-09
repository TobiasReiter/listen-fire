import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import * as db from '@prisma/client';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { trpc } from '../trpc';
import { currentContext } from '../../../services/context';
import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { getTestHarnessConfig } from '../../../lib/recording';
import { encryptToken } from '../../../lib/credentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { userProcedure as sharedUserProcedure } from '../procedures';

const CORPUS_DIR = process.env.TEST_HARNESS_CORPUS_DIR || join(process.cwd(), 'test-harness-data', 'corpus');

const testHarnessRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getStats: userProcedure.query(async () => {
      const config = getTestHarnessConfig();
      if (!config.teamId) return { configured: false as const };

      return {
        configured: true as const,
        teamId: config.teamId,
      };
    }),

    listCorpusFiles: userProcedure.query(async () => {
      try {
        const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
        const files = await Promise.all(
          entries
            .filter((e) => e.isFile() && !e.name.startsWith('.'))
            .map(async (e) => {
              const fileStat = await stat(join(CORPUS_DIR, e.name));
              return {
                name: e.name,
                size: fileStat.size,
                modifiedAt: fileStat.mtime.toISOString(),
              };
            }),
        );
        return { dir: CORPUS_DIR, files };
      } catch {
        return { dir: CORPUS_DIR, files: [] };
      }
    }),

    readCorpusFile: userProcedure
      .input(z.object({ filename: z.string() }))
      .query(async ({ input }) => {
        const safeName = input.filename.replace(/[/\\]/g, '');
        const filePath = join(CORPUS_DIR, safeName);
        const content = await readFile(filePath, 'utf-8');
        return { filename: safeName, content };
      }),

    seedFakeCredentials: userProcedure.mutation(async () => {
      const config = getTestHarnessConfig();
      if (!config.teamId) throw new Error('TEST_HARNESS_TEAM_ID not configured');

      const ctx = currentContext();
      const teamId = config.teamId;

      // Ensure a user exists on the test team — copy the current user if needed
      const testTeamUsers = await getCoreQb(['user'])
        .selectFrom('user')
        .where('default_team_id', '=', teamId as TeamId)
        .select(['id'])
        .execute();

      if (testTeamUsers.length === 0) {
        const currentUser = await getCoreQb(['user'])
          .selectFrom('user')
          .where('id', '=', ctx.user.id as any)
          .select(['username'])
          .executeTakeFirstOrThrow();

        const testUsername = `test@${currentUser.username.split('@').pop() ?? 'example.com'}`;
        const testUserId = randomUUID();

        await getCoreQb(['user'])
          .insertInto('user')
          .values({
            id: testUserId as any,
            default_team_id: teamId as TeamId,
            username: testUsername,
            is_platform_admin: false,
            is_internal: true,
            granted_access_at: new Date(),
            completed_registration_at: new Date(),
          })
          .execute();

        // Create user_email so the user is discoverable via impersonation search
        await getCoreQb(['user_email'])
          .insertInto('user_email')
          .values({
            id: randomUUID() as any,
            user_id: testUserId as any,
            email: testUsername,
            is_primary: true,
          })
          .execute();

        // Grant write membership of the team
        await getCoreQb(['team_membership'])
          .insertInto('team_membership')
          .values({
            id: randomUUID() as any,
            user_id: testUserId as any,
            team_id: teamId as TeamId,
            access: 'write',
          })
          .execute();
      }

      // Ensure team has a pipeline configuration
      const existingConfig = await getQb(['pipeline_configuration'])
        .selectFrom('pipeline_configuration')
        .where('team_id', '=', teamId as TeamId)
        .select(['id'])
        .executeTakeFirst();

      if (!existingConfig) {
        const configId = randomUUID();
        await getQb(['pipeline_configuration'])
          .insertInto('pipeline_configuration')
          .values({
            id: configId as any,
            team_id: teamId as TeamId,
            name: 'Default',
          })
          .execute();

        await getCoreQb(['team'])
          .updateTable('team')
          .set({ active_pipeline_configuration_id: configId as any })
          .where('id', '=', teamId as TeamId)
          .execute();
      }

      // Dummy credential values per service type — actual tokens don't matter
      // because injectFakeBaseUrl rewrites the baseUrl to fake-channels at runtime.
      // Names are deliberately user-facing (no "Test " prefix): dev-fixture
      // teams seed real-looking integration rows so the UI doesn't leak the
      // E2E plumbing to anyone who logs into the dev-loop stack.
      const serviceCredentials: Array<{ type: ExternalServiceType; name: string; creds: Record<string, unknown> }> = [
        { type: ExternalServiceType.SLACK, name: 'Slack', creds: { accessToken: 'fake-slack-token' } },
        { type: ExternalServiceType.AFFINITY, name: 'Affinity', creds: { apiKey: 'fake-affinity-key' } },
        { type: ExternalServiceType.ATTIO, name: 'Attio', creds: { accessToken: 'fake-attio-token' } },
        { type: ExternalServiceType.AIRTABLE, name: 'Airtable', creds: { accessToken: 'fake-airtable-token', refreshToken: 'fake', accessTokenExpiresAt: '2099-01-01', refreshTokenExpiresAt: '2099-01-01' } },
        { type: ExternalServiceType.GOOGLE, name: 'Google', creds: { accessToken: 'fake-google-token', refreshToken: 'fake', expiresAt: '2099-01-01' } },
        { type: ExternalServiceType.MAILGUN, name: 'Mailgun', creds: { apiKey: 'fake-mailgun-key' } },
      ];

      // Check which credentials already exist for this team
      const existing = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('team_id', '=', teamId as TeamId)
        .select(['id', 'type'])
        .execute();

      const existingTypes = new Set(existing.map((e) => e.type));
      const created: string[] = [];

      for (const { type, name, creds } of serviceCredentials) {
        if (existingTypes.has(type)) continue;

        const id = randomUUID();
        const encrypted = await encryptToken(JSON.stringify(creds), id);

        await getAutomationsQb(['external_service_credentials'])
          .insertInto('external_service_credentials')
          .values({
            id: id as ExternalServiceCredentialsId,
            name,
            type,
            credentials: encrypted,
            identifier: null,
            team_id: teamId as TeamId,
            user_id: ctx.user.id as any,
          })
          .execute();

        created.push(type);
      }

      return { created, alreadyExisted: [...existingTypes] };
    }),

    resetKnowledgeGraph: userProcedure.mutation(async () => {
      const config = getTestHarnessConfig();
      if (!config.teamId) throw new Error('TEST_HARNESS_TEAM_ID not configured');

      const qb = getQb([
        'knowledge.evidence',
        'knowledge.extraction_fact',
        'knowledge.linked_object',
        'knowledge.edge',
        'knowledge.node',
      ] as any);

      // Delete in FK-safe order (only tables that have team_id)
      await qb.deleteFrom('knowledge.linked_object' as any).where('team_id', '=', config.teamId).execute();
      await qb.deleteFrom('knowledge.evidence' as any).where('team_id', '=', config.teamId).execute();
      await qb.deleteFrom('knowledge.extraction_fact' as any).where('team_id', '=', config.teamId).execute();
      await qb.deleteFrom('knowledge.edge' as any).where('team_id', '=', config.teamId).execute();
      await qb.deleteFrom('knowledge.node' as any).where('team_id', '=', config.teamId).execute();

      return { success: true };
    }),
  });
};

export { testHarnessRouter };
