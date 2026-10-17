// Author-time connect-LINK key-entry form spec.
//
// The connect link works for OAuth adapters (browser sign-in) AND API-key
// adapters (a browser form where the user pastes — or replaces — the key). For
// the key-entry kind, the landing route renders a form whose FIELDS come from
// here, and the submit route validates the posted values with the SAME zod
// parser the in-app `addCredential` mutation uses (views/credentials.ts).
// One field spec per credential type, paired with its real parser, so the form
// is never hardcoded per adapter and can never drift from what the adapter
// actually accepts.
//
// Only adapters whose credential is a user-supplied key/secret belong here.
// Intrinsic credentials (NATIVE_VALUATIONS — server auto-mints; connected via
// intrinsic_provision.ts) and handshake credentials (TELEGRAM — deep-link /
// shared-bot) are deliberately absent: they have no "paste a key" browser form.

import { z } from 'zod';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { affinityCredsParser } from '@lf/affinity/api_client';
import { attioCredsParser } from '../../adapters/attio/apiClient';
import { evertraceCredsParser } from '../../adapters/evertrace/apiClient';
import { dealroomCredsParser } from '@lf/dealroom/api_client';
import {
  connectGmailByRefreshToken,
  gmailDelegatedCredsParser,
  gmailRefreshTokenCredsParser,
  validateGmailMailbox,
} from '../../adapters/gmail/apiClient';
import { gmailConnectMethod } from '../../adapters/gmail/connect_method';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { RemoteAdapterCredentialPayload } from '../translation_graph/adapters/remote/manifest';

/** Stored Granola credential — the API key the user pastes. */
export const granolaCredsParser = z.object({
  apiKey: z.string(),
});

/** One field rendered on the key-entry form. */
export interface ConnectFormField {
  /** The posted form field name — also the key in the credentials envelope. */
  name: string;
  /** Human label shown above the input. */
  label: string;
  /** A secret → rendered as a password input (no echo), never pre-filled. */
  secret: boolean;
  /** Optional fields don't block submission when left blank. */
  optional: boolean;
  /** Input type hint: a plain string vs a URL. */
  kind: 'text' | 'url';
  /** Optional placeholder / hint. */
  placeholder?: string;
  /** Short hint rendered under the input — what the field means / when to
   *  leave it blank. Plain text (the page escapes it). */
  help?: string;
}

/**
 * A key-entry connectable adapter's form: the fields to render + the parser to
 * validate the submitted envelope against (the EXACT parser `addCredential`
 * uses). `parse` returns the validated credentials object or throws.
 */
export interface ConnectFormSpec {
  fields: ConnectFormField[];
  /** Step-by-step "where to find this" instructions rendered above the form —
   *  the walk from the provider's UI to the value(s) below. Plain text. */
  guide?: string[];
  /** A caveat worth surfacing alongside the guide (plan requirements etc.). */
  note?: string;
  parse(values: Record<string, string>): unknown;
  /**
   * A LIVE check of the parsed envelope, before anything is stored.
   *
   * `parse` only says the values are the right shape; for a credential whose
   * failure modes are about the other end's configuration — a delegation a
   * Workspace admin never granted — shape is not the question. The submit route
   * re-renders the form with `message`, so the user corrects the thing that is
   * actually wrong rather than discovering it in a run a week later.
   *
   * A check that had to CALL the system may hand back what it learned there, as
   * `credentials`, and that is stored instead of what was typed. Gmail's pasted
   * refresh token is the case: reaching the mailbox is how the token is proved,
   * and the mailbox address and granted scopes come back with the proof. Nothing
   * is invented — a spec that returns no credentials stores exactly what was
   * parsed, as before.
   *
   * Omitted ⇒ nothing is called and a parsed envelope is stored as-is.
   */
  validate?(
    credentials: unknown,
  ): Promise<{ ok: true; credentials?: unknown } | { ok: false; message: string }>;
}

function specFor(
  parser: z.ZodType,
  fields: ConnectFormField[],
  extras: {
    guide?: string[];
    note?: string;
    validate?: ConnectFormSpec['validate'];
  } = {},
): ConnectFormSpec {
  return {
    fields,
    ...extras,
    parse(values) {
      // Trim, then OMIT blanks entirely so the parser's own required/optional
      // rules decide: a blank required field is dropped → the parser rejects the
      // missing key (we never persist an empty secret); a blank optional field
      // is dropped → `.optional()` is satisfied.
      const cleaned: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.name];
        if (v === undefined) continue;
        const trimmed = v.trim();
        if (trimmed === '') continue;
        cleaned[f.name] = trimmed;
      }
      return parser.parse(cleaned);
    },
  };
}

