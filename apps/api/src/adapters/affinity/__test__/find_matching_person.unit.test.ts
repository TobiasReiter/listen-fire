// `findMatchingPerson` is the fallback identity search used when the pipeline
// has no durable binding for a person. It decides create-vs-reconcile, and
// Affinity adjudicates the same question with a constraint of its own — so
// every case where our answer is narrower than Affinity's is either a hard 422
// (create) or a polluted contact (a case-variant email grafted onto a record
// that already had it).
//
// Verified against fake-channels over HTTP: an email differing only in case
// misses here, falls through to the name search, and — when the name has also
// drifted — reaches a create that Affinity rejects.

// The name-based fallback calls out to two LLMs. Stub them to a flat "no
// match" so each test isolates the EMAIL branch: anything these tests match,
// they matched on email alone.
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => JSON.stringify({ name: null })),
  anthropicChatStructured: jest.fn(async () => ({ id: null })),
}));

import type { AffinityAPIClient } from '../apiClient';

import { AffinityOperations } from '../operations';
import { normalizeEmail, ownsEmail } from '../common';
import { anthropicChat } from '../../../lib/anthropic';
import { logger } from '../../../services/logger';

const STORED = 'b.smith@acme.example';

function operationsWith(people: { id: number; first_name: string; last_name: string; primary_email: string | null; emails: string[] }[]) {
  const findManyPeople = jest.fn(async ({ search }: { search: string }) => {
    const term = search.toLowerCase();
    return people.filter(
      (p) =>
        p.primary_email?.toLowerCase().includes(term) ||
        p.emails.some((e) => e.toLowerCase().includes(term)) ||
        `${p.first_name} ${p.last_name}`.toLowerCase().includes(term),
    );
  });

  const client = { findManyPeople } as unknown as AffinityAPIClient;
  return { operations: new AffinityOperations(client), findManyPeople };
}

const BOB = {
  id: 1,
  first_name: 'Bob',
  last_name: 'Smith',
  primary_email: STORED,
  emails: [STORED],
};

