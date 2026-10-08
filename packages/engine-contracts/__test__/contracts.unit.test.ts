import { CORE_PARK_REASONS, HOST_FAMILIES, hostMethodPaths, isCorePark, tenantIdOf } from '../index';

describe('the tenant id', () => {
  it('brands any non-empty string, which it carries unchanged', () => {
    expect(tenantIdOf('a-tenant')).toBe('a-tenant');
  });

  it('refuses the empty string, which names no tenant', () => {
    expect(() => tenantIdOf('')).toThrow();
  });
});

describe('park reasons', () => {
  it('owns a timer, an await and a limit, and treats any other reason as a unit\'s', () => {
    expect([...CORE_PARK_REASONS]).toEqual(['timer', 'await', 'limit']);
    expect(CORE_PARK_REASONS.every(isCorePark)).toBe(true);
    expect(isCorePark('ask')).toBe(false);
  });
});

describe('the host families manifest', () => {
  it('names each method once, by its path', () => {
    const paths = hostMethodPaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('park.sink.commitAwaitPark');
    expect(Object.keys(HOST_FAMILIES)).toContain('segment');
  });
});
