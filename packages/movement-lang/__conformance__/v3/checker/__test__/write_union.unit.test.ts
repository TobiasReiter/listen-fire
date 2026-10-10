// UNTAGGED write unions (slack-blocks plan, layer 2): a type's writable surface
// is a union of write SHAPES with no discriminant, so assignability decides —
// the fields a body maps must be a subset of at least one variant.
//
// TWO deliberately different shapes, so a hardcode can't pass
// (movement-lang/CLAUDE.md's second-shape rule):
//
//   - `chat` mirrors the proving Slack case: a create-EDGE write (a channel's
//     `Messages`), TWO variants, one shared field (`Message`) and one exclusive
//     field each (`File` / `Blocks`).
//   - `dispatch` is the non-Slack shape: a ROOT write, THREE variants, a shared
//     field with a different name (`Reference`), three exclusive fields, and a
//     field (`Note`) that rides EVERY variant — proving nothing keys off two
//     variants, off the word "Message", or off "shared means exactly one".

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

// ── Schemas ──

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text', attachment: 'file' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// The proving case: a message is a file post OR an interactive post. `Message`
// (the notification text) rides both; `File` and `Blocks` are exclusive.
const chatSchema: InstanceSchema = {
  positions: {
    Channel: { properties: { name: 'text' }, edges: { Messages: { target: 'Message', writable: true } } },
    Message: { properties: { text: 'text' }, edges: {} },
  },
  collections: { channels: { target: 'Channel' } },
  writableRoots: {},
  createShapes: {
    Message: {
      fields: { Message: 'text', File: 'file', Blocks: 'json' },
      resultShape: { externalId: 'text' },
      writeUnion: {
        variants: [
          { name: 'a file post', fields: ['Message', 'File'] },
          { name: 'an interactive post', fields: ['Message', 'Blocks'] },
        ],
      },
    },
  },
};

// The second shape: a ROOT write with THREE delivery channels. `Reference` and
// `Note` ride every variant; `Address`, `Email` and `Sms` are exclusive.
const dispatchSchema: InstanceSchema = {
  positions: {
    Delivery: { properties: { Reference: 'text' }, edges: {} },
  },
  collections: { deliveries: { target: 'Delivery' } },
  writableRoots: {
    Delivery: {
      fields: {
        Reference: 'text',
        Note: 'text',
        Address: 'text',
        Email: 'text',
        Sms: 'text',
      },
      requiredFields: ['Reference'],
      resultShape: { externalId: 'text' },
      writeUnion: {
        variants: [
          { name: 'a postal delivery', fields: ['Reference', 'Note', 'Address'] },
          { name: 'an email delivery', fields: ['Reference', 'Note', 'Email'] },
          { name: 'a text delivery', fields: ['Reference', 'Note', 'Sms'] },
        ],
      },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    chat: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: chatSchema,
    },
    dispatch: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: dispatchSchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_chat: { adapter: 'chat' },
    acme_post: { adapter: 'dispatch' },
  },
});

const PRELUDE = [
  'import { email, chat, dispatch } from adapters',
  'import { dealflow_inbox, acme_chat, acme_post } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'room  = chat(credentials: acme_chat)',
  'post  = dispatch(credentials: acme_post)',
].join('\n');

const inMovement = (body: string): string =>
  `${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n${body}\n}`;

const check = (body: string): Diagnostic[] =>
  checkProgram(parseProgram(inMovement(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
const codes = (body: string): string[] => check(body).map((d) => d.code);

function expectClean(body: string): void {
  expect(check(body).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
}

const unionError = (body: string): Diagnostic | undefined =>
  check(body).find((d) => d.code === C.WRITE_UNION_UNSATISFIED);

/** The channel handle a `Messages` create-edge write hangs off. */
const inChannel = (write: string): string =>
  `  room-[ch:channels]-> {\n    ${write}\n  }`;

// ── The proving case: two variants on a create-edge write ──

describe('untagged write union (chat `Messages` — file post XOR interactive post)', () => {
  it('each variant alone typechecks', () => {
    expectClean(inChannel('write ch-[:Messages]-> { Message: "hi", File: msg.`attachment` }'));
    expectClean(inChannel('write ch-[:Messages]-> { Message: "hi", Blocks: { type: "section" } }'));
  });

  it('a write of only the SHARED field fits both variants', () => {
    expectClean(inChannel('write ch-[:Messages]-> { Message: "hi" }'));
  });

  it('an empty body fits every variant (the union constrains combinations, not presence)', () => {
    expectClean(inChannel('write ch-[:Messages]-> { }'));
  });

  it('a cross-variant mix errors, naming the shapes and the offending combination', () => {
    const error = unionError(
      inChannel('write ch-[:Messages]-> { Message: "hi", File: msg.`attachment`, Blocks: { type: "section" } }'),
    );
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'is either a file post (Message, File) or an interactive post (Message, Blocks)',
    );
    expect(error?.message).toContain("File and Blocks can't both be set");
  });

  it('the exclusive pair alone (no shared field) still errors', () => {
    expect(codes(inChannel('write ch-[:Messages]-> { File: msg.`attachment`, Blocks: { type: "section" } }')))
      .toContain(C.WRITE_UNION_UNSATISFIED);
  });

  it('an UNKNOWN field is the unknown-field error, not a union failure', () => {
    const diagnostics = check(inChannel('write ch-[:Messages]-> { Message: "hi", Bogus: "x" }'));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
  });
});

// ── The second, distinct shape: three variants on a ROOT write ──

describe('untagged write union (dispatch `Delivery` — three delivery shapes)', () => {
  it('each of the three variants typechecks, shared fields included', () => {
    expectClean('  write post-[:deliveries]-> { Reference: "A1", Note: "n", Address: "1 High St" }');
    expectClean('  write post-[:deliveries]-> { Reference: "A1", Note: "n", Email: "a@b.com" }');
    expectClean('  write post-[:deliveries]-> { Reference: "A1", Sms: "+44" }');
  });

  it('a write of only the shared fields fits all three', () => {
    expectClean('  write post-[:deliveries]-> { Reference: "A1", Note: "n" }');
  });

  it('two exclusive fields error, and the message alternates all three shapes', () => {
    const error = unionError(
      '  write post-[:deliveries]-> { Reference: "A1", Address: "1 High St", Email: "a@b.com" }',
    );
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'is either a postal delivery (Reference, Note, Address), an email delivery (Reference, Note, Email), or a text delivery (Reference, Note, Sms)',
    );
    // Exactly the two that fit no shape together — never the shared fields.
    expect(error?.message).toContain("Address and Email can't both be set");
    expect(error?.message).not.toContain('Reference and');
  });

  it('THREE exclusive fields read as a set, in body order', () => {
    const error = unionError(
      '  write post-[:deliveries]-> { Sms: "+44", Address: "1 High St", Email: "a@b.com" }',
    );
    expect(error?.message).toContain("Sms, Address and Email can't be set together");
  });

  it('requiredness stays orthogonal — a satisfied variant with a missing required field is still that error', () => {
    expect(codes('  write post-[:deliveries]-> { Address: "1 High St" }')).toEqual([
      C.WRITE_MISSING_REQUIRED_FIELD,
    ]);
  });

  it('a union failure and a missing required field are reported together, not instead of', () => {
    const reported = codes('  write post-[:deliveries]-> { Address: "1 High St", Sms: "+44" }');
    expect(reported).toContain(C.WRITE_UNION_UNSATISFIED);
    expect(reported).toContain(C.WRITE_MISSING_REQUIRED_FIELD);
  });
});
