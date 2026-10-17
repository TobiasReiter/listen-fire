import { Router } from 'express';

import {
  iconHandler,
  documentDownloadHandler,
  getFeatureFlags,
} from './public';
import {
  listIntegrationsHandler,
  suggestIntegrationHandler,
} from './integrations';
import {
  authGoogleAdminCallbackHandler,
  authGoogleAuthHandler,
  authMicrosoftAuthHandler,
  authGoogleIntegrationsCallbackHandler,
  authGmailCallbackHandler,
  authSlackCallbackHandler,
  authAirtableCallbackHandler,
  authAttioCallbackHandler,
  authDropboxCallbackHandler,
  requestMagicLinkHandler,
  verifyMagicLinkHandler,
  authPasswordLoginHandler,
  authPasswordSignupHandler,
  authPasswordConfirmHandler,
  authRealtimeTokenHandler,
  logoutHandler,
  impersonateHandler,
  stopImpersonateHandler,
} from './auth';
import { remoteAdapterSignInCallbackHandler } from './remote_adapter_callback';
import {
  inboundEmailHandler,
  resendInboundEmailHandler,
} from './private';
import { webhookRouter } from './webhooks';
import { whatsappRouter } from './whatsapp';
import { knowledgeRouter } from './v1/knowledge';
import { automationRouter } from './v1/automation';
import { meRouter } from './v1/me';
import { systemRouter } from './v1/system';
import { valuationsRouter } from './v1/valuations';
import { asksRouter } from './v1/asks';
import { mounts } from '../../products';

const publicRouter: ReturnType<typeof Router> = Router();

// NOTE: some of these could definitely be done via TRPC instead
publicRouter.get('/document/:id/data', documentDownloadHandler);
publicRouter.get('/icon', iconHandler);
publicRouter.get('/feature_flags/:email', getFeatureFlags);
publicRouter.get('/integrations', listIntegrationsHandler);
publicRouter.post('/integrations/suggest', suggestIntegrationHandler);
publicRouter.post('/save_click_event', (_, res) => res.sendStatus(200));
publicRouter.get('/page_view', (_, res) => res.sendStatus(200));

// WhatsApp Business API webhooks (public for Meta to access) — an automations
// trigger door (7_automations.md §5), so it goes where automations goes.
if (mounts('automations')) publicRouter.use('/whatsapp', whatsappRouter);

// `/auth` is two surfaces sharing a prefix (3_core.md §5): the sign-in family
// is core's, and the six adapter OAuth callbacks are the connect UX, which is
// automations' (D7). Each half mounts with its own unit.
const authRouter: ReturnType<typeof Router> = Router();
publicRouter.use('/auth', authRouter);

if (mounts('core')) {
  // Both /callback (login) and /signup route through the create-or-login handlers,
  // so first-time login provisions a new account (gated by early-access when on).
  // /google/admin/callback stays STRICT — admins must already exist.
  authRouter.post('/google/callback', authGoogleAuthHandler);
  authRouter.post('/google/admin/callback', authGoogleAdminCallbackHandler);
  authRouter.post('/microsoft/callback', authMicrosoftAuthHandler);
  authRouter.post('/google/signup', authGoogleAuthHandler);
  authRouter.post('/microsoft/signup', authMicrosoftAuthHandler);
  authRouter.post('/requestMagicLink', requestMagicLinkHandler);
  authRouter.post('/verify', verifyMagicLinkHandler);
  authRouter.post('/password/login', authPasswordLoginHandler);
  authRouter.post('/password/signup', authPasswordSignupHandler);
  authRouter.post('/password/confirm', authPasswordConfirmHandler);
  authRouter.get('/realtime-token', authRealtimeTokenHandler);
  authRouter.post('/logout', logoutHandler);
}

if (mounts('automations')) {
  authRouter.get('/google_integrations/callback', authGoogleIntegrationsCallbackHandler);
  authRouter.get('/gmail/callback', authGmailCallbackHandler);
  authRouter.get('/slack/callback', authSlackCallbackHandler);
  authRouter.get('/airtable/callback', authAirtableCallbackHandler);
  authRouter.get('/attio/callback', authAttioCallbackHandler);
  authRouter.get('/dropbox/callback', authDropboxCallbackHandler);
  authRouter.get('/remote_adapter/callback', remoteAdapterSignInCallbackHandler);
}

const privateRouter: ReturnType<typeof Router> = Router();

privateRouter.get('/authenticated', async (_req, res) => res.sendStatus(201));

// The live inbound-email door: a sender-keyed movement trigger (M-41), so it
// belongs to automations. `/webhook` is its outbound-telemetry sibling.
if (mounts('automations')) {
  privateRouter.post('/mailgun/callback', inboundEmailHandler);
  privateRouter.post('/email/callback', inboundEmailHandler);
  // The same door for mail carried by Resend. A different wire shape and a
  // different signature scheme, routed by the same three questions.
  privateRouter.post('/resend/callback', resendInboundEmailHandler);
  privateRouter.use('/webhook', webhookRouter);
  privateRouter.use('/v1/automation', automationRouter);
}

// `me` and `system` are unclaimed by any unit plan, so they stay everywhere
// (product_gate.ts records why unclaimed means shared).
privateRouter.use('/v1', meRouter);
privateRouter.use('/v1/system', systemRouter);

if (mounts('knowledge')) privateRouter.use('/v1/knowledge', knowledgeRouter);
if (mounts('valuations')) privateRouter.use('/v1/valuations', valuationsRouter);
if (mounts('asks')) privateRouter.use('/v1/asks', asksRouter);
if (mounts('core')) {
  privateRouter.post('/auth/impersonate', impersonateHandler);
  privateRouter.post('/auth/stop-impersonate', stopImpersonateHandler);
}

export { publicRouter, privateRouter };
