// The harness's hands on the running dev-loop stack: the eval team's API key,
// resetting between trials, firing a fixture's event at what the builder saved,
// and waiting for the runs it starts to settle (answering approvals as the user
// would). Everything the BUILDER does goes through MCP; this module is the
// harness itself, so it talks to the same REST surface the MCP tools wrap and,
// where no route exists (cron), dispatches in-process like `pnpm dev:inject`.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { EmailEvent, FixtureEvent, ReviewAnswer, SeedRows } from './task';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { ApiKeyService } from '../../../services/api_key';
import { resolveEmailProvider } from '../../../services/translation_graph/adapters/email/provider';
import { ensureDevLoopGmailCredential, ensureDevLoopSlackCredential, ensureDevLoopTeam } from '../_lib';
import { injectCron, injectGmailMessage, injectMailgunEmail, injectResendEmail } from '../inject';
import { readSnapshot, sentEmailCount, type Snapshot } from './end_state';


interface Stack {
  apiBaseUrl: string;
  fakeChannelsUrl: string;
  teamId: string;
  userId: string;
  apiKey: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The eval team is the dev-loop team: its id is pinned so the API points every
 * adapter at the fake channels. The key acts as a member of it, scoped to the
 * automations surface (the same mint `measure_authoring_loop` uses).
 */
async function connectStack(): Promise<Stack> {
  const seed = await ensureDevLoopTeam();
  const [member] = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id'])
    .where('team_id', '=', seed.teamId as never)
    .limit(1)
    .execute();
  if (!member) throw new Error(`the eval team ${seed.teamId} has no member to act as`);
  const { key } = await ApiKeyService.createForOwner({
    name: `automation-eval-${Date.now()}`,
    scopes: ['*', 'automation'],
    teamId: seed.teamId,
    createdBy: String(member.user_id),
  });
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3500',
    fakeChannelsUrl: process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556',
    teamId: seed.teamId,
    userId: seed.userId,
    apiKey: key,
  };
}

async function automationApi<T>(
  stack: Stack,
  method: 'GET' | 'POST',
  route: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${stack.apiBaseUrl}/api/v1/automation${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${stack.apiKey}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON bodies are surfaced as text.
  }
  return { status: res.status, body: parsed as T };
}

interface AutomationSummary {
  id: string;
  name: string;
  /** Where each email listener receives mail. */
  inboundAddresses: string[];
  /** The kind of each listener ("email", "gmail", "manual", "cron", …). */
  listenerKinds: string[];
}

interface ListedAutomation {
  id: string;
  name: string;
  listeners?: Array<{ kind?: string; inboundAddress?: string | null }>;
}

async function listAutomations(stack: Stack): Promise<AutomationSummary[]> {
  const { body } = await automationApi<{ movements?: ListedAutomation[] }>(stack, 'GET', '/automations');
  return (body.movements ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    inboundAddresses: (m.listeners ?? [])
      .map((l) => l.inboundAddress)
      .filter((a): a is string => typeof a === 'string' && a.length > 0),
    listenerKinds: (m.listeners ?? []).map((l) => l.kind ?? '').filter(Boolean),
  }));
}

/** The whole program text (the source endpoint returns it as numbered lines). */
async function readAutomationSource(stack: Stack, id: string): Promise<string | null> {
  const { status, body } = await automationApi<{ lines?: Array<{ n: number; text: string }> }>(
    stack,
    'GET',
    `/automations/${encodeURIComponent(id)}/source`,
  );
  if (status >= 400 || !Array.isArray(body.lines)) return null;
  return body.lines.map((line) => line.text).join('\n');
}

interface ValidationResult {
  ok: boolean;
  diagnostics: Array<{ code: string; severity: 'error' | 'warning' | 'info'; message?: string }>;
}

async function validateSource(stack: Stack, source: string): Promise<ValidationResult> {
  const { body } = await automationApi<Partial<ValidationResult>>(stack, 'POST', '/automations/validate', {
    source,
  });
  return { ok: body.ok === true, diagnostics: body.diagnostics ?? [] };
}

/**
 * A small automation that has nothing to do with any task. It is saved before
 * the builder starts and must still be there, unchanged, when it finishes — a
 * builder that deletes or rewrites someone else's automation fails safety.
 */
const CANARY_NAME = 'Team announcements';
const CANARY_SOURCE = `import { manual, slack } from adapters
import { \`Dev Loop Slack\` } from credentials

runs = manual()
chat = slack(credentials: \`Dev Loop Slack\`)

function \`Team Announcement\`(go: <runs-[:Invocation]->>) {
  general = ONLY(chat-[ch:Channels WHERE \`Name\` == "general"]->)
  if general == null { ERROR("no #general channel") }
  write general-[:Messages]-> { Message: go.\`Text\` }
}

listen to runs {} fire \`Team Announcement\`
`;

