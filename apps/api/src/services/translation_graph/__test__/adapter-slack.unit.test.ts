/**
 * Unit tests for the Slack adapter (R4a).
 *
 * Covers the source-side surface the adapter exposes:
 *
 *   1. `listEntryPoints` / `describe` publish the `slack:message` /
 *      `slack:file` types with the documented scalar fields, and the
 *      domain `files` edge (the input-side `#resources` reference is gone).
 *   2. `getFieldValue` reads scalar fields off `external-record` and
 *      `webhook-event` positions whose `data` is a Slack event payload.
 *   3. Input content reaches the graph EXPLICITLY — the message body via the
 *      `Text` field and attachments via the `files` edge (one `slack:file`
 *      position per attachment, each readable via `getFieldValue`). The
 *      old input-side `#resources` projection is removed; a `#resources` hop
 *      off a source position no longer resolves (it's now extracted-node
 *      provenance only).
 *   4. `getRelated('files', …)` fans a message out into per-file positions.
 *   5. `writeResource` is intentionally undefined (Slack outbound doesn't
 *      map cleanly onto the resource-write contract — see commit msg).
 */

import { parseProgram, checkProgram, mockCatalog, type Catalog } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';

import {
  SlackAdapter,
  SLACK_ADAPTER_TYPE,
  SLACK_FILE_TYPE_ID,
  SLACK_MESSAGE_FILES_REFERENCE,
  SLACK_MESSAGE_FILES_REFERENCE_NAME,
  SLACK_MESSAGE_TYPE_ID,
  slackEventToDiscriminable,
} from '../adapters/slack';
import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, makeUnstablePosition } from 'movement-engine/services/translation_graph/types';
import { parseSlackEvents } from '../../webhook_sync/providers/slack';
import { webhookEventToDiscriminable } from '../../webhook_sync/event_conversion';
import { discriminateEvent } from 'movement-engine/services/translation_graph/engine/inbound/discriminate';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';

const TEAM_ID = 'team-1' as TeamId;

function makeAdapter(): SlackAdapter {
  return new SlackAdapter(TEAM_ID);
}

function makeMessagePosition(data: Record<string, unknown>): SourcePosition {
  return makeStablePosition({
    adapterType: SLACK_ADAPTER_TYPE,
    recordId: (data.ts as string) ?? 'no-ts',
    // The source-read wrapper stamps the NATURAL type name (the entry's
    // displayName) onto a read position; field resolution keys off it.
    recordType: 'Message',
    data,
  });
}

