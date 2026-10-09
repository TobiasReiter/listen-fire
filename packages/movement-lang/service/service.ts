// The movement language service — pure, editor-agnostic.
//
// Three entry points, all (source, …, snapshot) → plain data:
//   - getMovementDiagnostics: parse + check, spans mapped to char offsets;
//   - getMovementCompletions: context-aware completions (statement keywords,
//     import names, write targets/fields, traversal edges, expression
//     positions delegated to the shared formula completion engine);
//   - getHoverInfo: best-effort type-at-position for an identifier.
//
// No DOM, no CodeMirror, no network: the editor adapts these to its
// extension points; tests drive them directly.

import {
  getCompletions as formulaCompletions,
  type Completion,
  type CompletionKind,
  type EdgeInfo,
  type FormulaCapabilities,
  type PropertyInfo,
} from '@listen-fire/shared/expression/formula';
import type { Loc, Span } from '../parser/ast';
import { spellParamType } from '../parser/ast';
import { MovementParseError, parseProgram } from '../parser/parse';
import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import { CLOSER, opensHop, scanName, skipOpaque } from '../parser/scan';
import {
  checkProgram,
  positionTypeOf,
  type Diagnostic,
  type RecordedWrite,
} from '../checker/check';
import type { ScopeSymbol } from '../checker/scopes';
import {
  borrowableFieldsOf,
  credentialArgOf,
  describeFieldType,
  type FieldType,
  type InstanceSchema,
} from '../checker/catalog';
import {
  describePosition,
  describeReturnShape,
  isEnumType,
  positionSchemaOfRef,
  type PositionTypeRef,
  ExpressionTyping,
} from '../checker/typing';
import { MOVEMENT_META_FIELDS as CANONICAL_META_FIELDS } from '../checker/meta';
import { parseMovementExpression, BridgeError } from '../expression/bridge';
import {
  BARE_COERCERS,
  bareCoercer,
  describeStdlibFamily,
  stdlibFamily,
  STDLIB_FAMILIES,
} from '../expression/stdlib';
import { fileExports } from '../checker/link';
import {
  analyze,
  lineStartsOf,
  locOfOffset,
  offsetOfLoc,
  type Analysis,
} from './analysis';
import {
  EMPTY_CATALOG_SNAPSHOT,
  fromCatalogSnapshot,
  instanceSchemaNotes,
  resolveFileFromSnapshot,
  type CatalogSnapshot,
} from './snapshot';

export type { Completion, CompletionKind } from '@listen-fire/shared/expression/formula';

// ── Diagnostics ──

export interface MovementDiagnostic extends Diagnostic {
  /** Character offsets into the source, for editors that work in offsets. */
  from: number;
  to: number;
}

export const PARSE_DIAGNOSTIC_CODE = 'MOV_PARSE';

export function getMovementDiagnostics(
  source: string,
  snapshot: CatalogSnapshot,
  options?: {
    /** The saved movement's pin. Absent ⇒ the current version. */
    languageVersion?: LanguageVersion;
    /** See `CheckOptions.upgradingFrom`. */
    upgradingFrom?: LanguageVersion;
  },
): MovementDiagnostic[] {
  const lineStarts = lineStartsOf(source);
  const toRange = (span: Span): { from: number; to: number } => {
    const from = Math.min(offsetOfLoc(lineStarts, span.start), source.length);
    let to = Math.min(offsetOfLoc(lineStarts, span.end), source.length);
    if (to <= from) {
      // Zero-width span — extend over the word at `from` so the squiggle is visible.
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(from));
      to = from + (word ? word[0].length : 1);
      to = Math.min(to, source.length);
      if (to <= from) to = Math.min(from + 1, source.length);
    }
    return { from, to };
  };

  const catalog = fromCatalogSnapshot(snapshot);
  const resolveFile = resolveFileFromSnapshot(snapshot);
  let diagnostics: Diagnostic[];
  try {
    const languageVersion = options?.languageVersion;
    const program = parseProgram(
      source,
      languageVersion !== undefined ? { languageVersion } : undefined,
    );
    diagnostics = checkProgram(program, catalog, {
      ...(resolveFile ? { resolveFile } : {}),
      ...(languageVersion !== undefined ? { languageVersion } : {}),
      ...(options?.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {}),
    });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    const span: Span = { start: e.loc, end: e.loc };
    diagnostics = [{ code: PARSE_DIAGNOSTIC_CODE, message: e.message, span }];
  }
  return diagnostics.map(d => ({ ...d, ...toRange(d.span) }));
}

// ── Completions ──

export interface MovementCompletionItem {
  label: string;
  insert: string;
  kind: CompletionKind;
  detail?: string;
  /**
   * Present on a "+ connect" entry: selecting it does NOT splice text —
   * the editor dispatches to its app-shipped handler registry by `kind`,
   * passing the adapter instance in play (so the handler can persist the
   * grant against the right credential and refresh the catalog). The
   * declaration originates from the adapter manifest's `connectActions`;
   * the language only carries it through.
   */
  connectAction?: {
    /** App-shipped client handler id, e.g. `'google-drive-picker'`. */
    kind: string;
    /** The adapter slug the instance constructs (aliases resolved). */
    adapter: string;
    /** The construction's credential import name, when it has one. */
    credential?: string;
  };
}

export interface MovementCompletions {
  /** Replace source[from..offset] with the picked item's `insert`. */
  from: number;
  items: MovementCompletionItem[];
}

const NO_COMPLETIONS: MovementCompletions = { from: 0, items: [] };

/**
 * The "+ connect" entries for the adapter instance a slot resolves against
 * — the generalised connect affordance. Each adapter-declared
 * `connectAction` becomes one entry; selecting it dispatches to the
 * editor's app-shipped handler registry by `kind` (the language carries the
 * declaration, never the UI). Empty for non-instance symbols, the ambient
 * kg / shapes (no adapter), and adapters that declare no actions.
 */
function connectActionItems(
  symbol: ScopeSymbol,
  snapshot: CatalogSnapshot,
): MovementCompletionItem[] {
  if (symbol.kind !== 'instance' || symbol.adapter === undefined) return [];
  const actions = snapshot.adapters[symbol.adapter]?.connectActions ?? [];
  return actions.map(action => ({
    label: `+ ${action.label}`,
    insert: '',
    kind: 'special' as const,
    detail: `${symbol.adapter}`,
    connectAction: {
      kind: action.kind,
      adapter: symbol.adapter as string,
      ...(symbol.credential !== undefined ? { credential: symbol.credential } : {}),
    },
  }));
}

const MOVEMENT_CAPABILITIES: FormulaCapabilities = {
  incomingEdges: false,
  edgeProperties: false,
  linkedObjects: false,
  resources: true,
  llm: true,
  kgGlobals: false,
};

const FILE_KEYWORDS: MovementCompletionItem[] = [
  { label: 'import', insert: 'import { ', kind: 'keyword', detail: 'bring names into scope' },
  { label: 'movement', insert: 'movement ', kind: 'keyword', detail: 'declare a movement' },
  { label: 'node', insert: 'node ', kind: 'keyword', detail: 'declare a reusable record structure' },
  { label: 'listen', insert: 'listen to ', kind: 'keyword', detail: 'fire a movement on events from an instance' },
];

const BODY_KEYWORDS: MovementCompletionItem[] = [
  { label: 'write', insert: 'write ', kind: 'keyword', detail: 'write a record' },
  { label: 'match', insert: 'match ', kind: 'keyword', detail: 'go on only if an existing record matches' },
  { label: 'if', insert: 'if ', kind: 'keyword', detail: 'branch' },
  { label: 'parallel', insert: 'parallel {', kind: 'keyword', detail: 'run statements concurrently' },
  { label: 'link', insert: 'link ', kind: 'keyword', detail: 'connect two records with an edge' },
];

/**
 * The ambient "meta-fields" — values a movement can read in any expression
 * with an `@` prefix. They exist at runtime (resolved per run by the engine,
 * see `resolveMovementMetaKey`); the editor surfaces them as completions and
 * hover so authors can discover them and read what each means. The `doc`
 * doubles as the hover text — single source of truth for key + description.
 */
const MOVEMENT_META_FIELDS: { key: string; doc: string }[] = CANONICAL_META_FIELDS.map(
  ({ key, doc }) => ({ key: `@${key}`, doc }),
);

const MOVEMENT_META_COMPLETIONS: MovementCompletionItem[] = MOVEMENT_META_FIELDS.map(
  ({ key, doc }) => ({ label: key, insert: key, kind: 'special', detail: doc }),
);

/** Lookup by `@`-prefixed key (e.g. `@actor_email`) → its hover description. */
const MOVEMENT_META_DOCS: Record<string, string> = Object.fromEntries(
  MOVEMENT_META_FIELDS.map(({ key, doc }) => [key, doc]),
);

/**
 * The movement standard library, as the editor surfaces it. Two surfaces from
 * one registry (the bare-coercer list + the namespaced families):
 *   - each bare coercer (`DATE` / `DATETIME` / `NUMBER`) is a function item —
 *     `DATE(…)` — that coerces a value to that scalar type;
 *   - each namespace (`CURRENCY` / `DATE` / `DATETIME` / `TEXT`) is a gateway
 *     item — `DATE.` — whose detail names its members; typing the dot then
 *     offers the members.
 * `DATE` and `DATETIME` legitimately appear as BOTH (the parser disambiguates
 * on `(` vs `.`, like JS `Date()` vs `Date.now()`); the duality is the point.
 */
const STDLIB_COERCER_COMPLETIONS: MovementCompletionItem[] = BARE_COERCERS.map(coercer => ({
  label: `${coercer.name}(…)`,
  insert: `${coercer.name}(`,
  kind: 'function',
  detail: coercer.summary,
}));

const STDLIB_NAMESPACE_COMPLETIONS: MovementCompletionItem[] = STDLIB_FAMILIES.map(family => ({
  label: `${family.namespace}.`,
  insert: `${family.namespace}.`,
  kind: 'function',
  detail: `${family.namespace.toLowerCase()} utilities: ${family.functions.map(fn => fn.name).join(', ')}`,
}));

const STDLIB_COMPLETIONS: MovementCompletionItem[] = [
  ...STDLIB_COERCER_COMPLETIONS,
  ...STDLIB_NAMESPACE_COMPLETIONS,
];

const RVALUE_KEYWORDS: MovementCompletionItem[] = [
  { label: 'write', insert: 'write ', kind: 'keyword', detail: 'bind the write handle' },
  { label: 'match', insert: 'match ', kind: 'keyword', detail: 'find an existing record by identity and bind it; never creates' },
  { label: 'link', insert: 'link ', kind: 'keyword', detail: 'match a record by a body, link it, and bind it' },
  { label: 'extract from', insert: 'extract from [', kind: 'keyword', detail: 'materialise an extraction' },
  { label: 'callback', insert: 'callback({', kind: 'keyword', detail: 'mint a deferred invocation: bind its .id into a button, await its Called edge' },
];

