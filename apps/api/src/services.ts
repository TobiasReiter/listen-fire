import { randomBytes } from 'node:crypto';

import { services } from './adapters/registry';
import { OutboundMailgunAdapter } from './adapters/email/mailgun.adapter';
import { OutboundResendAdapter } from './adapters/email/resend.adapter';
import { FakeOutboundEmailAdapter } from './adapters/email/fake.adapter';
import { UnconfiguredOutboundEmailAdapter } from './adapters/email/unconfigured.adapter';
import { withOutboundEmailLedger } from './adapters/email/ledger';
import { chooseOutboundEmailProvider } from './adapters/email/choose';
import {
  emailProvidersOverlap,
  resolveEmailProvider,
} from './services/translation_graph/adapters/email/provider';
import { logger } from 'movement-engine/public/log';
import { OutboundTwilioMessager } from './adapters/whatsapp/twilio.adapter';
import { FakeOutboundWhatsAppAdapter } from './adapters/whatsapp/fake.adapter';
import { UnconfiguredOutboundWhatsAppAdapter } from './adapters/whatsapp/unconfigured.adapter';
import { whatsappLinkVerification } from './services/whatsapp/phone_verification/link_verification';
import { S3Adapter } from './adapters/document/s3';
import { UnconfiguredDocumentProvider } from './adapters/document/unconfigured';
import { GoogleDocumentAIAdapter } from './adapters/ocr/google';
import { UnconfiguredOcrAdapter } from './adapters/ocr/unconfigured';
import { BrightDataAdapter } from './adapters/linkedin/brightData';
import { AirtableAppAdapter } from './adapters/airtable/connector';
import { SlackWebApiConnector } from './adapters/slack/webApi/connector';
import { AirtableAuthClient } from './adapters/airtable/authClient';
import { AttioAppAdapter } from './adapters/attio/connector';
import { AttioAuthClient } from './adapters/attio/authClient';
import { GoogleAppAdapter } from './adapters/google/connector';
import { GoogleAuthClient } from './adapters/google/authClient';
import { DropboxAppAdapter } from './adapters/dropbox/connector';
import { DropboxAuthClient } from './adapters/dropbox/authClient';
import { GmailAppAdapter } from './adapters/gmail/connector';
import { GmailAuthClient } from './adapters/gmail/authClient';
import {
  gmailConnectMethod,
  gmailOAuthClientCredentials,
} from './adapters/gmail/connect_method';
import { SlackMonitoring } from './lib/slack';
import { oauthRedirectBaseUrl } from './lib/api_base_url';
import { neverAsAny } from 'movement-engine/public/types';
import { getFlowUserId } from './lib/oauthFlows';
import { storePendingCredentials } from './lib/pendingCredentials';
import { resolveOAuthCallbackRedirect } from './lib/oauthCallbackRedirect';
import { askSettleDelivery } from './services/translation_graph/adapters/ask/delivery_mode';
import { notifyEngineOfSettledAsks } from './services/asks/in_process_notifier';
import { mounts } from './products';

const NODE_ENV = process.env.NODE_ENV as typeof process.env.NODE_ENV | 'staging';
const isProductionOrStaging = NODE_ENV === 'production' || NODE_ENV === 'staging';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_SENDING_DOMAIN = process.env.MAILGUN_SENDING_DOMAIN;
const MAILGUN_API_BASE_URL = process.env.MAILGUN_API_BASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_API_BASE_URL = process.env.RESEND_API_BASE_URL;
const OUTBOUND_EMAIL_FROM = process.env.OUTBOUND_EMAIL_FROM;
const OUTBOUND_EMAIL_FROM_NAME = process.env.OUTBOUND_EMAIL_FROM_NAME;
const OUTBOUND_EMAIL_BCC = process.env.OUTBOUND_EMAIL_BCC;

const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const AWS_DOCUMENT_S3_BUCKET = process.env.AWS_DOCUMENT_S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_ENDPOINT = process.env.AWS_S3_ENDPOINT;
const AWS_S3_FORCE_PATH_STYLE = process.env.AWS_S3_FORCE_PATH_STYLE;

const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const GOOGLE_PROJECT_LOCATION = process.env.GOOGLE_PROJECT_LOCATION;
const GOOGLE_PROCESSOR_ID = process.env.GOOGLE_OCR_PROCESSOR_ID;
const GOOGLE_STORAGE_BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET_NAME;

const BRIGHT_DATA_ACCESS_TOKEN = process.env.BRIGHT_DATA_ACCESS_TOKEN;

