// The commonest refusals carry their exact rewrite (checker/fixes.ts): built
// from the author's own source, said in the message (what an agent reads) and
// as edits (what a tool applies). Every case here pins the message text AND
// proves the fix by applying it and checking again — a suggested rewrite that
// does not resolve its own diagnostic is worse than none.
//
// Two adapter shapes throughout (`crm` and `board`, `inbox` and `chat`), so a
// fix derived from the schema cannot pass by matching one hardcoded name.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const crmSchema: InstanceSchema = {
  positions: {
    Company: { properties: { Name: 'text', Domain: 'text', Headcount: 'number' }, edges: {} },
  },
  collections: { Companies: { target: 'Company' } },
  writableRoots: {
    Company: {
      fields: { Name: 'text', Domain: 'text', Headcount: 'number' },
      requiredFields: ['Name'],
      resultShape: { externalId: 'text' },
    },
  },
};

const boardSchema: InstanceSchema = {
  positions: {
    Lane: { properties: { Title: 'text', Size: 'number' }, edges: {} },
  },
  collections: { Lanes: { target: 'Lane' } },
  writableRoots: {
    Lane: { fields: { Title: 'text', Size: 'number' }, requiredFields: ['Title'], resultShape: { externalId: 'text' } },
  },
};

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Attachments: { target: 'attachment' } },
    },
    attachment: { properties: { File: 'file' }, edges: {} },
  },
  collections: { message: { target: 'message' } },
  writableRoots: {},
};

const credentialed = [{ name: 'credentials', kind: 'credential' as const, required: true }];

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: credentialed, schema: crmSchema },
    trello: { constructionArgs: credentialed, schema: boardSchema },
    mail: {
      constructionArgs: [],
      triggerConfig: ['key'],
      triggerConfigRequired: ['key'],
      schema: inboxSchema,
    },
  },
  // One connection per adapter — so the one that constructs each is certain.
  credentials: { 'Acme CRM': { adapters: ['attio'] }, boards: { adapters: ['trello'] } },
});

const PRELUDE = [
  'import { attio, trello } from adapters',
  'import { `Acme CRM`, boards } from credentials',
  'crm = attio(credentials: `Acme CRM`)',
  'board = trello(credentials: boards)',
].join('\n');

const program = (body: string): string => `${PRELUDE}\nmovement main() {\n${body}\n}\n`;

const check = (source: string): Diagnostic[] => checkProgram(parseProgram(source), catalog);

/** The one diagnostic of `code`, its fix applied, and the source re-checked. */
function fixed(source: string, code: string): { diagnostic: Diagnostic; after: Diagnostic[]; repaired: string } {
  const found = check(source).filter(d => d.code === code);
  expect(found).toHaveLength(1);
  const [diagnostic] = found;
  expect(diagnostic.fix).toBeDefined();
  const repaired = applyFix(source, diagnostic.fix!);
  return { diagnostic, after: check(repaired), repaired };
}

const MAYBE_TITLE = '  t = ONLY(board-[l:Lanes]->.`Title`)';
const MAYBE_SIZE = '  s = ONLY(board-[l:Lanes]->.`Size`)';