/** Plain-language hints for the language keywords — so hovering `movement`,
 *  `extract`, `listen`, `fire`, … explains the construct, not nothing. */
const KEYWORD_HOVERS: Record<string, string> = {
  import: 'import — bring names into scope: adapters, credentials, plugins, or a movement file’s exports',
  movement: 'movement — a named unit of work over one position; a listener fires it for each event',
  function: 'function — the same declaration as movement; both spellings are accepted',
  callback: 'callback — a deferred invocation scoped to this run: cb.id is the payload a button carries, cb.url the link a human follows, and await cb-[:Called]-> waits for a tap',
  listen: 'listen — run a movement on an instance’s events: listen to <instance> fire <movement>',
  to: 'to — the instance to listen on, in a listen statement',
  fire: 'fire — the movement to run for each event, in a listen statement',
  write: 'write — create or update a record; a match (see unique by) updates instead of duplicating',
  if: 'if — branch on a condition; an IS test narrows the position inside the arm',
  else: 'else — taken when the preceding if conditions are all false',
  parallel: 'parallel — run the enclosed statements concurrently; their bindings come into scope after the block',
  match: 'match — find an existing record by its unique by identity and bind it; never creates or writes. On a miss the rest of the block is skipped',
  link: 'link — connect two records with an edge: one you hold (`link a -[:e]-> b`), or one a match body finds (`link a -[:e]-> { … }`, which is match then link)',
  unlink: 'unlink — remove an edge between two records',
  bind: 'bind — deprecated, under review; identify a record by unique by instead',
  run: 'run — invoke a movement directly',
  extract: 'extract — materialise structured records from a source with AI: extract from [ … ] { node … }',
  from: 'from — the source(s) an extract reads',
  node: 'node — anonymous (`node { … }`) builds a record in memory; named at the top level (`node Doc { … }`) declares a reusable structure a parameter can name, nesting `node <edge name> { … }` for related records; inside an extract, an entity to pull out: node company: "…" { field: "…" }',
  through: 'through — run a plugin pipeline over an extract stage before the next stage',
  await: 'await — durably wait on a wake source, then resume: answer = await q-[:Response]-> (an ask), or await sleep(2d)',
  race: 'race — run branches concurrently and proceed at the first completion, cancelling the rest: race({ … }, { … })',
};