// The Slack OAuth connector is the NEW "Listen-Fire" app (Option A): the modern
// connect flow installs it per workspace and its credentials are stamped
// app_id='listen-fire' (persistCredential). Reads the SLACK_MOVEMENTS_* env; the old
// SLACK_CLIENT_ID app is retired from the connect flow (legacy pipelines read
// pre-existing legacy / null credentials, not this connector).
const SLACK_CLIENT_ID = process.env.SLACK_MOVEMENTS_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_MOVEMENTS_CLIENT_SECRET;
const SLACK_STATE_SECRET = process.env.SLACK_MOVEMENTS_STATE_SECRET;
const SLACK_REDIRECT_URI = process.env.SLACK_MOVEMENTS_REDIRECT_URI;

const AIRTABLE_CLIENT_ID = process.env.AIRTABLE_CLIENT_ID;
const AIRTABLE_CLIENT_SECRET = process.env.AIRTABLE_CLIENT_SECRET;

const ATTIO_CLIENT_ID = process.env.ATTIO_CLIENT_ID;
const ATTIO_CLIENT_SECRET = process.env.ATTIO_CLIENT_SECRET;

const GOOGLE_INTEGRATIONS_CLIENT_ID = process.env.GOOGLE_INTEGRATIONS_CLIENT_ID;
const GOOGLE_INTEGRATIONS_CLIENT_SECRET = process.env.GOOGLE_INTEGRATIONS_CLIENT_SECRET;

const DROPBOX_CLIENT_ID = process.env.DROPBOX_CLIENT_ID;
const DROPBOX_CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET;

const SLACK_MONITORING_CREDENTIALS_ID = process.env.SLACK_MONITORING_CREDENTIALS_ID;
const SLACK_MONITORING_CONVERSATION_ID = process.env.SLACK_MONITORING_CONVERSATION_ID;

// SERVICE PROVIDERS
// mechanically, which provider we use for each service

// Every send is wrapped in the outbound_email ledger, so the db record is a
// property of the SEAM rather than of each of the dozen call sites.
// Production/staging missing anything a send needs — a provider key, Mailgun's
// verified sending domain, the from-address — gets a loudly-failing stub, never
// the fake adapter: the fake posts at a localhost outbox that isn't there, so
// alert email used to silently evaporate in exactly the environment that needs
// it. They are read here rather than inside the adapter so a deployment that
// sends no email still boots. The API base URLs and the archive BCC are the
// ones that are NOT required: each has a working default, and an unset BCC
// means no BCC rather than a copy to somebody else's inbox.
// Which provider `email` means in this deployment, said out loud at boot. It
// is one answer for inbound and outbound both: a deployment sending as itself
// through one company and receiving through another is a configuration nobody
// intends, and Resend winning a tie is what makes "whichever is configured" a
// rule rather than a coin flip.
const emailProvider = resolveEmailProvider();
logger.info(`[email] this deployment's email runs through ${emailProvider.slug}`, {
  provider: emailProvider.slug,
  inboundCallback: emailProvider.callbackPath,
  ...(emailProvidersOverlap()
    ? { note: 'both Resend and Mailgun are configured — Resend wins' }
    : {}),
});

const outboundEmailProvider = chooseOutboundEmailProvider();
const outboundEmailSender = {
  email: OUTBOUND_EMAIL_FROM ?? '',
  username: OUTBOUND_EMAIL_FROM_NAME ?? '',
};
switch (outboundEmailProvider) {
  case 'resend':
    services.email = withOutboundEmailLedger(
      new OutboundResendAdapter({
        resendApiKey: RESEND_API_KEY ?? '',
        defaultSender: outboundEmailSender,
        apiBaseUrl: RESEND_API_BASE_URL,
        archiveBcc: OUTBOUND_EMAIL_BCC,
      }),
      'resend',
    );
    break;
  case 'mailgun':
    services.email = withOutboundEmailLedger(
      new OutboundMailgunAdapter({
        mailgunApiKey: MAILGUN_API_KEY ?? '',
        sendingDomain: MAILGUN_SENDING_DOMAIN ?? '',
        defaultSender: outboundEmailSender,
        apiBaseUrl: MAILGUN_API_BASE_URL,
        archiveBcc: OUTBOUND_EMAIL_BCC,
      }),
      'mailgun',
    );
    break;
  case 'unconfigured':
    services.email = withOutboundEmailLedger(new UnconfiguredOutboundEmailAdapter(), 'unconfigured');
    break;
  case 'fake':
    services.email = withOutboundEmailLedger(new FakeOutboundEmailAdapter(), 'fake');
    break;
  default:
    neverAsAny(outboundEmailProvider);
}