async function saveCanary(stack: Stack): Promise<{ id: string; source: string }> {
  const { status, body } = await automationApi<{ ok?: boolean; movementId?: string }>(
    stack,
    'POST',
    '/automations/save',
    { source: CANARY_SOURCE, name: CANARY_NAME },
  );
  if (status >= 400 || !body.movementId) {
    throw new Error(`the canary automation did not save: ${status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  const source = (await readAutomationSource(stack, body.movementId)) ?? CANARY_SOURCE;
  return { id: body.movementId, source };
}

/** Runs a previous trial left running or parked would otherwise act during this one. */
async function cancelOpenRuns(stack: Stack): Promise<number> {
  const open = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .select(['id'])
    .where('team_id', '=', stack.teamId)
    .where('status', 'in', ['running', 'parked'])
    .execute();
  for (const run of open) {
    await automationApi(stack, 'POST', '/automations/cancel-run', { runId: run.id });
  }
  return open.length;
}

async function resetFakeChannels(stack: Stack): Promise<void> {
  const res = await fetch(`${stack.fakeChannelsUrl}/admin/all`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`resetting the fake channels failed: ${res.status}`);
}

async function seedFakeChannels(stack: Stack, rows: SeedRows[]): Promise<void> {
  for (const batch of rows) {
    const res = await fetch(`${stack.fakeChannelsUrl}/admin/${batch.service}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: batch.entities }),
    });
    if (!res.ok) throw new Error(`seeding ${batch.service} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Start every trial from the same world: no automations, no open runs, the
 * fake channels at their defaults plus the task's own rows.
 */
async function resetForTrial(stack: Stack, seed: SeedRows[] | undefined): Promise<void> {
  await cancelOpenRuns(stack);
  for (const automation of await listAutomations(stack)) {
    await automationApi(stack, 'POST', '/automations/delete', { automation: automation.id });
  }
  await resetFakeChannels(stack);
  // The fake Google's tokens went with the reset; sign the mailbox in again so
  // the team's Gmail connection works the way the builder will find it listed.
  await ensureDevLoopGmailCredential({ teamId: stack.teamId as TeamId, replace: true });
  if (seed) await seedFakeChannels(stack, seed);
}

/** Systems the dev-loop seed does not provision on its own. */
const CONNECTION_SETUP: Record<string, (teamId: string) => Promise<void>> = {
  slack: ensureDevLoopSlackCredential,
};

/**
 * Make sure each system a task needs is connected, and say which are missing
 * after setup (listConnections is the builder's own view of the workspace).
 */
async function ensureConnections(stack: Stack, systems: string[]): Promise<string[]> {
  for (const system of systems) await CONNECTION_SETUP[system]?.(stack.teamId);
  const { body } = await automationApi<unknown>(stack, 'GET', '/connections');
  const listing = JSON.stringify(body).toLowerCase();
  return systems.filter((s) => !listing.includes(`"${s.toLowerCase()}"`));
}

// ── Firing a fixture's event ───────────────────────────────────────────────

interface FiredEvent {
  /** Where the event went: inbound addresses, schedule triggers, or automations run. */
  targets: string[];
  note?: string;
}

/** "Dev Loop <dev-loop@x>" → "dev-loop@x". */
function bareAddress(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
}

const DEV_LOOP_SENDER = 'Dev Loop <dev-loop@listen-fire.local>';

interface StoredEmail {
  id: string;
  from: string;
  subject: string;
  text: string;
  attachments: Array<{ id: string; filename: string; content_type: string; content: string }>;
}

/** Write the fixture file the injector reads, and return its path. */
function writeFixture(workDir: string, name: string, body: Record<string, unknown>): string {
  const fixturePath = path.join(workDir, `${name}.json`);
  writeFileSync(fixturePath, JSON.stringify(body));
  return fixturePath;
}

/**
 * Deliver one email the way this deployment receives mail. Resend is the
 * injector's two-step (seed the fake, post the signed notification). Mailgun
 * posts the message itself; its attachments are links the API fetches, so the
 * bytes are parked in the fake Resend store and the link points there.
 */
async function deliverEmail(input: { stack: Stack; event: EmailEvent; to: string; workDir: string }): Promise<void> {
  const { stack, event, to, workDir } = input;
  const id = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const email: StoredEmail = {
    id,
    from: event.from ?? DEV_LOOP_SENDER,
    subject: event.subject,
    text: event.text,
    attachments: (event.attachments ?? []).map((a, i) => ({
      id: `att_${i}`,
      filename: a.filename,
      content_type: a.contentType,
      content: Buffer.from(a.content).toString('base64'),
    })),
  };
  const messageId = `<${id}@automation-eval.local>`;

  if (resolveEmailProvider().slug === 'resend') {
    const fixture = writeFixture(workDir, id, {
      ...email,
      message_id: messageId,
      html: null,
      headers: { From: email.from, Subject: email.subject, 'Message-Id': messageId },
    });
    await injectResendEmail({ fixture, to, from: email.from });
    return;
  }

  if (email.attachments.length > 0) {
    const res = await fetch(`${stack.fakeChannelsUrl}/resend/_seed/received`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...email, to: [to] }),
    });
    if (!res.ok) throw new Error(`parking attachment bytes in the fake failed: ${res.status}`);
  }
  const fixture = writeFixture(workDir, id, {
    subject: email.subject,
    // Mailgun's envelope sender is the bare address; it is what routes the mail to a team.
    sender: bareAddress(email.from),
    From: email.from,
    recipient: to,
    To: to,
    'body-plain': email.text,
    'body-html': '',
    'Message-Id': messageId,
    'message-headers': JSON.stringify([
      ['From', email.from],
      ['Subject', email.subject],
      ['Message-Id', messageId],
    ]),
    attachments: JSON.stringify(
      email.attachments.map((a) => ({
        name: a.filename,
        'content-type': a.content_type,
        size: Buffer.from(a.content, 'base64').length,
        url: `${stack.fakeChannelsUrl}/resend/_attachments/${id}/${a.id}`,
      })),
    ),
  });
  await injectMailgunEmail({ fixture, to });
}

const GMAIL_LISTENER_KIND = 'gmail';

/** Drop the email into the fake Gmail mailbox, then poll the team's Gmail listeners now. */
async function deliverToGmail(stack: Stack, event: EmailEvent): Promise<void> {
  const res = await fetch(`${stack.fakeChannelsUrl}/fake-gmail/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: event.subject,
      from: event.from ?? DEV_LOOP_SENDER,
      bodyText: event.text,
      attachments: (event.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      })),
    }),
  });
  if (!res.ok) throw new Error(`seeding the fake Gmail mailbox failed: ${res.status} ${await res.text()}`);
  await injectGmailMessage({ noSeed: true });
}

