// The inbound email door: what a Mailgun POST has to get past before anything
// downstream treats it as an event, and which team it belongs to when it does.
//
// It lives beside the email adapter because it is the same channel seen from
// the outside: the adapter owns the payload contract and the actor candidates,
// the door owns admission and routing. Its previous home was
// `adapters/pipeline/inbound/mailgun.adapter.ts` — a dealflow file — where the
// live door's auth logic sat inside a deletion set (carve M-41, ST-14/D31).
//
// Three questions, in order (carve D32):
//
//   1. Is it really Mailgun?     HMAC(apiKey, timestamp + token) === signature.
//   2. Whose team is this?       The SENDER's. External senders are refused —
//                                a `<local>+<key>@` address is a user-chosen
//                                slug, guessable by anyone, so the recipient
//                                cannot be the thing that authorises a metered
//                                run.
//   3. Which team, if several?   The routing key is unique only WITHIN a team,
//                                so a sender who belongs to more than one team
//                                is disambiguated by which team owns a trigger
//                                for that key. Two owners = ambiguous = dropped.
//
// The sender is resolved through two sources, mirroring what the columns it
// replaced did: the Directory answers for login addresses (core-owned identity,
// reached through the one deliberate global lookup, `teamsForEmail`), and
// `inbound_email_route` answers for SERVICE addresses — shared inboxes and
// forwarding proxies that are not anybody's login, plus the opt-in that lets a
// `+tag` on one of them still resolve.
//
// Steps 2 and 3 are about the MESSAGE, not about who carried it, so they are
// split out (`routeInboundEmail`) and shared: a Resend delivery, whose wire
// shape and signature scheme are entirely different, routes through the same
// three questions once its own door has believed it.

import type { InboundEmailDecision, MailgunStore, RoutableMessage } from 'movement-engine/public/inbound';

import { admitMailgunMail } from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { sendSlackNotification } from '../../../../lib/slack';
import { findTriggerByInboundKey } from '../../storage/tg_table';
import { principalDirectory } from '../../../principal';
import { routingKeyFrom } from './address';

/** The trigger kinds an inbound email may dispatch. */
const INBOUND_EMAIL_TRIGGER_KINDS = ['CUSTOM_EMAIL', 'MAILGUN', 'INBOUND_EMAIL'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The routing key on the deployment's own inbound address, if a recipient
 *  carries one. The address itself is configuration (`address.ts`). */
function inboundKeyFrom(recipients: string[]): string | null {
  return routingKeyFrom(recipients);
}

// ── 1. Is it really Mailgun? ───────────────────────────────────────────────

/**
 * The signing key. Mirrors how `services.ts` constructs the outgoing Mailgun
 * adapters: the real key only in production/staging, and the test-harness
 * constant everywhere else, so a developer's `.env` (which carries a live key
 * for outbound sends) cannot make locally-signed traffic verify against
 * production's secret — or fail against the dev loop's.
 */
function signingKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Typed as a string on purpose: 'staging' is a real deployment of this
  // service and is not in Node's own narrowing of NODE_ENV.
  const environment: string = env.NODE_ENV ?? '';
  if (environment === 'production' || environment === 'staging') {
    return str(env.MAILGUN_API_KEY);
  }
  return env.TEST_HARNESS_TEAM_ID ? 'test-harness-dummy-key' : undefined;
}

// ── 2. Whose team is this? ─────────────────────────────────────────────────

interface ServiceRoute {
  address: string;
  teamId: string;
  isServiceAddress: boolean;
  acceptsPlusAddressing: boolean;
}

function stripPlusTag(address: string): string {
  return address.replace(/\+.*@/, '@');
}

async function serviceRoutesFor(addresses: string[]): Promise<ServiceRoute[]> {
  if (addresses.length === 0) return [];
  const rows = await getAutomationsQb(['inbound_email_route'])
    .selectFrom('inbound_email_route')
    .where('address', 'in', addresses)
    .select(['address', 'team_id', 'is_service_email', 'accepts_plus_addressing'])
    .execute();
  return rows.map((row) => ({
    address: row.address,
    teamId: row.team_id,
    isServiceAddress: row.is_service_email,
    acceptsPlusAddressing: row.accepts_plus_addressing,
  }));
}