// Same three-branch shape as email above, and for the same reason: the fake
// adapter reports success whether or not the fake-channels host answers, so
// production missing any Twilio credential used to send WhatsApp messages
// nowhere, silently. There is no outbound_whatsapp ledger to record the
// failure — callers get `false` and nothing else.
if (isProductionOrStaging && TWILIO_NUMBER && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  services.whatsapp = new OutboundTwilioMessager({
    twilioNumber: TWILIO_NUMBER,
    accountSid: TWILIO_ACCOUNT_SID,
    authToken: TWILIO_AUTH_TOKEN,
  });
} else if (isProductionOrStaging) {
  services.whatsapp = new UnconfiguredOutboundWhatsAppAdapter();
} else {
  services.whatsapp = new FakeOutboundWhatsAppAdapter();
}

// Read here only so a mistyped value stops the boot, naming the variable and
// its values; the link flow reads it again per call.
whatsappLinkVerification();

// Object storage is OPTIONAL: a deployment that never touches a file (no
// exposed_file bytes, no valuations attachments) boots without it and only the
// file-touching paths fail, naming the vars. `AWS_S3_ENDPOINT` points the same
// adapter at any S3-compatible service — R2, MinIO, Supabase Storage — so
// "S3" here is a protocol, not a vendor.
if (AWS_DOCUMENT_S3_BUCKET && AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
  services.document = new S3Adapter({
    bucket: AWS_DOCUMENT_S3_BUCKET,
    region: AWS_REGION,
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    endpoint: AWS_S3_ENDPOINT,
    forcePathStyle: AWS_S3_FORCE_PATH_STYLE === 'true',
  });
} else {
  services.document = new UnconfiguredDocumentProvider();
}

if (
  GOOGLE_PRIVATE_KEY &&
  GOOGLE_CLIENT_EMAIL &&
  GOOGLE_CLIENT_ID &&
  GOOGLE_PROJECT_ID &&
  GOOGLE_PROJECT_LOCATION &&
  GOOGLE_PROCESSOR_ID &&
  GOOGLE_STORAGE_BUCKET_NAME
) {
  services.ocr = new GoogleDocumentAIAdapter({
    privateKey: GOOGLE_PRIVATE_KEY,
    clientEmail: GOOGLE_CLIENT_EMAIL,
    clientId: GOOGLE_CLIENT_ID,
    projectId: GOOGLE_PROJECT_ID,
    projectLocation: GOOGLE_PROJECT_LOCATION,
    processorId: GOOGLE_PROCESSOR_ID,
    bucketName: GOOGLE_STORAGE_BUCKET_NAME,
  });

  // TODO: allow user configuration of which adapters they use?
} else {
  // Optional for the same reason storage is: a deployment that never OCRs a
  // PDF should boot without Google Document AI credentials.
  services.ocr = new UnconfiguredOcrAdapter();
}

if (BRIGHT_DATA_ACCESS_TOKEN) {
  services.linkedin = new BrightDataAdapter({ accessToken: BRIGHT_DATA_ACCESS_TOKEN });
}

if (SLACK_CLIENT_ID && SLACK_CLIENT_SECRET && SLACK_STATE_SECRET && SLACK_REDIRECT_URI) {
  services.slack = new SlackWebApiConnector({
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    stateSecret: SLACK_STATE_SECRET,
    redirectUri: SLACK_REDIRECT_URI,
  });
}

if (SLACK_MONITORING_CREDENTIALS_ID && SLACK_MONITORING_CONVERSATION_ID) {
  services.slackMonitoring = new SlackMonitoring({
    conversationId: SLACK_MONITORING_CONVERSATION_ID,
    credentialsId: SLACK_MONITORING_CREDENTIALS_ID,
  });
}

if (AIRTABLE_CLIENT_ID && AIRTABLE_CLIENT_SECRET) {
  const airtableAuthClient = new AirtableAuthClient({
    clientId: AIRTABLE_CLIENT_ID,
    clientSecret: AIRTABLE_CLIENT_SECRET,
    redirectBaseUrl: oauthRedirectBaseUrl(),
  });

  services.airtable = new AirtableAppAdapter({
    authClient: airtableAuthClient,
  });
}