describe('MOV_ABSENT_REQUIRED — a maybe-absent value in a write field', () => {
  it('a required field: the COALESCE line to write, fallback typed by the value', () => {
    const { diagnostic, after, repaired } = fixed(
      program(`${MAYBE_TITLE}\n  write crm-[:Companies]-> { Name: t }`),
      C.ABSENT_REQUIRED,
    );
    expect(diagnostic.message).toBe(
      `'Name' on crm.Company needs a value, but 't' may be absent (text (or absent)) — write 'Name: COALESCE(t, "unknown")' to fall back to a value that is always there (see handbook: front#maybe-absent)`,
    );
    expect(repaired).toContain('{ Name: COALESCE(t, "unknown") }');
    expect(after.map(d => d.code)).not.toContain(C.ABSENT_REQUIRED);
  });

  it('a field the create may leave unset also offers the ?: form; the fallback follows the type', () => {
    const { diagnostic, after } = fixed(
      program(`${MAYBE_SIZE}\n  write board-[:Lanes]-> { Title: "x"\n Size: s }`),
      C.ABSENT_REQUIRED,
    );
    expect(diagnostic.message).toBe(
      `'Size' on board.Lane needs a value, but 's' may be absent (number (or absent)) — write 'Size: COALESCE(s, 0)' to fall back to a value that is always there, or 'Size ?: s' to leave it unset when absent (see handbook: front#maybe-absent)`,
    );
    expect(after.map(d => d.code)).not.toContain(C.ABSENT_REQUIRED);
  });

  it('the expression is the author’s own, path and backticks included', () => {
    const { diagnostic } = fixed(
      program('  l = ONLY(board-[x:Lanes]->)\n  write crm-[:Companies]-> { Name: l.`Title` }'),
      C.ABSENT_REQUIRED,
    );
    expect(diagnostic.message).toContain("write 'Name: COALESCE(l.`Title`, \"unknown\")'");
  });

  it('a field that identifies the record gets no fallback — it would merge them — but the gate, which works', () => {
    const source = program(`${MAYBE_TITLE}\n  write crm-[:Companies]-> {\n    unique by (Name)\n    Name: t\n  }`);
    const [diagnostic] = check(source).filter(d => d.code === C.ABSENT_REQUIRED);
    expect(diagnostic.fix).toBeUndefined();
    expect(diagnostic.message).toBe(
      `'Name' on crm.Company needs a value, but 't' may be absent (text (or absent)), and it identifies the record, so a fallback would merge every record written without it into one — write only when it is there: put the write inside 'if t != null { … }' (see handbook: front#maybe-absent)`,
    );
    const gated = program(`${MAYBE_TITLE}\n  if t != null {\n    write crm-[:Companies]-> {\n      unique by (Name)\n      Name: t\n    }\n  }`);
    expect(check(gated).map(d => d.code)).not.toContain(C.ABSENT_REQUIRED);
  });
});

describe('MOV_NAME_UNRESOLVED — a system or connection named but never imported', () => {
  it('a construction whose adapter is not imported: the import line', () => {
    const source = [
      'import { `Acme CRM` } from credentials',
      'crm = attio(credentials: `Acme CRM`)',
    ].join('\n');
    const { diagnostic, after, repaired } = fixed(source, C.NAME_UNRESOLVED);
    expect(diagnostic.message).toBe(
      "'attio' is not in scope — import it: add 'import { attio } from adapters' at the top of the file",
    );
    expect(repaired.split('\n')[0]).toBe('import { attio } from adapters');
    expect(after.map(d => d.code)).toEqual([]);
  });

  it('…and its credential, written as a string and never imported, repaired in the same fix', () => {
    const { diagnostic, after, repaired } = fixed('board = trello(credentials: "boards")', C.NAME_UNRESOLVED);
    expect(diagnostic.message).toBe(
      "'trello' is not in scope — import it: add 'import { trello } from adapters' at the top of the file, and write the credential as a name, not a string: 'credentials: boards', and add 'import { boards } from credentials' at the top of the file",
    );
    expect(repaired).toContain('board = trello(credentials: boards)');
    expect(after.map(d => d.code)).toEqual([]);
  });

  it('a credential named in backticks but not imported: its import line', () => {
    const source = ['import { attio } from adapters', 'crm = attio(credentials: `Acme CRM`)'].join('\n');
    const { diagnostic, after } = fixed(source, C.NAME_UNRESOLVED);
    expect(diagnostic.message).toBe(
      "'Acme CRM' is a credential — import it: add 'import { `Acme CRM` } from credentials' at the top of the file",
    );
    expect(after.map(d => d.code)).toEqual([]);
  });

  it('a credential written as a string, adapter imported: the name form, and its import', () => {
    const source = ['import { attio } from adapters', 'crm = attio(credentials: "Acme CRM")'].join('\n');
    const { diagnostic, after, repaired } = fixed(source, C.CRED_WRONG_ADAPTER);
    expect(diagnostic.message).toBe(
      "The credential argument must be an imported credential name, not an expression — write the credential as a name, not a string: 'credentials: `Acme CRM`', and add 'import { `Acme CRM` } from credentials' at the top of the file",
    );
    expect(repaired).toContain('crm = attio(credentials: `Acme CRM`)');
    expect(after.map(d => d.code)).toEqual([]);
  });

  it('an adapter read before any construction: both lines, with the one connection that can construct it', () => {
    // Not a fix: what to name the instance, and where, is the author's call.
    const [diagnostic] = check('movement main() {\n  c = ONLY(trello-[l:Lanes]->)\n}');
    expect(diagnostic.code).toBe(C.NAME_UNRESOLVED);
    expect(diagnostic.message).toBe(
      "'trello' is not in scope — import it and construct an instance first: import { trello } from adapters, then '<name> = trello(credentials: …)' — with the one trello connection here: 'import { boards } from credentials' and '<name> = trello(credentials: boards)' (see handbook: front#systems)",
    );
    expect(diagnostic.fix).toBeUndefined();
  });

  it('a string naming no connection the workspace has gets no fix — nothing to name', () => {
    const source = ['import { attio } from adapters', 'crm = attio(credentials: "Nobody")'].join('\n');
    const [diagnostic] = check(source).filter(d => d.code === C.CRED_WRONG_ADAPTER);
    expect(diagnostic.message).toBe('The credential argument must be an imported credential name, not an expression');
    expect(diagnostic.fix).toBeUndefined();
  });
});

