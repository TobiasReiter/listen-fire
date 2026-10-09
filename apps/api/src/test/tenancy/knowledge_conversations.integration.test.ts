// The two-team probe for the knowledge-agent conversation surface (phase 6.2).
//
// `agent_conversation` / `agent_message` were outside the ability entirely, so
// deleting CASL took nothing away from them — they never had a filter. Two
// readers took a conversation id and read it by id alone, whoever asked:
//
//   - the orchestrator's turn loader, the seam a whole agent turn hangs off
//     (the team the agent runs AS comes off that row); and
//   - the running-state service, which reads and rewrites the summary
//     paragraph on `metadata`.
//
// Both now carry the acting team. The routers in front of them already checked
// ownership at their own door, so this is not a hole those doors left open —
// it is the guarantee that does not depend on a door remembering.
//
// The expectations are load-bearing: dropping `teamId` from the orchestrator's
// load lets team A run a turn on team B's conversation, and dropping it from
// `loadRunningState` / `compactIfDue` hands team A team B's summary.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb, getKnowledgeQb, getQb } from '../../lib/kysely';
import { services } from '../../adapters/registry';
import { trpc } from '../../interfaces/trpc/trpc';
import { queryAgentRouter } from '../../interfaces/trpc/views/knowledge/queryAgent';
import { Context } from '../../services/context';
import { userPrincipal } from '../../services/principal';
import { compactIfDue, loadRunningState } from '../../services/agent_running_state';
import { runConversationTurn } from '../../lib/knowledge/orchestrator';
import { initAgentRegistry, registerAgent } from '../../lib/knowledge/agent_registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

const tag = randomUUID().slice(0, 8);

