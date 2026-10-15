// A credential is never a value in a program, in any sense, on every language
// version. The checker refuses every read of a credential name outside an
// integration's `credentials:` argument (MOV_CREDENTIAL_NOT_A_VALUE), so a run
// fails at the check. Behind that, the engine refuses it too: every read of an
// import already threw MOVENG_UNSUPPORTED, and the null-compare short-cut — which
// answered a bound name as present without reading it — no longer answers for a
// credential.

import { binding, Environment, evalMovementExpr } from '../expression';
import { runMovement } from '../run';
import { MovementEngineError } from '../errors';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { parseMovementExpression, type LanguageVersion } from 'movement-lang';

const VERSIONS: LanguageVersion[] = [1, 2, 3, 4, 5];

async function evaluate(raw: string, languageVersion: LanguageVersion): Promise<unknown> {
  const env = new Environment();
  // As the run binds `import { acme } from credentials`.
  env.declare('acme', binding({ kind: 'opaque', what: 'a credential', credential: true }));
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

  it('another import keeps its answer', async () => {
    await expect(evaluate('attio != null', version)).resolves.toBe(true);
  });
});

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;

describe.each(VERSIONS)('a run under version %s', (version) => {
  it('fails at the check, naming the refusal', async () => {
    const source = `import { manual } from adapters
import { acme } from credentials
runs = manual()
movement m(go: <runs-[:Invocation]->>) {
  if acme != null { ERROR("reached") }
}
listen to runs {} fire m
`;
    const run = runMovement({
      source,
      event: {
        pipelineInputId: 'trigger:manual-cred',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: new Date().toISOString() },
        occurredAt: new Date().toISOString(),
      },
      teamId: TEAM_ID,
      catalog: staticCatalogFromManifests({ credentials: { acme: { adapters: ['attio'] } } }),
      resolveAdapter: () => createManualAdapter({ teamId: TEAM_ID }),
      dryRun: false,
      languageVersion: version,
    });
    await expect(run).rejects.toMatchObject({
      code: 'MOVENG_CHECK',
      details: [expect.objectContaining({ code: 'MOV_CREDENTIAL_NOT_A_VALUE' })],
    });
  });
});
