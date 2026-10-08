// The ask unit's awaits as the run host reaches them: through the adapter
// registry's keepers, never by name. An ask await resolves when its ask
// settles; a withdrawn one closes its ask; a parked one is described by the
// question it asked.

import { getAsksQb } from '../../../../lib/kysely';
import type { AwaitKeeper } from '../await_correlation';
import { abandonAskAwaits, loadResolvableAskAwaits } from './await_store';
import { askIdSchema } from './store';
import { ASK_ADAPTER_TYPE } from './type';

/** What each ask await is waiting on, by ask id: the question it asked. */
async function describeAskAwaits(correlationKeys: string[]): Promise<Map<string, string>> {
  const askIds = correlationKeys.flatMap((key) => {
    const parsed = askIdSchema.safeParse(key);
    return parsed.success ? [parsed.data] : [];
  });
  const rows =
    askIds.length > 0
      ? await getAsksQb(['ask']).selectFrom('ask').where('id', 'in', askIds).select(['id', 'prompt']).execute()
      : [];
  const prompts = new Map<string, string>(rows.map((r) => [r.id, r.prompt]));
  return new Map(
    correlationKeys.map((key) => {
      const prompt = prompts.get(key);
      return [
        key,
        prompt !== undefined && prompt.trim() !== ''
          ? `waiting for an answer to: ${prompt}`
          : 'waiting for an answer to a question',
      ];
    }),
  );
}

export const askAwaitKeeper: AwaitKeeper = {
  adapterType: ASK_ADAPTER_TYPE,
  loadResolvable: (input) => loadResolvableAskAwaits(input),
  abandon: (input) => abandonAskAwaits(input),
  describe: describeAskAwaits,
};
