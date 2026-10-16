// Referenced-construction detection — which (adapter, credential) pairs a
// program actually constructs.
//
// The catalog snapshot ships as a fast skeleton (adapters, credentials,
// plugins, kg — no instance schemas); schemas stream in on demand for the
// pairs the source references. Both consumers use this module to compute
// that referenced set:
//   - the editor (apps/web) requests `describeInstance` per pair and merges
//     the result into its snapshot (`mergeInstanceSchema`);
//   - the compile path (apps/api saveMovement/provision) introspects only
//     these pairs instead of the whole workspace.
//
// Detection is a cheap parse (`parseProgram` is fast) walking every
// statement body for `name = adapter(credentials: cred)` assignments. While
// the program is mid-edit and doesn't parse, a line-level lexical fallback
// keeps detection alive so schemas still stream in as you type — the
// checker is silent on unknown schemas by design, so an over-approximate
// fallback can never cause a wrong diagnostic, only an unnecessary fetch
// (which the consumer's catalog membership check filters out anyway).

import type { ConstructionCall, Program, Statement } from '../parser/ast';
import { typeNameOf } from '../parser/ast';
import { MovementParseError, parseProgram } from '../parser/parse';
import { unwrapCredentialArg } from '../parser/scan';
import { eventAddressOfHops } from '../checker/event_address';
import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';

export interface ConstructionRef {
  /**
   * The adapter slug — the construction callee's ORIGINAL imported name
   * (`import { attio as crm_type } from adapters` resolves back to `attio`).
   */
  adapter: string;
  /**
   * The ORIGINAL credential import name passed as the construction's
   * `credentials` argument (the one universal construction argument), when
   * it's a plain identifier. Local aliases resolve back to the original —
   * `import { attio as AttioCred } from credentials` plus
   * `attio(credentials: AttioCred)` yields `attio`, the name the catalog,
   * the snapshot's `schemas` map and the checker's `instantiate` all key
   * on. Absent for credential-free constructions like `email()`.
   */
  credential?: string;
  /**
   * The construction's NON-credential args as authored (raw source, e.g.
   * `{ base: '"Sales CRM"' }`) — mirrors `InstanceChain.constructionArgs`.
   *
   * These pick the instance's entry POSITION, so they belong to the
   * construction itself, NOT to whether anything traverses it: a movement can
   * name a positioned instance purely in a parameter type
   * (`movement m(x: <at-[:\`Sales CRM — Deals\`]->>)`) and never walk from it. A
   * consumer that only learned positions from traversals would introspect such
   * an instance UNPOSITIONED and fail to resolve its types.
   *
   * Absent when the construction takes no non-credential args, and from the
   * lexical fallback (which only over-approximates the pair).
   */
  constructionArgs?: Record<string, string>;
}

/**
 * The de-duplicated constructions the source makes. Never throws: a program
 * that doesn't parse falls back to a lexical scan.
 *
 * De-duplication keys on the ENTRY POSITION as well as the (adapter,
 * credential) pair — two constructions of the same pair at different
 * positions are different instances with different surfaces, and that is the
 * documented way to reach two containers ("one lens per instance; construct
 * another instance for the second").
 */
