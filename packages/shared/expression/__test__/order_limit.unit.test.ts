// ORDER BY over asynchronous key reads: every read settles before a failure
// is thrown, and the failure thrown is the earliest by position, whichever
// read failed first in time.

import { sortByOrderKey } from '../order_limit';

function deferred(): { promise: Promise<unknown>; resolve: () => void; reject: (error: Error) => void } {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('sortByOrderKey', () => {
  it('sorts by the key, empty keys last, ties in arrival order', async () => {
    const items = [{ k: 2 }, { k: null }, { k: 1 }, { k: 2 }];
    const sorted = await sortByOrderKey(items, 'desc', { value: async (item) => item.k });
    expect(sorted).toEqual([items[0], items[3], items[2], items[1]]);
  });

  it("throws the first item's failure, though it fails last, and only once every read settled", async () => {
    const first = deferred();
    const second = deferred();
    let secondSettled = false;
    const keyOf = new Map([
      ['first', first.promise],
      ['second', second.promise.finally(() => {
        secondSettled = true;
      })],
    ]);

    const sorting = sortByOrderKey(['first', 'second'], 'asc', {
      value: (item) => keyOf.get(item) ?? Promise.resolve(undefined),
    });
    const outcome = sorting.then(
      () => ({ error: undefined, secondSettled }),
      (error: unknown) => ({ error, secondSettled }),
    );

    second.reject(new Error('second fails early'));
    await new Promise((resolve) => setImmediate(resolve));
    first.reject(new Error('first fails late'));

    const { error, secondSettled: settledWhenThrown } = await outcome;
    expect(error).toEqual(new Error('first fails late'));
    expect(settledWhenThrown).toBe(true);
  });

  it('waits for a later read to settle before throwing an earlier failure', async () => {
    const first = deferred();
    const second = deferred();
    const keyOf = new Map([
      ['first', first.promise],
      ['second', second.promise],
    ]);
    let thrown = false;
    const sorting = sortByOrderKey(['first', 'second'], 'asc', {
      value: (item) => keyOf.get(item) ?? Promise.resolve(undefined),
    }).catch((error: unknown) => {
      thrown = true;
      return error;
    });

    first.reject(new Error('first fails early'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(thrown).toBe(false);

    second.resolve();
    expect(await sorting).toEqual(new Error('first fails early'));
  });
});
