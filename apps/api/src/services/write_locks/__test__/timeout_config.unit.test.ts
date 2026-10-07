import { DEFAULT_WRITE_LOCK_TIMEOUT_MS, parseWriteLockTimeoutMs } from '../write_locks';

describe('MOVEMENT_WRITE_LOCK_TIMEOUT_MS', () => {
  it('defaults when unset or blank', () => {
    expect(parseWriteLockTimeoutMs(undefined)).toBe(DEFAULT_WRITE_LOCK_TIMEOUT_MS);
    expect(parseWriteLockTimeoutMs('  ')).toBe(DEFAULT_WRITE_LOCK_TIMEOUT_MS);
  });

  it('reads a positive whole number of milliseconds', () => {
    expect(parseWriteLockTimeoutMs(' 500 ')).toBe(500);
  });

  it.each(['0', '-5', '1.5', 'soon'])('refuses %p, naming the variable', (raw) => {
    expect(() => parseWriteLockTimeoutMs(raw)).toThrow('MOVEMENT_WRITE_LOCK_TIMEOUT_MS');
  });
});