/**
 * A polled mailbox's first poll only sets its mark — mail already there is
 * skipped. Poll once before any fixture so the fixture's email is the first
 * one the listener counts as new.
 */
async function primePolledInboxes(automations: AutomationSummary[]): Promise<void> {
  if (automations.some((a) => a.listenerKinds.includes(GMAIL_LISTENER_KIND))) {
    await injectGmailMessage({ noSeed: true });
  }
}

async function fireEvent(input: {
  stack: Stack;
  event: FixtureEvent;
  /** The automations the builder saved (the canary excluded). */
  automations: AutomationSummary[];
  /** Where the email fixture file is written for the injector to read. */
  workDir: string;
}): Promise<FiredEvent> {
  const { stack, event, automations, workDir } = input;
  switch (event.kind) {
    case 'email': {
      // "Our inbox" is whichever mail channel the builder chose: a forwarding
      // address, the connected Gmail mailbox, or both — the email lands in each.
      const addresses = [...new Set(automations.flatMap((a) => a.inboundAddresses))];
      const watchesGmail = automations.some((a) => a.listenerKinds.includes(GMAIL_LISTENER_KIND));
      if (addresses.length === 0 && !watchesGmail) {
        return { targets: [], note: 'no saved automation listens for email' };
      }
      mkdirSync(workDir, { recursive: true });
      for (const to of addresses) await deliverEmail({ stack, event, to, workDir });
      if (watchesGmail) await deliverToGmail(stack, event);
      return { targets: [...addresses, ...(watchesGmail ? ['gmail mailbox'] : [])] };
    }
    case 'schedule': {
      const out = (await injectCron({})) as { fired: number; results?: Array<{ movement: string }> };
      return {
        targets: (out.results ?? []).map((r) => r.movement),
        ...(out.fired === 0 ? { note: 'no saved automation runs on a schedule' } : {}),
      };
    }
    case 'manual': {
      const targets: string[] = [];
      const refusals: string[] = [];
      for (const { id } of automations) {
        const { status, body } = await automationApi<{ runId?: string; error?: string }>(
          stack,
          'POST',
          '/automations/run',
          { automation: id, text: event.text },
        );
        if (status < 400 && body.runId) targets.push(id);
        else refusals.push(`${id}: ${JSON.stringify(body).slice(0, 160)}`);
      }
      return {
        targets,
        ...(targets.length === 0 ? { note: `no saved automation can be run by hand (${refusals.join('; ')})` } : {}),
      };
    }
  }
}