describe('SlackAdapter — schema introspection', () => {
  it('listEntryPoints: the fires edge lands ON the message; messages/files are reached, not root-read', async () => {
    const adapter = makeAdapter();
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual([
      SLACK_MESSAGE_TYPE_ID,
      SLACK_FILE_TYPE_ID,
      'slack:reaction',
      'slack:channel',
      'slack:user',
    ]);
    // Root-READABLE is only what the root can genuinely enumerate: channels
    // and users (the read graph). A reaction is NOT enumerable workspace-wide
    // — it is an inbound event, reached only by arriving (its fires edge) or
    // by walking a message — so it dropped off the readable roots.
    // plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    const readable = entries.filter((e) => e.readable);
    expect(readable.map((e) => e.typeId)).toEqual([
      'slack:channel',
      'slack:user',
    ]);
    // A message ARRIVES (the fires edge) or is reached (channel history / a
    // reaction's `message` edge), never listed from the root; same for files
    // (a message's `files` edge). A fires edge is reachability, not a root
    // read.
    const message = entries.find((e) => e.typeId === SLACK_MESSAGE_TYPE_ID);
    expect(message?.readable).toBe(false);
    expect(message?.writable).toBe(false);
    const file = entries.find((e) => e.typeId === SLACK_FILE_TYPE_ID);
    expect(file?.readable).toBe(false);
    // A reaction is an event: reached only by arriving or via a message's
    // edge — neither a readable root nor a writable one.
    const reaction = entries.find((e) => e.typeId === 'slack:reaction');
    expect(reaction?.readable).toBe(false);
    expect(reaction?.writable).toBe(false);
  });

  it('Reaction is an inbound event — fires on `reaction_added`, like Message and the WhatsApp Reaction', async () => {
    const adapter = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const reaction = entries.find((e) => e.typeId === 'slack:reaction');
    expect(reaction).toBeDefined();
    expect(reaction?.displayName).toBe('Reaction');
    expect(reaction?.fires).toBe(true);
    // `reaction_added` selects this edge — a DIFFERENT event kind from the
    // message's `message` / `app_mention`, so a reaction never
    // mis-discriminates as a message.
    expect(reaction?.firesOn).toEqual(['reaction_added']);
  });

  it('the fires edge lands straight on Message — no field-less event node (rule 1)', async () => {
    const adapter = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const message = entries.find((e) => e.typeId === SLACK_MESSAGE_TYPE_ID);
    expect(message).toBeDefined();
    expect(message?.displayName).toBe('Message');
    expect(message?.fires).toBe(true);
    // `message` + `app_mention` select this edge; `reaction_added` is a
    // DIFFERENT event kind and deliberately not on it.
    expect(message?.firesOn).toEqual(['message', 'app_mention']);
    // The retired indirection stays retired: nothing describes it.
    expect(await adapter.describe('Message Received')).toBeNull();
  });

  it('describe(slack:message) returns the unified fields (writable Message + File + Blocks, read-only scalars, no Thread Timestamp)', async () => {
    const adapter = makeAdapter();
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    expect(desc).not.toBeNull();
    const byId = new Map(desc!.fields.map((f) => [f.fieldId, f]));
    expect([...byId.keys()].sort()).toEqual(['blocks', 'channel', 'file', 'text', 'ts', 'user']);
    expect(byId.get('text')!.writable).toBe(true);
    expect(byId.get('file')!.writable).toBe(true);
    expect(byId.get('file')!.kind).toBe('file');
    expect(byId.get('blocks')!.writable).toBe(true);
    expect(byId.get('blocks')!.kind).toBe('json');
    for (const id of ['channel', 'ts', 'user']) {
      expect(byId.get(id)!.writable).toBe(false);
    }
  });

  it('describe(slack:message) publishes only the files reference (no input-side #resources)', async () => {
    // G1 Gap D-1: the composition materialiser walks `getRelated('files', …)`;
    // without this reference the walk returns empty and file propagation
    // through composition is broken at the materialiser.
    //
    // The input-side `#resources` reference is GONE: source content is read
    // explicitly (message body via `Text`, attachments via the `files` edge).
    // `#resources` is now extracted-node provenance only — not reachable off
    // an input/source position — so it must NOT appear in describe().
    const adapter = makeAdapter();
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    expect(desc).not.toBeNull();
    // Domain edges only (`files`, plus the read graph's `replies`/`author`/
    // `channel`) — no system `#resources` reference.
    expect(desc!.references.map((r) => r.name)).toEqual([
      'Files',
      'Replies',
      'Reactions',
      'Author',
      'Channel',
    ]);
    expect(desc!.references[0]).toMatchObject({
      fieldId: SLACK_MESSAGE_FILES_REFERENCE,
      targetTypeId: SLACK_FILE_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: 'Files',
    });
    expect(desc!.references.map((r) => r.fieldId)).not.toContain(RESOURCES_REFERENCE_FIELD_ID);
  });

  it('describe(slack:file) describes the file record with a binary-handle data field', async () => {
    const adapter = makeAdapter();
    const desc = await adapter.describe(SLACK_FILE_TYPE_ID);
    expect(desc).not.toBeNull();
    const fieldIds = desc!.fields.map((f) => f.fieldId).sort();
    expect(fieldIds).toEqual(['contentType', 'data', 'id', 'name', 'size', 'url']);
    const dataField = desc!.fields.find((f) => f.fieldId === 'data');
    // Mirror the email adapter: E5 (wave-2) widened SchemaFieldKind to
    // include `'file'` distinctly so the field-mapping editor can route
    // File-typed expressions only into File-typed target fields.
    expect(dataField!.kind).toBe('file');
    expect(desc!.references).toEqual([]);
  });

  it('walks slack:message -[:files]-> slack:file via the descriptor to file positions', async () => {
    // The descriptor declares the `files` edge to `slack:file`; the same
    // attachments surface as `slack:file` positions via `getRelated`. This
    // test exercises the introspection-surface walk end-to-end: follow the
    // declared reference, dereference its target type's descriptor, then walk
    // the edge and confirm the descriptor-declared shape lines up with the
    // positions `getRelated` actually emits — and that field reads off those
    // positions are lossless.
    const adapter = makeAdapter();
    const position = makeMessagePosition({
      text: 'see attached',
      ts: '1700000000.123',
      channel: 'C999',
      files: [
        {
          id: 'F100',
          name: 'briefing.pdf',
          mimetype: 'application/pdf',
          url_private_download: 'https://files.slack.com/files-pri-d/F100/briefing.pdf',
          size: 4096,
        },
        {
          id: 'F101',
          title: 'spreadsheet.csv',
          mimetype: 'text/csv',
          url_private: 'https://files.slack.com/files-pri/F101/spreadsheet.csv',
        },
      ],
    });

    // 1. Discover the edge from slack:message's descriptor.
    const messageDesc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    const filesRef = messageDesc!.references.find((r) => r.fieldId === SLACK_MESSAGE_FILES_REFERENCE);
    expect(filesRef).toBeDefined();

    // 2. Resolve the edge's target type via the same introspection surface.
    const fileDesc = await adapter.describe(filesRef!.targetTypeId);
    expect(fileDesc).not.toBeNull();
    expect(fileDesc!.typeId).toBe(SLACK_FILE_TYPE_ID);
    const fileFieldIds = fileDesc!.fields.map((f) => f.fieldId);
    expect(fileFieldIds).toEqual(expect.arrayContaining(['name', 'contentType', 'url', 'size', 'data']));

    // 3. Walk the `files` edge: one slack:file position per attachment, with
    //    the descriptor-declared field surfaces readable via getFieldValue.
    //    This proves the explicit file path is lossless — the content the
    //    removed input-side `#resources` projection used to carry now reaches
    //    the graph through the regular `files` edge + per-file field reads.
    const related = await adapter.getRelated({
      position,
      fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);
    const fileIds = related.map(
      (r) => (r.position.identity as { data: { id: string } }).data.id,
    );
    expect(fileIds).toEqual(['F100', 'F101']);

    // Read descriptor-declared fields off the resulting file positions.
    const [first, second] = related;
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'Name' })).toBe(
      'briefing.pdf',
    );
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'Content Type' })).toBe(
      'application/pdf',
    );
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'URL' })).toBe(
      'https://files.slack.com/files-pri-d/F100/briefing.pdf',
    );
    // Second file: title-fallback for name, url_private fallback for url.
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'Name' })).toBe(
      'spreadsheet.csv',
    );
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'Content Type' })).toBe(
      'text/csv',
    );
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'URL' })).toBe(
      'https://files.slack.com/files-pri/F101/spreadsheet.csv',
    );
  });

  it('describe returns null for unknown type ids', async () => {
    const adapter = makeAdapter();
    expect(await adapter.describe('slack:not-a-type')).toBeNull();
  });
});

