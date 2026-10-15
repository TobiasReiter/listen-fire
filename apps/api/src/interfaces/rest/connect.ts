// Author-time credential-connect LANDING route.
//
// The link an MCP authoring agent hands the user (`/api/connect/<token>`) lands
// here. This route — NOT a popup, NOT a BroadcastChannel — connects the adapter
// in whatever browser the user opened, then persists the resulting credential
// team-bound. The single-use token in the URL IS the authorization (no login
// required), so this router mounts BEFORE the auth gate (alongside `/api/asks`,
// `/api/files`).
//
// Four adapter kinds land here, branched on the token's `connectKind`. In ALL
// cases GET renders a page and the user must explicitly click "Connect" — the
// link never auto-redirects to a provider on load:
//   - OAuth     → GET renders a confirm page (adapter name + a "Connect" button).
//     POST /:token starts the provider OAuth (binds the flow to the token), the
//     connector callback routes back to GET /:token/complete, which claims +
//     persists.
//   - key-entry → GET renders a server-side HTML form for the adapter's
//     credential fields; POST /:token validates + persists. No OAuth.
//   - intrinsic → GET renders a confirm page; POST /:token mints + provisions the
//     Listen-Fire-owned credential server-side and persists it. No external auth.
//   - handshake → (Telegram) GET renders a confirm page; POST /:token connects
//     the TEAM (the idempotent empty shared-bot credential), mints the deep-link
//     handshake token, and redirects into Telegram (`t.me/<bot>?start=<token>`) —
//     the identity bind itself completes when the user presses Start there.
//
// This is an author-time precondition resolver. It deliberately mirrors the
// single-use-token landing shape of the asks engine but shares NOTHING with the
// runtime ask park/resume machinery.

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { getAdapterManifest } from '../../services/translation_graph/adapters/registry';
import { bindFlowToUser, extractStateFromUrl } from '../../lib/oauthFlows';
import { claimPendingCredentials } from '../../lib/pendingCredentials';
import { persistCredential } from '../../services/credentials/persist_credential';
import { mintRemoteCredential } from '../../services/credentials/remote_credential';
import {
  getRemoteAdapter,
  linkRemoteAdapterCredential,
  rowToManifest,
} from '../../services/translation_graph/adapters/remote/store';
import { probeProtocolVersion } from '../../services/translation_graph/adapters/remote/install';
import { RemoteAdapterCredentialPayload } from '../../services/translation_graph/adapters/remote/manifest';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import {
  lookupConnectToken,
  startConnectOAuth,
  consumeConnectToken,
  type ConnectTokenRow,
} from '../../services/credentials/connect_link';
import { connectFormSpecForType } from '../../services/credentials/connect_form_spec';
import { intrinsicProvisionerForType } from '../../services/credentials/intrinsic_provision';
import {
  builtInBotUsername,
  ensureSharedTelegramTeamCredential,
  mintTelegramToken,
  telegramStartUrl,
} from '../../services/translation_graph/adapters/telegram/handshake';
import { services } from '../../adapters/registry';
import { decryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { googleCredsParser } from '../../adapters/google/authClient';
import { grantItem } from '../../services/credentials/granted_items';
import {
  pickerActionKindForAdapter,
  pickerSpecForActionKind,
  type PickerSpec,
} from '../../services/credentials/picker_spec';
import { logger } from 'movement-engine/services/logger';
import { slackAppDisplayName } from '../../lib/brand';

const connectRouter: ReturnType<typeof Router> = Router();

// ── GET /api/connect/:token — land: OAuth confirm page OR key-entry form ───
// Validates the token, then branches on the adapter's connect kind. The link
// NEVER auto-redirects to a provider on load: OAuth lands on a confirm page with
// an explicit "Connect" button; key-entry lands on the credential form. The
// actual provider sign-in only starts when the user POSTs (clicks Connect).
const startHandler: RequestHandler = async (req, res) => {
  const token = req.params.token;
  const lookup = await lookupConnectToken(token);
  if (!lookup.ok) {
    res.status(statusForReason(lookup.reason)).type('html').send(unavailablePage(lookup.reason));
    return;
  }

  const { row } = lookup;
  if (row.connectKind === 'key-entry') {
    res.status(200).type('html').send(keyEntryPage(row, token));
    return;
  }
  if (row.connectKind === 'intrinsic') {
    // No external sign-in: confirm page only; the POST provisions server-side.
    res.status(200).type('html').send(intrinsicConfirmPage(row, token));
    return;
  }
  if (row.connectKind === 'handshake') {
    // Telegram: confirm page; the POST connects the team + redirects into
    // Telegram for the identity handshake.
    res.status(200).type('html').send(handshakeConfirmPage(row, token));
    return;
  }
  if (row.connectKind === 'item-picker') {
    // Google item-grant link (Sheets/Drive): the page hosts the Drive Picker;
    // picking POSTs back to /:token/grant. Under drive.file the pick IS the
    // grant mechanism — there is no API-only path to an existing file/folder.
    const kind = pickerActionKindForAdapter(row.adapterSlug);
    if (!kind) {
      res.status(500).type('html').send(unavailablePage('unavailable'));
      return;
    }
    res.status(200).type('html').send(itemPickerPage(row, token, pickerSpecForActionKind(kind)));
    return;
  }

  // OAuth: show a confirm page. No redirect, no OAuth started yet — the user
  // clicks "Connect" which POSTs to this same token URL (see startOAuthFlow).
  res.status(200).type('html').send(oauthConfirmPage(row, token));
};

// ── POST /api/connect/:token — submit (OAuth start OR key-entry persist) ────
// Re-validate the token, then branch on the connect kind:
//   - OAuth     → start the provider sign-in (bind the flow to this token) and
//     redirect to the provider. The token is consumed later, on the callback's
//     /complete leg — NOT here — so a sign-in the user abandons can be retried.
//   - key-entry → build + validate the credentials envelope from the posted
//     fields, consume the token (atomic, replay-safe), then persist team-bound.
const submitHandler: RequestHandler = async (req, res) => {
  const token = req.params.token;
  const lookup = await lookupConnectToken(token);
  if (!lookup.ok) {
    res.status(statusForReason(lookup.reason)).type('html').send(unavailablePage(lookup.reason));
    return;
  }

  const { row } = lookup;
  if (row.connectKind === 'oauth') {
    await startOAuthFlow(row, token, res);
    return;
  }
  if (row.connectKind === 'intrinsic') {
    await provisionIntrinsic(row, res);
    return;
  }
  if (row.connectKind === 'handshake') {
    await startTelegramHandshake(row, res);
    return;
  }
  if (row.connectKind === 'item-picker') {
    // The picker flow's writes go through /:token/picker-token and
    // /:token/grant — a bare POST has no meaning here.
    res.status(400).type('html').send(unavailablePage('bad_request'));
    return;
  }

  const spec = connectFormSpecForType(row.serviceType);
  if (!spec) {
    res.status(500).type('html').send(unavailablePage('unavailable'));
    return;
  }

  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;

  // Collect only the spec's fields from the posted body (string-valued form).
  const body = bodyRecordSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).type('html').send(unavailablePage('bad_request'));
    return;
  }
  const values: Record<string, string> = {};
  for (const field of spec.fields) {
    const raw = body.data[field.name];
    values[field.name] = typeof raw === 'string' ? raw : '';
  }

  let credentials: unknown;
  try {
    credentials = spec.parse(values);
  } catch {
    // Re-render the form with a validation message (token NOT consumed — the
    // user can correct and resubmit).
    res
      .status(400)
      .type('html')
      .send(keyEntryPage(row, token, { error: 'Please check the values and try again.' }));
    return;
  }

  // The adapter's own live check, before anything is stored and before the
  // token is spent — a credential that cannot reach its system is not a
  // credential, and the user is still on the form to fix it.
  if (spec.validate) {
    let verdict: Awaited<ReturnType<NonNullable<typeof spec.validate>>>;
    try {
      verdict = await spec.validate(credentials);
    } catch (e) {
      logger.error('[CONNECT] credential validation threw', e);
      verdict = { ok: false, message: 'That could not be checked just now — try again shortly.' };
    }
    if (!verdict.ok) {
      res.status(400).type('html').send(keyEntryPage(row, token, { error: verdict.message }));
      return;
    }
    // A check that had to reach the system may hand back what it learned there
    // — Gmail's pasted refresh token comes back as the mailbox it belongs to
    // and the scopes it holds. That, not what was typed, is the credential.
    if (verdict.credentials !== undefined) {
      credentials = verdict.credentials;
    }
  }

  // A remote adapter's server is asked its protocol version with the secret
  // being linked, exactly as an install with the secret is — refused before the
  // token is spent or a credential minted, so the user can still fix the server.
  if (row.serviceType === ExternalServiceType.REMOTE) {
    const refusal = await remoteProtocolRefusal(row, credentials);
    if (refusal !== undefined) {
      res.status(400).type('html').send(keyEntryPage(row, token, { error: refusal }));
      return;
    }
  }

  // Consume FIRST (single-use, atomic) so a replayed submit can't double-persist.
  const consumed = await consumeConnectToken(row.id);
  if (!consumed) {
    res.status(410).type('html').send(unavailablePage('consumed'));
    return;
  }

  try {
    if (row.serviceType === ExternalServiceType.REMOTE) {
      // A remote adapter's secret is minted with app_id = the adapter slug (so
      // resolveAdapter can only ever use it for this adapter) and then linked
      // onto the install — the out-of-band half of the "install, connect the
      // secret" flow. The install row already exists (mint-link only resolves
      // for an installed remote slug).
      const { secret } = RemoteAdapterCredentialPayload.parse(credentials);
      const { credentialsId } = await mintRemoteCredential({
        teamId: row.teamId,
        userId: row.userId,
        adapterType: row.adapterSlug,
        displayName: row.credentialName,
        secret,
        replaceExisting: true,
      });
      await linkRemoteAdapterCredential({
        teamId: row.teamId,
        adapterType: row.adapterSlug,
        credentialsId,
      });
    } else {
      await persistCredential({
        teamId: row.teamId,
        userId: row.userId,
        name: row.credentialName,
        type: row.serviceType,
        credentials,
        replaceExisting: true,
      });
    }
  } catch (e) {
    logger.error('[CONNECT] failed to persist key credential', e);
    res.status(500).type('html').send(unavailablePage('persist_failed'));
    return;
  }

  res.status(200).type('html').send(connectedPage(displayName));
};

