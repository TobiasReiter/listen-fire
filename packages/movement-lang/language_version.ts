// Language versions — the one table.
//
// A saved movement is pinned to the language version it was written against,
// and every layer (parser, checker, engine, plugins, adapters) honours that pin
// by a conditional at the point of difference:
//
//     if (before(ctx.languageVersion, 2)) { …the old behaviour… }
//
// The integer is the identity — code compares it and never parses the name.
// The name is display only: it is what a person sees.
//
// A version keeps its row here after it leaves SUPPORTED, so a movement pinned
// to it can still be refused by name.
//
// See plans/language-versioning-2026-09-29/.

import type { Diagnostic } from './checker/check';
import { neverAsAny } from './never';

/** A language version's identity. */
export type LanguageVersion = number;

export interface LanguageVersionInfo {
  version: LanguageVersion;
  /** Display only. */
  name: string;
  /** What the version is, for release notes and people. */
  is: string;
}

export const LANGUAGE_VERSIONS: readonly LanguageVersionInfo[] = [
  { version: 1, name: 'Quiet Heron', is: 'the language as of tag v0.6.0' },
  { version: 2, name: 'Bright Otter', is: 'the language from v0.7.0 through v0.9.1' },
  {
    version: 3,
    name: 'Steady Lynx',
    is: 'the language from v0.10.0: a list literal is a tuple — exact at a literal index, a list of its members\' union elsewhere',
  },
  {
    version: 4,
    name: 'Luminous Owl',
    is: 'the language from v0.11.0: a match yields absent on a miss, a write handle reaches its pre-write record through @old',
  },
  {
    version: 5,
    name: 'Dancing Wren',
    is: 'the language after v0.11: no `write … bind`, no `#` hops (a plugin is a function you call), `delete` only where the system declares deletion, `_resources` only on what `extract` produces',
  },
];

/** What a movement saved today is pinned to, and what an entry point given no
 *  version compiles and runs under. */
export const CURRENT_LANGUAGE_VERSION: LanguageVersion = 5;

/** The versions this release parses, checks and runs. */
export const SUPPORTED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set([1, 2, 3, 4, 5]);

/** Supported versions that will be removed: they still run, with a warning. */
export const DEPRECATED_LANGUAGE_VERSIONS: ReadonlySet<LanguageVersion> = new Set<LanguageVersion>();

/** What a release declares about versions. The standing of a pin is a question
 *  asked of a release, so a deploy check can ask it of the next one. */
export interface LanguageRelease {
  current: LanguageVersion;
  supported: ReadonlySet<LanguageVersion>;
  deprecated: ReadonlySet<LanguageVersion>;
}

export const THIS_RELEASE: LanguageRelease = {
  current: CURRENT_LANGUAGE_VERSION,
  supported: SUPPORTED_LANGUAGE_VERSIONS,
  deprecated: DEPRECATED_LANGUAGE_VERSIONS,
};

/** `version` has (or postdates) the behaviour version `n` introduced. */
export function since(version: LanguageVersion, n: LanguageVersion): boolean {
  return version >= n;
}

/** `version` predates the behaviour version `n` introduced. */
export function before(version: LanguageVersion, n: LanguageVersion): boolean {
  return version < n;
}

/** Moving a program from version `from` to `to` crosses the behaviour
 *  version `n` introduced — where a warning that a construct changed meaning
 *  belongs. */
export function changedBetween(from: LanguageVersion, to: LanguageVersion, n: LanguageVersion): boolean {
  return before(from, n) && since(to, n);
}

export function languageVersionInfo(version: LanguageVersion): LanguageVersionInfo | undefined {
  return LANGUAGE_VERSIONS.find((info) => info.version === version);
}

/** `"Quiet Heron" (1)` — or `version 7` for an integer this release has never
 *  heard of (a movement saved by a newer release). */
export function describeLanguageVersion(version: LanguageVersion): string {
  const info = languageVersionInfo(version);
  return info ? `"${info.name}" (${info.version})` : `version ${version}`;
}

/** How a version is shown to a person or an agent: the integer that identifies
 *  it, and its name. */
export interface LanguageVersionView {
  version: LanguageVersion;
  name: string;
}

export function languageVersionView(version: LanguageVersion): LanguageVersionView {
  return { version, name: languageVersionInfo(version)?.name ?? `version ${version}` };
}

export type LanguageVersionStanding ='supported' | 'deprecated' | 'unsupported';

export function languageVersionStanding(
  version: LanguageVersion,
  release: LanguageRelease = THIS_RELEASE,
): LanguageVersionStanding {
  if (!release.supported.has(version)) return 'unsupported';
  if (release.deprecated.has(version)) return 'deprecated';
  return 'supported';
}

export const LanguageVersionDiagnosticCodes = {
  UNSUPPORTED: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
  DEPRECATED: 'MOV_LANGUAGE_VERSION_DEPRECATED',
} as const;

/**
 * What a movement pinned to `version` must be told before anything else: an
 * error when this release cannot run it (never a silent fallback to the current
 * version), a warning when it runs but will stop doing so, nothing otherwise.
 * The message names the version and the fix.
 */
export function languageVersionDiagnostic(
  version: LanguageVersion,
  release: LanguageRelease = THIS_RELEASE,
): Diagnostic | undefined {
  const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
  const current = describeLanguageVersion(release.current);
  const standing = languageVersionStanding(version, release);
  switch (standing) {
    case 'supported':
      return undefined;
    case 'unsupported':
      return {
        code: LanguageVersionDiagnosticCodes.UNSUPPORTED,
        message:
          `this automation is written in language version ${describeLanguageVersion(version)}, ` +
          `which this release does not support, so it will not validate or run. ` +
          `To fix: validate it under ${current}, repair what that reports, and upgrade it to ${current}.`,
        span,
      };
    case 'deprecated':
      return {
        code: LanguageVersionDiagnosticCodes.DEPRECATED,
        message:
          `this automation is written in language version ${describeLanguageVersion(version)}, ` +
          `which is deprecated and will be removed in a future release. ` +
          `Validate it under ${current}, repair what that reports, and upgrade it to ${current} before then.`,
        span,
        severity: 'warning',
      };
    default:
      return neverAsAny(standing);
  }
}