describe('SlackAdapter — getRelated("Replies", …), the bare-read side of the readable+awaitable edge', () => {
  function adapterWithReplies(replies: jest.Mock): SlackAdapter {
    const adapter = makeAdapter();
    (
      adapter as unknown as { requireSlackApiClient: (ctx: string) => Promise<unknown> }
    ).requireSlackApiClient = async () => ({ api: { conversations: { replies } } });
    return adapter;
  }

  it('follows response_metadata.next_cursor across a two-page thread, excluding the root', async () => {
    const rootTs = '1700000000.000000';
    const replies = jest.fn(async (args: { cursor?: string }) => {
      if (!args.cursor) {
        return {
          messages: [
            { ts: rootTs, text: 'root', user: 'U1' },
            { ts: '1700000000.000100', text: 'first reply', user: 'U2' },
          ],
          response_metadata: { next_cursor: 'page-2' },
        };
      }
      expect(args.cursor).toBe('page-2');
      return {
        messages: [{ ts: '1700000000.000200', text: 'second reply', user: 'U3' }],
        response_metadata: { next_cursor: '' },
      };
    });
    const adapter = adapterWithReplies(replies);
    const position = makeMessagePosition({ channel: 'C123', ts: rootTs });

    const related = await adapter.getRelated({ position, fieldId: 'Replies', direction: 'outgoing' });

    expect(replies).toHaveBeenCalledTimes(2);
    const bodies = await Promise.all(
      related.map((r) => adapter.getFieldValue({ position: r.position, fieldId: 'Message' })),
    );
    expect(bodies).toEqual(['first reply', 'second reply']);
    // Every landing carries the channel injected (root data doesn't carry it),
    // so onward hops (Channel, Author) resolve off the position.
    for (const r of related) {
      expect(await adapter.getFieldValue({ position: r.position, fieldId: 'Channel' })).toBe('C123');
    }
  });

  it('a thread root under thread_ts (this position is itself a reply) correlates on the thread root, not its own ts', async () => {
    const replies = jest.fn(async (args: { ts: string }) => {
      expect(args.ts).toBe('1700000000.000000');
      return {
        messages: [
          { ts: '1700000000.000000', text: 'root' },
          { ts: '1700000000.000050', text: 'a reply' },
        ],
        response_metadata: {},
      };
    });
    const adapter = adapterWithReplies(replies);
    const position = makeMessagePosition({
      channel: 'C1',
      ts: '1700000000.000050',
      thread_ts: '1700000000.000000',
    });
    const related = await adapter.getRelated({ position, fieldId: 'Replies', direction: 'outgoing' });
    expect(related).toHaveLength(1);
  });
});

describe('SlackAdapter — getFieldValue', () => {
  it('reads scalar fields off an external-record position', async () => {
    const adapter = makeAdapter();
    const position = makeMessagePosition({
      text: 'Alice met Bob',
      user: 'U123',
      channel: 'C456',
      ts: '1700000000.000001',
      thread_ts: '1700000000.000000',
    });
    expect(await adapter.getFieldValue({ position, fieldId: 'Message' })).toBe('Alice met Bob');
    expect(await adapter.getFieldValue({ position, fieldId: 'User' })).toBe('U123');
    expect(await adapter.getFieldValue({ position, fieldId: 'Channel' })).toBe('C456');
    expect(await adapter.getFieldValue({ position, fieldId: 'Timestamp' })).toBe('2023-11-14T22:13:20.000Z');
  });

  it('throws drift for unknown field ids', async () => {
    const adapter = makeAdapter();
    const position = makeMessagePosition({ text: 'hi', ts: '1' });
    // A field the descriptor doesn't publish is drift under the natural-name
    // contract — it fails loud rather than returning a spurious null.
    await expect(adapter.getFieldValue({ position, fieldId: 'nope' })).rejects.toThrow(
      /not a known field of 'Message'/,
    );
  });

  it('throws when the position is from another adapter', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.getFieldValue({
        position: makeStablePosition({
          adapterType: 'attio',
          recordId: 'r1',
          recordType: 'attio:companies',
          data: {},
        }),
        fieldId: 'text',
      }),
    ).rejects.toThrow(/different adapter/);
  });
});

