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
  SYSTEM_CALLER_VERSION,
  hostMethodPaths,
  isCorePark,
  refuseUnsupportedHostFamiliesVersion,
  refuseUnsupportedParkStateVersion,
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
    expect(versionLine('system-caller.md')).toBe(SYSTEM_CALLER_VERSION);
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

  // The Rust side's table, read from its source as the lowering vocabulary's
  // pin reads data.rs: the Rust engine refuses a version outside it by name.
  it('the Rust parser\'s version table is the same', () => {
    const rust = fs.readFileSync(path.resolve(__dirname, '../../../crates/movement-parser/src/version.rs'), 'utf8');
    const current = /^pub const CURRENT_LANGUAGE_VERSION: u32 = (\d+);$/m.exec(rust);
    const supported = /^pub const SUPPORTED_LANGUAGE_VERSIONS: &\[u32\] = &\[([\d, ]*)\];$/m.exec(rust);
    if (current === null || supported === null) throw new Error('version.rs no longer spells its constants as this test reads them');
    expect(Number(current[1])).toBe(CURRENT_LANGUAGE_VERSION);
    expect(supported[1].split(',').map((v) => Number(v.trim()))).toEqual([...SUPPORTED_LANGUAGE_VERSIONS]);
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

describe('a park state version is refused on read unless this release reads it', () => {
  it('passes the versions it reads: 1 (the TypeScript engine) and 2 (the Rust engine)', () => {
    expect(() => refuseUnsupportedParkStateVersion(PARK_STATE_VERSION)).not.toThrow();
    expect(() => refuseUnsupportedParkStateVersion(1)).not.toThrow();
  });

  it('refuses another version, or none, naming the contract, what it saw and what it reads', () => {
    expect(() => refuseUnsupportedParkStateVersion(3)).toThrow(
      'the parked state carries park state version 3, which this release does not read (supported: 1, 2)',
    );
    expect(() => refuseUnsupportedParkStateVersion(undefined)).toThrow(
      'the parked state carries park state version none, which this release does not read (supported: 1, 2)',
    );
  });
});

// The Rust engine's own input (`SegmentInput`, crates/movement-engine/src/
// run.rs), read from its source as the version table is: the README's
// `engine_start` member list names every field, optional ones marked `?`,
// and host-families.md's "Inputs only the Rust engine takes" names every
// field the shim reads from its process or deployment (a field whose doc
// says "so the engine reads no environment").
describe("the Rust engine's segment input is the one its documents name", () => {
  const repo = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(repo, 'crates/movement-engine/src/run.rs'), 'utf8');
  const struct = /^pub struct SegmentInput \{\n([\s\S]*?)^\}/m.exec(source);
  if (struct === null) throw new Error('run.rs no longer spells SegmentInput as this test reads it');
  const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const fields: Array<{ name: string; optional: boolean; fromEnvironment: boolean }> = [];
  let preamble: string[] = [];
  for (const line of struct[1].split('\n')) {
    const field = /^ {4}pub (\w+): (.+),$/.exec(line.trimEnd());
    if (field === null) {
      preamble.push(line);
      continue;
    }
    const attributes = preamble.join('\n');
    fields.push({
      name: camel(field[1]),
      optional: field[2].startsWith('Option<') || /#\[serde\(default/.test(attributes),
      fromEnvironment: /so the engine reads no\s+(?:\/\/\/\s+)?environment/.test(attributes),
    });
    preamble = [];
  }

  it('the README lists every field, its optional ones marked', () => {
    const readme = fs.readFileSync(path.join(repo, 'crates/movement-engine/README.md'), 'utf8');
    const list = /\*\*The input\*\* \(`engine_start`\): `\{([^}]*)\}`/.exec(readme);
    if (list === null) throw new Error('the README no longer spells the engine_start input as this test reads it');
    const listed = list[1].split(',').map((member) => member.trim().split(':')[0]!.trim());
    expect(listed).toEqual(['entry', ...fields.map(({ name, optional }) => (optional ? `${name}?` : name))]);
  });

  it("host-families.md names each input the shim reads so the engine reads no environment", () => {
    const doc = fs.readFileSync(path.join(repo, 'docs/contracts/host-families.md'), 'utf8');
    const section = /^- \*\*Inputs only the Rust engine takes\.\*\*[^\n]*\n((?: {2}- [^\n]*\n)+)/m.exec(doc);
    if (section === null) throw new Error('host-families.md no longer spells the inputs only the Rust engine takes as this test reads them');
    const named = [...section[1].matchAll(/^ {2}- `(\w+)`:/gm)].map(([, name]) => name);
    expect(named).toEqual(fields.filter((f) => f.fromEnvironment).map((f) => f.name));
  });
});
