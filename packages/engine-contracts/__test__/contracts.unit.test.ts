import fs from 'fs';
import path from 'path';

import {
  CURRENT_LANGUAGE_VERSION,
  DEPRECATED_LANGUAGE_VERSIONS,
  LANGUAGE_VERSIONS,
  SUPPORTED_LANGUAGE_VERSIONS,
} from 'movement-lang';

import {
  CATALOG_SNAPSHOT_VERSION,
  CONTRACTS,
  CORE_PARK_REASONS,
  HOST_FAMILIES,
  HOST_FAMILIES_VERSION,
  MANIFEST_PROTOCOL_VERSION,
  PARK_STATE_VERSION,
  PROTOCOL_VERSION,
  hostMethodPaths,
  isCorePark,
  refuseUnsupportedHostFamiliesVersion,
  tenantIdOf,
} from '../index';

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

describe('the contract versions are the ones docs/contracts/ states', () => {
  const docs = path.resolve(__dirname, '../../../docs/contracts');
  const read = (file: string) => fs.readFileSync(path.join(docs, file), 'utf8');
  const versionLine = (file: string) => {
    const match = /^Version: (\d+)$/m.exec(read(file));
    if (match === null) throw new Error(`${file} has no "Version: N" line`);
    return Number(match[1]);
  };
  const versionList = (cell: string) => (cell === 'none' ? [] : cell.split(', ').map(Number));

  it('each document states its constant', () => {
    expect(versionLine('catalog-snapshot.md')).toBe(CATALOG_SNAPSHOT_VERSION);
    expect(versionLine('park-state.md')).toBe(PARK_STATE_VERSION);
    expect(versionLine('host-families.md')).toBe(HOST_FAMILIES_VERSION);
    expect(versionLine('adapter-protocol.md')).toBe(MANIFEST_PROTOCOL_VERSION);
    expect(String(versionLine('adapter-protocol.md'))).toBe(PROTOCOL_VERSION);
    expect(versionLine('language-versions.md')).toBe(CURRENT_LANGUAGE_VERSION);
  });

  it('the index is the CONTRACTS table, contract by contract', () => {
    const rows = [...read('README.md').matchAll(/^\| ([a-z-]+) \| \[[^\]]+\]\(([^)]+)\) \| (\d+) \| ([^|]+) \| ([^|]+) \|/gm)];
    const indexed = Object.fromEntries(
      rows.map(([, name, file, current, supported, deprecated]) => {
        expect(file).toBe(`${name}.md`);
        return [name, { current: Number(current), supported: versionList(supported.trim()), deprecated: versionList(deprecated.trim()) }];
      }),
    );
    expect(indexed).toEqual(CONTRACTS);
  });

  it('the language document tabulates every version this release knows, and its standing', () => {
    const rows = [...read('language-versions.md').matchAll(/^\| (\d+) \| ([A-Za-z ]+) \| (yes|no) \| (yes|no) \|/gm)];
    expect(rows.map(([, version, name]) => ({ version: Number(version), name }))).toEqual(
      LANGUAGE_VERSIONS.map(({ version, name }) => ({ version, name })),
    );
    expect(rows.filter((row) => row[3] === 'yes').map((row) => Number(row[1]))).toEqual([...SUPPORTED_LANGUAGE_VERSIONS]);
    expect(rows.filter((row) => row[4] === 'yes').map((row) => Number(row[1]))).toEqual([...DEPRECATED_LANGUAGE_VERSIONS]);
  });
});

describe('a host families version is refused at segment.open unless this host serves it', () => {
  it('passes the version it serves', () => {
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: HOST_FAMILIES_VERSION })).not.toThrow();
  });

  it('refuses another version, or none, naming the contract, what it saw and what it serves', () => {
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: 9 })).toThrow(
      'segment.open carries host families version 9, which this host does not serve (supported: 1)',
    );
    expect(() => refuseUnsupportedHostFamiliesVersion({})).toThrow(
      'segment.open carries host families version none, which this host does not serve (supported: 1)',
    );
  });
});