// ── Input content reaches the graph explicitly, not via `#resources` ──────
//
// The input-side `#resources` projection (a TEXT body resource + per-file
// FILE resources resolved off a source/input position) has been REMOVED.
// `#resources` is now extracted-node provenance ONLY — a `#resources` hop off
// an input/source position no longer resolves. The same content is still
// exposed losslessly and explicitly:
//   • message body via the `Text` field (getFieldValue on a message position)
//   • files via the `files` edge (getRelated → one slack:file position per
//     attachment), each readable via getFieldValue.
describe('SlackAdapter — input content surfaces (explicit Text + files)', () => {
  it('a `#resources` hop off a slack:message position no longer resolves (drift)', async () => {
    // The describe() reference was removed, so resolving the natural edge name
    // `#resources` against the slack:message type is drift — it fails loud
    // rather than silently projecting the old input-side resources.
    const adapter = makeAdapter();
    const position = makeMessagePosition({
      text: 'Alice met Bob',
      ts: '1700000000.000001',
      channel: 'C456',
    });
    await expect(
      adapter.getRelated({
        position,
        fieldId: RESOURCES_REFERENCE_FIELD_ID,
        direction: 'outgoing',
      }),
    ).rejects.toThrow(/drift/);
  });

  it('exposes the message body via the `Message` field', async () => {
    const adapter = makeAdapter();
    const position = makeMessagePosition({
      text: 'Alice met Bob at the conference.',
      user: 'U123',
      channel: 'C456',
      ts: '1700000000.000001',
    });
    expect(await adapter.getFieldValue({ position, fieldId: 'Message' })).toBe(
      'Alice met Bob at the conference.',
    );
  });

  it('exposes attachments via the `files` edge — one slack:file position per file, each readable', async () => {
    const adapter = makeAdapter();
    const position = makeMessagePosition({
      text: 'see attached',
      ts: '1700000000.000002',
      channel: 'C456',
      files: [
        {
          id: 'F001',
          name: 'briefing.pdf',
          mimetype: 'application/pdf',
          url_private_download: 'https://files.slack.com/files-pri-d/F001/briefing.pdf',
          url_private: 'https://files.slack.com/files-pri/F001/briefing.pdf',
          size: 12345,
        },
        {
          id: 'F002',
          title: 'spreadsheet.csv',
          mimetype: 'text/csv',
          url_private: 'https://files.slack.com/files-pri/F002/spreadsheet.csv',
        },
      ],
    });

    const related = await adapter.getRelated({
      position,
      fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);

    const [first, second] = related;
    // First file: descriptor fields read losslessly off the file position.
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'File Id' })).toBe('F001');
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'Name' })).toBe('briefing.pdf');
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'Content Type' })).toBe(
      'application/pdf',
    );
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'URL' })).toBe(
      'https://files.slack.com/files-pri-d/F001/briefing.pdf',
    );
    expect(await adapter.getFieldValue({ position: first.position, fieldId: 'Size' })).toBe(12345);

    // Second file: title-fallback for name, url_private fallback for url.
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'Name' })).toBe('spreadsheet.csv');
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'Content Type' })).toBe('text/csv');
    expect(await adapter.getFieldValue({ position: second.position, fieldId: 'URL' })).toBe(
      'https://files.slack.com/files-pri/F002/spreadsheet.csv',
    );
  });
});

describe('SlackAdapter — capabilities', () => {
  it('declares resources: false — the input-side #resources bundle is retired', () => {
    const adapter = makeAdapter();
    expect(adapter.runtimeCapabilities().resources).toBe(false);
  });

  it('declares webhook as a supported trigger', () => {
    const adapter = makeAdapter();
    expect(adapter.supportedTriggers).toContain('webhook');
  });
});

// ── R12: webhook-event position support ─────────────────────────────────
//
// I1's production webhook bridge constructs `webhook-event`-kind
// SourcePositions (matching the Attio precedent), and R6's composition
// materialiser seeds the root from the trigger event as a
// `webhook-event` position. R4a's adapter shipped accepting only
// `external-record`; G1-v3 surfaced the gap (Gap F). These tests cover
// the symmetric webhook-event arms on `getFieldValue` / `getResources`,
// plus the new `getRelated('files', …)` fan-out the materialiser needs
// to walk the `slack:message -[:files]-> slack:file` edge R10 added.

/**
 * A webhook-event seed as the engine actually mints one: unstable (no external
 * id) but CARRYING ITS TYPE. It used to be minted `recordType: null` here,
 * which stopped being what the seed does — `discriminateEvent` stamps the
 * event's `positionType`, and the engine prefers the program's declared natural
 * type name. A fixture that mints something no producer produces tests a shape
 * that cannot occur, and hides the behaviour of the one that can.
 *
 * The NATURAL name, not the type id: field and edge resolution key off the
 * entry's `displayName`, which is what the engine's `surfaceType` carries.
 */
function makeWebhookEventPosition(data: Record<string, unknown>): SourcePosition {
  return makeUnstablePosition({
    adapterType: SLACK_ADAPTER_TYPE,
    recordType: 'Message',
    data,
  });
}