export function referencedConstructions(source: string): ConstructionRef[] {
  let refs: ConstructionRef[];
  try {
    refs = constructionsOfProgram(parseProgram(source));
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    refs = constructionsByLexicalScan(source);
  }
  const seen = new Set<string>();
  const out: ConstructionRef[] = [];
  for (const ref of refs) {
    const key = `${constructionKey(ref)}::${positionArgsKey(ref.constructionArgs)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Stable key for a construction's non-credential args, order-independent. */
function positionArgsKey(args: Record<string, string> | undefined): string {
  if (!args) return '';
  const entries = Object.entries(args).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? JSON.stringify(entries) : '';
}

export function constructionKey(ref: ConstructionRef): string {
  return `${ref.adapter}::${ref.credential ?? ''}`;
}

/** Local alias → original imported name, per builtin namespace. */
interface ImportAliasMaps {
  adapters: Map<string, string>;
  credentials: Map<string, string>;
}

function constructionsOfProgram(program: Program): ConstructionRef[] {
  const refs: Array<{ adapter: string; credential?: string; constructionArgs?: Record<string, string> }> = [];
  const aliases: ImportAliasMaps = { adapters: new Map(), credentials: new Map() };
  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'builtin' && statement.source.namespace !== 'plugins') {
            const map = aliases[statement.source.namespace];
            for (const { name, alias } of statement.names) {
              if (alias !== undefined) map.set(alias, name);
            }
          }
          break;
        case 'assign':
          if (statement.value.kind === 'construct') {
            const construct = statement.value.construct;
            const credentialRaw = construct.args.find((a) => a.name === 'credentials')?.value.raw;
            const credential =
              credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
            // Every non-credential arg, raw as authored — the entry position
            // rides here (see `ConstructionRef.constructionArgs`).
            const constructionArgs: Record<string, string> = {};
            for (const arg of construct.args) {
              if (arg.name === 'credentials') continue;
              constructionArgs[arg.name] = arg.value.raw;
            }
            refs.push({
              adapter: construct.callee,
              ...(credential !== null ? { credential } : {}),
              ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
            });
          } else if (statement.value.kind === 'block') {
            walk(statement.value.block.body);
          }
          break;
        case 'listen':
          // `listen to <name>` references a NAMED construction (handled by the
          // `assign` case); inline constructions are rejected by the checker,
          // so nothing to collect here.
          break;
        case 'movement':
          walk(statement.body);
          break;
        case 'block':
          walk(statement.block.body);
          break;
        case 'if':
          for (const arm of statement.arms) walk(arm.body);
          if (statement.elseArm) walk(statement.elseArm.body);
          break;
        default:
          break;
      }
    }
  };
  walk(program.statements);
  return refs.map((ref) => resolveAliases(ref, aliases));
}

/** Map a construction's local names back to original catalog-side names. */
/** A construction call → its `ConstructionRef`, aliases resolved. The one
 *  reading of a `name = adapter(credentials: cred, …)` binding, shared by every
 *  pre-scan that needs to ground a name in its construction. */
function constructionRefOf(construct: ConstructionCall, aliases: ImportAliasMaps): ConstructionRef {
  const credentialRaw = construct.args.find((a) => a.name === 'credentials')?.value.raw;
  const credential = credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
  const constructionArgs: Record<string, string> = {};
  for (const arg of construct.args) {
    if (arg.name === 'credentials') continue;
    constructionArgs[arg.name] = arg.value.raw;
  }
  return resolveAliases(
    {
      adapter: construct.callee,
      ...(credential !== null ? { credential } : {}),
      ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
    },
    aliases,
  );
}

function resolveAliases(
  ref: { adapter: string; credential?: string; constructionArgs?: Record<string, string> },
  aliases: ImportAliasMaps,
): ConstructionRef {
  return {
    adapter: aliases.adapters.get(ref.adapter) ?? ref.adapter,
    ...(ref.credential !== undefined
      ? { credential: aliases.credentials.get(ref.credential) ?? ref.credential }
      : {}),
    ...(ref.constructionArgs !== undefined ? { constructionArgs: ref.constructionArgs } : {}),
  };
}

/**
 * Mid-edit fallback: scan each line for `name = callee(args…)`. Matches a
 * superset of constructions (any call-shaped rvalue); consumers filter by
 * catalog membership, so over-approximation is harmless. Import lines are
 * scanned too so aliases still resolve to original names.
 */
const ASSIGN_CALL_LINE = /^[ \t]*[A-Za-z_]\w*\s*=\s*([A-Za-z_]\w*)\s*\(([^)]*)/;
const CREDENTIALS_ARG = /(?:^|[,(\s])credentials\s*:\s*(`[^`\n]+`|[A-Za-z_]\w*)/;
const BUILTIN_IMPORT_LINE = /^\s*import\s*\{([^}]*)\}\s*from\s+(adapters|credentials)\b/;
// A connection's import name is its verbatim row name, so any name that isn't
// identifier-shaped arrives backtick-quoted (and aliasing it is the only way to
// then name it) — the same shape `CREDENTIALS_ARG` accepts on the argument side.
const IMPORT_ENTRY = /^\s*(`[^`\n]+`|[A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/;

function constructionsByLexicalScan(source: string): ConstructionRef[] {
  const refs: Array<{ adapter: string; credential?: string }> = [];
  const aliases: ImportAliasMaps = { adapters: new Map(), credentials: new Map() };
  for (const line of source.split('\n')) {
    const importLine = BUILTIN_IMPORT_LINE.exec(line);
    if (importLine) {
      const map = importLine[2] === 'adapters' ? aliases.adapters : aliases.credentials;
      for (const entry of importLine[1].split(',')) {
        const parsed = IMPORT_ENTRY.exec(entry);
        if (parsed && parsed[2] !== undefined) {
          map.set(parsed[2], unwrapCredentialArg(parsed[1]) ?? parsed[1]);
        }
      }
      continue;
    }
    const call = ASSIGN_CALL_LINE.exec(line);
    if (!call) continue;
    const credentialRaw = CREDENTIALS_ARG.exec(call[2])?.[1];
    const credential = credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
    refs.push({ adapter: call[1], ...(credential !== null ? { credential } : {}) });
  }
  return refs.map((ref) => resolveAliases(ref, aliases));
}

// ── Referenced listens ───────────────────────────────────────────────────────
//
// A listen is a TRAVERSAL of the instance's event edge, with a WHERE — so the
// same scan that reports which constructions a program makes must report which
// listens it declares, and against which construction.
//
// This exists because listen config is the ONLY place the narrowing of an
// event's record edge is written. `scanInstanceChains` yields hop chains, and a
// listen is not a hop chain: nothing else in the pre-scan sees it. Yet
// `listen to at { base: "appDevLoop", table: "tblDeals" }` is precisely the
// address of the table the event's `record` edge lands on — the author says it
// once, here, and must not have to restate it in the movement.
//
// Purely syntactic, like the rest of this module: it reports what the source
// says and leaves resolving it against a schema to the host.

/** One `listen to <instance> { … } fire <movement>`, grounded in the
 *  construction it names. */
export interface ListenRef {
  /** The construction the listen names — aliases resolved back to the original
   *  imported names, exactly as `referencedConstructions` reports them. */
  construction: ConstructionRef;
  /**
   * The listen's config, keyed by config name. A plain string literal is
   * unwrapped to its VALUE (`base: "appDevLoop"` → `appDevLoop`) because that
   * is what a predicate over the members' data compares against; anything else
   * (a list, a type ref, an expression) is left raw for the caller to reject.
   */
  config: Record<string, string>;
  /** The movement this listener fires. */
  movement: string;
}

/**
 * Every listen the source declares, grounded in its construction. Never throws:
 * an unparseable program yields no listens (the save path's own parse reports
 * it), and a listen naming something that isn't a construction is skipped —
 * an ungrounded listen only means no static narrowing there, never a wrong one.
 */
export function referencedListens(source: string): ListenRef[] {
  let program: Program;
  try {
    program = parseProgram(source);
  } catch {
    return [];
  }

  const aliases: ImportAliasMaps = { adapters: new Map(), credentials: new Map() };
  const bindings = new Map<string, ConstructionRef>();
  const listens: ListenRef[] = [];

  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'builtin' && statement.source.namespace !== 'plugins') {
            const map = aliases[statement.source.namespace];
            for (const { name, alias } of statement.names) {
              if (alias !== undefined) map.set(alias, name);
            }
          }
          break;
        case 'assign':
          if (statement.value.kind === 'construct') {
            bindings.set(statement.name, constructionRefOf(statement.value.construct, aliases));
          } else if (statement.value.kind === 'block') {
            walk(statement.value.block.body);
          }
          break;
        case 'listen': {
          // The ambient `kg` and the rejected inline form ground in no
          // construction — nothing for the host to walk.
          const construction = bindings.get(statement.instance);
          if (!construction) break;
          const config: Record<string, string> = {};
          for (const arg of statement.config) {
            if (arg.isType === true) continue; // `type: <company>` — a kg listen's shape
            config[arg.name] = unwrapStringLiteral(arg.value.raw) ?? arg.value.raw.trim();
          }
          listens.push({ construction, config, movement: statement.movement });
          break;
        }
        case 'movement':
          walk(statement.body);
          break;
        case 'block':
          walk(statement.block.body);
          break;
        case 'if':
          for (const arm of statement.arms) walk(arm.body);
          if (statement.elseArm) walk(statement.elseArm.body);
          break;
        default:
          break;
      }
    }
  };
  walk(program.statements);
  return listens;
}

// ── Referenced event addresses ───────────────────────────────────────────────
//
// The FOURTH pre-scan, beside the demand set, the selectors and the listens.
// `scanInstanceChains` yields hop chains and `referencedListens` yields listens;
// a movement's PARAMETER TYPE is neither, yet an address written there
// (`movement intake(e: <at-[:`Record Change` WHERE `action` == "record.created" AND `table` == "tblDeals"]->>)`)
// names a position that does not exist until the host walks to it and grafts it.
// Nothing else sees the only place a signature's address is written.

/** An event address a movement signature declares, grounded in its construction. */
export interface EventAddressRef {
  /** The construction the address's instance names — aliases resolved back,
   *  exactly as `referencedConstructions` reports them. */
  construction: ConstructionRef;
  /** The event edge the address walks (`Record Change`). */
  event: string;
  /** What the address pins: config key → literal (`{ base: 'appDevLoop',
   *  table: 'tblDeals' }`). Empty ⇒ the WIDE type; nothing to graft. */
  narrowing: Record<string, string>;
  /** The movement whose parameter declares it. */
  movement: string;
}

/**
 * Every event address the source's movement signatures declare, grounded in its
 * construction. Never throws: an unparseable program yields none (the save
 * path's own parse reports it), and an address naming something that isn't a
 * construction — or a WHERE that isn't an address — is skipped. An ungrounded
 * address only means no graft there, so the signature doesn't resolve and the
 * checker stays silent. Never a wrong one.
 */
export function referencedEventAddresses(source: string): EventAddressRef[] {
  let program: Program;
  try {
    // The hops below are read under the version the program is parsed under.
    program = parseProgram(source, { languageVersion: CURRENT_LANGUAGE_VERSION });
  } catch {
    return [];
  }

  const aliases: ImportAliasMaps = { adapters: new Map(), credentials: new Map() };
  const bindings = new Map<string, ConstructionRef>();
  const addresses: EventAddressRef[] = [];

  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'builtin' && statement.source.namespace !== 'plugins') {
            const map = aliases[statement.source.namespace];
            for (const { name, alias } of statement.names) {
              if (alias !== undefined) map.set(alias, name);
            }
          }
          break;
        case 'assign':
          if (statement.value.kind === 'construct') {
            bindings.set(statement.name, constructionRefOf(statement.value.construct, aliases));
          } else if (statement.value.kind === 'block') {
            walk(statement.value.block.body);
          }
          break;
        case 'movement': {
          for (const param of statement.params) {
            const type = typeNameOf(param.type);
            if (type?.hopsRaw === undefined) continue;
            const construction = bindings.get(type.graph);
            if (!construction) break; // not an instance — the checker reports it
            const address = addressOfHops(type.hopsRaw, CURRENT_LANGUAGE_VERSION);
            if (address === undefined) continue; // not an address — stays silent
            addresses.push({ construction, ...address, movement: statement.name });
          }
          walk(statement.body);
          break;
        }
        case 'block':
          walk(statement.block.body);
          break;
        case 'if':
          for (const arm of statement.arms) walk(arm.body);
          if (statement.elseArm) walk(statement.elseArm.body);
          break;
        default:
          break;
      }
    }
  };
  walk(program.statements);
  return addresses;
}

/**
 * One address's hops → the event it walks and what it pins. THE shared
 * reading (`eventAddressOfHops` — the same one the checker and the engine
 * run), so the position the host grafts and the position a signature or an
 * IS test resolves to can never be two different things.
 */
function addressOfHops(
  hopsRaw: string,
  languageVersion: LanguageVersion,
): { event: string; narrowing: Record<string, string> } | undefined {
  return eventAddressOfHops(hopsRaw, languageVersion);
}

/** A plain single- or double-quoted string literal's VALUE, or null when the
 *  raw text is anything else (a list, an identifier, an expression). No escape
 *  handling: a config value carrying one isn't a plain literal. */
function unwrapStringLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  if (trimmed[trimmed.length - 1] !== quote) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.includes(quote) || inner.includes('\\')) return null;
  return inner;
}

// ── Referenced file imports ──────────────────────────────────────────────────
//
// The import-path half of the referenced set: which movement files a
// source pulls in (`import { … } from "<file>"`). The host's resolver
// assembly (apps/api) walks this transitively — each library's source is
// scanned again — to prefetch every file a check/run could touch.

/**
 * The de-duplicated file-import paths the source references. Never
 * throws: a program that doesn't parse falls back to a line-level scan.
 */
export function referencedFileImports(source: string): string[] {
  let paths: string[];
  try {
    paths = fileImportsOfProgram(parseProgram(source));
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    paths = fileImportsByLexicalScan(source);
  }
  return [...new Set(paths)];
}

function fileImportsOfProgram(program: Program): string[] {
  const paths: string[] = [];
  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'file') paths.push(statement.source.path);
          break;
        case 'movement':
          walk(statement.body);
          break;
        case 'block':
          walk(statement.block.body);
          break;
        case 'if':
          for (const arm of statement.arms) walk(arm.body);
          if (statement.elseArm) walk(statement.elseArm.body);
          break;
        case 'assign':
          if (statement.value.kind === 'block') walk(statement.value.block.body);
          break;
        default:
          break;
      }
    }
  };
  walk(program.statements);
  return paths;
}

const FILE_IMPORT_LINE = /^\s*import\s*\{[^}]*\}\s*from\s+"([^"]+)"/;

function fileImportsByLexicalScan(source: string): string[] {
  const paths: string[] = [];
  for (const line of source.split('\n')) {
    const match = FILE_IMPORT_LINE.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

/**
 * Every NAME the program mentions — backtick-quoted names and bare word
 * tokens, undeduplicated intent aside.
 *
 * The editor's demand signal. It cannot compute a demand set itself (that needs
 * the adapter's entry list, which lives server-side), and it must not send the
 * whole source: `describeInstance` is a tRPC QUERY, so its input is serialized
 * into the URL, and a movement of any size overruns what a URL may carry.
 *
 * Deliberately OVER-INCLUSIVE and lexical — no parse, so it still works on the
 * half-typed source that exists between keystrokes, which is exactly when the
 * editor asks. Over-inclusion is safe because the server matches these EXACTLY
 * against published entry names and demands only what it finds; a token that
 * names nothing is simply ignored, never fetched.
 *
 * It is also the editor's CACHE KEY: a request keyed on (adapter, credential)
 * alone is fetched once and then frozen, so a type the author names later is
 * never described and the checker goes quiet about it — errors that only appear
 * on save. Keying on the mentions means naming a new type refetches.
 *
 */
export function referencedNames(source: string): string[] {
  const names = new Set<string>();
  // Backtick-quoted names first, and remove them, so a quoted name containing
  // spaces (`Meeting Note`) survives whole rather than being split into words.
  const withoutQuoted = source.replace(/`([^`]*)`/g, (_match, name: string) => {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
    return ' ';
  });
  for (const word of withoutQuoted.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    names.add(word);
  }
  return [...names];
}