interface Tenant {
  teamId: TeamId;
  userId: UserId;
  conversationId: string;
  /** The paragraph on `metadata.runningState` — distinct per tenant, so
   *  "whose summary came back" is a question with a visible answer. */
  runningState: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const t: Tenant = {
    teamId: randomUUID() as TeamId,
    userId: randomUUID() as UserId,
    conversationId: randomUUID(),
    runningState: `running state belonging to tenant ${label} ${tag}`,
  };

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: t.teamId, name: `convo-probe-${label}-${tag}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(
      anyVals({
        id: t.userId,
        default_team_id: t.teamId,
        username: `convo-probe-${label}-${tag}`,
        granted_access_at: new Date(),
      }),
    )
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values(anyVals({ id: randomUUID(), user_id: t.userId, team_id: t.teamId, access: 'write' }))
    .execute();

  await getQb(['agent_conversation'])
    .insertInto('agent_conversation')
    .values(
      anyVals({
        id: t.conversationId,
        team_id: t.teamId,
        user_id: t.userId,
        agent_type: 'knowledge_query',
        active_agent: 'unified',
        title: `Probe conversation ${label}`,
        metadata: { runningState: t.runningState, compactedThrough: null },
      }),
    )
    .execute();

  await getQb(['agent_message'])
    .insertInto('agent_message')
    .values(
      anyVals({
        id: randomUUID(),
        conversation_id: t.conversationId,
        role: 'user',
        content: `probe question from ${label}`,
        message_type: 'chat',
      }),
    )
    .execute();

  return t;
}

async function dropTenant(t: Tenant | undefined): Promise<void> {
  if (!t) return;
  await getQb(['agent_message'])
    .deleteFrom('agent_message')
    .where('conversation_id', '=', t.conversationId as never)
    .execute();
  await getQb(['agent_conversation'])
    .deleteFrom('agent_conversation')
    .where('team_id', '=', t.teamId as never)
    .execute();
  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    .where('user_id', '=', t.userId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', t.userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', t.teamId).execute();
}

let a: Tenant;
let b: Tenant;

/** Every invocation the stand-in agent was handed. The orchestrator only gets
 *  here once it has loaded the conversation, so this doubles as the record of
 *  which turns got past the tenant condition. */
const CAPTURED: Array<{ conversationId: string | undefined; teamId: string }> = [];

beforeAll(async () => {
  a = await makeTenant('a');
  b = await makeTenant('b');

  // Initialise the real registry, then OVERRIDE the unified runner with a
  // capture-only stand-in — the probe is about which conversation a turn is
  // allowed to load, not about what an agent then says.
  await initAgentRegistry();
  registerAgent({
    domain: 'unified',
    canHandoffTo: [],
    run: async (invocation) => {
      CAPTURED.push({
        conversationId: invocation.conversationId,
        teamId: invocation.teamId,
      });
      return { text: 'ack', trace: [], suggestedActions: [], attachments: [] };
    },
  });
}, 60_000);

afterAll(async () => {
  await dropTenant(a);
  await dropTenant(b);
}, 60_000);

beforeEach(() => {
  CAPTURED.length = 0;
});

/** Acting as tenant A's user, with the identity built exactly the way a
 *  request builds it. A fresh Context per call, as the other tenancy probes
 *  do. */
async function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: a.userId, teamId: a.teamId }));
  return ctx.runAsync(fn);
}

const outcome = async (fn: () => Promise<unknown>): Promise<'ok' | 'refused'> => {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'refused';
  }
};

describe('the orchestrator turn loader — a turn runs on the acting team’s conversation or none', () => {
  it('runs a turn on the acting team’s own conversation', async () => {
    const result = await asTenantA(() =>
      runConversationTurn({
        conversationId: a.conversationId,
        userMessage: 'hello',
        sessionId: `probe-a-${tag}`,
      }),
    );
    expect(result.text).toBe('ack');
    expect(CAPTURED).toEqual([{ conversationId: a.conversationId, teamId: a.teamId }]);
  });

  it('refuses to run a turn on the other team’s conversation', async () => {
    await expect(
      outcome(() =>
        asTenantA(() =>
          runConversationTurn({
            conversationId: b.conversationId,
            userMessage: 'hello',
            sessionId: `probe-b-${tag}`,
          }),
        ),
      ),
    ).resolves.toBe('refused');
    // The refusal has to happen at the LOAD: no agent may be dispatched, and
    // no tombstone may be left on the other team's conversation.
    expect(CAPTURED).toEqual([]);
    const strays = await getQb(['agent_message'])
      .selectFrom('agent_message')
      .select('id')
      .where('conversation_id', '=', b.conversationId as never)
      .where('role', '=', 'assistant')
      .execute();
    expect(strays).toEqual([]);
  });
});

describe('the running-state service — one team’s summary is not another’s', () => {
  it('reads the acting team’s own running state', async () => {
    const snapshot = await asTenantA(() => loadRunningState(a.conversationId));
    expect(snapshot.runningState).toBe(a.runningState);
  });

  it('reads nothing from the other team’s conversation', async () => {
    const snapshot = await asTenantA(() => loadRunningState(b.conversationId));
    expect(snapshot.runningState).toBeNull();
  });

  it('compacts against the acting team’s own conversation and no one else’s', async () => {
    // Neither conversation has enough persisted assistant turns to trigger
    // Haiku, so `compactIfDue` returns the stored snapshot unchanged — which
    // is exactly the read under test.
    const own = await asTenantA(() => compactIfDue(a.conversationId));
    expect(own.runningState).toBe(a.runningState);

    const other = await asTenantA(() => compactIfDue(b.conversationId));
    expect(other.runningState).toBeNull();
  });
});

// ── The attachment download door ────────────────────────────────────────────
//
// `getAttachmentUrl` minted a signed download URL for whatever `objectUri` the
// client sent. The uri is `s3://<bucket>/<uuid>/<filename>` — an opaque storage
// key with no tenant in it — and one bucket holds every team's objects, so the
// only thing standing between team A and team B's files was not knowing a uri.
//
// Ownership is therefore not a property of the string; it is whether one of the
// acting team's own rows RECORDS it, and there are three that can:
//
//   1. `document.object_uri` (a file the team uploaded),
//   2. `agent_conversation.working_document_uri`, and
//   3. `agent_message.metadata.attachments[]` — an agent-GENERATED attachment,
//      which has no document row at all and reaches a team only through its
//      conversation. This is the one the UI actually downloads, so a check that
//      consulted `document` alone would have blanked the feature, not narrowed
//      it.
//
// Each of the three is asserted from both sides on purpose: stripping the team
// condition from any ONE of the three lookups turns exactly its own negative
// case green and leaves the other five alone, so a passing run means the filter
// narrows rather than blanks.

interface Objects {
  attachment: string;
  workingDocument: string;
  document: string;
}

const OBJECTS = new Map<string, Objects>();
const extraConversations: string[] = [];

async function giveObjects(t: Tenant, label: string): Promise<void> {
  const objects: Objects = {
    attachment: `s3://probe-bucket/${randomUUID()}/generated-report.pdf`,
    workingDocument: `s3://probe-bucket/${randomUUID()}/working-document.md`,
    document: `s3://probe-bucket/${randomUUID()}/uploaded.csv`,
  };
  OBJECTS.set(t.teamId, objects);

  // Its own conversation, so the turn-loader probe above is untouched by the
  // working document and the assistant turn this needs.
  const conversationId = randomUUID();
  extraConversations.push(conversationId);
  await getQb(['agent_conversation'])
    .insertInto('agent_conversation')
    .values(
      anyVals({
        id: conversationId,
        team_id: t.teamId,
        user_id: t.userId,
        agent_type: 'knowledge_query',
        active_agent: 'unified',
        title: `Attachment probe ${label}`,
        working_document_uri: objects.workingDocument,
      }),
    )
    .execute();

  await getQb(['agent_message'])
    .insertInto('agent_message')
    .values(
      anyVals({
        id: randomUUID(),
        conversation_id: conversationId,
        role: 'assistant',
        content: 'here is the report',
        message_type: 'chat',
        metadata: {
          attachments: [
            {
              title: 'Report',
              format: 'pdf',
              objectUri: objects.attachment,
              mimeType: 'application/pdf',
              sizeBytes: 1234,
            },
          ],
        },
      }),
    )
    .execute();

  await getKnowledgeQb(['document'])
    .insertInto('document')
    .values(
      anyVals({
        id: randomUUID(),
        team_id: t.teamId,
        description: `attachment-probe-${label}-${tag}.csv`,
        object_uri: objects.document,
      }),
    )
    .execute();
}

describe('getAttachmentUrl — a signed url only for an object the acting team records', () => {
  let attachmentUrl: (objectUri: string) => Promise<'ok' | 'refused'>;

  beforeAll(async () => {
    await giveObjects(a, 'a');
    await giveObjects(b, 'b');

    // The storage provider is not under test — whether we get as far as ASKING
    // it is. A harness process registers no adapters, so this stands one up
    // rather than spying on a getter that throws.
    services.document = {
      upload: async () => ({ objectUri: 's3://probe-bucket/unused', checksum: 'x' }),
      getFile: async () => null,
      getFileNodeStream: async () => {
        throw new Error('not used by this probe');
      },
      getDownloadUrl: async () => 'https://signed.example/download',
      delete: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const caller = queryAgentRouter(trpc.procedure).createCaller({
      authorise: async () => {},
    });
    attachmentUrl = (objectUri) =>
      outcome(() => asTenantA(() => caller.getAttachmentUrl({ objectUri })));
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await getQb(['agent_conversation'])
      .deleteFrom('agent_conversation')
      .where('id', 'in', extraConversations as never[])
      .execute();
    await getKnowledgeQb(['document'])
      .deleteFrom('document')
      .where('description', 'like', `attachment-probe-%-${tag}.csv` as never)
      .execute();
  }, 60_000);

  it('signs the acting team’s own generated attachment', async () => {
    await expect(attachmentUrl(OBJECTS.get(a.teamId)!.attachment)).resolves.toBe('ok');
  });

  it('refuses the other team’s generated attachment', async () => {
    await expect(attachmentUrl(OBJECTS.get(b.teamId)!.attachment)).resolves.toBe('refused');
  });

  it('signs the acting team’s own working document', async () => {
    await expect(attachmentUrl(OBJECTS.get(a.teamId)!.workingDocument)).resolves.toBe('ok');
  });

  it('refuses the other team’s working document', async () => {
    await expect(attachmentUrl(OBJECTS.get(b.teamId)!.workingDocument)).resolves.toBe('refused');
  });

  it('signs the acting team’s own uploaded document', async () => {
    await expect(attachmentUrl(OBJECTS.get(a.teamId)!.document)).resolves.toBe('ok');
  });

  it('refuses the other team’s uploaded document', async () => {
    await expect(attachmentUrl(OBJECTS.get(b.teamId)!.document)).resolves.toBe('refused');
  });

  it('refuses a uri no row records at all, in the same words', async () => {
    await expect(attachmentUrl(`s3://probe-bucket/${randomUUID()}/nobodys.pdf`)).resolves.toBe(
      'refused',
    );
  });
});
