import { describeError, getErrorMessage } from 'movement-engine/lib/utils/error';

describe('describeError', () => {
  it('returns a plain error message unchanged', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('appends the cause of an undici-style "fetch failed"', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeError(err)).toBe('fetch failed: getaddrinfo ENOTFOUND api.example.com');
  });

  it('walks a nested cause chain', () => {
    const root = new Error('socket hang up');
    const mid = Object.assign(new Error('request failed'), { cause: root });
    const top = Object.assign(new TypeError('fetch failed'), { cause: mid });
    expect(describeError(top)).toBe('fetch failed: request failed: socket hang up');
  });

  it('does not repeat a cause whose message equals the parent', () => {
    const cause = new Error('fetch failed');
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeError(err)).toBe('fetch failed');
  });

  it('falls back to getErrorMessage for non-Errors', () => {
    expect(describeError('nope')).toBe(getErrorMessage('nope'));
  });
});
