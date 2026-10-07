// The provider's failure path: a rejected fetch shows its own error with a
// "Try again" button instead of throwing, and pressing it fetches afresh.
// There is no DOM environment here, so the component runs against a minimal
// hook runtime standing in for react's useState/useEffect.
import fs from 'fs';
import path from 'path';
import type { ReactElement, ReactNode } from 'react';

process.env.NEXT_PUBLIC_PARSER_URL = '/movement_parser.0123456789ab.wasm';

type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };

function hookRuntime(render: () => ReactNode) {
  const states: unknown[] = [];
  const effects: Effect[] = [];
  const lastDeps: (readonly unknown[] | undefined)[] = [];
  let stateCursor = 0;
  let effectCursor = 0;
  let output: ReactNode = null;
  let dirty = false;

  const hooks = {
    useState(initial: unknown) {
      const slot = stateCursor++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        states[slot],
        (next: unknown) => {
          states[slot] = next;
          dirty = true;
        },
      ];
    },
    useEffect(run: Effect['run'], deps?: readonly unknown[]) {
      const slot = effectCursor++;
      effects[slot] = { run, deps };
    },
  };

  function pass(): void {
    stateCursor = 0;
    effectCursor = 0;
    output = render();
    effects.forEach((effect, slot) => {
      const previous = lastDeps[slot];
      const changed = previous === undefined || effect.deps === undefined || effect.deps.some((d, i) => d !== previous[i]);
      if (!changed) return;
      lastDeps[slot] = effect.deps;
      effect.run();
    });
  }

  return {
    hooks,
    /** Re-renders until `done` accepts the output; loading is asynchronous
     *  (a fetch, then a WASM compile), so a fixed number of ticks would flake. */
    async settle(done: (output: ReactNode) => boolean): Promise<ReactNode> {
      for (let attempt = 0; attempt < 100; attempt++) {
        dirty = false;
        pass();
        if (done(output)) return output;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the provider never settled');
    },
  };
}

function findButton(node: ReactNode): ReactElement<{ onClick: () => void }> | undefined {
  if (typeof node !== 'object' || node === null || !('props' in node)) return undefined;
  if (node.type === 'button') return node as ReactElement<{ onClick: () => void }>;
  const children: ReactNode = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found) return found;
  }
  return undefined;
}

describe('the browser parser provider when the parser fails to load', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('react');
  });

  it('shows an error with Try again, and a retry that succeeds renders the children', async () => {
    const artifact = fs.readFileSync(path.join(__dirname, '../../../../../packages/movement-lang/wasm/movement_parser.wasm'));
    Reflect.set(globalThis, 'window', globalThis);
    const fetched = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(artifact));

    let runtime: ReturnType<typeof hookRuntime> | undefined;
    const outcome: { provider?: typeof import('../parser-provider'); lang?: typeof import('movement-lang') } = {};
    jest.isolateModules(() => {
      const actual = jest.requireActual<typeof import('react')>('react');
      runtime = hookRuntime(() => outcome.provider!.ParserProvider({ children: 'the editor' }));
      jest.doMock('react', () => ({ ...actual, ...runtime!.hooks }));
      outcome.lang = require('movement-lang');
      outcome.provider = require('../parser-provider');
    });
    Reflect.deleteProperty(globalThis, 'window');
    if (!runtime || !outcome.lang) throw new Error('isolateModules did not run');

    const failed = await runtime.settle((output) => findButton(output) !== undefined);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failed)).toContain('could not load its parser');
    expect(JSON.stringify(failed)).toContain('offline');
    const retry = findButton(failed);
    if (!retry) throw new Error('the error UI has no Try again button');

    retry.props.onClick();
    const recovered = await runtime.settle((output) => output === 'the editor' || (typeof output === 'object' && output !== null && 'props' in output && output.props.children === 'the editor'));
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(outcome.lang.isParserReady()).toBe(true);
    expect(recovered).toMatchObject({ props: { children: 'the editor' } });
  });
});