describe('SlackAdapter — webhook-event positions', () => {
  describe('getFieldValue', () => {
    it('reads scalar fields off a webhook-event position', async () => {
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({
        text: 'Alice met Bob',
        user: 'U123',
        channel: 'C456',
        ts: '1700000000.000001',
        thread_ts: '1700000000.000000',
      });
      expect(await adapter.getFieldValue({ position, fieldId: 'Message' })).toBe('Alice met Bob');
      expect(await adapter.getFieldValue({ position, fieldId: 'User' })).toBe('U123');
      expect(await adapter.getFieldValue({ position, fieldId: 'Channel' })).toBe('C456');
      expect(await adapter.getFieldValue({ position, fieldId: 'Timestamp' })).toBe('2023-11-14T22:13:20.000Z');
    });

    it('throws drift for unknown field ids on a webhook-event position', async () => {
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({ text: 'hi', ts: '1' });
      // The typeless webhook seed still resolves field names against the
      // slack:message descriptor — an unpublished field is drift.
      await expect(adapter.getFieldValue({ position, fieldId: 'nope' })).rejects.toThrow(
        /not a known field of 'Message'/,
      );
    });

    it('reads fields off a TYPELESS position — the resolver must still be fed', async () => {
      // The engine's seed mints `recordType: null` when neither `surfaceType`
      // nor `rootRecordType` is known (`run.ts` — typeless-at-seed is a
      // documented intermediate state), and this method handles that: it
      // sniffs the payload for a file record and otherwise falls through to
      // the message type.
      //
      // Scoping the resolver to the position's own type broke exactly that
      // case — `types: []` describes NOTHING, so the fall-through then failed
      // to resolve its own field and reported `'Message' is not a known field
      // of 'Message'`: an empty resolver wearing schema drift's clothes.
      // Whatever a branch can select WITHOUT being told, this must describe.
      const adapter = makeAdapter();
      const typeless = makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: null,
        data: { text: 'Alice met Bob', user: 'U123', ts: '1700000000.000001' },
      });
      expect(await adapter.getFieldValue({ position: typeless, fieldId: 'Message' })).toBe(
        'Alice met Bob',
      );
      // And the payload-sniffed file branch, the other thing typeless selects.
      const typelessFile = makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: null,
        data: { id: 'F1', name: 'x.pdf', contentType: 'application/pdf', url: 'https://x', size: 1, data: null },
      });
      expect(await adapter.getFieldValue({ position: typelessFile, fieldId: 'Name' })).toBe('x.pdf');
    });

    it('rejects webhook-event positions from a different adapter', async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.getFieldValue({
          position: makeUnstablePosition({ adapterType: 'attio', recordType: null, data: { text: 'x' } }),
          fieldId: 'text',
        }),
      ).rejects.toThrow(/different adapter/);
    });
  });

  describe('getRelated("files", …)', () => {
    it('fans a webhook-event message position out into one webhook-event slack:file position per attachment', async () => {
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({
        text: 'see attached',
        ts: '1700000000.000002',
        channel: 'C456',
        files: [
          {
            id: 'F100',
            name: 'briefing.pdf',
            mimetype: 'application/pdf',
            url_private_download: 'https://files.slack.com/files-pri-d/F100/briefing.pdf',
            size: 4096,
          },
          {
            id: 'F101',
            title: 'spreadsheet.csv',
            mimetype: 'text/csv',
            url_private: 'https://files.slack.com/files-pri/F101/spreadsheet.csv',
          },
        ],
      });

      const related = await adapter.getRelated({
        position,
        fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
        direction: 'outgoing',
      });

      expect(related).toHaveLength(2);
      // Each yielded position is webhook-event-kind, carries the
      // normalised SlackFileRecord shape (name/contentType/url/size/data),
      // and points back to the slack adapter so downstream reads route
      // here.
      //
      // NAMED `File`, not typeless. These were minted with a null recordType,
      // which forced `getFieldValue` to re-derive the type by SNIFFING the
      // payload shape — a guess that happened to be right. The minter knows
      // what it is making; nothing downstream can.
      expect(related[0].position).toEqual(makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: 'File',
        data: {
          id: 'F100',
          name: 'briefing.pdf',
          contentType: 'application/pdf',
          url: 'https://files.slack.com/files-pri-d/F100/briefing.pdf',
          size: 4096,
          data: null,
        },
      }));
      // Second file: title-fallback for name, url_private fallback for
      // url, no size.
      expect(related[1].position).toEqual(makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: 'File',
        data: {
          id: 'F101',
          name: 'spreadsheet.csv',
          contentType: 'text/csv',
          url: 'https://files.slack.com/files-pri/F101/spreadsheet.csv',
          size: null,
          data: null,
        },
      }));
    });

    it('also fans out from external-record message positions (R4a position kind retained)', async () => {
      const adapter = makeAdapter();
      const position = makeMessagePosition({
        ts: '1',
        files: [{ id: 'F1', name: 'x.pdf', mimetype: 'application/pdf', url_private: 'u' }],
      });
      const related = await adapter.getRelated({
        position,
        fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
        direction: 'outgoing',
      });
      expect(related).toHaveLength(1);
      expect(related[0].position.identity.kind).toBe('unstable');
    });

    it('skips files without an id (parallels getResources behaviour)', async () => {
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({
        ts: '1',
        files: [
          { name: 'no-id.pdf', mimetype: 'application/pdf' },
          { id: 'F004', name: 'has-id.pdf', mimetype: 'application/pdf' },
        ],
      });
      const related = await adapter.getRelated({
        position,
        fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
        direction: 'outgoing',
      });
      expect(related).toHaveLength(1);
      expect((related[0].position.identity as { data: { id: string } }).data.id).toBe('F004');
    });

    it('returns empty for a message position with no files', async () => {
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({ text: 'hi', ts: '1' });
      const related = await adapter.getRelated({
        position,
        fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
        direction: 'outgoing',
      });
      expect(related).toEqual([]);
    });

    it('an unknown edge id is DRIFT, not a silent empty', async () => {
      // This asserted a "clean no-op, like Attio" — an unknown edge returning
      // `[]`. That is the silent-degradation shape: a walk down an edge that
      // does not exist reads as "nothing there", which is indistinguishable
      // from a real empty and hides a renamed or removed edge until someone
      // wonders why a movement stopped doing anything. Decision #4 made a miss
      // throw; the test kept asserting the old silence.
      const adapter = makeAdapter();
      const position = makeWebhookEventPosition({
        ts: '1',
        files: [{ id: 'F1', name: 'x.pdf' }],
      });
      await expect(
        adapter.getRelated({ position, fieldId: 'not-an-edge', direction: 'outgoing' }),
      ).rejects.toThrow(/'not-an-edge' is not a known edge of 'Message'/);
    });

    it('returns empty when walked from a slack:file position (no outbound edges)', async () => {
      const adapter = makeAdapter();
      const filePosition: SourcePosition = makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: null,
        data: {
          id: 'F1',
          name: 'x.pdf',
          contentType: 'application/pdf',
          url: 'u',
          size: null,
          data: null,
        },
      });
      const related = await adapter.getRelated({
        position: filePosition,
        fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
        direction: 'outgoing',
      });
      expect(related).toEqual([]);
    });

    it('rejects incoming traversal', async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.getRelated({
          position: makeWebhookEventPosition({ ts: '1', files: [] }),
          fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
          direction: 'incoming',
        }),
      ).rejects.toThrow(/only supports outgoing/);
    });

    it('rejects positions from a different adapter', async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.getRelated({
          position: makeUnstablePosition({ adapterType: 'attio', recordType: null, data: {} }),
          fieldId: SLACK_MESSAGE_FILES_REFERENCE_NAME,
          direction: 'outgoing',
        }),
      ).rejects.toThrow(/different adapter/);
    });
  });

  describe('slack:file positions (returned by getRelated)', () => {
    const fileRecord = {
      id: 'F100',
      name: 'briefing.pdf',
      contentType: 'application/pdf',
      url: 'https://files.slack.com/files-pri-d/F100/briefing.pdf',
      size: 4096,
      data: null,
    };

    it('getFieldValue reads slack:file descriptor fields off a webhook-event file position', async () => {
      const adapter = makeAdapter();
      const position: SourcePosition = makeUnstablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordType: null,
        data: fileRecord,
      });
      expect(await adapter.getFieldValue({ position, fieldId: 'File Id' })).toBe('F100');
      expect(await adapter.getFieldValue({ position, fieldId: 'Name' })).toBe('briefing.pdf');
      expect(await adapter.getFieldValue({ position, fieldId: 'Content Type' })).toBe('application/pdf');
      expect(await adapter.getFieldValue({ position, fieldId: 'URL' })).toBe(fileRecord.url);
      expect(await adapter.getFieldValue({ position, fieldId: 'Size' })).toBe(4096);
      // The `File` field is the binary primitive — a FileRef descriptor naming
      // this instance and the raw Slack file id as its handle, so file bytes
      // reach extraction / carry-forward via `files->.File`. This is the
      // lossless replacement for the retired input-side `_resources`.
      const file = await adapter.getFieldValue({ position, fieldId: 'File' });
      expect(file).toMatchObject({
        __brand: 'FileRef',
        name: 'briefing.pdf',
        contentType: 'application/pdf',
        size: 4096,
        source: { adapterType: SLACK_ADAPTER_TYPE, handle: 'F100' },
      });
    });

    it('getFieldValue reads slack:file fields off an external-record file position', async () => {
      const adapter = makeAdapter();
      const position: SourcePosition = makeStablePosition({
        adapterType: SLACK_ADAPTER_TYPE,
        recordId: 'F100',
        recordType: SLACK_FILE_TYPE_ID,
        data: fileRecord,
      });
      expect(await adapter.getFieldValue({ position, fieldId: 'Name' })).toBe('briefing.pdf');
      expect(await adapter.getFieldValue({ position, fieldId: 'Content Type' })).toBe('application/pdf');
      // The `File` field yields a working FileRef (lossless file-bytes path).
      const file = await adapter.getFieldValue({ position, fieldId: 'File' });
      expect(file).toMatchObject({ __brand: 'FileRef', source: { handle: 'F100' } });
    });
  });
});