/** A recognised address and, if it is a service address, its team. */
interface RecognisedAddress {
  address: string;
  isServiceAddress: boolean;
  route: ServiceRoute | null;
}

/**
 * Which of the candidate addresses we recognise, in the order the door should
 * believe them.
 *
 * The ordering is load-bearing and is the one the door has always applied: a
 * person's own address is tried BEFORE the service address of the same domain
 * it was forwarded through, so a message from a known colleague is attributed
 * to them rather than to the shared inbox — while a service address that has
 * no personal counterpart still wins over anything after it.
 */
async function recogniseAddresses(candidates: string[]): Promise<RecognisedAddress[]> {
  const stripped = candidates.map(stripPlusTag);
  const routes = await serviceRoutesFor(Array.from(new Set([...candidates, ...stripped])));
  const routeByAddress = new Map(routes.map((route) => [route.address.toLowerCase(), route]));

  const directory = principalDirectory();
  const recognised: RecognisedAddress[] = [];

  for (const candidate of candidates) {
    const exactRoute = routeByAddress.get(candidate.toLowerCase()) ?? null;
    const knownLogin = exactRoute === null && (await directory.teamsForEmail(candidate)).length > 0;

    let match: RecognisedAddress | null = null;
    if (exactRoute !== null) {
      match = {
        address: exactRoute.address,
        isServiceAddress: exactRoute.isServiceAddress,
        route: exactRoute,
      };
    } else if (knownLogin) {
      match = { address: candidate, isServiceAddress: false, route: null };
    } else {
      // A `+tag` only resolves to the base address when that address opted in.
      const base = routeByAddress.get(stripPlusTag(candidate).toLowerCase());
      if (base?.acceptsPlusAddressing) {
        match = { address: base.address, isServiceAddress: base.isServiceAddress, route: base };
      }
    }

    if (match === null) continue;

    if (match.isServiceAddress) {
      recognised.push(match);
      continue;
    }
    const domain = match.address.split('@')[1];
    const serviceOfSameDomain = recognised.findIndex(
      (seen) => seen.isServiceAddress && seen.address.split('@')[1] === domain,
    );
    if (serviceOfSameDomain > -1) recognised.splice(serviceOfSameDomain, 0, match);
    else recognised.push(match);
  }

  return recognised;
}

interface SenderAssociation {
  address: string;
  teamId: string;
  userId: string;
}

/** Every team the message's sender can act for, most-believed first. */
async function associationsFor(recognised: RecognisedAddress[]): Promise<SenderAssociation[]> {
  const directory = principalDirectory();
  const associations: SenderAssociation[] = [];
  const seen = new Set<string>();

  const add = (address: string, teamId: string, userId: string) => {
    const key = `${userId} ${teamId}`;
    if (seen.has(key)) return;
    seen.add(key);
    associations.push({ address, teamId, userId });
  };

  for (const { address, route } of recognised) {
    const owners = await directory.teamsForEmail(address);
    // A service address routes to ITS team, acted for by whoever owns the
    // address — the association the `associated_team_id` column used to carry.
    // An address nobody owns cannot be acted for, so it routes nowhere.
    if (route !== null && owners.length > 0) add(address, route.teamId, owners[0].userId);
    for (const owner of owners) add(address, owner.teamId, owner.userId);
  }

  return associations;
}

/**
 * When nothing about the sender is recognised, one last question: does their
 * DOMAIN have a service address? A team that registered `@acme.com`'s shared
 * inbox is telling us it answers for that domain's mail.
 */
async function sameDomainFallback(address: string): Promise<SenderAssociation[]> {
  const domain = address.split('@')[1];
  if (domain === undefined) return [];

  const row = await getAutomationsQb(['inbound_email_route'])
    .selectFrom('inbound_email_route')
    .where('is_service_email', '=', true)
    .where('address', 'like', `%@${domain}`)
    .select(['address', 'team_id'])
    .executeTakeFirst();
  if (row === undefined) return [];

  const owners = await principalDirectory().teamsForEmail(row.address);
  if (owners.length === 0) return [];
  return [{ address: row.address, teamId: row.team_id, userId: owners[0].userId }];
}