describe('MOV_FUNCTION_UNKNOWN — the did-you-mean as the whole corrected call', () => {
  it('the call as written, its name swapped', () => {
    const { diagnostic, after, repaired } = fixed(program('  x = TRIM(UPPR("a b"))'), C.FUNCTION_UNKNOWN);
    expect(diagnostic.message).toBe(
      `Unknown function 'UPPR' — did you mean 'UPPER'? Write 'UPPER("a b")' — a call names a movement or function declared or imported here, or a built-in (see handbook: front#functions-not-methods)`,
    );
    expect(repaired).toContain('x = TRIM(UPPER("a b"))');
    expect(after.map(d => d.code)).not.toContain(C.FUNCTION_UNKNOWN);
  });
});

describe('MOV_LISTEN_BAD_CONFIG — the routing key a listener requires', () => {
  const source = [
    'import { mail } from adapters',
    'inbox = mail()',
    'movement `Log Sender`(m: <inbox-[:message]->>) {',
    '}',
    'listen to inbox {} fire `Log Sender`',
  ].join('\n');

  it('the whole listen statement, with a key derived from the movement', () => {
    const { diagnostic, after, repaired } = fixed(source, C.LISTEN_BAD_CONFIG);
    expect(diagnostic.message).toBe(
      "a 'mail' listener requires a 'key' config — e.g. listen to inbox { key: \"log-sender\" } fire `Log Sender`",
    );
    expect(repaired.split('\n').at(-1)).toBe('listen to inbox { key: "log-sender" } fire `Log Sender`');
    expect(after.map(d => d.code)).not.toContain(C.LISTEN_BAD_CONFIG);
  });
});

describe('MOV_CALL_ARG_TYPE — one value where a list of them is taken', () => {
  const source = (arg: string): string =>
    [
      'import { mail } from adapters',
      'inbox = mail()',
      'movement keep(files: <file[]>) {',
      '}',
      'movement main(m: <inbox-[:message]->>) {',
      `  keep(${arg})`,
      '}',
      'listen to inbox { key: "main" } fire main',
    ].join('\n');

  it('a walk read is spliced into a list', () => {
    const { diagnostic, after } = fixed(source('m-[a:Attachments]->.`File`'), C.CALL_ARG_TYPE);
    expect(diagnostic.message).toContain(" — pass it as a list: '[...m-[a:Attachments]->.`File`]'");
    expect(after.map(d => d.code)).not.toContain(C.CALL_ARG_TYPE);
  });
});