// Shared by the v3 adapter and the v1/v2 output path, so both compare the same
// way. The null-vs-null case is the one with teeth: without it, an address that
// normalizes away would "match" the first person carrying no email at all.
describe('email predicate shared across the Affinity write paths', () => {
  it.each([
    ['A.E.O.N@gmx.de', 'a.e.o.n@gmx.de'],
    ['  spaced@example.com  ', 'spaced@example.com'],
    ['MiXeD@Example.COM', 'mixed@example.com'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([null, undefined, '', '   '])('treats %p as no address at all', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });

  it('does not report ownership when the address normalizes away', () => {
    expect(ownsEmail([null, undefined, ''], '   ')).toBe(false);
    expect(ownsEmail(['real@example.com'], null)).toBe(false);
  });

  it('reports ownership across case and padding', () => {
    expect(ownsEmail(['a.e.o.n@gmx.de'], 'A.E.O.N@gmx.de')).toBe(true);
    expect(ownsEmail(['other@example.com', ' Real@Example.com '], 'real@example.com')).toBe(true);
    expect(ownsEmail(['other@example.com'], 'real@example.com')).toBe(false);
  });
});

describe('AffinityOperations.findMatchingPerson — email is matched the way Affinity scopes it', () => {
  it('matches an email that differs only in case', async () => {
    const { operations } = operationsWith([BOB]);

    const match = await operations.findMatchingPerson({
      name: 'Roberta Fitzwilliam-Devereux', // name has drifted; email is the identity
      email: 'B.Smith@Acme.example',
    });

    expect(match).toEqual(BOB);
  });

  it('matches an email carrying stray surrounding whitespace', async () => {
    const { operations } = operationsWith([BOB]);

    const match = await operations.findMatchingPerson({
      name: 'Roberta Fitzwilliam-Devereux',
      email: `  ${STORED} `,
    });

    expect(match).toEqual(BOB);
  });

  it('matches on a secondary email, not just the primary', async () => {
    const { operations } = operationsWith([
      { ...BOB, primary_email: 'other@acme.example', emails: ['other@acme.example', STORED] },
    ]);

    const match = await operations.findMatchingPerson({
      name: 'Roberta Fitzwilliam-Devereux',
      email: STORED.toUpperCase(),
    });

    expect(match).toEqual({ ...BOB, primary_email: 'other@acme.example', emails: ['other@acme.example', STORED] });
  });

  it('does not invent a match when the email genuinely belongs to nobody', async () => {
    const { operations, findManyPeople } = operationsWith([BOB]);

    // No email match and no name match — the caller must be free to create.
    // (Guarded so a normalization bug can't silently turn "not found" into a
    // false positive.)
    const match = await operations.findMatchingPerson({
      name: '',
      email: 'nobody@elsewhere.example',
    });

    expect(match).toBeNull();
    expect(findManyPeople).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createPerson — Affinity demands a first AND a last name, and neither the
// author's own split nor a name the model won't divide may cost us the write.
// A production run of 128 records died on the second: "Hong Yan Hank" + "Wu"
// was joined into one string, handed to the model, and came back as two nulls.
// ---------------------------------------------------------------------------

function operationsCreating() {
  const createPerson = jest.fn(async () => ({ id: 77 }));
  const client = { createPerson } as unknown as AffinityAPIClient;
  return { operations: new AffinityOperations(client), createPerson };
}

describe('AffinityOperations.createPerson — the first/last pair Affinity requires', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the author\'s own split verbatim, without asking the model', async () => {
    const { operations, createPerson } = operationsCreating();

    await operations.createPerson({
      name: 'Hong Yan Hank Wu',
      firstName: 'Hong Yan Hank',
      lastName: 'Wu',
      email: 'hank@acme.example',
    });

    expect(createPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Hong Yan Hank', lastName: 'Wu' }),
    );
    expect(anthropicChat).not.toHaveBeenCalled();
  });

  it('asks the model only when the write supplies one undivided name', async () => {
    const { operations, createPerson } = operationsCreating();
    (anthropicChat as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ first_name: 'Jane', last_name: 'Doe' }),
    );

    await operations.createPerson({ name: 'Jane Doe' });

    expect(anthropicChat).toHaveBeenCalledTimes(1);
    expect(createPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe' }),
    );
  });

  it('falls back to the last token when the model declines to split', async () => {
    const { operations, createPerson } = operationsCreating();
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    (anthropicChat as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ first_name: null, last_name: null }),
    );

    const person = await operations.createPerson({ name: 'Hong Yan Hank Wu' });

    expect(person).toEqual({ id: 77 });
    expect(createPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Hong Yan Hank', lastName: 'Wu' }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('last-token rule'),
      expect.objectContaining({ fallback: { firstName: 'Hong Yan Hank', lastName: 'Wu' } }),
    );
    warn.mockRestore();
  });

  it('leaves the surname blank for a mononym rather than inventing one', async () => {
    const { operations, createPerson } = operationsCreating();
    jest.spyOn(logger, 'warn').mockImplementation();
    (anthropicChat as jest.Mock).mockResolvedValueOnce(JSON.stringify(null));

    await operations.createPerson({ name: 'Cher' });

    expect(createPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Cher', lastName: '' }),
    );
  });

  it('honours a half-authored split instead of re-deriving it', async () => {
    const { operations, createPerson } = operationsCreating();

    await operations.createPerson({ name: 'Wu', lastName: 'Wu' });

    expect(anthropicChat).not.toHaveBeenCalled();
    expect(createPerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: '', lastName: 'Wu' }),
    );
  });

  it('creates nobody from a nameless write', async () => {
    const { operations, createPerson } = operationsCreating();

    expect(await operations.createPerson({ name: '   ' })).toBeNull();
    expect(createPerson).not.toHaveBeenCalled();
    expect(anthropicChat).not.toHaveBeenCalled();
  });
});