describe('SlackAdapter — channel listing resilience (the prod "no channels" class)', () => {
  const platformError = (error: string) =>
    Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error } });

  function adapterWithList(list: jest.Mock) {
    const adapter = makeAdapter() as unknown as {
      requireSlackApiClient: (ctx: string) => Promise<unknown>;
      getSlackApiClient: () => Promise<unknown>;
      listChannelPositions: () => Promise<Array<{ position: { identity: { recordId?: string } } }>>;
      withLiveChannelKnownValues: (d: unknown) => Promise<{ fields: Array<{ fieldId: string; description?: string }> }>;
    };
    const client = { api: { conversations: { list } } };
    adapter.requireSlackApiClient = async () => client;
    adapter.getSlackApiClient = async () => client;
    return adapter;
  }

  it('falls back to public channels when groups:read is missing — partial beats empty', async () => {
    const list = jest.fn(async (args: { types?: string }) => {
      if (args.types?.includes('private_channel')) throw platformError('missing_scope');
      return { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }] };
    });
    const adapter = adapterWithList(list);
    const results = await adapter.listChannelPositions();
    expect(results).toHaveLength(1);
    // The private-inclusive attempt happened AND the public-only retry — the
    // resolver's describe pass lists too (same resilient path), so assert on
    // the argument shapes rather than a brittle call count.
    const typesSeen = list.mock.calls.map((c: [{ types?: string }]) => c[0]?.types);
    expect(typesSeen).toContain('public_channel,private_channel');
    expect(typesSeen).toContain('public_channel');
  });

  it('a listing that fails outright names the cause and the fix — never a silent empty', async () => {
    const list = jest.fn(async () => {
      throw platformError('missing_scope');
    });
    const adapter = adapterWithList(list);
    await expect(adapter.listChannelPositions()).rejects.toThrow(/missing_scope.*reconnect Slack/s);
  });

  it('a successful listing rides as OPEN known-values on the Channel `Name` field (no id pattern)', async () => {
    const list = jest.fn(async () => ({
      ok: true,
      channels: [
        { id: 'C1', name: 'general', is_private: false },
        { id: 'C2', name: 'dealflow', is_private: false },
      ],
    }));
    const adapter = adapterWithList(list);
    const descriptor = {
      typeId: 'slack:channel',
      displayName: 'Channel',
      fields: [{ fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true, description: 'The channel name.' }],
      references: [],
    };
    const out = await adapter.withLiveChannelKnownValues(descriptor);
    const name = out.fields.find((f) => f.fieldId === 'name') as {
      knownValues?: string[];
      knownValuePattern?: string;
      description?: string;
    };
    expect(name.knownValues).toEqual(['dealflow', 'general']);
    // No id pattern: an id-shaped literal in a Name equality SHOULD warn.
    expect(name.knownValuePattern).toBeUndefined();
    expect(name.description).toContain('2 channels');
  });

  it('the Name description NEVER enumerates the channels — the list is knownValues', async () => {
    // It used to inline the first 50 names, sorted, into the description. On a
    // real workspace that reads as the authoritative list while stopping partway
    // through the alphabet, so an agent grounding on the prose calls every
    // channel past the cut UNKNOWN — reported live against `hjjs-action-items`
    // and `test-inbound-slack`, both real. The complete list was in
    // `knownValues` the whole time; the prose was a truncated second copy.
    //
    // A copy that can be truncated is a copy that will be believed. There is
    // one list now, and the prose points at it.
    const list = jest.fn(async () => ({
      ok: true,
      channels: Array.from({ length: 120 }, (_, i) => ({
        id: `C${i}`,
        name: `ch-${String(i).padStart(3, '0')}`,
        is_private: false,
      })),
    }));
    const adapter = adapterWithList(list);
    const descriptor = {
      typeId: 'slack:channel',
      displayName: 'Channel',
      fields: [{ fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true, description: 'The channel name.' }],
      references: [],
    };
    const out = await adapter.withLiveChannelKnownValues(descriptor);
    const name = out.fields.find((f) => f.fieldId === 'name') as {
      knownValues?: string[];
      description?: string;
    };
    // Every channel is offered…
    expect(name.knownValues).toHaveLength(120);
    expect(name.knownValues).toContain('ch-119');
    // …and the prose names NONE of them, so it cannot be read as a short list.
    expect(name.description).not.toContain('ch-000');
    expect(name.description).not.toContain('ch-119');
    expect(name.description).not.toMatch(/more\)/);
    // It says how many there are, which is cheap and cannot go stale mid-list.
    expect(name.description).toContain('120 channels');
  });

  it('withLiveChannelKnownValues reports the failure in the Name description instead of swallowing it', async () => {
    const list = jest.fn(async () => {
      throw platformError('invalid_auth');
    });
    const adapter = adapterWithList(list);
    const descriptor = {
      typeId: 'slack:channel',
      displayName: 'Channel',
      fields: [{ fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true, description: 'The channel name.' }],
      references: [],
    };
    const out = await adapter.withLiveChannelKnownValues(descriptor);
    const name = out.fields.find((f) => f.fieldId === 'name');
    expect(name?.description).toContain('Channel listing unavailable (invalid_auth)');
    expect(name?.description).toContain('reconnect Slack');
  });
});

