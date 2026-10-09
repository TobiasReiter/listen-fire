// The movement validity LIFECYCLE, end-to-end over real seams
// (plans/2026-07-13-movement-validity-lifecycle): real Postgres, the real
// saveMovement consent gate, real firings through runMovementNow/dispatch,
// and a real remote adapter server on a live socket (the fake CRM).
//
//   1. broken save (unknown edge)      → needsConfirmation, nothing ships
//   2. save anyway (acknowledgeErrors) → SHIPS invalid + consented
//   3. fire → fails                    → movement_issue opens (count 1)
//   4. fire again                      → same issue counts to 2, no new row
//   5. fixed save                      → validity flips valid
//   6. fire → clean CRM write          → open issue auto-resolves
//   7. adapter killed, fire → fails    → surprise-failure re-check (drift):
//      validity leaves 'valid' (unverified — introspection now unreachable)

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FakeCrmServer } from '../../../../scripts/dev/fake_crm_adapter';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { saveMovement } from '../provision';
import { runMovementNow } from '../run_now';
import { getMovementRow } from '../store';
import { installRemoteAdapterFromManifest } from '../../adapters/remote/install';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_COMPANY_TYPE,
  startFakeCrmServer,
} from '../../../../scripts/dev/fake_crm_adapter';


jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));
// Alerts are transition-gated Slack sends — stub the transport, assert calls.
const slackMock = jest.fn(async () => undefined);
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: (...args: unknown[]) => slackMock(...(args as [])),
}));

const NAME = 'validity-lifecycle-probe';

const sourceWithEdge = (edge: string) => `import { manual, \`${FAKE_CRM_ADAPTER_TYPE}\` as crm } from adapters

runs = manual()
df = crm()

movement probe(go: <runs-[:\`Invocation\`]->>) {
  write df-[:\`${edge}\`]-> {
    Name: "Vireo Robotics"
  }
}

listen to runs {} fire probe
`;

describe('movement validity lifecycle (real save gate + firings + live remote socket)', () => {
  let teamId: TeamId;
  let server: FakeCrmServer;

  const issues = () =>
    getAutomationsQb(['movement_issue'])
      .selectFrom('movement_issue')
      .where('team_id', '=', teamId as never)
      .select(['failure_class', 'count', 'state'])
      .execute();

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `validity-${teamId.slice(0, 8)}` } as any)
      .execute();
    // Trigger derivation needs an active pipeline_configuration (dispatch
    // routing scope) — mirror what dev:seed provisions.
    const pcId = randomUUID();
    await getQb(['pipeline_configuration'])
      .insertInto('pipeline_configuration')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: pcId, team_id: teamId, name: 'validity-probe' } as any)
      .execute();
    await getCoreQb(['team'])
      .updateTable('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ active_pipeline_configuration_id: pcId } as any)
      .where('id', '=', teamId)
      .execute();
    server = await startFakeCrmServer({ secret: 'probe-secret' });
    await installRemoteAdapterFromManifest({
      teamId,
      userId: null,
      manifest: {
        protocolVersion: 2,
        adapterType: FAKE_CRM_ADAPTER_TYPE,
        baseUrl: server.baseUrl,
        authStrategy: { kind: 'bearer' },
        supportedTriggers: [],
        runtimeCapabilities: {
          traversal: { incoming: false, edgeProperties: false },
          resources: false,
        },
        methods: ['listEntryPoints', 'describe', 'resolveEntity', 'createRecord'],
      },
      secret: 'probe-secret',
    });
  });

  afterAll(async () => {
    await server.close().catch(() => {});
    await cleanupTeam(teamId);
  });

  it('drives broken → consent → fire-fail → issue → fix → resolve → drift', async () => {
    // [1] Broken save: unknown edge → the consent gate withholds it.
    const broken = sourceWithEdge('Companyy');
    const r1 = await saveMovement({ teamId: teamId as string, source: broken, name: NAME });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.needsConfirmation).toBe(true);
    expect(r1.validity?.status).toBe('invalid');
    const movementId = r1.movementId as string;

    // [2] Save anyway: ships invalid, consent recorded, listener derived.
    const r2 = await saveMovement({
      teamId: teamId as string,
      source: broken,
      id: movementId,
      name: NAME,
      acknowledgeErrors: true,
    });
    expect(r2.ok).toBe(true);
    const row2 = await getMovementRow({ teamId: teamId as string, id: movementId });
    expect(row2?.validityStatus).toBe('invalid');
    expect(row2?.validityConsentedAt).toBeTruthy();

    // [3] Fire → fails at the engine check → one issue opens + one alert.
    const f1 = await runMovementNow({ teamId: teamId as string, movementId });
    expect(f1.ok).toBe(false);
    let open = await issues();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ count: 1, state: 'open' });
    const alertsAfterFirstFailure = slackMock.mock.calls.length;
    expect(alertsAfterFirstFailure).toBeGreaterThanOrEqual(1);

    // [4] Fire again → same issue counts, NO second alert, no new row.
    await runMovementNow({ teamId: teamId as string, movementId });
    open = await issues();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ count: 2, state: 'open' });
    expect(slackMock.mock.calls.length).toBe(alertsAfterFirstFailure);

    // [5] Fix the edge → clean save flips validity to valid.
    const r5 = await saveMovement({
      teamId: teamId as string,
      source: sourceWithEdge(FAKE_CRM_COMPANY_TYPE),
      id: movementId,
      name: NAME,
    });
    expect(r5.ok).toBe(true);
    const row5 = await getMovementRow({ teamId: teamId as string, id: movementId });
    expect(row5?.validityStatus).toBe('valid');

    // [6] Fire → the write lands in the CRM over the socket; issue resolves.
    const f3 = await runMovementNow({ teamId: teamId as string, movementId });
    expect(f3.ok).toBe(true);
    expect(server.writes.length).toBeGreaterThanOrEqual(1);
    expect(server.writes[0]?.fields).toMatchObject({ Name: 'Vireo Robotics' });
    open = await issues();
    expect(open[0]).toMatchObject({ state: 'resolved' });

    // [7] Drift: kill the adapter; a VALID movement failing is a surprise —
    // the prediction rule re-validates and the status leaves 'valid'
    // (unverified: the referenced adapter can no longer be introspected).
    await server.close();
    const f4 = await runMovementNow({ teamId: teamId as string, movementId });
    expect(f4.ok).toBe(false);
    const row7 = await getMovementRow({ teamId: teamId as string, id: movementId });
    expect(row7?.validityStatus).not.toBe('valid');
    // The regression alert fired for the reopened/new issue.
    const reopened = await issues();
    expect(reopened.some((i) => i.state === 'open')).toBe(true);
  }, 120_000);
});
