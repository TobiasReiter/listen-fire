// `@lf/slack`: Slack as a module. The host hands it the install's credential
// (a workspace bot token, the workspace id, optionally a base URL) and a
// fetch; the module builds the Web API client from them per call, so a
// credential edited between calls is read by the next one.
// `ctx.config.baseUrlOverride` (the dev loop's fake) wins over the
// credential's own base URL.
//
// Two things a module cannot do alone come from the host when it has them:
// the model the composition function (`SLACK_MESSAGE`) writes with, and the
// bytes of a `File` value another system owns. The platform builds its own
// definition with both (`slackModuleWith`); every other host runs
// `slackModule`, whose files come by URL or through `ctx.files` and which has
// no model.

import type { FileRef } from 'movement-engine/public/adapter';

import { defineModule, type AdapterModuleDefinition, type ModuleContext } from 'module-kit';

import { SlackAdapter, type SlackSources } from './adapter';
import { getSlackClient, slackCredsParser, type SlackAPIClient } from './api_client';
import { composeSlackMessage, type SlackComposeChat } from './compose';
import { SLACK_MANIFEST } from './manifest';

/** What a host may give the module beyond its context. */
export interface SlackHosted {
  /** The model the composition function writes with. */
  chat?: SlackComposeChat;
  /** The bytes of a `File` value (the platform redeems any owner's). */
  readFile?: (ref: FileRef, ctx: ModuleContext) => Promise<{ body: Buffer; contentType?: string }>;
}

/** A file's bytes with only the context: its URL through the host's fetch,
 *  else the host's files. */
async function readFileFromContext(ref: FileRef, ctx: ModuleContext): Promise<{ body: Buffer; contentType?: string }> {
  if (typeof ref.url === 'string') {
    const res = await ctx.fetch(ref.url);
    if (!res.ok) throw new Error(`Slack: fetching the file at its URL failed (status ${res.status}).`);
    const contentType = res.headers.get('content-type');
    return { body: Buffer.from(await res.arrayBuffer()), ...(contentType !== null ? { contentType } : {}) };
  }
  return { body: Buffer.from(await ctx.files.read(ref)) };
}

/** The adapter's sources over a module context. */
export function slackSourcesFrom(ctx: ModuleContext, hosted: SlackHosted = {}): SlackSources {
  const { chat } = hosted;
  const readFile = hosted.readFile ?? readFileFromContext;
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one parse serves until then.
  let last: { fields: unknown; client: SlackAPIClient | null } | undefined;
  return {
    client: async () => {
      let fields: unknown;
      try {
        fields = await ctx.credential.fields();
      } catch {
        // No credential reachable: the read paths that need Slack answer
        // nothing, and a send refuses by name.
        return null;
      }
      if (last?.fields === fields) return last.client;
      const parsed = slackCredsParser.safeParse(fields);
      const client = parsed.success ? getSlackClient(parsed.data.accessToken, ctx.config.baseUrlOverride ?? parsed.data.baseUrl) : null;
      last = { fields, client };
      return client;
    },
    missingClient: (op) => {
      const which = `no usable Slack credential for team ${ctx.config.tenant} (credentialsId=${ctx.config.credentialRef ?? 'unset'}).`;
      return op === 'streamSlackFileBytes' ? `slack.${op}: ${which}` : `SlackAdapter.${op}: ${which} Connect Slack.`;
    },
    tenant: ctx.config.tenant,
    ...(ctx.config.credentialRef !== undefined ? { credentialRef: ctx.config.credentialRef } : {}),
    log: ctx.log,
    fetch: ctx.fetch,
    readFile: (ref) => readFile(ref, ctx),
    compose: async (args) => {
      if (chat === undefined) {
        throw new Error(
          'SlackAdapter.invokeFieldFunction: composing a Slack message needs a model, ' +
            'and this host gives the Slack module none. Write the message text instead.',
        );
      }
      return composeSlackMessage(chat, args);
    },
  };
}

/** The module, over what `hosted` adds to each context. */
export function slackModuleWith(hosted: SlackHosted): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/slack',
    manifest: SLACK_MANIFEST,
    // The stored payload the platform's Slack installer writes (its own flow:
    // a signed state and comma-joined scopes, not the shared connect flow).
    // A bot token never expires, so the host has nothing to refresh.
    credentials: [
      {
        name: 'slack',
        kind: 'static',
        fields: [
          { name: 'accessToken', label: 'Bot token (xoxb-…)' },
          { name: 'teamId', label: 'Workspace id', secret: false, optional: true },
          { name: 'enterpriseId', label: 'Enterprise id', secret: false, optional: true },
          { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
        ],
      },
    ],
    // Slack signs every delivery with the app's signing secret (`v0`), and
    // its door answers the one-time `url_verification` challenge unsigned.
    // The same scheme and header the door has always read, so every
    // subscription's URL and Slack's signatures keep working.
    inbound: {
      providerKey: 'slack',
      scheme: 'slack_v0',
      signatureHeaders: ['x-slack-signature'],
      intercepts: ['slack_url_verification'],
    },
    create: (ctx) => new SlackAdapter(slackSourcesFrom(ctx, hosted)),
  });
}

export const slackModule = slackModuleWith({});

export default slackModule;

export * from './adapter';
export * from './api_client';
export * from './compose';
export * from './handbook_section';
export * from './history_window';
export * from './inbound';
export * from './manifest';
export * from './mentions';
export * from './read_graph';
export * from './types';
export * from './write';