// ── Inbound parse → discriminate contract (pins the ff2bc7432 fix) ────────
//
// `parseSlackEvents` forwards the INNER `event_callback.event` object as
// `WebhookEvent.rawPayload` (see the provider's module comment) — not the
// envelope it arrived in. `webhookEventToDiscriminable` carries `rawPayload`
// through verbatim as the `DiscriminableEvent.payload`, and `listEventTypes`
// matches on `payload.type` (the inner event's `type`, e.g. `'message'`).
// If any of those three ever forwarded the envelope instead, `payload.type`
// would read `'event_callback'` and discrimination would silently fail —
// which is exactly the class of bug ff2bc7432 fixed (no event type meant no
// stable position, so a reply write off the inbound message errored with
// "carries no durable record id"). This test drives a realistic envelope
// through the REAL parse → convert → discriminate pipeline the dispatch path
// runs, and a second case demonstrates the failure mode directly: asserting
// the same discrimination against the raw ENVELOPE (rather than the inner
// event) as payload, which must NOT match.
describe('SlackAdapter.listEventTypes — inbound parse→discriminate contract', () => {
  const inboundEnvelope = {
    type: 'event_callback',
    event_id: 'Ev0PARSE1',
    event_time: 1700000000,
    team_id: 'T0TEAM1',
    api_app_id: 'A0APP1',
    event: {
      type: 'message',
      user: 'U123',
      channel: 'C456',
      ts: '1700000000.000100',
      event_ts: '1700000000.000100',
      text: 'Alice met Bob',
    },
  };

  it('a real inbound event_callback delivery discriminates to the Message position type', async () => {
    const adapter = new SlackAdapter(TEAM_ID);

    // The exact machinery the dispatch path runs: pure parse, then the
    // shared WebhookEvent → DiscriminableEvent conversion.
    const parsed = parseSlackEvents(inboundEnvelope);
    expect(parsed).toHaveLength(1);
    const discriminable = webhookEventToDiscriminable(parsed[0]);

    const eventTypes = await adapter.listEventTypes();
    const result = discriminateEvent({
      adapterType: SLACK_ADAPTER_TYPE,
      event: discriminable,
      eventTypes,
    });

    expect(result?.eventType.positionType).toBe(SLACK_MESSAGE_TYPE_ID);
    expect(result?.position.recordType).toBe(SLACK_MESSAGE_TYPE_ID);
    expect(result?.position.identity).toMatchObject({ kind: 'stable', recordId: '1700000000.000100' });
  });

  it('fails to discriminate if the ENVELOPE (not the inner event) were forwarded as the payload', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const eventTypes = await adapter.listEventTypes();

    // Simulates the pre-fix / regressed shape: a discriminable event whose
    // payload is the whole envelope rather than `envelope.event`. The
    // envelope's own `type` is `'event_callback'`, which matches none of
    // the declared event types, so discrimination must come back null —
    // proving the pin actually depends on the inner-event payload, not
    // just on "some payload" being present.
    const envelopeAsPayload = {
      payload: inboundEnvelope,
      externalId: inboundEnvelope.event.ts,
    };
    const result = discriminateEvent({
      adapterType: SLACK_ADAPTER_TYPE,
      event: envelopeAsPayload,
      eventTypes,
    });

    expect(result).toBeNull();
  });
});