const CONNECT_FORM_SPECS: Partial<Record<ExternalServiceType, ConnectFormSpec>> = {
  [ExternalServiceType.AFFINITY]: specFor(
    affinityCredsParser,
    [
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
      {
        name: 'webhookSignatureKey',
        label: 'Webhook signature key (optional)',
        secret: true,
        optional: true,
        kind: 'text',
        help:
          'Optional extra security: with this set, events Affinity sends us are ' +
          'checked against your account\u2019s signature key so forged deliveries are ' +
          'rejected. Found next to your API key in the API section.',
      },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank — it's only needed if Affinity has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Affinity in your browser.',
        'Open Settings, then the API section.',
        "Copy your API key (generate one there if you don't have one yet) and paste it below.",
        'Optionally also copy the Webhook Signature Key from the same page for verified event deliveries.',
      ],
    },
  ),
  // Attio issues workspace access tokens that authenticate exactly like the
  // OAuth ones (`Authorization: Bearer …`), so the pasted token lands in the
  // same `accessToken` envelope the OAuth callback stores and every outbound
  // call is unchanged. `connectKindForType` still prefers OAuth wherever the
  // connector is wired; this form is what a deployment WITHOUT its own Attio
  // OAuth app connects through.
  [ExternalServiceType.ATTIO]: specFor(
    attioCredsParser,
    [
      { name: 'accessToken', label: 'Access token', secret: true, optional: false, kind: 'text' },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank — it's only needed if Attio has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Attio, open the dropdown beside your workspace name and choose Workspace settings.',
        'Open the Developers tab and click "+ New access token".',
        'Name the token and give it these scopes: record_permission:read-write, object_configuration:read, ' +
          'list_entry:read-write, list_configuration:read, note:read-write, task:read-write, ' +
          'comment:read-write, file:read-write, webhook:read-write, user_management:read.',
        'Copy the token and paste it below.',
      ],
      note: 'Only an Attio workspace admin can create an access token.',
    },
  ),
  [ExternalServiceType.GRANOLA]: specFor(
    granolaCredsParser,
    [{ name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' }],
    {
      guide: [
        'Open the Granola desktop app.',
        'Go to Settings, then API keys, and click "Create new key".',
        'Copy the key (it starts with "grn_") and paste it below.',
      ],
      note: 'Creating Granola API keys requires a Business or Enterprise workspace.',
    },
  ),
  [ExternalServiceType.EVERTRACE]: specFor(
    evertraceCredsParser,
    [
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank \u2014 it's only needed if Evertrace has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Evertrace in your browser.',
        'Open Settings, then API access, and create a key.',
        'Copy the key (it starts with "sk_live_") and paste it below.',
      ],
    },
  ),
  [ExternalServiceType.DEALROOM]: specFor(
    dealroomCredsParser,
    [
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
      {
        name: 'baseUrl',
        label: 'API base URL (optional)',
        secret: false,
        optional: true,
        kind: 'url',
        help: "Leave this blank \u2014 it's only needed if Dealroom has given you a custom API address.",
      },
    ],
    {
      guide: [
        'Sign in to Dealroom in your browser.',
        'Open your account settings and find the API section.',
        'Copy the API key and paste it below.',
      ],
      note: 'API access is part of a Dealroom Premium plan \u2014 ask your account manager if the API section is missing.',
    },
  ),
  // Gmail's DELEGATED method: the mailbox is connected by NAMING it, not by
  // signing into one — the deployment's Google service account acts as the
  // address through domain wide delegation, which a Workspace admin grants
  // once. There is no secret to paste, which is why the form has one plain
  // field and why the real check is the live `validate` below rather than
  // anything the parser can see. `connectFormSpecForType` withholds this whole
  // form under the `oauth` method.
  [ExternalServiceType.GOOGLE_GMAIL]: specFor(
    gmailDelegatedCredsParser,
    [
      {
        name: 'mailbox',
        label: 'Mailbox address',
        secret: false,
        optional: false,
        kind: 'text',
        placeholder: 'deals@yourcompany.com',
        help:
          'The Google Workspace address automations should read and send as. A ' +
          'real user or shared mailbox — a group address has no inbox. Only a ' +
          'mailbox this installation lists in GMAIL_MAILBOX_ALLOWLIST can be connected.',
      },
    ],
    {
      guide: [
        'Decide which Workspace mailbox automations should act as.',
        'Ask a Workspace admin to open Security, then API controls, then Domain wide delegation.',
        'Have them add this deployment’s service account client id with the scopes ' +
          'https://www.googleapis.com/auth/gmail.readonly and ' +
          'https://www.googleapis.com/auth/gmail.send.',
        'Enter the mailbox address below.',
      ],
      note:
        'Nothing is stored until the mailbox answers, so a failure here means the ' +
        'delegation or the address is wrong — not that anything was lost.',
      validate: async (credentials) =>
        validateGmailMailbox(gmailDelegatedCredsParser.parse(credentials)),
    },
  ),
  // A user-installed remote adapter authenticates with a single secret (the
  // token its server checks on every request). The parser is the same
  // { secret } payload resolveAdapter decrypts, so the form can never drift
  // from what the adapter accepts. The submit binds it to the adapter (app_id)
  // and links it onto the install — see interfaces/rest/connect.ts.
  [ExternalServiceType.REMOTE]: specFor(
    RemoteAdapterCredentialPayload,
    [
      {
        name: 'secret',
        label: 'Adapter secret',
        secret: true,
        optional: false,
        kind: 'text',
        help:
          'The auth token your adapter server checks on each request (sent as a ' +
          'Bearer token or your configured header). Paste it here.',
      },
    ],
    {
      guide: [
        'Open the adapter server you built for your CRM.',
        'Copy the secret it expects for authentication.',
        'Paste it below — it is stored encrypted and never leaves Listen-Fire.',
      ],
    },
  ),
};

