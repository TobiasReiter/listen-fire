// Object literals through the engine: evaluation and the save-time
// interpretability gate.
//
// `{ key: <expr>, … }` evaluates to a PLAIN JS object — every entry
// evaluated (no laziness), keys verbatim, nested lists and objects intact.
// This is the currency an adapter write receives, so nothing along the way
// may stringify or comma-join it.

import { Environment, evalMovementExpr } from '../expression';
import { listUnsupportedConstructs } from '../interpretable';
import { parseMovementExpression } from 'movement-lang';

async function evaluate(text: string, bindings: Record<string, unknown> = {}): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) {
    env.declare(name, { kind: 'value', value });
  }
  return (await evalMovementExpr(parseMovementExpression(text), { env })).value;
}

describe('object literal evaluation', () => {
  it('evaluates to a plain object with the keys verbatim', async () => {
    await expect(evaluate('{ type: "section", block_id: "b1" }')).resolves.toEqual({
      type: 'section',
      block_id: 'b1',
    });
  });

  it('the empty object evaluates to {}', async () => {
    await expect(evaluate('{}')).resolves.toEqual({});
  });

  it('evaluates every entry — expressions, not just literals', async () => {
    await expect(
      evaluate('{ text: CONCAT("Re: ", subject), n: 1 + 2, flag: TRUE }', { subject: 'Acme' }),
    ).resolves.toEqual({ text: 'Re: Acme', n: 3, flag: true });
  });

  it('carries nested objects and lists through intact — a Block Kit shape', async () => {
    await expect(
      evaluate(
        '[{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: label }, value: "yes" }] }]',
        { label: 'Approve' },
      ),
    ).resolves.toEqual([
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Approve' }, value: 'yes' },
        ],
      },
    ]);
  });

  it('a later entry with the same key wins, as in JSON', async () => {
    await expect(evaluate('{ a: 1, a: 2 }')).resolves.toEqual({ a: 2 });
  });

  it('carries the provenance of every value read', async () => {
    const env = new Environment();
    env.declare('subject', { kind: 'value', value: 'Acme' });
    const result = await evalMovementExpr(parseMovementExpression('{ text: subject }'), { env });
    expect(result.value).toEqual({ text: 'Acme' });
    expect(result.provenance).toBeDefined();
  });
});

describe('interpretability gate', () => {
  it('an object-literal field value is a supported construct', () => {
    const source = `
import { email, slack } from adapters
import { acme_workspace } from credentials

inbox = email()
team  = slack(credentials: acme_workspace)

movement notify(m: <inbox-[:message]->>) {
  write team-[:message]-> {
    channel: "#dealflow"
    blocks: [{ type: "section", text: { type: "mrkdwn", text: m.\`subject\` } }]
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