// Rule 1's collapse: the fires edge lands STRAIGHT on the message — a listen
// delivers the message itself (the engine seeds it stable on its ts), so
// there is no event node and no `record` hop.
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md + adapters/CLAUDE.md
describe('SlackAdapter — the record-edge indirection is GONE', () => {
  const messageEvent = {
    type: 'message',
    text: 'hello there',
    user: 'U123',
    channel: 'C002',
    ts: '1700000000.777',
  };

  it('the SEED reads directly — Message/Channel/Timestamp off the delivered position', async () => {
    const adapter = makeAdapter();
    // What the engine seeds after the collapse: the message itself, stable on
    // the bare ts (so `replyAnchorFromParent` reads channel off data exactly
    // as it did off the retired record-edge mint).
    const seed = makeMessagePosition(messageEvent);
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'Message' })).toBe(
      'hello there',
    );
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'Channel' })).toBe('C002');
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'Timestamp' })).toBe(
      '2023-11-14T22:13:20.777Z',
    );
  });

  it('a `record` hop off a message is DRIFT — the edge died with the event node', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.getRelated({
        position: makeMessagePosition(messageEvent),
        fieldId: 'record',
        direction: 'outgoing',
      }),
    ).rejects.toThrow(/not a known edge/);
  });
});

// The one WebhookEvent→DiscriminableEvent mapper both Slack doors use:
// `changeType: 'create'` on MESSAGE deliveries is a stored-receipt fact
// (nothing routes on it since the variant retirement — the seed routes on
// discrimination); kept so the event shape stays byte-identical.
describe('slackEventToDiscriminable', () => {
  const envelope = (inner: Record<string, unknown>) => ({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev123',
    event: inner,
  });

  it('stamps create on message + app_mention deliveries', () => {
    for (const type of ['message', 'app_mention']) {
      const [event] = parseSlackEvents(
        envelope({ type, text: 'x', user: 'U1', channel: 'C1', ts: '1.2' }),
      );
      expect(slackEventToDiscriminable(event).changeType).toBe('create');
    }
  });

  it('leaves reaction_added unstamped — a different event kind', () => {
    const [event] = parseSlackEvents(
      envelope({
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: '1.2' },
        event_ts: '1.3',
      }),
    );
    expect(slackEventToDiscriminable(event).changeType).toBeUndefined();
  });
});

// ── `Replies` is readable AND awaitable — same edge, two read modes ────────
// The old declaration set `readable: false` believing `awaitable: true`
// forced it (the comment said so; it doesn't — the checker's AWAIT_REQUIRED
// branch only fires when the edge ALSO says `readable: false`, and the
// `Called` callback edge already proves readable+awaitable coexist). These
// compile movement source against the REAL projected schema — the exact
// surface authoring sees — so a regression back to `readable: false` fails
// loudly here instead of only showing up as a live "why can't I read my
// thread" report.
describe('Replies — readable AND awaitable, against the real projected schema', () => {
  let catalog: Catalog;

  beforeAll(async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map<string, SchemaTypeDescriptor>();
    for (const entry of entries) {
      const descriptor = await adapter.describe(entry.typeId);
      if (descriptor) descriptors.set(entry.typeId, descriptor);
    }
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: SLACK_ADAPTER_TYPE,
      entries,
      descriptors,
    });
    catalog = mockCatalog({
      adapters: {
        slack: {
          constructionArgs: [],
          // Real Slack has no `defaultSubscribedEvents` — a config-less
          // listen fires every declared event edge (Message AND Reaction),
          // and there is no `events:` listen-config key to narrow it (Slack's
          // only key is `channels`). This test isn't about listen scoping —
          // it's about the `Replies` edge, which only exists on Message — so
          // the mock scopes the listen to Message the way a real author would
          // route Reaction through its own handler, keeping the fixture
          // param-compatible without asserting anything about the real
          // config-less default (that asymmetry is documented at the real
          // `listEntryPoints` declaration).
          defaultEvents: ['message'],
          schema: projected.schema,
        },
      },
    });
  });

  // The fires edge lands straight on the message (rule 1's collapse), so the
  // listener parameter types as `Message` itself.
  const compile = (body: string) =>
    checkProgram(
      parseProgram(
        [
          'import { slack } from adapters',
          '',
          'sl = connect slack',
          '',
          'function handle_message(m: <sl-[:`Message`]->>) {',
          body,
          '}',
          '',
          'listen to sl {} fire handle_message',
        ].join('\n'),
      ),
      catalog,
    ).filter((d) => (d.severity ?? 'error') === 'error');

  it('a BARE `m-[:Replies]->` traversal type-checks clean — reads the thread so far', () => {
    expect(compile('  m-[r:Replies]-> {\n    if (r.`Message`) { }\n  }')).toEqual([]);
  });

  it('`await FIRST(m-[:Replies]->)` still type-checks clean — the same edge, waited on', () => {
    expect(compile('  r = await first(m-[:Replies]->)\n  if (r.`Message`) { }')).toEqual([]);
  });
});