/** Why the remote adapter's server cannot take this secret, or undefined when
 *  it answers protocol version 2. */
async function remoteProtocolRefusal(row: ConnectTokenRow, credentials: unknown): Promise<string | undefined> {
  const install = await getRemoteAdapter({ teamId: row.teamId, adapterType: row.adapterSlug });
  if (!install) return `Remote adapter "${row.adapterSlug}" is not installed.`;
  const { secret } = RemoteAdapterCredentialPayload.parse(credentials);
  try {
    await probeProtocolVersion({ teamId: row.teamId, manifest: rowToManifest(install), secret });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// OAuth start (POST leg of the confirm page). Generate the adapter's install
// URL and bind the OAuth flow to BOTH the token's user (so the connector
// callback recovers the user) and the connect token (so the callback routes
// back to /complete). Redirect the browser to the provider. The token is NOT
// consumed here — that happens on the /complete leg after the credential is in
// hand, so an abandoned sign-in leaves the link usable for a retry.
async function startOAuthFlow(
  row: ConnectTokenRow,
  token: string,
  res: Parameters<RequestHandler>[1],
): Promise<void> {
  try {
    const installUrl = await startConnectOAuth(row.serviceType);
    if (!installUrl) {
      res.status(503).type('html').send(unavailablePage('unavailable'));
      return;
    }
    const state = extractStateFromUrl(installUrl);
    if (!state) {
      logger.error('[CONNECT] install URL has no state param', { adapter: row.adapterSlug });
      res.status(500).type('html').send(unavailablePage('unavailable'));
      return;
    }
    bindFlowToUser(state, row.userId, { connectToken: token });
    res.redirect(installUrl);
  } catch (e) {
    logger.error('[CONNECT] failed to start OAuth', e);
    res.status(500).type('html').send(unavailablePage('unavailable'));
  }
}

// Intrinsic provisioning (POST leg of the intrinsic confirm page). There's no
// external round-trip — Listen-Fire owns both ends — so consume the token FIRST
// (atomic, replay-safe), then mint + register the Listen-Fire-owned credential and
// persist it team-bound. A replayed submit that loses the consume race does
// nothing, so we can never double-mint.
async function provisionIntrinsic(
  row: ConnectTokenRow,
  res: Parameters<RequestHandler>[1],
): Promise<void> {
  const provisioner = intrinsicProvisionerForType(row.serviceType);
  if (!provisioner) {
    res.status(500).type('html').send(unavailablePage('unavailable'));
    return;
  }
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;

  const consumed = await consumeConnectToken(row.id);
  if (!consumed) {
    res.status(410).type('html').send(unavailablePage('consumed'));
    return;
  }

  try {
    const { credentials } = await provisioner.provision({
      teamId: row.teamId,
      userId: row.userId,
      credentialName: row.credentialName,
    });
    await persistCredential({
      teamId: row.teamId,
      userId: row.userId,
      name: row.credentialName,
      type: row.serviceType,
      credentials,
      replaceExisting: true,
    });
  } catch (e) {
    logger.error('[CONNECT] failed to provision intrinsic credential', e);
    res.status(500).type('html').send(unavailablePage('persist_failed'));
    return;
  }

  res.status(200).type('html').send(connectedPage(displayName));
}

// Telegram handshake (POST leg of the handshake confirm page). Consume the
// token FIRST (atomic, replay-safe — mirroring intrinsic), then:
//   1. ensure the TEAM's shared-bot credential exists (idempotent — this is
//      what makes `telegram(credentials: …)` constructible and what the
//      authoring agent sees appear in listCatalog), and
//   2. mint the deep-link handshake token for the token's USER and redirect the
//      browser into Telegram (`t.me/<bot>?start=<token>`).
// The identity bind itself happens out-of-band when the user presses Start in
// Telegram (`bindTelegramFromStart` via the shared-bot webhook) — there is no
// /complete leg for this kind.
async function startTelegramHandshake(
  row: ConnectTokenRow,
  res: Parameters<RequestHandler>[1],
): Promise<void> {
  const botUsername = builtInBotUsername();
  if (!botUsername) {
    // Minting already guards on this; only a config change between mint and
    // click lands here.
    res.status(503).type('html').send(unavailablePage('unavailable'));
    return;
  }

  const consumed = await consumeConnectToken(row.id);
  if (!consumed) {
    res.status(410).type('html').send(unavailablePage('consumed'));
    return;
  }

  try {
    // The name only applies if this connect CREATES the credential; an existing
    // one keeps its name (which mintConnectLink already promised in that case).
    await ensureSharedTelegramTeamCredential({
      teamId: row.teamId,
      userId: row.userId,
      name: row.credentialName,
    });
    const { token: startToken } = await mintTelegramToken({
      nativeUserId: row.userId,
      teamId: row.teamId,
    });
    res.redirect(telegramStartUrl({ botUsername, token: startToken }));
  } catch (e) {
    logger.error('[CONNECT] failed to start Telegram handshake', e);
    res.status(500).type('html').send(unavailablePage('persist_failed'));
  }
}

const bodyRecordSchema = z.record(z.string(), z.unknown());

// ── GET /api/connect/:token/complete?claimToken=… — finish + persist ───────
// The connector callback redirected here after staging the freshly-exchanged
// tokens as pending credentials. Claim them, persist the credential team-bound
// under the desired name, consume the token (single-use), confirm.
const completeHandler: RequestHandler = async (req, res) => {
  const token = req.params.token;
  const claimToken = typeof req.query.claimToken === 'string' ? req.query.claimToken : undefined;

  const lookup = await lookupConnectToken(token);
  if (!lookup.ok) {
    res.status(statusForReason(lookup.reason)).type('html').send(unavailablePage(lookup.reason));
    return;
  }
  if (!claimToken) {
    res.status(400).type('html').send(unavailablePage('bad_request'));
    return;
  }

  const { row } = lookup;
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;

  // Consume FIRST (single-use, atomic) so a replayed callback can't double-persist.
  const consumed = await consumeConnectToken(row.id);
  if (!consumed) {
    res.status(410).type('html').send(unavailablePage('consumed'));
    return;
  }

  try {
    const credentials = await claimPendingCredentials(claimToken, row.userId);
    await persistCredential({
      teamId: row.teamId,
      userId: row.userId,
      name: row.credentialName,
      type: row.serviceType,
      credentials,
      replaceExisting: true,
    });
  } catch (e) {
    logger.error('[CONNECT] failed to persist credential', e);
    res.status(500).type('html').send(unavailablePage('persist_failed'));
    return;
  }

  res.status(200).type('html').send(connectedPage(displayName));
};

// ── Item picker legs (Sheets/Drive) ─────────────────────────────────────────

/** Fresh Google access token for the picker (refreshed if expired) + the
 *  Picker app id. Authorized by the single-use URL; the token is NOT consumed
 *  here (the page may retry) — consumption happens on /grant. */
const pickerTokenHandler: RequestHandler = async (req, res) => {
  const lookup = await lookupConnectToken(req.params.token);
  if (!lookup.ok) {
    res.status(lookup.reason === 'consumed' ? 410 : 404).json({ error: lookup.reason });
    return;
  }
  if (lookup.row.connectKind !== 'item-picker' || !lookup.row.credentialsId) {
    res.status(404).json({ error: 'invalid_link' });
    return;
  }
  if (!services.google) {
    res.status(503).json({ error: 'google_not_configured' });
    return;
  }
  const appId = process.env.GOOGLE_APP_ID ?? process.env.NEXT_PUBLIC_GOOGLE_APP_ID;
  if (!appId) {
    logger.error('[CONNECT] item picker: GOOGLE_APP_ID is not set on the API');
    res.status(503).json({ error: 'picker_not_configured' });
    return;
  }
  try {
    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', lookup.row.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', lookup.row.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirstOrThrow();
    const creds = googleCredsParser.parse(JSON.parse(await decryptToken(row.credentials, row.id)));
    const client = services.google.authClient.getGoogleClient(row.id, creds);
    const { token: accessToken } = await client.getAccessToken();
    if (!accessToken) throw new Error('no access token');
    res.json({ accessToken, appId });
  } catch (e) {
    logger.error('[CONNECT] item picker token failed', e);
    res.status(500).json({ error: 'token_failed' });
  }
};

const pickerGrantBodySchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        mimeType: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** Record the picked items against the link's credential. Consumes the
 *  token FIRST (single-use, replay-safe). */
const pickerGrantHandler: RequestHandler = async (req, res) => {
  const lookup = await lookupConnectToken(req.params.token);
  if (!lookup.ok) {
    res.status(lookup.reason === 'consumed' ? 410 : 404).json({ error: lookup.reason });
    return;
  }
  if (lookup.row.connectKind !== 'item-picker' || !lookup.row.credentialsId) {
    res.status(404).json({ error: 'invalid_link' });
    return;
  }
  const body = pickerGrantBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const consumed = await consumeConnectToken(lookup.row.id);
  if (!consumed) {
    res.status(410).json({ error: 'consumed' });
    return;
  }
  try {
    for (const item of body.data.items) {
      await grantItem({
        credentialsId: lookup.row.credentialsId,
        itemId: item.id,
        mimeType: item.mimeType,
        ...(item.name !== undefined ? { name: item.name } : {}),
      });
    }
    res.json({ granted: body.data.items.length });
  } catch (e) {
    logger.error('[CONNECT] item picker grant failed', e);
    res.status(500).json({ error: 'grant_failed' });
  }
};

connectRouter.post('/:token/picker-token', pickerTokenHandler);
connectRouter.post('/:token/grant', pickerGrantHandler);
connectRouter.get('/:token/complete', completeHandler);
connectRouter.post('/:token', submitHandler);
connectRouter.get('/:token', startHandler);

export { connectRouter };

// ── Pages ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One shared stylesheet for every connect page, in the marketing site's visual
// language (its primary palette + clean card layout) so the link feels like
// Listen-Fire end-to-end. Pages compose the classes below; none carry their own
// <style> blocks.
const SHELL_CSS =
  `body{font-family:-apple-system,system-ui,sans-serif;background:#F6F6F8;color:#1a1a1a;` +
  `line-height:1.5;margin:0;padding:1.5rem;-webkit-font-smoothing:antialiased}` +
  `.wrap{max-width:28rem;margin:3rem auto}` +
  `.brand{font-weight:700;font-size:1.0625rem;margin:0 0 1rem .25rem;color:#271F52}` +
  `.card{background:#fff;border:1px solid #E8E8EC;border-radius:1rem;padding:2rem;` +
  `box-shadow:0 1px 2px rgba(39,31,82,.04),0 8px 24px rgba(39,31,82,.05)}` +
  `h1{font-size:1.25rem;font-weight:600;margin:0 0 .75rem}` +
  `p{margin:.75rem 0}.muted{color:#5B5B66;font-size:.9375rem}` +
  `.guide{background:#F5F3FE;border:1px solid #EBE8FD;border-radius:.625rem;` +
  `padding:.9rem 1rem;margin:1.25rem 0}` +
  `.guide-title{font-size:.8125rem;font-weight:600;color:#5242A8;margin:0}` +
  `.guide ol,.guide ul{margin:.5rem 0 0;padding-left:1.2rem}` +
  `.guide li{margin:.35rem 0;font-size:.875rem;color:#4B4B57}` +
  `.guide .note{font-size:.8125rem;color:#6B6B76;margin:.6rem 0 0}` +
  `label{display:block;margin:1rem 0 .3rem;font-weight:600;font-size:.875rem}` +
  `input{width:100%;box-sizing:border-box;padding:.55rem .75rem;border:1px solid #D8D8DE;` +
  `border-radius:.5rem;font-size:1rem}` +
  `input:focus{outline:none;border-color:#8778F7;box-shadow:0 0 0 3px #EBE8FD}` +
  `.help{font-size:.8125rem;color:#71717A;margin:.3rem 0 0}` +
  `button{margin-top:1.5rem;width:100%;padding:.65rem 1.2rem;background:#8778F7;color:#fff;` +
  `border:0;border-radius:.5rem;font-size:1rem;font-weight:600;cursor:pointer}` +
  `button:hover{background:#6B5BD4}` +
  `button:focus-visible{outline:2px solid #A296F8;outline-offset:2px}` +
  `.error{background:#FDF2F2;border:1px solid #F5C6C6;color:#B00020;border-radius:.5rem;` +
  `padding:.6rem .8rem;font-size:.875rem;margin:1rem 0 0}` +
  `.ok-badge{display:inline-flex;align-items:center;justify-content:center;width:2.5rem;` +
  `height:2.5rem;border-radius:50%;background:#EBE8FD;color:#5242A8;font-size:1.25rem;` +
  `margin-bottom:1rem}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${SHELL_CSS}</style></head><body>` +
    `<div class="wrap"><div class="brand">Listen-Fire</div><div class="card">${body}</div></div>` +
    `</body></html>`;
}

function connectedPage(displayName: string): string {
  return shell(
    'Connected',
    `<div class="ok-badge">&#10003;</div>` +
      `<h1>${escapeHtml(displayName)} is connected.</h1>` +
      `<p class="muted">You can close this tab and return to your conversation — ` +
      `the assistant can now use ${escapeHtml(displayName)}.</p>`,
  );
}

// The OAuth confirm page. No auto-redirect: the user sees what they're
// connecting and clicks "Connect", which POSTs to the same token URL and starts
// the real provider sign-in (see startOAuthFlow). This is the explicit
// confirm-then-connect step the author-time link lands on.
function oauthConfirmPage(row: ConnectTokenRow, token: string): string {
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;
  const action = `/api/connect/${encodeURIComponent(token)}`;
  return shell(
    `Connect ${displayName}`,
    `<h1>Connect ${escapeHtml(displayName)}</h1>` +
      `<p class="muted">Listen-Fire is requesting access to your ${escapeHtml(displayName)} account ` +
      `so it can run your automation. Click <strong>Connect</strong> to sign in to ` +
      `${escapeHtml(displayName)} and grant access. You'll come right back here when it's done.</p>` +
      oauthConnectExtraGuide(row.adapterSlug) +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<button type="submit">Connect ${escapeHtml(displayName)}</button></form>`,
  );
}

/**
 * Optional adapter-specific guidance shown on the OAuth confirm page, above the
 * Connect button. Slack: a bot auto-joins PUBLIC channels but must be added to a
 * PRIVATE channel by hand, so tell the user how — otherwise a movement targeting
 * a private channel silently can't post there.
 */
function oauthConnectExtraGuide(adapterSlug: string): string {
  if (adapterSlug === 'slack') {
    return (
      `<div class="guide"><p class="guide-title">Using it in private channels</p>` +
      `<p class="note">${escapeHtml(slackAppDisplayName())} joins a <strong>public</strong> channel automatically the first ` +
      `time it posts there. For it to post in (or react to messages in) a ` +
      `<strong>private</strong> channel, add it first: open the channel in Slack, then use ` +
      `<strong>Integrations &rarr; Add apps</strong> (or type <code>/invite</code> and pick ` +
      `the ${escapeHtml(slackAppDisplayName())} app while in the channel). Bots cannot self-join a private channel, so this ` +
      `is required once per private channel.</p></div>`
    );
  }
  return '';
}

// The intrinsic confirm page. No external sign-in and no key to paste — the
// adapter is part of Listen-Fire, which owns both ends of the credential. The user
// clicks "Connect" and the POST leg provisions it server-side (see
// provisionIntrinsic). Copy is deliberately different from the OAuth page:
// nothing is being authorized with a third party.
function intrinsicConfirmPage(row: ConnectTokenRow, token: string): string {
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;
  const action = `/api/connect/${encodeURIComponent(token)}`;
  return shell(
    `Connect ${displayName}`,
    `<h1>Connect ${escapeHtml(displayName)}</h1>` +
      `<p class="muted">${escapeHtml(displayName)} is part of Listen-Fire — connecting it just sets ` +
      `it up for your team, with nothing to sign in to. Click <strong>Connect</strong> and ` +
      `you're done.</p>` +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<button type="submit">Connect ${escapeHtml(displayName)}</button></form>`,
  );
}

// The Telegram handshake confirm page. Unlike OAuth/key-entry, the linking act
// finishes inside Telegram itself — so the copy walks the user through the one
// extra step (press Start) that no other kind has.
//
// The "What the bot can see" panel answers the two questions this moment
// poses — "is this reading all my Telegram?" and "who else sees what I send?"
// — right where the user forms that mental model, instead of leaving the
// answer buried in a post-connect schema call. The visibility facts mirror
// TELEGRAM_MANIFEST.triggerExpectation (the agent-facing statement of the same
// semantics); if Telegram's delivery rules change, update both.
function handshakeConfirmPage(row: ConnectTokenRow, token: string): string {
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;
  const action = `/api/connect/${encodeURIComponent(token)}`;
  return shell(
    `Connect ${displayName}`,
    `<h1>Connect ${escapeHtml(displayName)}</h1>` +
      `<p class="muted">This links your Telegram account to Listen-Fire, so messages you send ` +
      `the bot can run your automations and it can message you back.</p>` +
      `<div class="guide"><p class="guide-title">What the bot can see</p><ul>` +
      `<li>It cannot read your Telegram. Bots only receive what is sent to them — ` +
      `your other chats stay completely out of reach.</li>` +
      `<li>In your one-to-one chat with the bot, it sees what you send it. In a group ` +
      `it's added to, it only sees direct replies to it and @-mentions.</li>` +
      `<li>Everything it receives from you goes only to your own workspace — ` +
      `never to anyone else's.</li>` +
      `</ul></div>` +
      `<div class="guide"><p class="guide-title">What happens next</p><ol>` +
      `<li>Telegram opens with the bot.</li>` +
      `<li>Press <strong>Start</strong> in the chat.</li>` +
      `<li>The bot replies "Linked" — that's it, you can head back to your conversation.</li>` +
      `</ol><p class="note">Don't have Telegram on this device? Open this page on your ` +
      `phone instead.</p></div>` +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<button type="submit">Connect ${escapeHtml(displayName)}</button></form>`,
  );
}

// The item picker page (Sheets or Drive, per `spec`). Hosts Google's Drive
// Picker (the ONLY way to grant an existing file/folder under drive.file):
// Connect → fetch a fresh OAuth token from /:token/picker-token → open the
// Picker (configured from `spec`'s mimetypes/folders) → on PICKED, POST the
// picks to /:token/grant (which consumes the link) → confirmation. Everything
// inline; the only external script is Google's own picker loader.
function itemPickerPage(row: ConnectTokenRow, token: string, spec: PickerSpec): string {
  const t = encodeURIComponent(token);
  const mimeJs = JSON.stringify(spec.mimeTypes.join(','));
  const foldersJs = spec.allowFolders ? 'true' : 'false';
  return shell(
    spec.title,
    `<h1>${escapeHtml(spec.title)}</h1>` +
      `<p class="muted">${escapeHtml(spec.blurb)}</p>` +
      `<div class="guide"><p class="guide-title">What happens next</p><ol>` +
      `<li>Click <strong>Choose</strong> — Google's picker opens.</li>` +
      `<li>Pick what you want Listen-Fire to use (you can pick several).</li>` +
      `<li>You're done — the assistant can now use them.</li>` +
      `</ol></div>` +
      `<div id="msg"></div>` +
      `<button id="pick" type="button">Choose</button>` +
      `<script src="https://apis.google.com/js/api.js"></script>` +
      `<script>` +
      `var TOK='${t}';var MIME=${mimeJs};var FOLDERS=${foldersJs};` +
      `var btn=document.getElementById('pick');var msg=document.getElementById('msg');` +
      `function say(html,err){msg.innerHTML='<div class="'+(err?'error':'guide')+'">'+html+'</div>';}` +
      `function done(n){document.querySelector('h1').textContent='Connected.';` +
      `say((n>1?n+' items are':'It is')+' now available to the assistant — you can close this tab.');btn.remove();}` +
      `btn.onclick=function(){btn.disabled=true;` +
      `fetch('/api/connect/'+TOK+'/picker-token',{method:'POST'}).then(function(r){` +
      `if(!r.ok)throw new Error('token');return r.json();}).then(function(cfg){` +
      `gapi.load('picker',{callback:function(){` +
      `var view=new google.picker.DocsView(google.picker.ViewId.DOCS);` +
      `if(MIME)view.setMimeTypes(MIME);` +
      `if(FOLDERS){view.setIncludeFolders(true);view.setSelectFolderEnabled(true);}` +
      `view.setMode(google.picker.DocsViewMode.LIST);` +
      `var picker=new google.picker.PickerBuilder().addView(view)` +
      `.setOAuthToken(cfg.accessToken).setAppId(cfg.appId)` +
      `.setCallback(function(data){` +
      `if(data.action===google.picker.Action.PICKED){` +
      `var docs=(data.docs||[]).filter(function(d){return d.id;}).map(function(d){return {id:d.id,mimeType:d.mimeType||'',name:d.name||d.id};});` +
      `fetch('/api/connect/'+TOK+'/grant',{method:'POST',headers:{'content-type':'application/json'},` +
      `body:JSON.stringify({items:docs})}).then(function(r){` +
      `if(r.status===410){say('This link was already used — ask the assistant for a fresh one.',true);}` +
      `else if(!r.ok){throw new Error('grant');}else{done(docs.length);}}).catch(function(){say('Saving the choice failed — please try again.',true);btn.disabled=false;});` +
      `}else if(data.action===google.picker.Action.CANCEL){btn.disabled=false;}` +
      `}).build();picker.setVisible(true);` +
      `},onerror:function(){say('Could not load the Google picker — please try again.',true);btn.disabled=false;}});` +
      `}).catch(function(){say('Could not prepare the picker — ask the assistant for a fresh link.',true);btn.disabled=false;});};` +
      `</script>`,
  );
}

// The API-key entry form. Renders the adapter's credential fields from the
// connect-form spec (never hardcoded per adapter). Secrets are password inputs
// with no value pre-filled (no echo / no leak), and the form posts back to the
// same token URL. `posts back to the same token URL` keeps the token the single
// authz.
function keyEntryPage(
  row: ConnectTokenRow,
  token: string,
  opts: { error?: string } = {},
): string {
  const manifest = getAdapterManifest(row.adapterSlug);
  const displayName = manifest?.displayName ?? row.adapterSlug;
  const spec = connectFormSpecForType(row.serviceType);
  const fields = spec?.fields ?? [];

  const errorBlock = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : '';

  // The adapter's "where to find this" walkthrough (from the connect-form
  // spec, never hardcoded here) — rendered above the form so the user isn't
  // staring at a bare "API key" input with no idea where to get one.
  const guideBlock = spec?.guide?.length
    ? `<div class="guide"><p class="guide-title">Where to find this</p><ol>` +
      spec.guide.map((step) => `<li>${escapeHtml(step)}</li>`).join('') +
      `</ol>` +
      (spec.note ? `<p class="note">${escapeHtml(spec.note)}</p>` : '') +
      `</div>`
    : '';

  const inputs = fields
    .map((f) => {
      const id = `f_${escapeHtml(f.name)}`;
      const type = f.secret ? 'password' : f.kind === 'url' ? 'url' : 'text';
      const required = f.optional ? '' : ' required';
      const autocomplete = f.secret ? ' autocomplete="off"' : '';
      const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
      const help = f.help ? `<p class="help">${escapeHtml(f.help)}</p>` : '';
      return (
        `<label for="${id}">${escapeHtml(f.label)}</label>` +
        `<input id="${id}" name="${escapeHtml(f.name)}" type="${type}"${required}${autocomplete}${placeholder} />` +
        help
      );
    })
    .join('');

  const action = `/api/connect/${encodeURIComponent(token)}`;
  return shell(
    `Connect ${displayName}`,
    `<h1>Connect ${escapeHtml(displayName)}</h1>` +
      `<p class="muted">Enter the credential for <strong>${escapeHtml(row.credentialName)}</strong>. ` +
      `If it's already connected, this will replace it.</p>` +
      guideBlock +
      errorBlock +
      `<form method="post" action="${escapeHtml(action)}">${inputs}` +
      `<button type="submit">Connect</button></form>`,
  );
}

function statusForReason(reason: string): number {
  switch (reason) {
    case 'not_found':
      return 404;
    case 'expired':
    case 'consumed':
      return 410; // Gone
    case 'bad_request':
      return 400;
    default:
      return 400;
  }
}

function unavailablePage(reason: string): string {
  const map: Record<string, { title: string; detail: string }> = {
    not_found: {
      title: "This link isn't valid.",
      detail: 'Check you opened the full link, or ask the assistant for a fresh one.',
    },
    expired: {
      title: 'This link has expired.',
      detail: 'Connection links are single-use and only last a day. Ask the assistant for a fresh one.',
    },
    consumed: {
      title: 'This link has already been used.',
      detail:
        'If that was you, the connection likely went through — check with the assistant. ' +
        'Otherwise, ask it for a fresh link.',
    },
    misconfigured: {
      title: "This integration can't be connected through a browser link.",
      detail: 'Connect it from inside the Listen-Fire app instead.',
    },
    unavailable: {
      title: "This integration isn't available to connect right now.",
      detail: 'Please try again shortly, or ask the assistant for another way to connect.',
    },
    persist_failed: {
      title: 'Something went wrong saving the connection.',
      detail: 'Nothing was stored. Ask the assistant for a fresh link and try again.',
    },
    bad_request: {
      title: 'This link is missing required information.',
      detail: 'Check you opened the full link, or ask the assistant for a fresh one.',
    },
  };
  const page = map[reason] ?? {
    title: 'Connection unavailable.',
    detail: 'Ask the assistant for a fresh link.',
  };
  return shell(
    'Connection unavailable',
    `<h1>${escapeHtml(page.title)}</h1><p class="muted">${escapeHtml(page.detail)}</p>`,
  );
}
