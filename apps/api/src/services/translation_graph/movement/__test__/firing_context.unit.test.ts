// The firing's Context seam (../firing_context.ts).
//
// The bug it exists for: the background workers called straight into a firing
// with no ambient Context, so every service that scopes itself by the acting
// identity threw inside the run. Page fetching is the one that hurt — its
// persistence step reads the team off the Context, the plugin's catch turned
// the throw into a warning, and a scheduled movement fetched nothing at all.

import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line prefer-const
let mockTrigger: { created_by_user_id: string | null } | undefined = {
  created_by_user_id: 'user-author',
};
// eslint-disable-next-line prefer-const
let mockMembers: Array<{ user_id: string; access: string }> = [
  { user_id: 'user-author', access: 'write' },
];

jest.mock('../../../../lib/kysely', () => {
  const chain = <T>(terminal: string, value: () => T) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['selectFrom', 'select', 'where', 'orderBy']) {
      builder[method] = () => builder;
    }
    builder[terminal] = async () => value();
    return builder;
  };
  return {
    getAutomationsQb: () => chain('executeTakeFirst', () => mockTrigger),
    getCoreQb: () => chain('execute', () => mockMembers),
  };
});

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { Context, currentContext, unsafeCurrentContext } from '../../../context';
import { withFiringContext } from '../firing_context';
import { userPrincipal } from '../../../principal';

const TEAM = 'team-1' as TeamId;
const firing = { teamId: TEAM, triggerId: 'trigger-1' };

beforeEach(() => {
  mockTrigger = { created_by_user_id: 'user-author' };
  mockMembers = [{ user_id: 'user-author', access: 'write' }];
});

describe('withFiringContext', () => {
  it('gives a firing with no ambient Context one bound to the trigger’s team', async () => {
    // What a plugin's persistence step does: read the acting identity.
    const seen = await withFiringContext(firing, async () => ({
      teamId: currentContext().user.teamId,
      userId: currentContext().user.id,
    }));

    expect(seen).toEqual({ teamId: TEAM, userId: 'user-author' });
  });

  it('leaves an ambient Context alone — a request-driven firing keeps its own', async () => {
    const outer = new Context();
    outer.bindPrincipal(userPrincipal({ userId: 'user-requesting', teamId: 'team-other' }));

    const seen = await outer.runAsync(() =>
      withFiringContext(firing, async () => ({
        same: unsafeCurrentContext() === outer,
        teamId: currentContext().user.teamId,
      })),
    );

    expect(seen).toEqual({ same: true, teamId: 'team-other' });
  });

  it('falls back to a write member when the author has left the team', async () => {
    mockMembers = [
      { user_id: 'user-remaining', access: 'write' },
      { user_id: 'user-later', access: 'write' },
    ];

    const seen = await withFiringContext(firing, async () => currentContext().user.id);

    expect(seen).toBe('user-remaining');
  });

  it('still runs the firing when there is nobody to act as', async () => {
    mockTrigger = { created_by_user_id: null };
    mockMembers = [];

    const ran = await withFiringContext(firing, async () => 'ran');

    expect(ran).toBe('ran');
    expect(unsafeCurrentContext()).toBeUndefined();
  });
});

// Every firing entry point must pass through the seam — that is the whole
// reason it is one place rather than one wrapper per background worker.
describe('execute.ts routes every firing through the seam', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'execute.ts'), 'utf-8');

  it.each([
    ['runMovementFiring', 'runMovementFiringInContext'],
    ['resumeMovementFiring', 'resumeMovementFiringInContext'],
    ['fireCallbackFiring', 'fireCallbackFiringInContext'],
  ])('%s', (_entry, inner) => {
    expect(src).toContain(`withFiringContext(input, () => ${inner}(input))`);
  });
});