if (process.env.MOCK_OUTPUT_ADAPTERS === 'true') {
  // Dev-loop installs `services.attio` so Attio still advertises the OAuth
  // connect kind. The real fake data comes from fake-channels via
  // `injectFakeBaseUrl` — credentials issued to the test-harness team carry a
  // `baseUrl` pointing at fake-channels, and every caller builds its own
  // client from that credential.
  services.attio = {
    // Faithful fake OAuth round-trip for the dev loop: the install URL points
    // straight at our own callback with a dev code + a real `state` (so the
    // connect-link flow can bind it). `handleCallback` stages pending creds the
    // same way a real connector does and uses the shared redirect helper, so
    // the author-time connect-link path can be exercised end-to-end without a
    // real provider.
    generateInstallUrl: async () => {
      const base = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
      const state = randomBytes(24).toString('base64url');
      return `${base}/api/public/auth/attio/callback?code=dev-fake-code&state=${state}`;
    },
    handleCallback: async (req, res) => {
      const state = String(req.query.state ?? '');
      const userId = getFlowUserId(state);
      if (!userId) {
        res.status(401).send('Unknown OAuth flow');
        return;
      }
      const claimToken = await storePendingCredentials(
        { accessToken: 'dev-fake-attio-token', baseUrl: `${process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556'}/attio` },
        userId,
      );
      res.redirect(
        resolveOAuthCallbackRedirect({
          state,
          claimToken,
          callbackUrl: `${(process.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:3003').replace(/\/$/, '')}/attio/callback`,
        }),
      );
    },
  };
} else if (ATTIO_CLIENT_ID && ATTIO_CLIENT_SECRET) {
  const attioAuthClient = new AttioAuthClient({
    clientId: ATTIO_CLIENT_ID,
    clientSecret: ATTIO_CLIENT_SECRET,
    redirectBaseUrl: oauthRedirectBaseUrl(),
  });
  services.attio = new AttioAppAdapter({
    authClient: attioAuthClient,
  });
}

if (GOOGLE_INTEGRATIONS_CLIENT_ID && GOOGLE_INTEGRATIONS_CLIENT_SECRET) {
  services.google = new GoogleAppAdapter({
    authClient: new GoogleAuthClient({
      clientId: GOOGLE_INTEGRATIONS_CLIENT_ID,
      clientSecret: GOOGLE_INTEGRATIONS_CLIENT_SECRET,
      redirectBaseUrl: oauthRedirectBaseUrl(),
    }),
  });
}

// Gmail's OAuth client is the operator's own (`GMAIL_OAUTH_CLIENT_ID`) when
// they registered one, and otherwise the client Sheets and Drive already use.
// Registered only under the `oauth` connect method; under `delegated` there is
// no sign-in, so no connector, and the key-entry form is what the app offers
// instead.
const GMAIL_OAUTH_CLIENT =
  gmailConnectMethod() === 'oauth' ? gmailOAuthClientCredentials() : null;
if (GMAIL_OAUTH_CLIENT) {
  services.gmail = new GmailAppAdapter({
    authClient: new GmailAuthClient({
      clientId: GMAIL_OAUTH_CLIENT.clientId,
      clientSecret: GMAIL_OAUTH_CLIENT.clientSecret,
      redirectBaseUrl: oauthRedirectBaseUrl(),
      // The dev loop signs in against the fake Google in fake-channels, so the
      // real exchange and the real profile call run with nothing mocked out.
      ...(process.env.MOCK_OUTPUT_ADAPTERS === 'true'
        ? { fakeBaseUrl: process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556' }
        : {}),
    }),
  });
}

// The dev loop signs in and refreshes against the fake OAuth provider in
// fake-channels (and supplies a client of its own when none is configured), so
// a token refresh writing back through the secrets store runs end to end.
const dropboxFakeBaseUrl =
  process.env.MOCK_OUTPUT_ADAPTERS === 'true'
    ? (process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556')
    : undefined;
const dropboxClientId = DROPBOX_CLIENT_ID || (dropboxFakeBaseUrl ? 'dev-loop-dropbox-client' : undefined);
const dropboxClientSecret = DROPBOX_CLIENT_SECRET || (dropboxFakeBaseUrl ? 'dev-loop-dropbox-secret' : undefined);
if (dropboxClientId && dropboxClientSecret) {
  services.dropbox = new DropboxAppAdapter({
    authClient: new DropboxAuthClient({
      clientId: dropboxClientId,
      clientSecret: dropboxClientSecret,
      redirectBaseUrl: oauthRedirectBaseUrl(),
      ...(dropboxFakeBaseUrl ? { fakeBaseUrl: dropboxFakeBaseUrl } : {}),
    }),
  });
}

// METERING + ADMISSION (D8)
// Automations meters and admits through interfaces and ships with no-ops.
// ASK SETTLE NOTIFICATION (A-5)
// The composed deployment notifies in-process: a settled ask queues the
// engine's wake for it, which is the only thing that wakes a run parked on an
// answered ask. Standalone runs `webhook` instead and never registers anything
// here — exactly one path is active, so an answer is never announced twice.
// Registered beside the other provider choices rather than in the worker
// registries, because the answer door runs in the request path of every
// instance, not only the one holding the background lock.
//
// There is an engine to nudge only where automations runs: an asks-only
// deployment has nothing to notify in-process, whatever its delivery mode says.
if (askSettleDelivery() === 'local' && mounts('automations')) {
  notifyEngineOfSettledAsks();
}
