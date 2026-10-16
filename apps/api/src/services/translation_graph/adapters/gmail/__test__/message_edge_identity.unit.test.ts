// language-ergonomics-2026-09-28 item C.4: does a parameter typed via the
// listener's event edge (`<mail-[:Message]->>`) accept a record delivered
// along the ordinary readable collection edge (`<mail-[:Messages]->>`), and
// the reverse?
//
// The Gmail entry surface publishes the SAME type (gmail:message) along two
// edges on purpose (adapters/CLAUDE.md rule 9 — a readable root collection
// and an event edge are two promises about one node): `Messages` (the
// searchable collection) and the unnamed `fires` edge, displayed as
// `Message` (schema.ts's gmailEntryPoints()). Per
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md, that is the
// INTENDED shape — "even if the node is stable... you'd have an additional
// non-event edge to get to it" — not an accident to reconcile.
//
// FINDING (see full readout at the bottom of this file's PR / brief report):
// there is only ONE position for this type. instanceSchemaFromDescriptors
// keys a position by the entry's `displayName`; both gmail entries share
// `GMAIL_MESSAGE_DISPLAY_NAME` ("Message"), so the second entry (the event)
// is folded into the position the first (readable) entry already minted —
// `positions` ends up with exactly `Message` (+ `Attachment`), never
// `Messages`. The `Messages` name survives only as a COLLECTION key
// (`collections.Messages.target === 'Message'`, via the entry's
// `collectionName` override), which the TYPE-MARKER grammar (`<inst-[:X]->>`)
// does not read at all — it resolves `X` against `positions`/`unions` only
// (`positionRefIn` / `reportUnknownPosition`, check.ts). So `<mail-[:Message]->>`
// is the only type marker Gmail's message type actually has; `<mail-[:Messages]->>`
// is refused with MOV_UNKNOWN_POSITION ("it has: Message, Attachment") —
// not a conformance refusal, a name that was never a position to begin with.
//
// Neither of the brief's two hypotheses (checker fix vs. "path is the
// identity, report don't change") applies: there is no cross-edge type to
// reconcile, because the projection never minted two. A record read off
// `mail-[m:Messages]->` and the listener's own event record are the SAME
// PositionTypeRef, so passing one into a function parameter typed against
// the other is not a conformance question — it typechecks the way passing a
// value to a same-typed parameter always does.

import { parseProgram, checkProgram, mockCatalog, type Diagnostic } from 'movement-lang';

import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { gmailEntryPoints, GMAIL_MAILBOX_DESCRIPTOR, describeGmailType } from '../schema';
import { GMAIL_MESSAGE_TYPE_ID, GMAIL_ATTACHMENT_TYPE_ID } from '../types';

const descriptors = new Map(
  [GMAIL_MESSAGE_TYPE_ID, GMAIL_ATTACHMENT_TYPE_ID].map((typeId) => [
    typeId,
    describeGmailType(typeId)!,
  ]),
);

const { schema: gmailSchema, notes } = instanceSchemaFromDescriptors({
  adapterType: 'gmail',
  entries: gmailEntryPoints(),
  descriptors,
  metaDescriptor: GMAIL_MAILBOX_DESCRIPTOR,
  supportsInPlaceUpdate: false,
});

const catalog = mockCatalog({
  adapters: {
    gmail: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: gmailSchema,
    },
  },
  credentials: { gmail_cred: { adapter: 'gmail' } },
});

const PRELUDE = `import { gmail } from adapters
import { gmail_cred } from credentials
mail = connect gmail using gmail_cred
`;

function errors(source: string): Diagnostic[] {
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

describe('the real Gmail projection: one position for two entries', () => {
  it('mints exactly one position for the message type, keyed by displayName ("Message"), no note', () => {
    expect(Object.keys(gmailSchema.positions).sort()).toEqual(['Attachment', 'Message']);
    expect(notes).toEqual([]);
  });

  it('the Messages collection targets that same position', () => {
    expect(gmailSchema.collections.Messages?.target).toBe('Message');
  });

  it('the event surface fires the same position', () => {
    expect(gmailSchema.eventPosition).toBe('Message');
  });
});

describe('<mail-[:Messages]->> is not a position — only <mail-[:Message]->> is', () => {
  it('the collection name is refused as a type marker, naming the real positions', () => {
    const source = `${PRELUDE}
movement Triage(m: <mail-[:Messages]->>) {
  x = m.\`Subject\`
}
`;
    const codes = errors(source).map((d) => d.code);
    expect(codes).toContain('MOV_UNKNOWN_POSITION');
    const message = errors(source).find((d) => d.code === 'MOV_UNKNOWN_POSITION')?.message;
    expect(message).toContain("has no position type 'Messages'");
    expect(message).toContain('Message');
  });
});

describe('a record from either edge satisfies a parameter typed against the other — because they are the same position', () => {
  it('a record walked off the Messages collection passes into a function typed <mail-[:Message]->>', () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Message]->>) {
  x = m.\`Subject\`
}
function lister(go: <mail-[:Message]->>) {
  found = mail-[m:Messages]-> { return m }
  Triage(found[0])
}
`;
    expect(errors(source)).toEqual([]);
  });

  it("the listener's own event record passes straight through to the same parameter", () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Message]->>) {
  x = m.\`Subject\`
}
function main(msg: <mail-[:Message]->>) {
  Triage(msg)
}
listen to mail {} fire main
`;
    expect(errors(source)).toEqual([]);
  });
});
