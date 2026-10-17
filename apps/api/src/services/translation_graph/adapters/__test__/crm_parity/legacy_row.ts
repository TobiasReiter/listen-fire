// The one thing a CRM's legacy line is given in place of production: the
// credential row it reads and decrypts. A test mocks `lib/kysely` and
// `lib/credentials` with these, and seeds `legacyRow.payload` with the
// credential pointed at the recording (or replaying) server; everything from
// the row onward is the legacy code as it runs. A fresh `id` per subject keeps
// a client cached by credential id from carrying one server's URL into the
// next subject.

export const legacyRow: { payload?: Record<string, unknown>; id?: string } = {};

const rowId = (): string => legacyRow.id ?? 'cred-parity';

/** A query builder that answers every chain with the seeded row. */
export function rowQueryBuilder(): unknown {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'executeTakeFirst' || property === 'executeTakeFirstOrThrow') {
          return async () => ({ id: rowId(), credentials: Buffer.from('sealed') });
        }
        if (property === 'execute') return async () => [{ id: rowId(), credentials: Buffer.from('sealed') }];
        if (property === 'then') return undefined;
        return () => chain;
      },
    },
  );
  return chain;
}

export async function decryptSeededRow(): Promise<string> {
  if (legacyRow.payload === undefined) throw new Error('no legacy credential row seeded');
  return JSON.stringify(legacyRow.payload);
}

/** A model call a CRM made, and the canned answer it was given: the model
 *  is a host service, so its calls are part of what parity compares. */
export interface ModelCall {
  label: string;
  system: string;
  userMessage: string;
}

export const modelCalls: ModelCall[] = [];

/** Deterministic answers by label; a structured call answers "no match". */
export function cannedChat(input: { label?: string; system: string; userMessage: unknown }): string {
  const userMessage = String(input.userMessage);
  modelCalls.push({ label: input.label ?? '', system: input.system, userMessage });
  const label = input.label ?? '';
  if (/location/i.test(label)) {
    return JSON.stringify({ street_address: null, city: 'Berlin', state: null, country: 'Germany', continent: 'Europe' });
  }
  if (label.endsWith('stripNameAffixes')) return JSON.stringify({ name: userMessage });
  if (label.endsWith('splitName')) {
    const at = userMessage.lastIndexOf(' ');
    return JSON.stringify({ first_name: userMessage.slice(0, at), last_name: userMessage.slice(at + 1) });
  }
  if (label.endsWith('extractFieldValues')) return '{}';
  return 'null';
}

export function cannedStructured(input: { label?: string; system: string; userMessage: unknown }): { id: null } {
  modelCalls.push({ label: input.label ?? '', system: input.system, userMessage: String(input.userMessage) });
  return { id: null };
}