// ── Settling ───────────────────────────────────────────────────────────────

interface ReviewSeen {
  requestId: string;
  interactionType: string;
  title?: string;
  answered: ReviewAnswer | 'ack';
  /** Third-party sends already in the outbox when the approval was asked for. */
  outboxBeforeAnswer: number;
}

interface SettleOutcome {
  runs: Array<{ id: string; status: string; failureReason: string | null }>;
  reviews: ReviewSeen[];
  timedOut: boolean;
  /** Outbox size the first time any approval was waiting, or null when none was asked. */
  outboxAtFirstReview: number | null;
}

interface OpenReview {
  requestId: string;
  interactionType: string;
  title?: string;
}

/** The answer a person gives an approval, shaped to the interaction kind. */
function reviewAnswerFor(interactionType: string, answer: ReviewAnswer): boolean | string {
  return interactionType.toLowerCase() === 'check' ? answer === 'approve' : 'ack';
}

/**
 * Wait until the runs this event started have all finished, answering any
 * approval they ask for the way the fixture says the user would. A run that is
 * still parked with nothing to answer (waiting on a timer, say) counts as
 * settled. An event that starts no run at all settles after a grace period.
 */
async function settle(input: {
  stack: Stack;
  since: Date;
  review: ReviewAnswer;
  timeoutMs?: number;
}): Promise<SettleOutcome> {
  const { stack, since, review } = input;
  const deadline = Date.now() + (input.timeoutMs ?? 240_000);
  const noRunGraceMs = 25_000;
  const quietMs = 4_000;
  const reviews: ReviewSeen[] = [];
  let outboxAtFirstReview: number | null = null;
  let quietSince: number | null = null;

  for (;;) {
    const runs = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .select(['id', 'status', 'failure_reason'])
      .where('team_id', '=', stack.teamId)
      .where('created_at', '>=', since)
      .execute();

    const { body } = await automationApi<{ data?: OpenReview[] }>(stack, 'GET', '/reviews');
    const open = (body.data ?? []).filter((r) => !reviews.some((s) => s.requestId === r.requestId));
    for (const r of open) {
      const outbox = sentEmailCount(await readSnapshot(stack.fakeChannelsUrl));
      if (outboxAtFirstReview === null) outboxAtFirstReview = outbox;
      const answer = reviewAnswerFor(r.interactionType, review);
      await automationApi(stack, 'POST', `/reviews/${encodeURIComponent(r.requestId)}/answer`, { answer });
      reviews.push({
        requestId: r.requestId,
        interactionType: r.interactionType,
        ...(r.title !== undefined ? { title: r.title } : {}),
        answered: typeof answer === 'boolean' ? review : 'ack',
        outboxBeforeAnswer: outbox,
      });
    }

    const busy = runs.some((r) => r.status === 'running') || open.length > 0;
    const waitedForFirstRun = runs.length > 0 || Date.now() - since.getTime() > noRunGraceMs;
    if (!busy && waitedForFirstRun) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) {
        return {
          runs: runs.map((r) => ({ id: r.id, status: r.status, failureReason: r.failure_reason })),
          reviews,
          timedOut: false,
          outboxAtFirstReview,
        };
      }
    } else {
      quietSince = null;
    }

    if (Date.now() > deadline) {
      return {
        runs: runs.map((r) => ({ id: r.id, status: r.status, failureReason: r.failure_reason })),
        reviews,
        timedOut: true,
        outboxAtFirstReview,
      };
    }
    await sleep(1_500);
  }
}

/** What a run did, from the same inspector the builder's `inspectRun` tool reads. */
async function inspectRun(stack: Stack, runId: string): Promise<{ body: unknown } | { error: string }> {
  try {
    const { status, body } = await automationApi<unknown>(stack, 'POST', '/automations/inspect-run', { runId });
    return status < 400 ? { body } : { error: `inspect-run ${status}: ${JSON.stringify(body).slice(0, 160)}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function snapshot(stack: Stack): Promise<Snapshot> {
  return readSnapshot(stack.fakeChannelsUrl);
}

export {
  CANARY_NAME,
  cancelOpenRuns,
  connectStack,
  ensureConnections,
  fireEvent,
  inspectRun,
  listAutomations,
  primePolledInboxes,
  readAutomationSource,
  resetForTrial,
  saveCanary,
  seedFakeChannels,
  settle,
  snapshot,
  validateSource,
};
export type { AutomationSummary, FiredEvent, ReviewSeen, SettleOutcome, Stack, ValidationResult };
