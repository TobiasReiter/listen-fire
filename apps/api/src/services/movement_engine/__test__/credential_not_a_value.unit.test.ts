// A credential is never a value in a program, in any sense, on every language
// version. The checker refuses every read of a credential name outside an
// integration's `credentials:` argument (MOV_CREDENTIAL_NOT_A_VALUE), so a run
// fails at the check. Behind that, the engine refuses it too: every read of an
// import already threw MOVENG_UNSUPPORTED, and the null-compare short-cut — which
// answered a bound name as present without reading it — no longer answers for a
// credential.

import { binding, Environment, evalMovementExpr } from 'movement-engine/services/movement_engine/expression';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { tenantIdOf } from 'engine-contracts';
import { mockCatalogSnapshot, parseMovementExpression, type LanguageVersion } from 'movement-lang';

const VERSIONS: LanguageVersion[] = [1, 2, 3, 4, 5];

async function evaluate(raw: string, languageVersion: LanguageVersion): Promise<unknown> {
  const env = new Environment();
  // As the run binds `import { acme } from credentials`.
  env.declare('acme', binding({ kind: 'opaque', what: 'import', credential: true }));
  env.declare('attio', binding({ kind: 'opaque', what: 'import' }));
  return (await evalMovementExpr(parseMovementExpression(raw), { env, languageVersion })).value;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e instanceof MovementEngineError ? e.code : String(e);
  }
}

describe.each(VERSIONS)('the engine under version %s', (version) => {
  it.each(['acme == null', 'acme != null'])('`%s` is refused, not answered', async (raw) => {
    await expect(codeOf(evaluate(raw, version))).resolves.toBe('MOVENG_UNSUPPORTED');
  });

  // The Rust engine's run test pins the same message (run.rs
  // `a_null_test_of_a_credential_is_refused_not_answered`).
  it('says what it refused, as the Rust engine does', async () => {
    await expect(evaluate('acme == null', version)).rejects.toThrow(
      "reading 'acme' (an import) as a bare value is not supported by the movement engine yet",
    );
  });

  it('another import keeps its answer', async () => {
    await expect(evaluate('attio != null', version)).resolves.toBe(true);
  });
});

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000041');

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [],
      schema: {
        positions: { message: { properties: { subject: 'text' }, edges: {} } },
        collections: {},
        writableRoots: {},
      },
    },
  },
  credentials: { acme: { adapters: ['attio'] } },
});

describe.each(VERSIONS)('a run under version %s', (version) => {
  it('fails at the check, naming the refusal', async () => {
    const source = `import { email } from adapters
import { acme } from credentials
inbox = email()
movement m(msg: <inbox-[:message]->>) {
  if acme != null { ERROR("reached") }
}
`;
    const run = runMovement({
      source,
      event: {
        pipelineInputId: 'trigger:email-cred',
        adapterType: 'email',
        triggerType: 'webhook',
        payload: {},
        occurredAt: new Date().toISOString(),
      },
      teamId: TEAM_ID,
      catalog,
      host: makeTestHost({
        adapters: {
          resolve: () => {
            throw new Error('test: the check refuses the run before any adapter');
          },
        },
      }),
      languageVersion: version,
    });
    await expect(run).rejects.toMatchObject({
      code: 'MOVENG_CHECK',
      details: [expect.objectContaining({ code: 'MOV_CREDENTIAL_NOT_A_VALUE' })],
    });
  });
});