/** Admission: the door's own policy, applied to associations the Directory
 *  reports without judging. A person who may not act for the team is not a
 *  sender for it. */
async function admissible(associations: SenderAssociation[]): Promise<SenderAssociation[]> {
  const directory = principalDirectory();
  const admitted: SenderAssociation[] = [];
  for (const association of associations) {
    const user = await directory.userById({ id: association.userId, teamId: association.teamId });
    if (user?.hasAccess === true) admitted.push(association);
  }
  return admitted;
}

// ── 3. Which team, when there are several? ─────────────────────────────────

async function routeByKey(
  associations: SenderAssociation[],
  key: string,
): Promise<{ association: SenderAssociation; trigger: { id: string; kind: string } }[]> {
  const matches: { association: SenderAssociation; trigger: { id: string; kind: string } }[] = [];
  const teamsTried = new Set<string>();

  for (const association of associations) {
    if (teamsTried.has(association.teamId)) continue;
    teamsTried.add(association.teamId);

    const trigger = await findTriggerByInboundKey({
      teamId: association.teamId,
      kinds: INBOUND_EMAIL_TRIGGER_KINDS,
      key,
    });
    if (trigger) matches.push({ association, trigger: { id: trigger.id, kind: trigger.kind } });
  }
  return matches;
}

// ── The door ───────────────────────────────────────────────────────────────

/**
 * Questions 2 and 3, for a message any door has already believed: whose team
 * this is, and which of that team's triggers (if any) the address names.
 */
async function routeInboundEmail(message: RoutableMessage): Promise<InboundEmailDecision> {
  const recognised = await recogniseAddresses(message.senderCandidates);
  const identifier = recognised[0]?.address ?? message.senderCandidates[0] ?? '';
  let associations = await admissible(await associationsFor(recognised));
  if (associations.length === 0) {
    associations = await admissible(await sameDomainFallback(identifier));
  }

  if (associations.length === 0) {
    // No Listen-Fire account, and no service address for their domain. A person
    // decides whether to onboard them; the message is dropped cleanly (201, so
    // Mailgun does not retry) rather than processed as an anonymous submission.
    await sendSlackNotification({
      type: 'SUPPORT',
      text: `Unrecognised inbound email from ${identifier} — not routed (no Listen-Fire account, and no service email for their domain). Onboard them if this should be handled.`,
      opsTitle: `Unrecognised inbound email from ${identifier} was not routed`,
    });
    return { outcome: 'refused', status: 201 };
  }

  const key = inboundKeyFrom(message.recipients);
  const primary = associations[0];

  if (key === null) {
    return {
      outcome: 'routed',
      userId: primary.userId,
      teamId: primary.teamId,
      route: { teamId: primary.teamId, key: null, trigger: null },
    };
  }

  const matches = await routeByKey(associations, key);
  if (matches.length > 1) {
    // The key belongs to more than one of the sender's teams. Guessing which
    // one they meant would run somebody's automation on a coin flip.
    logger.warn('[InboundEmail] dropped an email whose routing key is ambiguous', {
      sender: identifier,
      key,
      teams: matches.map((match) => match.association.teamId),
    });
    return { outcome: 'refused', status: 201 };
  }

  const matched = matches[0];
  const association = matched?.association ?? primary;
  return {
    outcome: 'routed',
    userId: association.userId,
    teamId: association.teamId,
    route: {
      teamId: association.teamId,
      key,
      trigger: matched?.trigger ?? null,
    },
  };
}

/** The platform's side of the mail doors: the environment's signing rules and
 *  the sender-keyed routing above; the core (`admitMailgunMail`,
 *  `admitResendMail`) is everything between. */
const platformMailgunStore: MailgunStore = {
  route: routeInboundEmail,
  mailgunSigningKey: () => signingKey(),
};

/** The Mailgun door over the platform's store. */
function verifyInboundEmailRequest(body: unknown): Promise<InboundEmailDecision> {
  return admitMailgunMail(platformMailgunStore, body);
}

export {
  INBOUND_EMAIL_TRIGGER_KINDS,
  inboundKeyFrom,
  recogniseAddresses,
  routeInboundEmail,
  signingKey,
  verifyInboundEmailRequest,
};