/**
 * Gmail's OAUTH-method form: paste a refresh token the mailbox already granted.
 *
 * Beside the sign-in button rather than instead of it — a Workspace admin who
 * would rather authorise the mailbox themselves than hand a browser to whoever
 * is connecting ends up here. The `validate` below is the whole check: it
 * exchanges the token with this installation's own Gmail OAuth client, which is
 * what proves the token is one that client issued and that the account has not
 * revoked it, and what comes back is the mailbox and the scopes. So the stored
 * credential is byte-identical to a signed-in one, and the token is never
 * echoed, logged, or trusted for anything it did not prove.
 */
const GMAIL_REFRESH_TOKEN_SPEC: ConnectFormSpec = specFor(
  gmailRefreshTokenCredsParser,
  [
    {
      name: 'refreshToken',
      label: 'Refresh token',
      secret: true,
      optional: false,
      kind: 'text',
      help:
        'A Google OAuth refresh token for the mailbox, issued by the same OAuth ' +
        'client this installation is configured with. The mailbox address and what ' +
        'it may do are read from Google, not from anything typed here.',
    },
  ],
  {
    guide: [
      'Authorise the mailbox against this installation’s Gmail OAuth client, asking for ' +
        'https://www.googleapis.com/auth/gmail.readonly and, to send, ' +
        'https://www.googleapis.com/auth/gmail.send.',
      'Ask for offline access, so Google issues a refresh token rather than only an ' +
        'access token.',
      'Paste the refresh token below.',
    ],
    note:
      'Most people should use the Google sign-in instead — this form is for a Workspace ' +
      'admin who authorised the mailbox themselves.',
    validate: async (credentials) => {
      const entry = gmailRefreshTokenCredsParser.parse(credentials);
      return connectGmailByRefreshToken({
        refreshToken: entry.refreshToken,
        ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
      });
    },
  },
);

/** The key-entry form spec for a credential type, or undefined if it isn't a
 *  key-entry connectable adapter (OAuth / intrinsic / handshake).
 *
 *  Gmail has TWO forms and the connect method picks between them — they ask for
 *  different things because they carry different authority. Under `delegated`
 *  the field is a mailbox address, because the deployment already holds the
 *  right to act as it. Under `oauth` the field is a refresh token, because
 *  nothing but a grant from that mailbox is a right to read it; typing an
 *  address there would let a deployment claim a mailbox it was never given.
 */
export function connectFormSpecForType(
  type: ExternalServiceType,
): ConnectFormSpec | undefined {
  if (type === ExternalServiceType.GOOGLE_GMAIL) {
    const method = gmailConnectMethod();
    switch (method) {
      case 'oauth':
        return GMAIL_REFRESH_TOKEN_SPEC;
      case 'delegated':
        return CONNECT_FORM_SPECS[type];
      default:
        return neverAsAny(method);
    }
  }
  return CONNECT_FORM_SPECS[type];
}

/** Whether a credential type can be connected via the browser key-entry form. */
export function isKeyEntryConnectable(type: ExternalServiceType): boolean {
  return connectFormSpecForType(type) !== undefined;
}
