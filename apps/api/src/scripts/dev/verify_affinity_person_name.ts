/**
 * Drive the Affinity adapter's PERSON WRITE against a live fake-channels server
 * over real HTTP, and read back what actually landed on the record.
 *
 * Two things to see, both from a production failure on
 * `write org -[:Founders]-> { `First name` ?: f.first, `Last name` ?: f.last }`:
 *   1. an authored first/last split reaches Affinity verbatim, with the model
 *      never asked to re-derive it (`affinity.splitName` is absent from the
 *      intercepted calls — only the search's affix strip remains);
 *   2. a single undivided name the model declines to split still creates the
 *      person, via the last-token rule, instead of aborting the run.
 *
 * Usage: FAKE_BASE=http://localhost:6199/affinity ts-node … verify_affinity_person_name.ts
 */
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import { AffinityAdapter } from '../../services/translation_graph/adapters/affinity';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6199/affinity';

/** Which model prompt each request carried, so "the split was never asked for"
 *  is an observation rather than a hope. The person write also asks the model
 *  to strip affixes off the SEARCH name — that call is the matching path and
 *  is expected; `affinity.splitName` is the one under test. */
const modelCalls: string[] = [];
/** What the split prompt gets told, when it is reached at all. */
const splitAnswer = JSON.stringify({ first_name: null, last_name: null });

const SPLIT_PROMPT = 'splits a name into first name and last name';

const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('api.anthropic.com')) return realFetch(input, init);

  const request = JSON.parse(String(init?.body ?? '{}'));
  const system = request.system?.map((block: { text: string }) => block.text).join('') ?? '';
  const userMessage = request.messages?.[0]?.content ?? '';

  // The judge that picks a match out of the search results — a forced tool
  // call, so it answers as JSON rather than a stream. "No match" keeps the
  // write on the CREATE path this script is here to exercise.
  if (request.tools) {
    modelCalls.push('affinity.findMatchingPerson');
    return jsonResponse({
      id: 'msg_verify',
      type: 'message',
      role: 'assistant',
      model: request.model,
      content: [{ type: 'tool_use', id: 'tool_verify', name: request.tool_choice.name, input: { id: null } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  const isSplit = system.includes(SPLIT_PROMPT);
  modelCalls.push(isSplit ? 'affinity.splitName' : 'affinity.stripNameAffixes');

  // The affix strip is the search path — hand the name straight back so the
  // write reaches the create it is actually here to exercise.
  const reply = isSplit ? splitAnswer : JSON.stringify({ name: userMessage });
  return new Response(streamedText(reply), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}) as typeof fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The Anthropic SDK streams every chat, so a canned reply has to arrive as
 *  the same SSE event sequence a real one would. */
function streamedText(text: string): string {
  const message = {
    id: 'msg_verify',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: 'team-verify' as TeamId,
    credentialsId: 'creds-verify' as ExternalServiceCredentialsId,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  Object.assign(adapter, {
    getApiClient: async () => client,
    web: { getWebBaseUrl: async () => 'https://verify.affinity.co' },
  });
  return adapter;
}

async function personOnFake(id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/persons/${id}`);
  return (await response.json()) as Record<string, unknown>;
}

async function main() {
  const adapter = adapterOnFake();

  const org = await adapter.createRecord({
    recordType: 'Organization',
    fields: { Name: 'Veltha', Domain: 'veltha.example' },
    mutationContext: {} as never,
  });

  // 1. The authored split — exactly the fields the failing movement wrote.
  modelCalls.length = 0;
  const founder = await adapter.createRecord({
    recordType: 'Person',
    fields: { 'First name': 'Hong Yan Hank', 'Last name': 'Wu' },
    parentLinks: [
      { recordType: 'Organization', externalId: org.externalId, edgeName: 'Founders' },
    ],
    mutationContext: {} as never,
  });
  const founderRecord = await personOnFake(founder.externalId);
  console.log('\n── `First name` + `Last name` written as authored');
  console.log(`   first_name: ${JSON.stringify(founderRecord.first_name)}`);
  console.log(`   last_name:  ${JSON.stringify(founderRecord.last_name)}`);
  console.log(`   model calls: ${modelCalls.join(', ')}`);

  // 2. One undivided name the model refuses to split — the run must survive.
  // The model shrugs at this name — exactly what killed the production run.
  modelCalls.length = 0;
  const unsplittable = await adapter.createRecord({
    recordType: 'Person',
    fields: { 'Full name': 'Mei Ling Grace Chen', Email: 'grace@veltha.example' },
    mutationContext: {} as never,
  });
  const unsplittableRecord = await personOnFake(unsplittable.externalId);
  console.log('\n── `Full name` the model declines to split');
  console.log(`   first_name: ${JSON.stringify(unsplittableRecord.first_name)}`);
  console.log(`   last_name:  ${JSON.stringify(unsplittableRecord.last_name)}`);
  console.log(`   model calls: ${modelCalls.join(', ')}`);

  process.exit(0);
}

void main();