export function getMovementCompletions(
  source: string,
  offset: number,
  snapshot: CatalogSnapshot,
): MovementCompletions {
  const clamped = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, clamped);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineBefore = before.slice(lineStart);
  let lineEnd = source.indexOf('\n', clamped);
  if (lineEnd === -1) lineEnd = source.length;
  const fullLine = source.slice(lineStart, lineEnd);

  if (inComment(before)) return NO_COMPLETIONS;

  const partialMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(lineBefore);
  const partial = partialMatch?.[0] ?? '';
  const wordFrom = clamped - partial.length;
  const done = (items: MovementCompletionItem[], from = wordFrom): MovementCompletions => ({
    from,
    items: filterByPrefix(items, source.slice(from, clamped)),
  });

  // ── import statements (pure lexical — no analysis needed) ──
  if (/^\s*import\b/.test(lineBefore)) {
    // `from "<partial path>` — the saved movement files are the path space.
    const filePath = /\bfrom\s+"([^"]*)$/.exec(lineBefore);
    if (filePath) {
      const items = Object.keys(snapshot.files ?? {}).map(path => ({
        label: path,
        insert: `${path}"`,
        kind: 'value' as const,
        detail: 'movement file',
      }));
      return done(items, clamped - filePath[1].length);
    }
    if (/\bfrom\s+[A-Za-z_]?\w*$/.test(lineBefore)) {
      const items: MovementCompletionItem[] = [
        { label: 'adapters', insert: 'adapters', kind: 'keyword', detail: 'adapter types' },
        { label: 'credentials', insert: 'credentials', kind: 'keyword', detail: 'workspace credentials' },
        { label: 'plugins', insert: 'plugins', kind: 'keyword', detail: 'transform plugins' },
      ];
      if (Object.keys(snapshot.files ?? {}).length > 0) {
        items.push({
          label: '"<file>"',
          insert: '"',
          kind: 'keyword',
          detail: 'movements and shapes from a saved movement file',
        });
      }
      return done(items);
    }
    if (/\{[^}]*$/.test(lineBefore)) {
      return done(importNameItems(snapshot, fullLine), nameReplaceFrom(lineBefore, lineStart, wordFrom));
    }
    return NO_COMPLETIONS;
  }

  const analysis = analyze(source, snapshot, { cursorOffset: clamped });
  const lineStarts = lineStartsOf(source);
  const loc = locOfOffset(lineStarts, clamped);
  const scope = analysis.symbolsAt(loc);

  // ── listen statements: `listen to <instance> { <config> } fire <movement>` ──
  if (/^\s*listen\s+[A-Za-z_]?\w*$/.test(lineBefore) && !/\bto\b/.test(lineBefore)) {
    return done([{ label: 'to', insert: 'to ', kind: 'keyword', detail: 'the instance to listen on' }]);
  }
  if (/^\s*listen\s+to\s+[A-Za-z_]?\w*$/.test(lineBefore)) {
    const items: MovementCompletionItem[] = [];
    for (const symbol of scope.values()) {
      if (symbol.kind === 'instance') {
        items.push({
          label: symbol.name,
          insert: symbol.name,
          kind: 'value',
          detail: describeGraphSymbol(symbol),
        });
      }
    }
    return done(items);
  }
  if (/^\s*listen\s+to\s+\w+.*\bfire\s+[A-Za-z_]?\w*$/.test(lineBefore)) {
    const items: MovementCompletionItem[] = [];
    for (const symbol of scope.values()) {
      if (symbol.kind === 'movement') {
        items.push({
          label: symbol.name,
          insert: symbol.name,
          kind: 'function',
          detail: 'the movement this listener fires',
        });
      }
    }
    return done(items);
  }
  const listenConfig = /^\s*listen\s+to\s+([A-Za-z_]\w*)\s*\{[^}]*$/.exec(lineBefore);
  if (listenConfig && /[{,]\s*[A-Za-z_]?\w*$/.test(lineBefore)) {
    const instance = scope.get(listenConfig[1]);
    const vocabulary =
      instance?.adapter !== undefined
        ? snapshot.adapters[instance.adapter]?.triggerConfig
        : undefined;
    return done(
      (vocabulary ?? []).map(key => ({
        label: key,
        insert: `${key}: `,
        kind: 'value' as const,
        detail: `${instance?.adapter} listener config`,
      })),
    );
  }
  if (/^\s*listen\s+to\s+\w+\s*(?:\{[^{}]*\})?\s+[A-Za-z_]?\w*$/.test(lineBefore)) {
    return done([
      { label: 'fire', insert: 'fire ', kind: 'keyword', detail: 'the movement to run' },
    ]);
  }

  // ── construction args: `crm = attio(<arg>: …, <arg>: …)` ──
  // The callee is a NAME (bare or backtick-quoted), so a dash-slugged adapter —
  // `` `native-valuations`(…) `` — surfaces its argument suggestions too.
  const constructionArg = /^\s*[A-Za-z_]\w*\s*=\s*(`[^`\n]+`|[A-Za-z_]\w*)\(([^)]*)$/.exec(lineBefore);
  if (constructionArg && /[(,]\s*[A-Za-z_]?\w*$/.test(lineBefore)) {
    const calleeName = unquoteName(constructionArg[1]);
    const callee = scope.get(calleeName);
    const spec = callee?.kind === 'adapter' ? snapshot.adapters[callee.name] : undefined;
    if (spec) {
      const given = new Set(
        [...constructionArg[2].matchAll(/([A-Za-z_]\w*)\s*:/g)].map(m => m[1]),
      );
      const items: MovementCompletionItem[] = [];
      for (const carg of spec.constructionArgs) {
        if (given.has(carg.name)) continue;
        items.push({
          label: carg.name,
          insert: `${carg.name}: `,
          kind: 'value',
          detail:
            carg.kind === 'credential'
              ? `an imported ${calleeName} credential`
              : `${calleeName} construction argument`,
        });
      }
      if (!given.has('dry_run')) {
        items.push({
          label: 'dry_run',
          insert: 'dry_run: true',
          kind: 'special',
          detail: 'rehearse writes to this instance instead of committing them',
        });
      }
      return done(items);
    }
  }

  // ── construction credential value: `crm = attio(credentials: <cred>` ──
  // Offer the in-scope credentials the constructing adapter can actually
  // authenticate with — a slack credential is a type error in an attio
  // construction — backtick-quoting any name that isn't identifier-safe.
  const constructionVal = /^\s*[A-Za-z_]\w*\s*=\s*(`[^`\n]+`|[A-Za-z_]\w*)\(([^)]*)$/.exec(lineBefore);
  if (constructionVal) {
    const callee = scope.get(unquoteName(constructionVal[1]));
    const adapterSlug = callee?.kind === 'adapter' ? callee.importedName ?? callee.name : undefined;
    const spec = adapterSlug !== undefined ? snapshot.adapters[adapterSlug] : undefined;
    const currentArg = constructionVal[2].slice(constructionVal[2].lastIndexOf(',') + 1);
    const argName = /^\s*([A-Za-z_]\w*)\s*:\s*/.exec(currentArg)?.[1];
    const credArg = spec ? credentialArgOf(spec) : undefined;
    if (adapterSlug !== undefined && credArg !== undefined && argName === credArg.name) {
      const items: MovementCompletionItem[] = [];
      for (const symbol of scope.values()) {
        if (symbol.kind !== 'credential') continue;
        const cred = snapshot.credentials[symbol.importedName ?? symbol.name];
        if (cred !== undefined) {
          const adapters = 'adapters' in cred ? cred.adapters : [cred.adapter];
          if (!adapters.includes(adapterSlug)) continue;
        }
        items.push({
          label: symbol.name,
          insert: quoteIfNeeded(symbol.name),
          kind: 'value',
          detail: `${adapterSlug} credential`,
        });
      }
      return done(items, nameReplaceFrom(lineBefore, lineStart, wordFrom));
    }
  }

  // ── write target: `write crm.` → writable roots; `write ` → graphs/handles ──
  const writeTarget = /\bwrite\s+([A-Za-z_]\w*)\.([A-Za-z_]?\w*)?$/.exec(lineBefore);
  if (writeTarget) {
    const graph = scope.get(writeTarget[1]);
    if (!graph) return NO_COMPLETIONS;
    // The writable roots an instance enumerates depend on what's been
    // granted (Sheets: the picked spreadsheets' tables). Where the adapter
    // declares a connect action, offer it alongside — "+ Connect a Google
    // Sheet" — so an author with no granted file yet can grant one in place.
    const connectItems = connectActionItems(graph, snapshot);
    if (!graph.schema) return connectItems.length > 0 ? done(connectItems) : NO_COMPLETIONS;
    return done([
      ...Object.entries(graph.schema.writableRoots).map(([name, root]) => ({
        label: name,
        insert: name,
        kind: 'value' as const,
        detail: `fields: ${Object.keys(root.fields).join(', ') || '—'}`,
      })),
      ...connectItems,
    ]);
  }
  if (/\bwrite\s+[A-Za-z_]?\w*$/.test(lineBefore)) {
    const items: MovementCompletionItem[] = [];
    for (const symbol of scope.values()) {
      // A declaration's nodes are writable roots on paper — that is how the
      // retired declaration-WRITE construct resolved. The checker refuses it now, so
      // offering it here would complete straight into an error.
      if (symbol.kind === 'shape') continue;
      if (symbol.schema && Object.keys(symbol.schema.writableRoots).length > 0) {
        items.push({
          label: `${symbol.name}.`,
          insert: `${symbol.name}.`,
          kind: 'value',
          detail: describeGraphSymbol(symbol),
        });
      } else if (symbol.posType?.kind === 'handle') {
        items.push({
          label: symbol.name,
          insert: symbol.name,
          kind: 'value',
          detail: `${describePosition(symbol.posType)} — start a linked write`,
        });
      }
    }
    return done(items);
  }

  // ── type position: movement params and IS tests (`<graph-[:position]->>`) ──
  // Types wear angle brackets and name their edge as an address ('.' is for
  // properties); completions insert the address spelling (the opening `<` is
  // added when not already typed, the position closes the hop and the marker).
  const typeRef =
    /\bmovement\s+\w+\s*\([^)]*:\s*<\s*([A-Za-z_]\w*)-\[\s*:\s*`?([A-Za-z_]?[\w ]*)?$/.exec(lineBefore)
    ?? /\bIS\s+<\s*([A-Za-z_]\w*)-\[\s*:\s*`?([A-Za-z_]?[\w ]*)?$/.exec(lineBefore);
  if (typeRef) {
    const graph = scope.get(typeRef[1]);
    if (!graph) return NO_COMPLETIONS;
    const connectItems = connectActionItems(graph, snapshot);
    if (!graph.schema) return connectItems.length > 0 ? done(connectItems) : NO_COMPLETIONS;
    return done([...typeNameItems(graph.schema), ...connectItems]);
  }
  if (/\bmovement\s+\w+\s*\([^)]*:\s*<?\s*[A-Za-z_]?\w*$/.test(lineBefore) || /\bIS\s+<?\s*[A-Za-z_]?\w*$/.test(lineBefore)) {
    const bracketTyped = /<\s*[A-Za-z_]?\w*$/.test(lineBefore);
    const items: MovementCompletionItem[] = [];
    for (const symbol of scope.values()) {
      if (symbol.schema) {
        items.push({
          label: `<${symbol.name}-[:`,
          insert: `${bracketTyped ? '' : '<'}${symbol.name}-[:`,
          kind: 'value',
          detail: describeGraphSymbol(symbol),
        });
      }
    }
    return done(items);
  }

  // ── `through [` plugin pipelines ──
  if (/\bthrough\s*\[\s*[A-Za-z_]?\w*$/.test(lineBefore)) {
    return done(
      Object.entries(snapshot.plugins).map(([name, spec]) => ({
        label: name,
        insert: name,
        kind: 'function' as const,
        detail: spec.args.length ? `args: ${spec.args.join(', ')}` : 'plugin',
      })),
    );
  }

  // ── `unique by (` identity components ──
  if (/\bunique\s+by\s*\([^)]*$/.test(lineBefore)) {
    const region = analysis.writeAt(loc);
    const items: MovementCompletionItem[] = [];
    // FUZZY prefixes a component to match it by similarity — only offered where
    // the target's adapter can resolve identity fuzzily.
    if (region?.root?.fuzzyResolution !== undefined) {
      items.push({
        label: 'FUZZY',
        insert: 'FUZZY ',
        kind: 'special',
        detail: 'match the next component by similarity, not exactly',
      });
    }
    for (const field of Object.keys(region?.root?.fields ?? {})) {
      items.push({ label: `\`${field}\``, insert: `\`${field}\``, kind: 'value', detail: 'identity by field value' });
    }
    for (const symbol of scope.values()) {
      if (symbol.posType?.kind === 'handle') {
        items.push({ label: symbol.name, insert: symbol.name, kind: 'special', detail: 'identity by edge to this record' });
      }
    }
    const backtickFrom = lineBefore.endsWith('`' + partial) ? wordFrom - 1 : wordFrom;
    return done(items, backtickFrom);
  }

  // ── borrowed type annotations: `stage: <crm-[:companies]->.\`funding_stage\`>` ──
  // A field-entry line whose value is a bracketed borrowed type (an extract
  // field's — or a declared field's): an edge into the other graph, then the
  // field as a property tail. Write bodies are excluded: there a name after
  // the colon is an expression, not a type.
  const borrowed =
    /^\s*[A-Za-z_]\w*\s*:\s*<\s*([A-Za-z_]\w*)-\[\s*:\s*(?:(`[^`\n]+`|[A-Za-z_]\w*)\s*\]->\.)?`?[A-Za-z_]?[\w ]*$/.exec(
      lineBefore,
    );
  if (borrowed && analysis.writeAt(loc) === undefined) {
    const graph = scope.get(borrowed[1]);
    if (graph?.schema) {
      if (borrowed[2] === undefined) {
        const names = new Set([
          ...Object.keys(graph.schema.writableRoots),
          ...Object.keys(graph.schema.positions),
        ]);
        return done(
          [...names].map(name => ({
            label: name,
            insert: `${quoteIfNeeded(name)}]->.`,
            kind: 'value' as const,
            detail: `borrow a field type from ${borrowed[1]}-[:${name}]->`,
          })),
        );
      }
      const rootName = unquoteName(borrowed[2]);
      const fields = borrowableFieldsOf(graph.schema, rootName);
      if (fields) {
        return done(
          Object.entries(fields).map(([name, type]) => ({
            label: name,
            insert: `\`${name}\`>`,
            kind: 'value' as const,
            detail: `${describeFieldType(type)} — borrowed from ${borrowed[1]}-[:${rootName}]->`,
          })),
        );
      }
    }
  }

  // ── traversal edges: `…-[` / `…-[alias:` ──
  const traversal = /^(.*?)(<?-\[\s*(?:[A-Za-z_]\w*\s*:)?\s*:?\s*`?(#?[A-Za-z_]?\w*)?)$/.exec(lineBefore);
  if (traversal) {
    const position = chainPositionAt(traversal[1], scope);
    const items = position ? edgeItems(position) : [];
    if (position?.kind === 'position' || position?.kind === 'handle') {
      items.push({
        label: '_resources',
        insert: '_resources]->',
        kind: 'edge',
        detail: 'attached files / documents',
      });
    }
    const partialEdge = traversal[3] ?? '';
    return done(items, clamped - partialEdge.length);
  }

  // ── property read: `<chain>.` → backticked fields ──
  const propertyRead = /^(.*)\.(`?)([A-Za-z_]?\w*)?$/.exec(lineBefore);
  if (propertyRead && /(?:\]->|[A-Za-z0-9_]|`)$/.test(propertyRead[1])) {
    const position = chainPositionAt(propertyRead[1], scope);
    if (position) {
      const tickTyped = propertyRead[2] === '`';
      const partialProp = propertyRead[3] ?? '';
      const from = clamped - partialProp.length - (tickTyped ? 1 : 0);
      return done(propertyItems(position), from);
    }
  }

  // ── inside a hop WHERE: offer only the fields the source can filter by ──
  // (adapter-capability-contract chunk 6). The cursor is inside an unclosed
  // `-[ … WHERE … ]` bracket, at a field-name position. Offer the hop TARGET's
  // properties, narrowed to what's filterable: a `native` edge offers only the
  // fields the source can filter server-side; a `bounded` edge (or an
  // under-described one) offers all — the engine filters those in-app.
  const whereField = hopWhereFieldContext(lineBefore);
  if (whereField) {
    const target = chainPositionAt(`${whereField.root}-[__w:${whereField.edge}]->`, scope);
    const source = chainPositionAt(whereField.root, scope);
    if (target) {
      const items = filterableFieldItems({ target, source, edge: whereField.edge });
      const from = clamped - whereField.partial.length - (whereField.tickTyped ? 1 : 0);
      return done(items, from);
    }
  }

  // ── inside a write body: field names + unique by ──
  const blankLine = /^\s*[A-Za-z_]?\w*$/.test(lineBefore);
  if (blankLine) {
    const region = analysis.writeAt(loc);
    if (region) {
      const items: MovementCompletionItem[] = [];
      if (!region.hasUniqueBy) {
        items.push({
          label: 'unique by (…)',
          insert: 'unique by (',
          kind: 'keyword',
          detail: 'how to identify an existing record',
        });
      }
      for (const [name, type] of Object.entries(region.root?.fields ?? {})) {
        if (region.declaredFields.has(name)) continue;
        items.push({
          label: name,
          insert: `${name}: `,
          kind: 'value',
          detail: `${describeFieldType(type)} — field of ${region.description}`,
        });
      }
      return done(items);
    }
  }

  // ── statement start: keywords + callable movements + traversable names ──
  if (blankLine) {
    const frame = analysis.frameAt(loc);
    const items: MovementCompletionItem[] =
      frame === undefined || frame.kind === 'file' ? [...FILE_KEYWORDS] : [...BODY_KEYWORDS];
    if (frame !== undefined && frame.kind !== 'file') {
      for (const symbol of scope.values()) {
        if (symbol.kind === 'movement') {
          items.push({ label: `${symbol.name}(…)`, insert: `${symbol.name}(`, kind: 'function', detail: 'call this movement' });
        } else if (symbol.posType !== undefined || symbol.schema !== undefined) {
          // A statement can start a traversal/write off a graph or a position
          // (`crm-[:companies]->`, `link msg`) — deliberately excludes a
          // scalar binding (fieldType, no posType): you can't traverse or
          // write off a plain value, only read it in an expression.
          items.push({
            label: symbol.name,
            insert: symbol.name,
            kind: 'value',
            detail: hoverTypeLine(symbol),
          });
        }
      }
    }
    return done(items);
  }

  // ── rvalue start: `x = ` ──
  if (/^\s*[A-Za-z_]\w*\s*=\s*[A-Za-z_]?\w*$/.test(lineBefore)) {
    const items: MovementCompletionItem[] = [...RVALUE_KEYWORDS];
    for (const symbol of scope.values()) {
      if (symbol.kind === 'adapter') {
        items.push({
          label: `${symbol.name}(credentials: …)`,
          insert: `${symbol.name}(credentials: `,
          kind: 'function',
          detail: 'construct an instance',
        });
      } else if (
        symbol.posType !== undefined ||
        symbol.schema !== undefined ||
        symbol.fieldType !== undefined
      ) {
        // An rvalue position is an expression start — a scalar binding (has a
        // fieldType, not a posType: `price = msg.\`amount\``) is a legal read
        // here (`total = price`), unlike at statement start where nothing can
        // traverse or write off it.
        items.push({ label: symbol.name, insert: symbol.name, kind: 'value', detail: hoverTypeLine(symbol) });
      }
    }
    return done(items);
  }

  // ── enum field value: offer the target field's options ──
  // A write-body field whose value type is an enum — `stage: "¦"` or bare
  // `stage: ¦` — suggests the allowed options, bare-quoting them only when
  // the cursor isn't already inside a string literal.
  const fieldValue = scanFieldEntry(lineBefore);
  if (fieldValue) {
    const fieldName = fieldValue.name;
    const fieldType = analysis.writeAt(loc)?.root?.fields?.[fieldName];
    if (isEnumType(fieldType)) {
      const inString = (fieldValue.value.match(/"/g)?.length ?? 0) % 2 === 1;
      const enumItems: MovementCompletionItem[] = fieldType.options.map((option): MovementCompletionItem => ({
        label: option,
        insert: inString ? option : `"${option}"`,
        kind: 'value',
        detail: `option of ${fieldName}`,
      }));
      if (inString) return done(enumItems);
      return expressionCompletions({ lineBefore, scope, done, prepend: enumItems });
    }
  }

  // ── expression position: delegate to the shared formula engine ──
  return expressionCompletions({ lineBefore, scope, done });
}

// ── Expression delegation ──

function expressionCompletions(input: {
  lineBefore: string;
  scope: Map<string, ScopeSymbol>;
  done: (items: MovementCompletionItem[], from?: number) => MovementCompletions;
  /** Items to surface ahead of the formula engine's (e.g. enum options). */
  prepend?: MovementCompletionItem[];
}): MovementCompletions {
  const { lineBefore, scope, done, prepend = [] } = input;
  const segment = expressionSegment(lineBefore);
  if (segment === undefined) return prepend.length > 0 ? done(prepend) : NO_COMPLETIONS;

  // ── namespace member access: `DATE.par` → the DATE family's members ──
  // The partial after the dot is `wordFrom`, so the default `from` prefix-filters.
  const memberItems = stdlibMemberCompletions(segment.text);
  if (memberItems !== undefined) return done(memberItems);

  const delegated = formulaCompletions(
    segment.text,
    segment.text.length,
    [],
    [],
    undefined,
    undefined,
    undefined,
    MOVEMENT_CAPABILITIES,
  );
  const items: MovementCompletionItem[] = [
    ...prepend,
    ...delegated.map(c => ({ ...c })),
    ...MOVEMENT_META_COMPLETIONS,
    ...STDLIB_COMPLETIONS,
  ];

  if (valueExpecting(segment.text)) {
    for (const symbol of scope.values()) {
      // Same rationale as the rvalue-start gate: a scalar binding (fieldType,
      // no posType) is an ordinary value in an operator/rvalue position —
      // `total = price * ¦` should offer `price`.
      if (
        symbol.posType !== undefined ||
        symbol.schema !== undefined ||
        symbol.fieldType !== undefined
      ) {
        items.push({ label: symbol.name, insert: symbol.name, kind: 'special', detail: hoverTypeLine(symbol) });
      }
    }
  } else if (segment.isCondition && /[`\w\])]\s+[A-Za-z_]?\w*$/.test(segment.text)) {
    items.push({ label: 'IS', insert: 'IS ', kind: 'keyword', detail: 'type test — narrows in the block' });
  }
  return done(items);
}

/** Matches a trailing `<Namespace>.<partial>` not preceded by an identifier
 *  char, a dot, or a backtick (so it's a fresh namespace, not a field read). */
const STDLIB_MEMBER_ACCESS = /(?:^|[^A-Za-z0-9_.`])([A-Za-z_]\w*)\.(\w*)$/;

/**
 * When the expression segment ends in `<KnownNamespace>.<partial>`, the member
 * items of that stdlib family — one per `family.functions[]`. Returns undefined
 * when the trailing token isn't a known namespace member access (so the caller
 * falls through to the ordinary expression completions). The partial after the
 * dot is the editor's `wordFrom`, so returning these with the default `from`
 * prefix-filters them automatically.
 */
function stdlibMemberCompletions(text: string): MovementCompletionItem[] | undefined {
  const match = STDLIB_MEMBER_ACCESS.exec(text);
  if (!match) return undefined;
  const family = stdlibFamily(match[1]);
  if (!family) return undefined;
  return family.functions.map(fn => ({
    label: fn.name,
    insert: fn.name,
    kind: 'function' as const,
    detail: `${fn.signature} — ${fn.summary}`,
  }));
}

/**
 * The `<name> :` head of a write-body field entry, and the value tail after the
 * colon. The KEY is a NAME exactly as the parser reads it (`Parser.readName`):
 * a bare identifier when the exposed name is identifier-safe, or a backtick-quoted
 * name when it carries spaces / punctuation (`` `Snoozed Until`: … ``). Name
 * recognition comes from the parser's own scanner (`scanName`) so it can never
 * drift from the grammar — we do NOT re-encode the name grammar here.
 *
 * Returns the verbatim field name (backticks stripped, identical to the parser's
 * `readName` result) and the value text, or `undefined` when the line before the
 * cursor is not a `name :` field head.
 */
function scanFieldEntry(lineBefore: string): { name: string; value: string } | undefined {
  let pos = 0;
  while (pos < lineBefore.length && /\s/.test(lineBefore[pos])) pos++;
  const scanned = scanName(lineBefore, pos);
  if (scanned === null) return undefined;
  pos = scanned.end;
  while (pos < lineBefore.length && /\s/.test(lineBefore[pos])) pos++;
  if (lineBefore[pos] !== ':') return undefined;
  pos++;
  while (pos < lineBefore.length && /\s/.test(lineBefore[pos])) pos++;
  return { name: scanned.name, value: lineBefore.slice(pos) };
}

/** The expression text the cursor is completing within, on the current line. */
function expressionSegment(
  lineBefore: string,
): { text: string; isCondition: boolean } | undefined {
  // Interpolation: complete inside the LAST unclosed `${…}`.
  const interp = /\$\{([^}]*)$/.exec(lineBefore);
  if (interp) return { text: interp[1], isCondition: false };

  const condition = /^\s*(?:\}\s*)?(?:else\s+)?if\s+(.*)$/.exec(lineBefore);
  if (condition) return { text: condition[1], isCondition: true };

  const fieldEntry = scanFieldEntry(lineBefore);
  if (fieldEntry) return { text: fieldEntry.value, isCondition: false };

  const assignment = /^\s*[A-Za-z_]\w*\s*=\s*(.*)$/.exec(lineBefore);
  if (assignment) return { text: assignment[1], isCondition: false };

  const dataList = /\bfrom\s*\[\s*(.*)$/.exec(lineBefore);
  if (dataList) return { text: dataList[1], isCondition: false };

  return undefined;
}

function valueExpecting(text: string): boolean {
  const trimmed = text.replace(/[A-Za-z_]\w*$/, '').trimEnd();
  if (trimmed === '') return true;
  if (/[(,[+\-*/=<>]$/.test(trimmed)) return true;
  if (/\b(AND|OR|NOT|IF|THEN|ELSE)$/.test(trimmed)) return true;
  return false;
}

// ── Chains: resolving `root-[:hops]->` typed positions ──

/**
 * The position type at the end of the trailing chain of `text`
 * (`msg`, `deals-[c:company]->`, `co-[:rounds]->`), when derivable.
 */
function chainPositionAt(
  text: string,
  scope: Map<string, ScopeSymbol>,
): PositionTypeRef | undefined {
  const chain = /([A-Za-z_]\w*)((?:<?-\[[^\]]*\]->)*)$/.exec(text.trimEnd());
  if (!chain) return undefined;
  const symbol = scope.get(chain[1]);
  if (!symbol) return undefined;
  const rootType = positionTypeOf(symbol);
  if (rootType === undefined) return undefined;
  if (!chain[2]) return rootType;

  try {
    const parsed = parseMovementExpression(`${chain[1]}${chain[2]}.\`__probe__\``);
    if (parsed.type !== 'traverse') return undefined;
    // A completion walks hops only; nothing a version changes is read here.
    const typing = new ExpressionTyping({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      resolveRoot: name => {
        const s = scope.get(name);
        return s ? positionTypeOf(s) : undefined;
      },
      report: () => {},
      span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    });
    return typing.walkSteps(rootType, parsed.steps);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
}

function edgeItems(position: PositionTypeRef): MovementCompletionItem[] {
  const close = (name: string) => `${quoteIfNeeded(name)}]->`;
  switch (position.kind) {
    case 'meta':
      return Object.entries(position.instance.schema.collections).map(([name, collection]) => ({
        label: name,
        insert: close(name),
        kind: 'edge' as const,
        detail: `→ ${position.instance.name}.${collection.target}`,
      }));
    case 'position':
    case 'handle': {
      const schema = positionSchemaOfRef(position);
      return Object.entries(schema?.edges ?? {}).map(([name, edge]) => ({
        label: name,
        insert: close(name),
        kind: 'edge' as const,
        detail: `→ ${position.instance.name}.${edge.target}`,
      }));
    }
    case 'union': {
      const items = new Map<string, MovementCompletionItem>();
      for (const variant of position.variants) {
        const schema = position.instance.schema.positions[variant];
        for (const [name, edge] of Object.entries(schema?.edges ?? {})) {
          if (!items.has(name)) {
            items.set(name, {
              label: name,
              insert: close(name),
              kind: 'edge',
              detail: `→ ${position.instance.name}.${edge.target} (on ${variant})`,
            });
          }
        }
      }
      return [...items.values()];
    }
    case 'extract':
      return [...position.node.children.keys()].map(name => ({
        label: name,
        insert: close(name),
        kind: 'edge' as const,
        detail: 'extracted entities',
      }));
    case 'closure':
      // Nothing traverses off a closure — call it, and traverse what it
      // returns.
      return [];
    case 'local':
      return Object.entries(position.edges ?? {}).map(([name, local]) => ({
        label: name,
        insert: close(name),
        kind: 'edge' as const,
        detail: local.target !== undefined ? `→ ${describePosition(local.target)}` : '→ (unknown)',
      }));
    case 'maybeEmpty':
      return edgeItems(position.of);
  }
}

/**
 * Detect that the cursor sits inside an unclosed `-[ … WHERE … ]` bracket at a
 * field-name position (right after WHERE / AND / OR / NOT / `(` / a backtick),
 * and pull out the chain root, the edge name, and the partial field being
 * typed. Returns undefined when the cursor isn't in that position (e.g. after
 * an operator, where a VALUE is expected, not a field).
 */
function hopWhereFieldContext(
  lineBefore: string,
): { root: string; edge: string; partial: string; tickTyped: boolean } | undefined {
  const lastOpen = lineBefore.lastIndexOf('-[');
  if (lastOpen < 0 || lineBefore.slice(lastOpen).includes(']')) return undefined;
  const inner = lineBefore.slice(lastOpen + 2);
  const where = /^\s*(?:[A-Za-z_]\w*\s*:\s*)?(#?[A-Za-z_][\w ]*?)\s+WHERE\s+(.*)$/i.exec(inner);
  if (!where) return undefined;
  const edge = where[1].trim();
  const afterWhere = where[2];
  const tail = /(`?)([A-Za-z_]?\w*)$/.exec(afterWhere);
  if (!tail) return undefined;
  const before = afterWhere.slice(0, tail.index).trimEnd();
  // A field is expected at the start of the clause or right after a boolean
  // connective / open paren — NOT after a comparison operator (that's a value).
  const atFieldPosition = before === '' || /(?:\bWHERE\b|\bAND\b|\bOR\b|\bNOT\b|\(|!)$/i.test(before);
  if (!atFieldPosition) return undefined;
  return { root: lineBefore.slice(0, lastOpen), edge, partial: tail[2] ?? '', tickTyped: tail[1] === '`' };
}

/**
 * The hop target's properties a WHERE may filter by, capability-aware: a
 * `native` edge offers only the fields the source declares filterable
 * server-side; a `bounded` edge (or one whose source/target declares no
 * capability) offers all — the engine filters those in-app. Mirrors the gate
 * in typing.ts so suggestions never offer what authoring would reject.
 */
function filterableFieldItems(input: {
  target: PositionTypeRef;
  source: PositionTypeRef | undefined;
  edge: string;
}): MovementCompletionItem[] {
  const targetSchema = positionSchemaOfRef(input.target);
  if (!targetSchema) return [];
  const filterMode =
    input.source?.kind === 'meta'
      ? 'native' // a top-level collection is a native queryable endpoint
      : input.source !== undefined
        ? positionSchemaOfRef(input.source)?.edges[input.edge]?.capability?.filter
        : undefined;
  const caps = targetSchema.propertyCapabilities;
  const offerable = (name: string): boolean => {
    if (filterMode === 'bounded') return true; // shared unit filters any field
    if (caps === undefined) return true; // under-described ⇒ best-effort, offer all
    const ops = caps[name]?.filterOperators;
    return ops !== undefined && ops.length > 0;
  };
  return Object.entries(targetSchema.properties)
    .filter(([name]) => offerable(name))
    .map(([name, type]): MovementCompletionItem => ({
      label: name,
      insert: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``,
      kind: 'value',
      detail: `${describeFieldType(type)} — filterable here`,
    }));
}

function propertyItems(position: PositionTypeRef): MovementCompletionItem[] {
  const item = (name: string, type?: FieldType, detail?: string): MovementCompletionItem => ({
    label: name,
    insert: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``,
    kind: 'value',
    detail: detail ?? (type !== undefined ? describeFieldType(type) : undefined),
  });
  switch (position.kind) {
    case 'handle': {
      const items = Object.entries(position.resultShape).map(([n, t]) => item(n, t));
      const schema = positionSchemaOfRef(position);
      for (const [n, t] of Object.entries(schema?.properties ?? {})) {
        if (!(n in position.resultShape)) items.push(item(n, t));
      }
      return items;
    }
    case 'position': {
      const schema = positionSchemaOfRef(position);
      return Object.entries(schema?.properties ?? {}).map(([n, t]) => item(n, t));
    }
    case 'union': {
      const items = new Map<string, MovementCompletionItem>();
      for (const variant of position.variants) {
        const schema = position.instance.schema.positions[variant];
        for (const [n, t] of Object.entries(schema?.properties ?? {})) {
          if (!items.has(n)) items.set(n, item(n, t, `${describeFieldType(t)} (on ${variant})`));
        }
      }
      return [...items.values()];
    }
    case 'extract': {
      const items: MovementCompletionItem[] = [];
      for (const [n, info] of position.node.properties) {
        const type = info.explicit;
        items.push(item(n, type, type !== undefined ? describeFieldType(type) : 'extracted field'));
      }
      return items;
    }
    case 'local':
      return Object.entries(position.reads).map(([n, t]) => item(n, t));
    case 'maybeEmpty':
      return propertyItems(position.of);
    case 'closure':
      // A closure carries no data — only a signature.
      return [];
    case 'meta':
      return [];
  }
}

// ── Definitions (cmd-click navigation) ──

/** Where a name at a position comes from — the editor maps each kind to a
 *  page: 'file' to that movement file's page (name is the file's path/name),
 *  the namespaces to their workspace pages (name is the ORIGINAL name in
 *  the namespace, import aliases resolved). */
export interface DefinitionTarget {
  kind: 'file' | 'adapters' | 'credentials' | 'plugins';
  name: string;
}

/**
 * The definition target of the token at `offset`, when it resolves to
 * something outside this file:
 *   - on an IMPORT line: the names inside the braces (originals and
 *     aliases alike) target their source; the quoted path targets the file;
 *   - at a USE SITE: a name bound by an import resolves through the
 *     analysis scope to the same target (adapter types at construction
 *     calls, credentials in construction args, plugins in `through […]`,
 *     imported movements/shapes anywhere they're used).
 * Locally-declared names (instances, params, handles, movements declared
 * in this file) have no external definition — undefined.
 */
export function getDefinition(
  source: string,
  offset: number,
  snapshot?: CatalogSnapshot,
): DefinitionTarget | undefined {
  const fromImportLine = importLineTarget(source, offset);
  if (fromImportLine) return fromImportLine;

  const word = wordAt(source, offset);
  if (!word) return undefined;
  const snap = snapshot ?? EMPTY_CATALOG_SNAPSHOT;
  const analysis = analyze(source, snap, { cursorOffset: offset });
  const loc = locOfOffset(lineStartsOf(source), word.from);
  const symbol = analysis.resolveAt(word.text, loc);
  if (!symbol) return undefined;
  switch (symbol.kind) {
    case 'adapter':
      return { kind: 'adapters', name: symbol.importedName ?? symbol.name };
    case 'credential':
      return { kind: 'credentials', name: symbol.importedName ?? symbol.name };
    case 'plugin':
      return { kind: 'plugins', name: symbol.importedName ?? symbol.name };
    default:
      // File-imported movements/shapes (and opaque file imports) carry
      // their import path; everything else is defined in this file.
      return symbol.importPath !== undefined
        ? { kind: 'file', name: symbol.importPath }
        : undefined;
  }
}

const IMPORT_LINE = /^(\s*import\s*\{)([^}]*)(\}\s*from\s+)(\S.*?)\s*$/;

/** Lexical resolution on an import line — covers tokens the scope can't
 *  (the ORIGINAL name of an aliased import, the quoted file path). */
function importLineTarget(source: string, offset: number): DefinitionTarget | undefined {
  const clamped = Math.max(0, Math.min(offset, source.length));
  const lineStart = source.lastIndexOf('\n', clamped - 1) + 1;
  let lineEnd = source.indexOf('\n', clamped);
  if (lineEnd === -1) lineEnd = source.length;
  const match = IMPORT_LINE.exec(source.slice(lineStart, lineEnd));
  if (!match) return undefined;
  const col = clamped - lineStart;

  const quotedPath = /^"([^"]*)"/.exec(match[4]);
  const namespace = /^(adapters|credentials|plugins)\b/.exec(match[4])?.[1] as
    | 'adapters'
    | 'credentials'
    | 'plugins'
    | undefined;

  // A name inside the braces: either the original or its alias targets
  // the ORIGINAL name in the import's source.
  const namesStart = match[1].length;
  if (col >= namesStart && col <= namesStart + match[2].length) {
    let cursor = namesStart;
    for (const clause of match[2].split(',')) {
      const clauseStart = cursor;
      cursor += clause.length + 1;
      if (col < clauseStart || col > clauseStart + clause.length) continue;
      const parts = /^(\s*)([A-Za-z_]\w*)(?:(\s+as\s+)([A-Za-z_]\w*))?\s*$/.exec(clause);
      if (!parts) return undefined;
      const nameFrom = clauseStart + parts[1].length;
      const nameTo = nameFrom + parts[2].length;
      const aliasFrom = parts[4] !== undefined ? nameTo + parts[3].length : undefined;
      const onName = col >= nameFrom && col <= nameTo;
      const onAlias =
        aliasFrom !== undefined && col >= aliasFrom && col <= aliasFrom + parts[4].length;
      if (!onName && !onAlias) return undefined;
      if (quotedPath) return { kind: 'file', name: quotedPath[1] };
      return namespace !== undefined ? { kind: namespace, name: parts[2] } : undefined;
    }
    return undefined;
  }

  // The quoted path itself.
  if (quotedPath) {
    const pathFrom = match[1].length + match[2].length + match[3].length + 1;
    if (col >= pathFrom && col <= pathFrom + quotedPath[1].length) {
      return { kind: 'file', name: quotedPath[1] };
    }
  }
  return undefined;
}

// ── Hover ──

export interface MovementHover {
  from: number;
  to: number;
  /** Plain-text lines: headline first, then detail lines. */
  contents: string[];
}

export function getHoverInfo(
  source: string,
  offset: number,
  snapshot: CatalogSnapshot,
): MovementHover | undefined {
  // A backtick-quoted name (`\`Sender Name\``) is one token even with spaces —
  // prefer it so multi-word fields resolve.
  const word = backtickTokenAt(source, offset) ?? wordAt(source, offset);
  if (!word) return undefined;
  // The `from` target of an import describes the SOURCE namespace, not the
  // imported value of the same spelling.
  const importHover = importContextHover(source, word);
  if (importHover) return importHover;
  const analysis = analyze(source, snapshot, { cursorOffset: offset });
  const lineStarts = lineStartsOf(source);
  const loc = locOfOffset(lineStarts, word.from);
  // `unique by` is a keyword, not a symbol — hovering it inside a write
  // body explains identity for THIS write, including the target's own
  // native rules (the adapter matches by those regardless of authoring).
  if (word.text === 'unique' || word.text === 'by') {
    const uniqueHover = uniqueByHover(analysis, loc, word);
    if (uniqueHover) return uniqueHover;
  }
  // An `@`-prefixed meta-field (`@actor_email`, `@current_date`, …). `wordAt`
  // strips the `@`, so the sigil sits just before the token — recover it and
  // extend the hover range over it.
  const metaHover = movementMetaHover(source, word);
  if (metaHover) return metaHover;
  // The stdlib surfaces — bare coercers (`DATE(` …) and namespaced families
  // (`DATE.parse`, `CURRENCY.…`). Dispatched before symbol resolution: a user
  // field literally named DATE is implausible, and the char after the token
  // (`(` vs `.`) tells coercer from namespace, so this only fires on real
  // stdlib intent.
  const stdlibHov = stdlibHover(source, word);
  if (stdlibHov) return stdlibHov;
  const symbol = analysis.resolveAt(word.text, loc);
  // Not a symbol: a field read (`item.Text`), a write-body field key (`Name:`),
  // then a language keyword.
  if (!symbol) {
    const fieldHover = fieldAccessHover(source, word, analysis.symbolsAt(loc));
    if (fieldHover) return withWriteTargetNativeRule(fieldHover, word, analysis.writeAt(loc));
    const keyHover = writeFieldKeyHover(source, word, analysis.writeAt(loc));
    if (keyHover) return keyHover;
    const edgeHover = traversalEdgeHover(source, word, analysis, loc);
    if (edgeHover) return edgeHover;
    const cfgHover = configKeyHover(source, word, analysis.symbolsAt(loc), snapshot);
    if (cfgHover) return cfgHover;
    const keyword = KEYWORD_HOVERS[word.text];
    return keyword !== undefined ? { from: word.from, to: word.to, contents: [keyword] } : undefined;
  }
  const contents = hoverContents(symbol, snapshot);
  if (contents.length === 0) return undefined;
  return { from: word.from, to: word.to, contents };
}

/** Hover for an `@`-prefixed meta-field. The hovered token may carry the `@`
 *  (`word.text === '@actor_email'`) or not (`wordAt` strips it, leaving the
 *  sigil at `word.from - 1`) — handle both, extending the range over the `@`. */
function movementMetaHover(
  source: string,
  word: { text: string; from: number; to: number },
): MovementHover | undefined {
  if (word.text.startsWith('@')) {
    const doc = MOVEMENT_META_DOCS[word.text];
    return doc ? { from: word.from, to: word.to, contents: [doc] } : undefined;
  }
  if (source[word.from - 1] !== '@') return undefined;
  const doc = MOVEMENT_META_DOCS[`@${word.text}`];
  return doc ? { from: word.from - 1, to: word.to, contents: [doc] } : undefined;
}

/**
 * Hover for the movement standard library — mirrors `movementMetaHover`,
 * single registries (BARE_COERCERS + STDLIB_FAMILIES) feeding both completion
 * and hover. Three cases, disambiguated by the character after the token:
 *   - a bare coercer (`DATE` / `DATETIME` / `NUMBER`) immediately followed by
 *     `(` → its summary; for `DATE` and `DATETIME`, also the namespace duality;
 *   - a namespace (`CURRENCY` / `DATE` / `DATETIME` / `TEXT`) immediately
 *     followed by `.` → the family's members and their summaries;
 *   - a member name right after `<Namespace>.` → that member's signature/summary.
 */
function stdlibHover(
  source: string,
  word: { text: string; from: number; to: number },
): MovementHover | undefined {
  const here = (contents: string[]): MovementHover => ({ from: word.from, to: word.to, contents });
  const after = source[word.to];
  const beforeDot = source[word.from - 1] === '.' ? source[word.from - 2] : undefined;

  // A member name right after `<Namespace>.` (e.g. PARSE in `DATE.PARSE`).
  if (source[word.from - 1] === '.' && beforeDot !== undefined && /[A-Za-z0-9_]/.test(beforeDot)) {
    const nsStart = (() => {
      let i = word.from - 1; // the dot
      let j = i - 1;
      while (j >= 0 && /[A-Za-z0-9_]/.test(source[j])) j--;
      return { name: source.slice(j + 1, i), from: j + 1 };
    })();
    const family = stdlibFamily(nsStart.name);
    const member = family?.functions.find(fn => fn.name.toUpperCase() === word.text.toUpperCase());
    if (member) return here([`${member.signature} — ${member.summary}`]);
    return undefined;
  }

  // A namespace immediately followed by `.` (e.g. `DATE.`).
  if (after === '.') {
    const family = stdlibFamily(word.text);
    if (family) {
      return here([
        `${family.namespace} — ${family.namespace.toLowerCase()} utilities (call as ${family.namespace}.${family.functions[0]?.name.toLowerCase()}, …)`,
        ...family.functions.map(fn => `${fn.signature} — ${fn.summary}`),
        `members: ${describeStdlibFamily(family)}`,
      ]);
    }
    return undefined;
  }

  // A bare coercer immediately followed by `(` (e.g. `DATE(`).
  if (after === '(') {
    const coercer = bareCoercer(word.text);
    if (coercer) {
      const contents = [coercer.summary];
      if (stdlibFamily(coercer.name)) {
        const family = stdlibFamily(coercer.name)!;
        contents.push(
          `Also a namespace: ${family.functions
            .map(fn => `${coercer.name}.${fn.name.toLowerCase()}`)
            .join(' / ')}.`,
        );
      }
      return here(contents);
    }
  }
  return undefined;
}

/** Hover for a construction-arg label (`credentials:`, `dry_run:`) or a listen
 *  config key (`schedule:`, `key:`) — the manifest's meaning for that key. */
function configKeyHover(
  source: string,
  word: { text: string; from: number; to: number },
  scope: Map<string, ScopeSymbol>,
  snapshot: CatalogSnapshot,
): MovementHover | undefined {
  if (!/^\s*:/.test(source.slice(word.to))) return undefined; // a key, not a value
  const before = source.slice(source.lastIndexOf('\n', word.from - 1) + 1, word.from);
  const hint = (text: string): MovementHover => ({ from: word.from, to: word.to, contents: [text] });

  // Construction: `name = adapter( … <key>:`
  const ctor = /[A-Za-z_]\w*\s*=\s*([A-Za-z_]\w*)\s*\([^)]*$/.exec(before);
  if (ctor) {
    if (word.text === 'dry_run') return hint('dry_run — rehearse writes to this instance instead of committing them (a universal construction arg)');
    const callee = scope.get(ctor[1]);
    const adapter = callee?.kind === 'adapter' ? (callee.importedName ?? callee.name) : undefined;
    const spec = adapter !== undefined ? snapshot.adapters[adapter] : undefined;
    if (spec) {
      const credArg = credentialArgOf(spec);
      if (credArg && word.text === credArg.name) return hint(`${word.text} — an imported ${adapter} credential to authenticate with`);
      if (spec.constructionArgs.some((a) => a.name === word.text)) return hint(`${word.text} — a ${adapter} construction argument`);
    }
    return undefined;
  }

  // Listen config: `listen to <instance> { … <key>:`
  const listen = /listen\s+to\s+([A-Za-z_]\w*)\s*\{[^}]*$/.exec(before);
  if (listen) {
    const inst = scope.get(listen[1]);
    const spec = inst?.adapter !== undefined ? snapshot.adapters[inst.adapter] : undefined;
    if (spec?.triggerConfig?.includes(word.text)) {
      const fmt = spec.triggerConfigFormats?.[word.text];
      const required = spec.triggerConfigRequired?.includes(word.text);
      return hint(`${word.text} — ${inst?.adapter} listener config${fmt ? ` (${fmt})` : ''}${required ? ' — required' : ''}`);
    }
  }
  return undefined;
}

/** Hover for a write-body field key (`Name: …`) — the target field's type. */
function writeFieldKeyHover(
  source: string,
  word: { text: string; from: number; to: number },
  region: RecordedWrite | undefined,
): MovementHover | undefined {
  const type = region?.root?.fields[word.text];
  if (type === undefined) return undefined;
  // The key may be backtick-quoted (`\`Email addresses\`: …`) — its closing
  // backtick sits between the token and the write operator, so allow a trailing
  // backtick, then ANY of the four field-write operators before bailing:
  // `:` (fill) · `?:` (set-if-empty) · `+:` (append) · `+?:` (append-missing).
  // `backtickTokenAt` reports the interior text, so the field-name lookup above
  // already matches; only the after-token punctuation differed. (Missing `+?:`
  // here is exactly what dropped the hover for an `\`Email addresses\` +?:` key.)
  if (!/^`?\s*\+?\??:/.test(source.slice(word.to))) return undefined; // a key, not a value occurrence
  const to = source[word.to] === '`' ? word.to + 1 : word.to;
  return {
    from: word.from,
    to,
    contents: [
      `${word.text}: ${describeFieldType(type)} — field of ${region!.description}`,
      ...nativeUniquenessHint(region!),
    ],
  };
}

/** The write target's BUILT-IN identity rules, as an overlay-hint line — what
 *  the adapter matches records by regardless of authored `unique by`. Surfaced
 *  on the object being written to (its fields, its write target) so the author
 *  sees the native matching rather than being warned about it (the retired
 *  MOV_UNIQUE_NATIVE_CONFLICT). Empty when the target declares no native rules. */
function nativeUniquenessHint(region: RecordedWrite): string[] {
  const native = region.root?.nativeUniqueness;
  if (!native || native.length === 0) return [];
  const rules = native.map(group => group.map(f => `\`${f}\``).join(' + ')).join(', or ');
  return [`Matched natively by ${rules} — the target identifies records by this on its own.`];
}

/** Hover for the SOURCE of an import (`… from adapters` / `… from "file"`) —
 *  distinct from the imported value of the same spelling, and `from` here
 *  means imports, not extract. Returns undefined outside an import's target. */
function importContextHover(
  source: string,
  word: { text: string; from: number; to: number },
): MovementHover | undefined {
  const before = source.slice(source.lastIndexOf('\n', word.from - 1) + 1, word.from);
  if (!/^\s*import\b/.test(before)) return undefined;
  const hint = (text: string): MovementHover => ({ from: word.from, to: word.to, contents: [text] });
  if (word.text === 'from') {
    return hint('from — where these imports come from: adapters, credentials, plugins, or a "movement file"');
  }
  if (!/\bfrom\b/.test(before)) return undefined; // a name inside { } — let symbol resolution describe it
  const sources: Record<string, string> = {
    adapters: 'adapters — the adapter-type catalogue (email, attio, slack, …)',
    credentials: 'credentials — your saved workspace credentials',
    plugins: 'plugins — transform plugins, used in through […]',
  };
  return hint(sources[word.text] ?? 'a saved movement file — brings in the movements and shapes it exports');
}

/** The type of a field read off a position — for hovering `item.Text`. */
function fieldTypeOnPosition(position: PositionTypeRef, field: string): FieldType | undefined {
  switch (position.kind) {
    case 'position':
      return positionSchemaOfRef(position)?.properties[field];
    case 'handle':
      return position.resultShape[field] ?? positionSchemaOfRef(position)?.properties[field];
    case 'local':
      return position.reads[field];
    case 'extract':
      return position.node.properties.get(field)?.explicit;
    case 'union': {
      for (const variant of position.variants) {
        const t = position.instance.schema.positions[variant]?.properties[field];
        if (t !== undefined) return t;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function fieldTypeHover(
  word: { text: string; from: number; to: number },
  where: string,
  type: FieldType | undefined,
): MovementHover {
  return {
    from: word.from,
    to: word.to,
    contents: [
      type !== undefined
        ? `${word.text}: ${describeFieldType(type)} — field of ${where}`
        : `${word.text} — field of ${where}`,
    ],
  };
}

/** An object type / write target — show its shape (its fields). */
function objectTypeHover(
  word: { text: string; from: number; to: number },
  label: string,
  shape: Record<string, FieldType>,
): MovementHover {
  const fields = Object.entries(shape).map(([n, t]) => `${n} (${describeFieldType(t)})`);
  const block = hoverBlock('Fields', fields);
  return {
    from: word.from,
    to: word.to,
    contents: [`${word.text}: ${label} — object type`, ...(block ? [block] : [])],
  };
}

/** Hover for a field read or an object-type/write-target reference:
 *  - `item.Text` / `c.`name`` / `msg.`Sender Name`` → the field's type
 *  - `attioTarget.Companies` → the object type's shape (a write target/position)
 *  - `attioTarget.Companies.Name` → a field's type within that object type */
function fieldAccessHover(
  source: string,
  word: { text: string; from: number; to: number },
  scope: Map<string, ScopeSymbol>,
): MovementHover | undefined {
  let dot = word.from;
  if (source[dot - 1] === '`') dot--; // an optional opening backtick around the field
  if (source[dot - 1] !== '.') return undefined;
  const lineStart = source.lastIndexOf('\n', dot - 2) + 1;
  const rawChain = source.slice(lineStart, dot - 1);
  const field = word.text;

  // Dotted instance path (no traversal steps): instance.<object>[.<field>].
  const dm = /((?:[A-Za-z_]\w*|`[^`]*`)(?:\.(?:[A-Za-z_]\w*|`[^`]*`))*)$/.exec(rawChain);
  if (dm) {
    const segs = dm[1].split('.').map(s => s.replace(/`/g, '').trim());
    const root = scope.get(segs[0]);
    if (root?.schema) {
      if (segs.length === 1) {
        const shape = borrowableFieldsOf(root.schema, field);
        if (shape) return objectTypeHover(word, `${root.name}.${field}`, shape);
      } else if (segs.length === 2) {
        const t = borrowableFieldsOf(root.schema, segs[1])?.[field];
        if (t !== undefined) return fieldTypeHover(word, `${root.name}.${segs[1]}`, t);
      }
    }
  }
  // A position chain (param / binding / alias, + traversal steps) → its field.
  const position = chainPositionAt(rawChain, scope);
  if (position) return fieldTypeHover(word, describePosition(position), fieldTypeOnPosition(position, field));
  return undefined;
}

function uniqueByHover(
  analysis: Analysis,
  loc: Loc,
  word: { from: number; to: number },
): MovementHover | undefined {
  const region = analysis.writeAt(loc);
  if (!region) return undefined;
  const contents = [
    `unique by — identity for this write: matching records update instead of duplicating`,
  ];
  const native = region.root?.nativeUniqueness;
  if (native && native.length > 0) {
    contents.push(
      `${region.description} also matches natively by: ${native
        .map(group => group.map(f => `\`${f}\``).join(' + '))
        .join(', or ')} (enforced by the target regardless of what you author here)`,
    );
  } else if (region.root) {
    contents.push(`${region.description} declares no native identity rules of its own`);
  }
  return { from: word.from, to: word.to, contents };
}

/**
 * Append the write target's native-uniqueness overlay line when the hovered
 * object IS the write region's target (`write crm-[:comp]->¦any { … }`, including a
 * traversal target `write company-[:team]-> { … }`). The object-shape hover
 * doesn't know about the surrounding write, so the native rule rides here —
 * the surfacing half of the retired MOV_UNIQUE_NATIVE_CONFLICT.
 */
function withWriteTargetNativeRule(
  hover: MovementHover,
  word: { text: string },
  region: RecordedWrite | undefined,
): MovementHover {
  if (!region) return hover;
  // The write target's plain-language name ends in the written object
  // (`crm.company`, or `company` for a traversal target) — match the hovered
  // word against it so we only annotate the actual write target.
  const targetName = region.description.split(/[.\s>-]/).filter(Boolean).pop();
  if (targetName !== word.text) return hover;
  const extra = nativeUniquenessHint(region);
  return extra.length > 0 ? { ...hover, contents: [...hover.contents, ...extra] } : hover;
}

/**
 * Hover for a traversal hop's EDGE name — `c-[p:perso¦n]->`,
 * `write company-[:tea¦m]-> { … }`. Surfaces the edge off the source position
 * (its target type), consistent with the field-write hover. Resolves the chain
 * to the LEFT of the `-[` to type the source, then reads the edge from its
 * schema. Silent when the caret isn't an edge name or the source/edge is
 * unknown.
 */
function traversalEdgeHover(
  source: string,
  word: { text: string; from: number; to: number },
  analysis: Analysis,
  loc: Loc,
): MovementHover | undefined {
  const lineStart = source.lastIndexOf('\n', word.from - 1) + 1;
  const before = source.slice(lineStart, word.from);
  // The edge name follows `-[`, an optional `alias:`, an optional leading `:`
  // (`-[:edge]`), and an optional opening backtick — with nothing closing the
  // bracket in between. A trailing `]` or `]->` (optionally backtick-closed)
  // must follow the word for it to be an edge name rather than a field.
  const head = /(<?-\[\s*(?:[A-Za-z_]\w*\s*:)?\s*:?\s*`?)$/.exec(before);
  if (!head) return undefined;
  const after = source.slice(word.to);
  if (!/^`?\s*(?:\bWHERE\b|\]|$)/i.test(after) && !/^`?\s*\]/.test(after)) return undefined;
  const chainEnd = before.length - head[1].length;
  const chain = before.slice(0, chainEnd);
  const position = chainPositionAt(chain, analysis.symbolsAt(loc));
  if (!position) return undefined;
  const to = source[word.to] === '`' ? word.to + 1 : word.to;
  // Meta position: the edge names a collection (`crm-[c:Companie¦s]->`).
  if (position.kind === 'meta') {
    const target = position.instance.schema.collections[word.text]?.target;
    if (target === undefined) return undefined;
    // When this meta edge IS a write's target (`write crm-[:comp¦anies]-> { … }`),
    // the edge names the written object — surface its shape and native identity
    // rule, the same overlay the flat `crm.company` target used to carry.
    if (/\bwrite\s+`?[A-Za-z_][\w-]*`?$/.test(chain)) {
      const region = analysis.writeAt(loc);
      if (region?.root) {
        const shape = objectTypeHover({ ...word, to }, region.description, region.root.fields);
        const extra = nativeUniquenessHint(region);
        return extra.length > 0
          ? { ...shape, contents: [...shape.contents, ...extra] }
          : shape;
      }
    }
    return {
      from: word.from,
      to,
      contents: [`${word.text} — every ${position.instance.name}.${target} (a collection to stream)`],
    };
  }
  const schema = positionSchemaOfRef(position);
  const edge = schema?.edges[word.text];
  if (!edge) return undefined;
  const instanceName =
    position.kind === 'position'
    || position.kind === 'handle'
    || position.kind === 'union'
      ? position.instance.name
      : 'the target';
  const required = edge.required ? ', required' : '';
  return {
    from: word.from,
    to,
    contents: [
      `${word.text} — edge from ${describePosition(position)} to ${instanceName}.${edge.target}${required}`,
    ],
  };
}

/** The backtick-quoted name the cursor sits inside (`\`Sender Name\``), if any —
 *  its interior, so a multi-word field reads as one token. */
function backtickTokenAt(source: string, offset: number): { text: string; from: number; to: number } | undefined {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  let count = 0;
  for (let i = lineStart; i < offset; i++) if (source[i] === '`') count++;
  if (count % 2 === 0) return undefined; // an even count ⇒ not inside a span
  const open = source.lastIndexOf('`', offset - 1);
  let lineEnd = source.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = source.length;
  const close = source.indexOf('`', offset);
  if (open < lineStart || close === -1 || close > lineEnd) return undefined;
  return { text: source.slice(open + 1, close), from: open + 1, to: close };
}

function wordAt(source: string, offset: number): { text: string; from: number; to: number } | undefined {
  if (offset < 0 || offset > source.length) return undefined;
  let from = offset;
  while (from > 0 && /[A-Za-z0-9_]/.test(source[from - 1])) from--;
  let to = offset;
  while (to < source.length && /[A-Za-z0-9_]/.test(source[to])) to++;
  if (from === to) return undefined;
  const text = source.slice(from, to);
  if (!/^[A-Za-z_]/.test(text)) return undefined;
  return { text, from, to };
}

function hoverContents(symbol: ScopeSymbol, snapshot: CatalogSnapshot): string[] {
  switch (symbol.kind) {
    case 'adapter':
      return [`${symbol.name} — adapter type`, `Construct an instance: ${symbol.name}(credentials: …)`];
    case 'credential':
      return [
        `${symbol.name} — credential${symbol.adapter !== undefined ? ` for ${symbol.adapter}` : ''}`,
      ];
    case 'plugin':
      return [`${symbol.name} — transform plugin (use in 'through […]')`];
    case 'fileImport':
      return [`${symbol.name} — imported from a file`];
    case 'movement': {
      // The movement's OWN parameter names and their authored types — a call
      // hint the author can paste, not a generic `param: value`.
      const params = symbol.movement?.decl.params ?? [];
      const sig = params.length
        ? params.map(p => (p.type === undefined ? p.name : `${p.name}: <${spellParamType(p.type)}>`)).join(', ')
        : 'param: value';
      return [`${symbol.name} — movement (call it with its arguments in order, or named: ${symbol.name}(${sig}))`];
    }
    case 'type': {
      const type = symbol.fieldType;
      const values = isEnumType(type) ? type.options.join(' | ') : '';
      return [`${symbol.name} — declared type (one of: ${values})`];
    }
    case 'instance':
    case 'shape':
      return graphHover(symbol, snapshot);
    case 'param':
    case 'alias':
    case 'binding':
      return positionHover(symbol);
  }
}

function graphHover(symbol: ScopeSymbol, snapshot: CatalogSnapshot): string[] {
  const headline =
    symbol.kind === 'shape'
      ? `${symbol.name} — declared node`
      : `${symbol.name} — ${symbol.adapter ?? 'graph'} instance`;
  const lines = [headline];
  if (symbol.kind === 'instance') {
    lines.push('Dry run: add `dry_run: true` to its construction to rehearse writes without touching the live system.');
  }
  if (symbol.schema) {
    const positions = Object.keys(symbol.schema.positions);
    const writable = Object.keys(symbol.schema.writableRoots);
    if (positions.length) lines.push(`Reads: ${positions.join(', ')}`);
    if (writable.length) lines.push(`Writes: ${writable.join(', ')}`);
  } else {
    // An untyped instance with a RECORDED reason (the schema fetch failed)
    // gets an honest line; only a genuinely unknown gap stays generic.
    const notes =
      symbol.kind === 'instance' && symbol.adapter !== undefined
        ? instanceSchemaNotes(snapshot, {
            adapter: symbol.adapter,
            ...(symbol.credential !== undefined ? { credentialName: symbol.credential } : {}),
          })
        : undefined;
    if (notes !== undefined && notes.length > 0) {
      lines.push(`Couldn't load this instance's schema: ${notes.join('; ')}`);
    } else {
      lines.push('No schema available — checks stay silent for this instance');
    }
  }
  return lines;
}

function positionHover(symbol: ScopeSymbol): string[] {
  const kindLabel =
    symbol.kind === 'param' ? 'parameter' : symbol.kind === 'alias' ? 'traversal step' : 'value';
  if (symbol.posType) {
    const lines = [`${symbol.name}: ${describePosition(symbol.posType)} — ${kindLabel}`];
    lines.push(...(hoverTypeDetail(symbol.posType) ?? []));
    return lines;
  }
  // A scalar value binding carries a field type, not a position — surface it
  // (describeFieldType renders an enum with its options inline).
  if (symbol.fieldType !== undefined) {
    return [`${symbol.name}: ${describeFieldType(symbol.fieldType)} — ${kindLabel}`];
  }
  return [`${symbol.name} — ${kindLabel}`];
}

// A labelled, newline-separated block — one item per line is far more
// readable in a hint than a long comma-run, especially for a wide record.
function hoverBlock(label: string, items: string[]): string | undefined {
  return items.length ? `${label}:\n${items.map(i => `  ${i}`).join('\n')}` : undefined;
}

function hoverTypeDetail(posType: PositionTypeRef): string[] | undefined {
  switch (posType.kind) {
    case 'position': {
      const schema = positionSchemaOfRef(posType);
      if (!schema) return undefined;
      const fields = Object.entries(schema.properties).map(
        ([n, t]) => `${n} (${describeFieldType(t)})`,
      );
      return [
        hoverBlock('Fields', fields),
        hoverBlock('Edges', Object.keys(schema.edges)),
      ].filter((l): l is string => l !== undefined);
    }
    case 'handle': {
      const fields = Object.entries(posType.resultShape).map(
        ([n, t]) => `${n} (${describeFieldType(t)})`,
      );
      const block = hoverBlock('Carries', fields);
      return block ? [block] : undefined;
    }
    case 'union':
      return [`One of: ${posType.variants.map(v => `${posType.instance.name}.${v}`).join(', ')} — narrow with an IS test`];
    case 'extract': {
      return [
        hoverBlock('Fields', [...posType.node.properties.keys()]),
        hoverBlock('Edges', [...posType.node.children.keys()]),
      ].filter((l): l is string => l !== undefined);
    }
    case 'local': {
      const carries = Object.entries(posType.reads).map(
        ([n, t]) => (t === undefined ? n : `${n} (${describeFieldType(t)})`),
      );
      return [
        hoverBlock('Carries', carries),
        hoverBlock('Edges', Object.keys(posType.edges ?? {})),
      ].filter((l): l is string => l !== undefined);
    }
    case 'closure': {
      const params = posType.params.map((p) => `${p.name}: ${describeReturnShape(p)}`);
      return [
        `Takes: ${params.length ? params.join(', ') : '(nothing)'}`,
        `Returns: ${describeReturnShape(posType.returns)}`,
      ];
    }
    case 'meta': {
      const collections = Object.keys(posType.instance.schema.collections);
      return collections.length ? [`Collections: ${collections.join(', ')}`] : undefined;
    }
    case 'maybeEmpty':
      return hoverTypeDetail(posType.of);
  }
}

function hoverTypeLine(symbol: ScopeSymbol): string | undefined {
  if (symbol.posType) return describePosition(symbol.posType);
  if (symbol.schema) return describeGraphSymbol(symbol);
  // A scalar binding has neither — it carries a fieldType instead (describeFieldType
  // renders `T | absent` honestly as "T (or absent)").
  if (symbol.fieldType !== undefined) return describeFieldType(symbol.fieldType);
  return undefined;
}

function describeGraphSymbol(symbol: ScopeSymbol): string {
  if (symbol.kind === 'shape') return 'declared node';
  return `${symbol.adapter ?? 'graph'} instance`;
}

// ── Shared helpers ──

function importNameItems(snapshot: CatalogSnapshot, fullLine: string): MovementCompletionItem[] {
  const namespaceMatch = /\bfrom\s+(adapters|credentials|plugins)\b/.exec(fullLine);
  const namespace = namespaceMatch?.[1];
  const alreadyListed = new Set(
    (/\{([^}]*)/.exec(fullLine)?.[1] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
  // `import { … } from "<file>"` — complete from the file's exports
  // (its file-level movements and shapes).
  const fileMatch = /\bfrom\s+"([^"]+)"/.exec(fullLine);
  if (fileMatch) {
    const source = snapshot.files?.[fileMatch[1]]?.source;
    if (source === undefined) return [];
    let program;
    try {
      program = parseProgram(source);
    } catch (e) {
      if (e instanceof MovementParseError) return [];
      throw e;
    }
    return fileExports(program)
      .filter(exported => !alreadyListed.has(exported.name))
      .map(exported => ({
        label: exported.name,
        insert: exported.name,
        kind: exported.kind === 'movement' ? ('function' as const) : ('value' as const),
        detail: `${exported.kind} from "${fileMatch[1]}"`,
      }));
  }
  const items: MovementCompletionItem[] = [];
  const add = (names: string[], ns: string, detail: (name: string) => string | undefined) => {
    for (const name of names) {
      if (alreadyListed.has(name)) continue;
      items.push({ label: name, insert: quoteIfNeeded(name), kind: 'value', detail: detail(name) ?? ns });
    }
  };
  if (namespace === 'adapters' || namespace === undefined) {
    add(Object.keys(snapshot.adapters), 'adapter', () => 'adapter type');
  }
  if (namespace === 'credentials' || namespace === undefined) {
    add(Object.keys(snapshot.credentials), 'credential', name => {
      const c = snapshot.credentials[name];
      const adapter = c !== undefined ? ('adapters' in c ? c.adapters[0] : c.adapter) : undefined;
      return adapter !== undefined ? `${adapter} credential` : 'credential';
    });
  }
  if (namespace === 'plugins' || namespace === undefined) {
    add(Object.keys(snapshot.plugins), 'plugin', () => 'transform plugin');
  }
  return items;
}

/** Position-type completions inside a type marker — the insert closes the `<…>`. */
function typeNameItems(schema: InstanceSchema): MovementCompletionItem[] {
  const items: MovementCompletionItem[] = [];
  for (const [name, variants] of Object.entries(schema.unions ?? {})) {
    // A union whose key is not author-facing (an adapter-projected union, a
    // grafted event address) carries a `unionDisplayNames` entry — the key is a
    // derived address, so offering it as an insert would put a token in the
    // buffer that does not parse. Its VARIANTS are what an author narrows to,
    // and they are offered below like any other position.
    if (schema.unionDisplayNames?.[name] !== undefined) continue;
    items.push({
      label: name,
      insert: `${quoteIfNeeded(name)}]->>`,
      kind: 'value',
      detail: `any of: ${variants.join(', ')}`,
    });
  }
  for (const name of Object.keys(schema.positions)) {
    if (schema.unions?.[name]) continue;
    items.push({
      label: name,
      insert: `${quoteIfNeeded(name)}]->>`,
      kind: 'value',
      detail: 'position type',
    });
  }
  return items;
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

/** The verbatim name a (possibly backtick-quoted) callee/reference denotes —
 *  backticks stripped, so a dash-slugged adapter resolves by its real name. */
function unquoteName(name: string): string {
  return name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name;
}

/** Where a catalog-name completion should start replacing: the open backtick
 *  when one is unclosed on the line (so a backtick-quoted insert subsumes a
 *  partially typed `` `Spaced Na ``), otherwise the trailing identifier word. */
function nameReplaceFrom(lineBefore: string, lineStart: number, wordFrom: number): number {
  let ticks = 0;
  let last = -1;
  for (let i = 0; i < lineBefore.length; i++) {
    if (lineBefore[i] === '`') {
      ticks++;
      last = i;
    }
  }
  return ticks % 2 === 1 ? lineStart + last : wordFrom;
}

function filterByPrefix(
  items: MovementCompletionItem[],
  typed: string,
): MovementCompletionItem[] {
  const prefix = typed.replace(/^`/, '').toLowerCase();
  if (!prefix) return items;
  return items.filter(item => {
    const label = item.label.toLowerCase().replace(/^`/, '');
    const insert = item.insert.toLowerCase().replace(/^`/, '');
    return label.startsWith(prefix) || insert.startsWith(prefix);
  });
}

/**
 * Is the end of `before` inside a `#` comment? Read with the parser's own
 * bracket scan: strings and quoted names are stepped over whole, and a `#`
 * directly inside a hop's brackets begins a head (`-[#linked]->`), not a comment.
 */
function inComment(before: string): boolean {
  const hops: boolean[] = [];
  let i = 0;
  while (i < before.length) {
    const opaque = skipOpaque(before, i, { inHop: hops[hops.length - 1] ?? false });
    if (opaque !== undefined) {
      if (opaque.kind === 'comment' && opaque.end >= before.length) return true;
      if (opaque.kind !== 'unterminated') {
        i = opaque.end;
        continue;
      }
      // An unclosed string runs to the cursor; an unclosed name ends its line.
      if (opaque.what === 'string') return false;
      const lineEnd = before.indexOf('\n', i);
      if (lineEnd === -1) return false;
      i = lineEnd;
      continue;
    }
    const c = before[i];
    if (c in CLOSER) hops.push(opensHop(before, i));
    else if (c === ')' || c === ']' || c === '}') hops.pop();
    i++;
  }
  return false;
}
