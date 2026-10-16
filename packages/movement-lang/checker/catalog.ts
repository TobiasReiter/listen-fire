// Injectable catalog interface for the movement checker (M2).
//
// The movement-lang package stays pure: it never reads adapter manifests,
// credential stores, or plugin registries itself. The host (apps/api)
// implements `Catalog` from its real sources — adapter manifests
// (listEntryPoints / describeTypes), the workspace credential store, the
// transform-plugin registry — and injects it into `checkProgram`.
//
// M2a needed only the file-boundary facts (4_type_system.md "What the
// checker knows", check 1): which adapters / credentials / plugins exist,
// which named arguments a construction call accepts, which of those is the
// credential, and which adapter each credential authenticates. M2b adds the
// per-instance schema surface (`InstanceSchema`) that the typed checks —
// writes, linked writes, traversal validity, narrowing, call fit — resolve
// against. A host that cannot produce a schema returns `undefined` from
// `instantiate`; every schema-typed check stays silent for that instance.

import type {
  EdgeCapability,
  EdgeSequencing,
  Expression,
  FieldCapability,
} from '@listen-fire/shared/expression/types';
import { neverAsAny } from '../never';
import { before, since, type LanguageVersion } from '../language_version';
import type { CallArg, ExprSlot, Loc, NamedArg, PluginCall, Program, Span, TypeDeclaration } from '../parser/ast';
import { treeOfSlot } from '../expression/bridge';
import { slotTrees } from '../expression/slot_trees';
import { pluginName } from '../parser/surface';
import { isMapSpread, type At, type MapMember, type MExpr } from '../parser/expression/tree';
import type { DeclaredEffectRow } from './effects';
// A record is a value, so `FieldType` names the arrow plane's own type and
// spells it with the arrow plane's own words. That is a cycle with `typing.ts`
// and it is the honest one: neither plane is beneath the other, and there is
// one type universe rather than a copy of position types kept here. Nothing is
// read at module load, so the two initialise in either order.
import { describePosition, type PositionTypeRef } from './typing';

/**
 * One argument in an adapter's construction signature. The list is the full
 * signature: the credential (when the adapter needs one) is just an entry with
 * `kind: 'credential'`, alongside any entry-position args (`kind: 'position'`).
 * There is no separate credential field — `credentialArgOf` derives it.
 */
export interface ConstructionArg {
  /** The construction-arg name, e.g. `credentials`, `spreadsheet`. */
  name: string;
  /**
   * `credential` = names an imported credential whose `adapter` is this adapter
   * (always required). `position` = an entry-position arg (e.g. Sheets'
   * `spreadsheet`) that pins where the instance starts.
   */
  kind: 'credential' | 'position';
  /** Whether construction MUST supply it. Credential args are required; position args are optional today. */
  required: boolean;
  /**
   * Position args only: the collection/type whose members are the value enum
   * (Sheets: `Spreadsheet`). The author enumerates it via describeConnection.
   */
  optionsFromType?: string;
  /** Author-facing label (defaults to `name`). */
  label?: string;
}

export interface AdapterSpec {
  /**
   * The adapter's full construction signature — the credential (if any) folded
   * in as a `kind: 'credential'` entry, plus every entry-position arg.
   */
  constructionArgs: ConstructionArg[];
  /**
   * Whether this adapter declares ANY trigger surface at all — projected from
   * the manifest's `supportedTriggers`, which is a construction-free fact: it
   * needs no credential, no introspection, and no describe() call.
   *
   * EXPLICIT, like `writable` (layer 13): only `true` projects, and its absence
   * on a spec the catalog KNOWS is the positive fact "this system cannot fire
   * anything". That distinction is the whole point — an absent SPEC (unknown
   * adapter) stays leniently unchecked, while a present spec without this flag
   * is a definite no. Collapsing the two is what let a Google Sheets listener
   * provision valid and stay silent forever.
   */
  canFire?: boolean;
  /**
   * The config keys a `listen to <instance> { … }` accepts for this adapter
   * (e.g. the email plus-address routing `key`). When present, an unknown
   * key is MOV_LISTEN_BAD_CONFIG; when absent, listener config goes
   * unvalidated (the adapter declares no vocabulary).
   */
  triggerConfig?: string[];
  /**
   * Per-key VALUE vocabularies for listen config — the adapter's
   * subscribable-event surface, projected by the host from its manifest
   * (e.g. attio's `events` key accepts `record.created` / `record.updated`
   * / `record.deleted`). A key listed in `triggerConfig` with an entry
   * here has a CLOSED value set: a listen config value (string, or each
   * element of a list) outside it is MOV_LISTEN_BAD_CONFIG. Keys without
   * an entry stay value-unvalidated.
   */
  triggerConfigOptions?: Record<string, string[]>;
  /**
   * The `events:` selection a listen WITHOUT one is subscribed to — the
   * adapter's own dispatch default, so the checker derives the same event
   * type the runtime will deliver (whatsapp: messages only). Absent ⇒ every
   * subscribable event.
   */
  defaultEvents?: string[];
  /**
   * Keys (⊆ `triggerConfig`) a listen on this adapter MUST carry — a
   * listen missing one is MOV_LISTEN_BAD_CONFIG with a ready-to-paste
   * fix-it. The cron adapter's `schedule` is the motivating case: a
   * schedule-less cron listener would never fire.
   */
  triggerConfigRequired?: string[];
  /**
   * Why a required key is required, by key, said after the refusal — the
   * host's words, because only the host knows what the value does (email's
   * routing `key` IS the inbound address; without it no mail can reach the
   * listener). Keys without an entry are refused with the bare fix-it.
   */
  triggerConfigRequiredWhy?: Record<string, string>;
  /**
   * Per-key value FORMATS the checker validates statically. `'cron'`
   * validates the value as a five-field cron expression; `'timezone'`
   * validates it as an IANA time-zone id (@listen-fire/shared/cron — the same
   * parser the platform scheduler runs, so check time and fire time can
   * never disagree).
   *
   * `'fields'` is the changed-attribute filter: a list of BARE property
   * names, validated against the position the listen's address lands on
   * (the derived event type). Any adapter with a "only fire when one of
   * these attributes changed" surface declares it; it is not the graph's,
   * it is just the graph that needed it first.
   *
   * `'strings'` is a non-empty list of non-empty quoted strings — the shape
   * only; the values are the source system's own (Gmail's `labels`).
   */
  triggerConfigFormats?: Record<string, 'cron' | 'timezone' | 'fields' | 'strings'>;
  /**
   * Interactive "connect" actions the adapter offers when authoring against
   * one of its instances. The checker never reads these — they're carried
   * for the editor/chat suggestion engine, which appends a "+ <label>"
   * entry per action wherever a slot resolves against this adapter's
   * instance, dispatching to an app-shipped handler by `kind`. Projected
   * by the host from the `action` blocks in the adapter manifest's
   * `construction` block list (config-blocks).
   */
  connectActions?: ConnectAction[];
  /**
   * How this adapter is connected, when it needs a credential at all:
   *   - 'oauth'     — a browser sign-in (connectCredential mints a link).
   *   - 'key-entry' — a short form where the user pastes an API key
   *                   (connectCredential mints a link to it).
   *   - 'intrinsic' — part of Listen-Fire itself (e.g. Listen-Fire Valuations);
   *                   connectCredential mints a one-click link — no external
   *                   sign-in and no key to paste, the server provisions it.
   *   - 'handshake' — the link hands the user into the system's own linking
   *                   flow (e.g. Telegram's bot Start step); connectCredential
   *                   mints a link to it.
   *   - 'app-only'  — connected inside the Listen-Fire app; connectCredential
   *                   CANNOT mint a link for it, so don't try.
   * Absent ⇒ the adapter needs no credential (nothing to connect). Lets an
   * author pick the right connect path — or skip a doomed connectCredential —
   * without a failed call. The checker never reads this; it's catalog metadata.
   */
  connect?: 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';
  /**
   * Plain-language truth about what a listener on this adapter fires on
   * (e.g. which Telegram messages actually reach the bot). Catalog metadata
   * for the author — trigger-surface claims ground in this rather than being
   * invented. The checker never reads it.
   */
  triggerExpectation?: string;
  /**
   * 'introspected' = the instance schema comes from live workspace
   * introspection (describing costs upstream API calls — scope requests);
   * 'static' = describing is free. Catalog metadata; the checker never
   * reads it.
   */
  schemaShape?: 'static' | 'introspected';
}

/**
 * The credential arg in a construction signature, if the adapter needs one.
 * Replaces the old dedicated `credentialArg` field — the credential is just the
 * `kind: 'credential'` entry, so every consumer derives it the same way.
 */
export function credentialArgOf(
  spec: Pick<AdapterSpec, 'constructionArgs'>,
): ConstructionArg | undefined {
  return spec.constructionArgs.find((a) => a.kind === 'credential');
}

/**
 * The ENTRY POSITION a construction pins, as an opaque key.
 *
 * An instance's schema belongs to (adapter, credential, position): the
 * `kind: 'position'` args pick which node the cursor starts at, and a Sheets
 * instance started at one spreadsheet has different leaves than one started at
 * another. Anything that stores or looks up a schema needs all three.
 *
 * Only the spec's DECLARED position args count. The credential is already the
 * other half of the key, and an arg the adapter never declared a position does
 * not move the cursor — letting either in would fork one instance's schema into
 * several that describe the same node.
 *
 * The key is derived, sorted and COMPARED — never parsed. That is what keeps it
 * an identity rather than a fabricated name: two sides that derive it the same
 * way cannot disagree, and no value inside it can collide with another.
 * `''` means the meta position (the node you get when you pin nothing).
 */
export function entryPositionKeyOf(
  spec: Pick<AdapterSpec, 'constructionArgs'>,
  args: Record<string, string> | undefined,
): string {
  const values: [string, string][] = [];
  for (const arg of spec.constructionArgs) {
    if (arg.kind !== 'position') continue;
    const raw = args?.[arg.name];
    if (raw === undefined || raw.trim() === '') continue;
    values.push([arg.name, unquoteConstructionArg(raw)]);
  }
  values.sort(([a], [b]) => a.localeCompare(b));
  return values.length ? JSON.stringify(values) : '';
}

/**
 * A position arg's value as AUTHORED is raw source (`"LP Commitments"`, quotes
 * included). The key is the VALUE, not its spelling — the host resolves the
 * unquoted string against the real service, so a key built from the quoted form
 * would never match the one built from the resolved form.
 */
function unquoteConstructionArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/** One adapter-declared interactive connect action — the declaration half
 *  of the generalised "+" connect affordance. `kind` names an app-shipped
 *  client handler; `label` is the suggestion text. The language stays pure:
 *  it carries the declaration and never interprets `kind`. */
export interface ConnectAction {
  kind: string;
  label: string;
}

/**
 * The one UNIVERSAL listen-config key — valid on every listener regardless of
 * adapter, like `dry_run` is the universal construction arg. It is NOT a loop
 * detector: it's a declarative 2-WAY-SYNC semantic. When an author builds an
 * A↔B sync (a movement that both reads and writes the same system) they set
 * `suppress_self: true` to mean "ignore my own writes echoing back into this
 * system," so the sync doesn't self-trigger.
 *
 * DEFAULT OFF (absent / false). Off matters: a user legitimately wants to react
 * to Listen-Fire's own writes (Movement 1 writes a company to Attio → Movement 2
 * posts new Attio companies to Slack). A default-on suppression would nuke that.
 *
 * Boolean-literal only. Validated centrally in `checkListen` (so every adapter
 * accepts it without each declaring it), then carried into
 * the persisted trigger config; the dispatch boundary capability-gates it on
 * the adapter answering "did WE author this change?". An adapter that can't
 * answer makes it a clearly-logged no-op.
 */
export const SUPPRESS_SELF_KEY = 'suppress_self';

/**
 * The event node's change-kind field — the ONE protocol name (like
 * `suppress_self` or the `events:` listen key) for "which kind of event this
 * occurrence is". An adapter with a change-kind axis declares an ordinary
 * enum field of this name on its event node, its options exactly the
 * listen's `events:` vocabulary; a listen's selection then pins it in the
 * derived event address, and a signature narrows with
 * `` WHERE `action` == "record.created" ``. Adapters with no such axis
 * (cron's tick, a messaging Message Received) simply declare no such field.
 *
 */
export const EVENT_ACTION_FIELD = 'action';

/** The `events:` value that means "the record no longer exists" — the pin
 *  under which `requiresLiveRecord` edges are dropped from a narrowed event
 *  position (the one real behaviour the retired delete VARIANT carried,
 *  keyed on the pin rather than on a synthesized name). The `record.*`
 *  vocabulary is deliberately uniform across adapters (attio, airtable). */
export const RECORD_DELETED_ACTION = 'record.deleted';

export interface CredentialSpec {
  /** The adapters this credential can authenticate — `slack(credentials: <attio cred>)`
   *  is a type error unless 'slack' is in this set. A credential *type* may serve
   *  several adapters (e.g. a Google credential serves sheets + drive). */
  adapters: string[];
}

/**
 * A PLUGIN is a function whose body isn't visible — it lives in the transform
 * registry, not in the program. Under the one-function-sort ruling that is the
 * ONLY thing separating it from a movement, so what it needs is the one fact
 * the checker would otherwise infer by walking a body: its effect row.
 *
 * The row is DECLARED beside the arguments, in the registry entry, because that
 * is where the plugin's surface already is — the same place its parameter names
 * are written, checked by the same lockstep test that keeps manifests and
 * implementations from drifting.
 *
 * An UNDECLARED row (`effects` absent) is not "does nothing": it is nobody
 * having said. That keeps the plugin legal exactly where it is legal today —
 * inside an extract's `through [ … ]`, where the pipeline bounds what a stage
 * can reach — and refuses it anywhere else, since a call the checker cannot
 * describe has no business being folded into a movement's row.
 *
 */
export interface PluginSpec {
  /** Named arguments the plugin accepts. */
  args: string[];
  /**
   * Whether invoking it may cost money (a paid scrape, a paid search, priced
   * work of its own). The engine refuses to start a priced plugin once the
   * run has spent its cost cap; an unpriced one runs regardless.
   */
  priced: boolean;
  /**
   * What each argument takes, by name — the plugin's declared input types. A
   * call is checked against them as a movement's arguments are against its
   * parameters: a record handed to an argument that takes text is refused
   * where it is written, and an argument declared to take structured data
   * (`json`) is handed a record's fields. Absent for an argument nobody typed.
   */
  argTypes?: Record<string, SchemaFieldType>;
  /**
   * Arguments (⊆ `args`) a call MUST supply — the `triggerConfigRequired`
   * shape, one door over: a call missing one is MOV_THROUGH_ARG_MISSING.
   *
   * This is an AUTHORING gate, not a runtime one, and the two stay
   * deliberately different: the engine's skip-on-absent sentinel covers a
   * required argument that resolves absent at run time (a record whose
   * source field came back empty — legitimate, so the stage quietly does
   * nothing that firing). It was never meant to cover an argument the
   * author never wrote at all, which is what this catches instead — at
   * check time, once, rather than as a stage that silently never fires.
   *
   * An `auto` param (engine-injected, never in `args`) can never appear
   * here either — there is nothing for an author to omit.
   */
  requiredArgs?: string[];
  /** What running it may do. Absent ⇒ nobody declared, and it stays a
   *  through-stage-only name. */
  effects?: DeclaredEffectRow;
  /**
   * The EXTRACTION supplies what this plugin runs on — an engine-injected
   * parameter (the `from [ … ]` text), or a body that reads the fields the
   * enclosing extract has produced so far. Such a plugin has no inputs of its
   * own, so an ordinary call could only pass it nothing; it is a stage, and a
   * call anywhere else is refused with the stage to write it in.
   *
   * A fact about the plugin's own signature, derived where the signature is —
   * not a second declaration an author could get out of step with the first.
   *
   * Narrow on purpose: it means the extraction is the plugin's ONLY way in. A
   * plugin whose engine-injected parameter an ordinary call could write itself
   * is `fedArgs`, not this — that one is callable, it just has to be handed
   * what the stage would have handed it.
   */
  fedByExtraction?: boolean;
  /**
   * Arguments the EXTRACTION fills inside a `through [ … ]` stage — the engine
   * feeds them from the `from [ … ]` source, which is why a stage never writes
   * one and `args` deliberately excludes them.
   *
   * A PLAIN call has no extraction behind it, so it writes them itself: they
   * are accepted there, and a required one omitted is
   * MOV_PLUGIN_FED_BY_EXTRACTION naming the argument. The same parameter, two
   * ways of being filled — not two parameters.
   */
  fedArgs?: PluginFedArg[];
  /**
   * What a plain call HANDS BACK. Absent ⇒ nobody declared, and a plain call
   * is refused (MOV_PLUGIN_OUTPUT_UNDECLARED): a value nothing describes would
   * type as unknown everywhere it flowed, which is the silence this checker
   * exists to refuse. A `through [ … ]` stage is unaffected — a stage's output
   * goes to the extractor, not to a name.
   */
  output?: PluginOutput;
  /**
   * The shapes `output` had before it changed: each is what a plain call hands
   * back to a program pinned before language version `before`, earliest
   * first. A call is typed under its program's pin (`pluginOutputUnder`);
   * removing a language version removes its entries.
   */
  earlierOutputs?: ReadonlyArray<{ before: LanguageVersion; output: PluginOutput }>;
  /** The package tag it is a member of (`@lf/web`), matched exactly
   *  (`packageMembers`); absent when it is in none. */
  package?: string;
}

/** One `fedArgs` entry: the argument's name, and whether a PLAIN call must
 *  write it (a stage never does either way). */
export interface PluginFedArg {
  name: string;
  required?: true;
}

// ── A plugin's arguments by position (language version 5, design §2.7) ──
//
// Its required inputs in the manifest's declared order, then one optional
// settings record `{ name: value }` for the rest. Binding turns that call into
// the named arguments versions 1–4 write, so every check and the wire to the
// plugin read one form. The Rust twin is `PluginSpec::bind_args`
// (crates/movement-parser/src/catalog/plugin_args.rs); both checkers and both
// engines bind through these two and nothing else.

// ── A plugin package (language version 5, design §2.10, §4.3) ──
//
// A tag a plugin's spec declares as its `package`, matched exactly and never
// parsed. ``import { `@lf/web` as web } from plugins`` binds each member under
// the dotted local name `web.fetchUrl`, so a call of it is an ordinary plugin
// call. The Rust twin is crates/movement-parser/src/catalog/packages.rs.

/** One plugin of a package: the name it is called by after the package's
 *  local name and a dot, and the catalog's key it invokes. */
export interface PackageMember {
  name: string;
  key: string;
}

/** The plugins whose spec declares `tag` as its package, in catalog order;
 *  none when no spec does, which is how a package import is told from an
 *  import of one plugin. */
export function packageMembers(catalog: Pick<Catalog, 'plugin' | 'pluginNames'>, tag: string): PackageMember[] {
  return (catalog.pluginNames?.() ?? [])
    .filter(key => catalog.plugin(key)?.package === tag)
    .map(key => ({ name: pluginName(key), key }));
}

/** The local name a package's member is bound to: `web.fetchUrl`. */
export function memberLocal(packageLocal: string, member: string): string {
  return `${packageLocal}.${member}`;
}

/** The program with each package import read as the imports of its members
 *  (`` `@lf/web` as web `` → `fetch_url as web.fetchUrl`, …), which is what an
 *  engine binds. An import that names no package is left as written. The
 *  checker does not read this: it binds the same names itself, keeping the
 *  package to name in a diagnostic. */
export function expandPackageImports(
  program: Program,
  catalog: Pick<Catalog, 'plugin' | 'pluginNames'>,
  languageVersion: LanguageVersion,
): Program {
  if (!since(languageVersion, 5)) return program;
  return {
    ...program,
    statements: program.statements.map(statement => {
      if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'plugins') {
        return statement;
      }
      return {
        ...statement,
        names: statement.names.flatMap(imported => {
          const members = packageMembers(catalog, imported.name);
          if (members.length === 0) return [imported];
          const local = imported.alias ?? imported.name;
          return members.map(m => ({ name: m.key, alias: memberLocal(local, m.name) }));
        }),
      };
    }),
  };
}

/** The parameter a plain call hands a plugin fed only by an extraction (from
 *  language version 5): the record it runs on, which a `through [ … ]` stage
 *  fed it implicitly. */
export const EXTRACTED_RECORD_PARAM = 'record';

/**
 * A plugin as a plain call sees it under `languageVersion`. From version 5 a
 * plugin is a function, so one fed only by an extraction is no longer a
 * stage: what the stage fed it implicitly — the record it enriched — becomes
 * its one required input, written by position like any fed argument and
 * taking structured data. Versions 1–4 read the spec as it is, and refuse the
 * call. The Rust twin is `PluginSpec::under` (crates/movement-parser/src/catalog/plugin_args.rs).
 */
export function pluginSpecUnder(spec: PluginSpec, languageVersion: LanguageVersion): PluginSpec {
  if (spec.fedByExtraction !== true || before(languageVersion, 5)) return spec;
  const { fedByExtraction: _fed, ...callable } = spec;
  return {
    ...callable,
    fedArgs: [{ name: EXTRACTED_RECORD_PARAM, required: true }, ...(spec.fedArgs ?? [])],
    argTypes: { ...spec.argTypes, [EXTRACTED_RECORD_PARAM]: 'json' },
  };
}

/** Where a plugin is called: a plain call writes the arguments a stage is
 *  fed, a `through [ … ]` stage never does. */
export type PluginCallSite = 'plain' | 'stage';

/** A positional call that does not fit the plugin's parameters. */
export type PluginArgMisfit =
  /** An argument past the positional parameters that is not the settings record. */
  | { kind: 'extra'; span: Span }
  /** A settings key that names a parameter taken by position. */
  | { kind: 'settingIsPositional'; name: string; span: Span }
  /** A settings record member that is not `name: value`. */
  | { kind: 'settingNotNamed'; span: Span };

/** A call's arguments, bound to the plugin's parameters by name. */
export interface PluginArgBinding {
  args: CallArg[];
  misfits: PluginArgMisfit[];
}

/** The parameters a call fills by position, in the manifest's declared
 *  order. The spec keeps the fed parameters apart from the author's, and
 *  every plugin declares its fed one first, so fed-then-author is that order. */
export function pluginPositionalParams(spec: PluginSpec, site: PluginCallSite): string[] {
  const fed = site === 'plain' ? (spec.fedArgs ?? []).filter(f => f.required === true).map(f => f.name) : [];
  const required = spec.requiredArgs ?? [];
  return [...fed, ...spec.args.filter(a => required.includes(a))];
}

/** What is wrong, in the words both checkers report (MOV_THROUGH_BAD_ARG). */
export function pluginArgMisfitMessage(misfit: PluginArgMisfit, callee: string, positional: readonly string[]): string {
  switch (misfit.kind) {
    case 'extra': {
      const byPosition =
        positional.length === 0
          ? 'no argument by position'
          : positional.length === 1
            ? `one argument by position (${positional[0]})`
            : `${positional.length} arguments by position (${positional.join(', ')})`;
      return `'${callee}' takes ${byPosition}, then its settings as one record \`{ name: value }\` — this argument is past them`;
    }
    case 'settingIsPositional':
      return `'${misfit.name}' is an argument '${callee}' takes by position — write it in its place, not in the settings record`;
    case 'settingNotNamed':
      return `'${callee}'s settings record holds only \`name: value\` entries`;
    default:
      return neverAsAny(misfit);
  }
}

/** Positional arguments named by `pluginPositionalParams`; the argument
 *  after those, written as a record literal, is the settings, each entry a
 *  named argument whose value is its own slot; any further one is a misfit.
 *  A named argument stays as written. */
export function bindPluginArgs(
  spec: PluginSpec,
  site: PluginCallSite,
  args: readonly CallArg[],
  options: { languageVersion: LanguageVersion },
): PluginArgBinding {
  const params = pluginPositionalParams(spec, site);
  const positional = args.filter(a => a.name === undefined);
  const settingsArg = positional[params.length];
  const settings = settingsArg !== undefined ? recordLiteral(settingsArg, options.languageVersion) : undefined;
  const binding: PluginArgBinding = { args: [], misfits: [] };
  let at = 0;
  for (const arg of args) {
    if (arg.name !== undefined) {
      binding.args.push(arg);
      continue;
    }
    const index = at++;
    const param = params[index];
    if (param !== undefined) {
      binding.args.push({ ...arg, name: param });
    } else if (settings !== undefined && index === params.length) {
      bindSettings(settings, params, binding);
    } else {
      binding.misfits.push({ kind: 'extra', span: callArgSpan(arg) });
    }
  }
  return binding;
}

/** A `through [ … ]` stage's arguments, bound to the plugin's parameters by name. */
export interface StageArgBinding {
  args: NamedArg[];
  misfits: PluginArgMisfit[];
}

/** A stage's positional arguments bound as a call's are, with the stage's
 *  positional parameters (never a fed one). */
export function bindStageArgs(spec: PluginSpec, stage: PluginCall, options: { languageVersion: LanguageVersion }): StageArgBinding {
  const bound = bindPluginArgs(spec, 'stage', (stage.positional ?? []).map((expr): CallArg => ({ kind: 'expr', expr })), options);
  // Binding names an expression and makes nothing else.
  const named = bound.args.flatMap((arg): NamedArg[] => (arg.kind === 'expr' && arg.name !== undefined ? [{ name: arg.name, value: arg.expr }] : []));
  return { args: [...stage.args, ...named], misfits: bound.misfits };
}

interface RecordLiteral {
  slot: ExprSlot;
  entries: MapMember[];
}

function recordLiteral(arg: CallArg, languageVersion: LanguageVersion): RecordLiteral | undefined {
  if (arg.kind !== 'expr') return undefined;
  let tree: MExpr;
  try {
    // The tree the program's own parse read; a slot without one is read
    // under the program's version.
    tree = treeOfSlot(arg.expr, languageVersion);
  } catch {
    return undefined;
  }
  return tree.kind === 'map' ? { slot: arg.expr, entries: tree.entries } : undefined;
}

/** An entry's value as a slot of its own: its text, and the tree the
 *  record's parse read for it, its offsets moved to that text. */
function entrySlot(record: RecordLiteral, value: MExpr, span: Span): ExprSlot {
  const slot: ExprSlot = { raw: record.slot.raw.slice(value.at.start, value.at.end), span };
  slotTrees.set(slot, shiftedTree(value, value.at.start));
  return slot;
}

/** The tree (plain JSON, as the parser handed it over) with every offset
 *  moved back by `by`. */
function shiftedTree(tree: MExpr, by: number): MExpr {
  return JSON.parse(JSON.stringify(tree), (key: string, value: unknown) =>
    key === 'at' && isAt(value) ? { start: value.start - by, end: value.end - by } : value,
  );
}

function isAt(value: unknown): value is At {
  return typeof value === 'object' && value !== null && 'start' in value && 'end' in value
    && typeof value.start === 'number' && typeof value.end === 'number';
}

function bindSettings(record: RecordLiteral, params: readonly string[], binding: PluginArgBinding): void {
  const spanOf = (at: At): Span => ({ start: locIn(record.slot, at.start), end: locIn(record.slot, at.end) });
  for (const member of record.entries) {
    if (isMapSpread(member)) {
      binding.misfits.push({ kind: 'settingNotNamed', span: spanOf(member.at) });
      continue;
    }
    const { key, value } = member;
    if (key.quoted === 'string') {
      binding.misfits.push({ kind: 'settingNotNamed', span: spanOf(key.at) });
      continue;
    }
    if (params.includes(key.text)) {
      binding.misfits.push({ kind: 'settingIsPositional', name: key.text, span: spanOf(key.at) });
      continue;
    }
    binding.args.push({
      kind: 'expr',
      name: key.text,
      expr: entrySlot(record, value, spanOf(value.at)),
    });
  }
}

/** The file's line and column of `offset` into a slot's text. */
function locIn(slot: ExprSlot, offset: number): Loc {
  let { line, col } = slot.span.start;
  for (let i = 0; i < Math.min(offset, slot.raw.length); i++) {
    if (slot.raw[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/** Where an argument is written, whatever form it takes. */
export function callArgSpan(arg: CallArg): Span {
  switch (arg.kind) {
    case 'expr':
      return arg.expr.span;
    case 'write':
      return arg.write.span;
    case 'node':
      return arg.node.span;
    case 'call':
      return arg.call.span;
    case 'closure':
    case 'type':
      return arg.span;
    default:
      return neverAsAny(arg);
  }
}

/**
 * What a plugin's plain call evaluates to, on whichever PLANE it lives — the
 * same two planes every other bound value has, and no third type language:
 *
 *   - `value`   — one value on the dot plane, an ordinary `FieldType`. Absence
 *                 is spelled the way absence is spelled everywhere else, with
 *                 `maybeAbsent`;
 *   - `record`  — several values read by name, which is a node on the arrow
 *                 plane: the checker mints a LOCAL node whose reads are these
 *                 fields, exactly as `callback(…)` and a node literal do;
 *   - `records` — zero or more of those nodes, one per thing the plugin found.
 *                 The value is a list of records, typed exactly as a hop's
 *                 landings are, so `FIRST(pages).text` and `MAP` read it the
 *                 way they read any other list of records.
 */
export type PluginOutput =
  | { kind: 'value'; type: SchemaFieldType }
  | { kind: 'record'; fields: Record<string, SchemaFieldType> }
  | { kind: 'records'; fields: Record<string, SchemaFieldType> };

/** What a plain call to `spec`'s plugin hands back to a program pinned to
 *  `languageVersion` — its current output, or an older shape it kept for
 *  programs pinned before the change (`PluginSpec.earlierOutputs`). */
export function pluginOutputUnder(spec: PluginSpec, languageVersion: LanguageVersion): PluginOutput | undefined {
  const earlier = spec.earlierOutputs?.find((entry) => before(languageVersion, entry.before));
  return earlier !== undefined ? earlier.output : spec.output;
}

// ── Field value types ──

/**
 * The value type of a field/property. Deliberately small: enough to catch
 * shape mistakes (text into a number field, a string into a file slot)
 * without reproducing every adapter's type system.
 */
export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  // A calendar day (normalised to midnight UTC) — `date` — versus an instant —
  // `datetime`. Both are temporal and mutually comparable (a date is midnight).
  | 'date'
  | 'datetime'
  | 'file'
  /**
   * A structured value — the DATA top type, TypeScript's `unknown` for the
   * data plane. Every data shape is assignable TO it (text, number, boolean,
   * date/datetime, a list of data, an object literal, json itself); `file` is
   * not, because a file is a HANDLE, not data. Nothing is assignable FROM it:
   * a json value has no known shape, so operating on one (arithmetic,
   * comparison, text concatenation) is an error and the author passes it
   * through unchanged. Narrowing constructs are deliberately absent — an
   * adapter field declared `json` mirrors the target API verbatim, which is
   * the point (plans/slack-blocks-json-fields-2026-07-30).
   */
  | 'json'
  /**
   * The type of the `null` LITERAL, and of nothing else — TypeScript's `null`
   * under strictNullChecks. It is the one value every `T | absent` may turn out
   * to be, which is what makes `x == null` a legal comparison at any `T` and a
   * meaningful one only where absence is possible. No adapter surface declares
   * it (a field is `T` or `maybeAbsent(T)`, never this), so it reaches nothing
   * outside the checker's own expression typing.
   */
  | 'absent'
  /**
   * The type of a value that never arrives — `fail("…")` written inside an
   * expression (language version 5) — TypeScript's `never`. It fits every
   * type, and a union with it is the union's other members.
   */
  | 'never'
  /**
   * A collection of values. `unordered` is the ORDER discipline's value-plane
   * half: the list's members are there, but the sequence they are in means
   * nothing, so an order-sensitive fold over it is refused. A list is a
   * sequence by construction (a literal, a source's own multi-value field, a
   * tuple), so the flag is the exception, set only where the order genuinely
   * came from nowhere — a block bound over an unordered traversal, a `COLLECT`
   * of one. The position plane carries the same fact differently (a walk's
   * last hop is sequenced, or it isn't), exactly as absence does.
   */
  | { kind: 'list'; of: FieldType; unordered?: true }
  /**
   * `<[T, U]>` — a heterogeneous list whose slots were written down: a list
   * literal (`[m.Body, file]` is `[text, file]`, from language version 3;
   * earlier versions type a literal as the list it reads as) and the receipt of a
   * combinator written with literal arms (`await parallel([f, g])`). Every slot
   * is its own type, so a literal-index read (`AT(r, 0)`) types exactly; every
   * other operation reads a tuple as the list it widens to — TypeScript's
   * tuple-to-array assignability.
   *
   * A slot is `null` where the value could not be typed — "we could not see",
   * spelled with the one nothing-value JSON can carry, since this type crosses
   * the wire verbatim. `'absent'` is the other answer and means the opposite:
   * this arm hands nothing back, so the slot's VALUE is always null at run
   * time.
   *
   * `rest` makes the tuple VARIADIC — TypeScript's `[T, ...U[]]`: a run of
   * any length (zero included) of `rest.of`, sitting just before slot
   * `rest.at` (`at === of.length` puts it last). A spread of a list into a
   * literal is what writes one: `[m.Body, ...files]` is `[text, ...file[]]`.
   * There is at most one run — a second spread folds everything from the
   * first run onward into it, as TypeScript does.
   */
  | { kind: 'tuple'; of: Array<FieldType | null>; rest?: TupleRest }
  /**
   * `{ k: v, … }` — a collection keyed by TEXT. Keys are strings and nothing
   * else: a dict is JSON-object-shaped, which is the whole value world's one
   * story (snapshots, `json` interop, the wire), and JSON has no other key. A
   * key that arrives as some other type is a save error demanding the author
   * write the coercion down, never a silent stringification.
   *
   * `of` is what a key nobody wrote down may hold: the value type every key
   * shares, or `json` when they disagree — json is the data type every value
   * flows into. (A value union exists, but only as what a tuple widens to.)
   *
   * `shape` is the TypeScript object literal's type: a dict WRITTEN as a
   * literal knows its keys, so a lookup by a literal key reads that key's own
   * type, present, and a literal key it does not have is refused. A key is
   * `null` where its value could not be typed — "we could not see", as a
   * tuple's slot is. Absent on every dict whose keys are data rather than
   * program text: `GROUPBY`/`KEYBY`'s answers, and every adapter surface.
   *
   * There is no order: a dict is looked up, never folded, so the set/list
   * discipline has nothing to say about one. What `GROUPBY` puts INSIDE it —
   * a list per key — carries the source's ordering as any other list does.
   */
  | { kind: 'dict'; of: FieldType; shape?: Record<string, FieldType | null> }
  /** `open` marks a KNOWN-VALUES field, not a closed enum: the options are
   *  what the adapter could enumerate live (Slack channels, select options),
   *  but other values remain legal — ids matching `allowPattern`, runtime
   *  expressions, values the listing couldn't see. Literal membership misses
   *  are WARNINGS with a did-you-mean, never errors. */
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  /**
   * `T | absent` — a value that MAY not be there (asks-as-adapter P20/F13). Read
   * from a PARTIAL context (a race receipt property bound in only some branches,
   * F18) or a maybe-empty node's field (an awaited landing off a `resolvesEmpty`
   * edge, F19/F20). It PROPAGATES silently through expressions; the checker
   * errors only where a NON-ABSENT value is REQUIRED (a plain write field, an
   * ordered comparison), never at the read — the TS `T | undefined` model.
   * Discharged by a `?:` (fill) write field, a traversal-as-gate, or an `==`
   * guard (equality tolerates absence and narrows). Produced ONLY by
   * the checker's typing layer; it never appears in an adapter/schema surface, so
   * runtime data (the engine, trpc) never carries it. `of` is never itself
   * `maybeAbsent` — construct via the `maybeAbsent()` helper, which flattens. */
  | { kind: 'maybeAbsent'; of: FieldType }
  /**
   * `T | U` — a value that is one of several types, TypeScript's union. It
   * arises where a tuple is READ as a list: `[text, number]` widens to a list
   * of `text | number`, as TypeScript widens `[string, number]` to
   * `(string | number)[]` (language version 3; earlier versions read such a
   * tuple as a list nobody can type).
   *
   * A union IS its member set, as a record-position union is: build one only
   * through `valueUnion`, which keeps the set canonical — flattened (no member
   * is a union), de-duplicated, sorted by display, at least two members (one
   * member is that member), absence hoisted out (`maybeAbsent` wraps the
   * union, never sits inside it), a member another member already accepts
   * absorbed (`json` takes every data shape, `text` every enum). Members are
   * VALUES: records and values have no union (a list of both is
   * `MOV_LIST_MIXED`), and records of different positions are already one
   * record type.
   *
   * Produced only by the checker's typing layer; no adapter surface declares
   * one.
   */
  | { kind: 'union'; of: FieldType[] }
  /**
   * A RECORD held as a value — a traversed record, a write handle, a
   * synthesised node, an extraction result. One type universe: a record is
   * what `MAP` hands back when its function returns one, what a list literal
   * of them holds, and what a map's key can carry, so lists and dicts nest
   * over records exactly as they nest over text.
   *
   * It is a value TYPE, not a value shape: nothing reads it as data. A record
   * written into a field, interpolated into text, added up or compared to a
   * scalar is refused where it is written; what it CAN do is be walked from
   * (a block head), read by field (the dot plane), and held in a collection.
   *
   * `position` is which record, where the checker can say — the same
   * `PositionTypeRef` the arrow plane uses, never a parallel one. ABSENT means
   * "a record, and nobody can name which": members of a list that disagree,
   * an extraction result, a synthesised node. The distinction is load-bearing
   * and is the same one `LocalEdge.target` draws — a walk off a record whose
   * position is unknown stays silent and runs, and one off a named position is
   * checked.
   */
  | { kind: 'record'; position?: PositionTypeRef };

/** A variadic tuple's run: any number of `of`, just before slot `at`. `of` is
 *  `null` where the run's members could not be typed. */
export interface TupleRest {
  at: number;
  of: FieldType | null;
}

/**
 * What an adapter SURFACE can declare — every field type except a record,
 * nested collections included.
 *
 * A record is a place in a graph, and no adapter field is one: a record type
 * arises only where the checker types an EXPRESSION. Saying so here is what
 * keeps a schema clear of the position model — and a schema crosses the wire
 * (`InstanceSchema` is a tRPC response), where a field type that reached into
 * positions would reach back into schemas again, a cycle no serialiser's type
 * can follow.
 *
 * The collections are spelled a second time because TypeScript cannot subtract
 * a member from a RECURSIVE union — `Exclude` removes the record at the top
 * and leaves `list of record` behind, which is the same cycle. The scalars and
 * every rule about them live on `FieldType` above; this is that union with one
 * member gone, and every `SchemaFieldType` IS a `FieldType`, so nothing that
 * reads a schema needs to know which it was handed.
 */
export type SchemaFieldType =
  | Exclude<FieldType, { kind: string }>
  | { kind: 'list'; of: SchemaFieldType; unordered?: true }
  | { kind: 'tuple'; of: Array<SchemaFieldType | null> }
  | { kind: 'dict'; of: SchemaFieldType }
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  | { kind: 'maybeAbsent'; of: SchemaFieldType };

/**
 * A field type spelled as ONE tagged variant — the scalars given the `kind`
 * the collections already carry.
 *
 * `FieldType` is half bare names and half objects, so a `switch` could never
 * see it whole: every branch over it was a `typeof === 'object'` if-chain, the
 * compiler enumerated nothing, and a new variant silently took whichever
 * fallthrough happened to come last. Both halves here are DERIVED from the
 * type parameter, so this is not a second list to keep in step — add a variant
 * to `FieldType` and every `switch` over a variant stops compiling at once.
 *
 * Generic in the type it normalises so a `SchemaFieldType` stays one: its
 * `list` still holds a `SchemaFieldType`, and its switch still has no `record`
 * case to answer.
 */
export type FieldTypeVariant<T extends FieldType = FieldType> =
  | { kind: Extract<T, string> }
  | Extract<T, { kind: string }>;

/**
 * The tag for each bare name, shared rather than built per call: `stripAbsent`
 * and `fieldTypeEquals` run over every expression the checker walks, and a
 * normaliser that allocated would put that cost on a path that had none.
 *
 * The mapped type is the third place a new bare name has to be answered — add
 * one to `FieldType` and this table is missing a key.
 */
const SCALAR_VARIANTS: { [K in Extract<FieldType, string>]: { kind: K } } = {
  text: { kind: 'text' },
  number: { kind: 'number' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  datetime: { kind: 'datetime' },
  file: { kind: 'file' },
  json: { kind: 'json' },
  absent: { kind: 'absent' },
  never: { kind: 'never' },
};

/**
 * Normalise a field type for an exhaustive `switch (variantOf(t).kind)`.
 *
 * The one assertion is the boundary the whole scheme rests on: `typeof` cannot
 * prove to TypeScript that a GENERIC `T`'s string half is `Extract<T, string>`,
 * though it is, by construction of the union.
 */
export function variantOf<T extends FieldType>(type: T): FieldTypeVariant<T> {
  const wide: FieldType = type;
  return (typeof wide === 'string' ? SCALAR_VARIANTS[wide] : wide) as FieldTypeVariant<T>;
}

/** Maps a surface type name (shape declarations, extract annotations) to a SchemaFieldType. */
/**
 * The type a `type Thesis = <"A" | "B">` declaration names — a CLOSED enum,
 * identical in shape to an option set borrowed from a live field, so nothing
 * downstream (extraction prompt, literal check, did-you-mean) can tell a
 * written refinement from a fetched one.
 */
export function declaredTypeOf(decl: TypeDeclaration): SchemaFieldType {
  return { kind: 'enum', options: decl.options };
}

/**
 * Every refinement a program declares, by name. A `type` is a FILE-level
 * declaration, so this flat map and the checker's scope resolution answer the
 * same question — the engine, which has no scopes, asks it this way.
 */
export function declaredTypesIn(program: Program): Map<string, SchemaFieldType> {
  const declared = new Map<string, SchemaFieldType>();
  for (const statement of program.statements) {
    if (statement.kind === 'type') declared.set(statement.name, declaredTypeOf(statement));
  }
  return declared;
}

export function parseFieldTypeName(name: string | undefined): SchemaFieldType | undefined {
  switch (name) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
      return name;
    default:
      return undefined;
  }
}

// ── Borrowed types ───────────────────────────────────────────────────────────
//
// An extract field's type may be BORROWED from another graph's field by
// path — `stage: crm.companies.funding_stage` — instead of declared
// inline. The path is `<instance>.<root-or-position>.<field>`, resolved
// against the instance's live schema (so an Attio select that gains an
// option is followed; nothing is copied out). The checker resolves it
// from the catalog for diagnostics; the engine re-resolves per firing.

/** The dotted segments of a borrowed-type annotation, or undefined for a
 *  plain (primitive) type name. */
export function borrowedTypeSegments(name: string | undefined): string[] | undefined {
  if (name === undefined || !name.includes('.')) return undefined;
  return name.split('.');
}

/**
 * The borrowable fields of one root/position of a schema: the writable
 * root's fields unioned with the position's properties. Writable fields
 * win per-name — enums (select options) live on the write surface.
 * Undefined when the schema has no root or position of that name.
 */
export function borrowableFieldsOf(
  schema: InstanceSchema,
  rootName: string,
): Record<string, SchemaFieldType> | undefined {
  const writable = schema.writableRoots[rootName]?.fields;
  const readable = schema.positions[rootName]?.properties;
  if (!writable && !readable) return undefined;
  return { ...(readable ?? {}), ...(writable ?? {}) };
}

/** Resolve `<root>.<field>` of a borrowed path against a schema. */
export function resolveBorrowedField(
  schema: InstanceSchema,
  rootName: string,
  fieldName: string,
): SchemaFieldType | undefined {
  return borrowableFieldsOf(schema, rootName)?.[fieldName];
}

export function describeFieldType(type: FieldType): string {
  const variant = variantOf(type);
  switch (variant.kind) {
    // `absent` is the one bare name that is NOT its surface spelling — the
    // author writes `null`, and there is no annotation to paste back (no field
    // is declared this type).
    case 'absent':
      return 'null';
    // A bare type name IS its surface spelling — `json` included — and the
    // annotation suggestions paste this text back into a program, so it must
    // stay the word `parseFieldTypeName` reads.
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'never':
      return variant.kind;
    case 'maybeAbsent':
      return `${describeMember(variant.of)} (or absent)`;
    case 'list':
      return `list of ${describeMember(variant.of)}`;
    // TypeScript's own notation, because that is what the type is.
    case 'union':
      return variant.of.map(describeFieldType).join(' | ');
    // A tuple IS its slots, in order — the surface spelling, so a diagnostic
    // can paste it back. An untyped slot reads as `?`, which is what the
    // checker knows, not a type it is claiming.
    case 'tuple': {
      const slots = variant.of.map(slot => (slot === null ? '?' : describeFieldType(slot)));
      if (variant.rest !== undefined) {
        const run = variant.rest.of === null ? '?' : describeMember(variant.rest.of);
        slots.splice(variant.rest.at, 0, `...list of ${run}`);
      }
      return `[${slots.join(', ')}]`;
    }
    // A shaped dict IS its keys — the literal's own spelling, the way a tuple
    // reads as its slots.
    case 'dict':
      if (variant.shape !== undefined) {
        const keys = Object.entries(variant.shape).map(
          ([key, slot]) => `${key}: ${slot === null ? '?' : describeFieldType(slot)}`,
        );
        return `{ ${keys.join(', ')} }`;
      }
      return `dict of ${describeMember(variant.of)}`;
    // A record reads as the record it IS, in the arrow plane's own words. A
    // record nobody can name is still definitely a record, which is what the
    // absent ref means and what the reader needs to hear.
    case 'record':
      return variant.position !== undefined ? describePosition(variant.position) : 'a record';
    case 'enum':
      if (variant.open) return `known values (${variant.options.join(' | ')}, …)`;
      // An empty CLOSED option set is the empty union — `enum ()` reads like a
      // rendering bug, so name the fact.
      if (variant.options.length === 0) return 'enum (no available values)';
      return `enum (${variant.options.join(' | ')})`;
    default:
      return neverAsAny(variant);
  }
}

/** A type spelled inside another — parenthesised when it is a union, as
 *  TypeScript writes `(string | number)[]`, so `list of (text | number)` cannot
 *  be read as `(list of text) | number`. */
function describeMember(type: FieldType): string {
  const described = describeFieldType(type);
  return typeof type !== 'string' && type.kind === 'union' ? `(${described})` : described;
}

// ── Per-instance schema ──

/** A reference (edge) declared by a position type. */
export interface EdgeSchema {
  /** The position type (or union) the edge points at. */
  target: string;
  /**
   * A polymorphic edge's concrete target varies per record; a linked write
   * through it must name the type explicitly (`write x-[:related]->company`).
   */
  polymorphic?: boolean;
  /**
   * The DECLARING type cannot exist without this edge — a required
   * FK/reference field IS a required edge (the projection rule). Surfaced
   * for hover/agent display; the checker's create gate reads the written
   * type's `WritableRootSchema.requiredEdges`.
   */
  required?: boolean;
  /**
   * Whether — and how — filter / order / limit push across this edge
   * (adapter-capability-contract chunk 4). The gate (chunk 6) combines this
   * with the TARGET position's per-property `propertyCapabilities`: a `native`
   * edge offers the target's filterable fields; a `bounded` edge offers all of
   * them (the adapter runs the shared filter unit). Absent ⇒ unknown ⇒ gating
   * degrades to silent best-effort, exactly like an absent schema.
   */
  capability?: EdgeCapability;
  /**
   * What this edge's members are inherently ordered BY, when they are ordered
   * at all. Absent ⇒ unordered, the safe default.
   *
   * NOT `capability.order`, which is about PUSHDOWN — whether an authored
   * ORDER BY reaches the source. This is about what the author gets without
   * asking. An edge can be one without the other in either direction.
   *
   * Carried for the set/list split (core-calculus v2 R2/R4): a sequenced edge
   * yields a list, an unsequenced one a set. Nothing reads it yet — the split's
   * checker lands separately.
   */
  sequenced?: EdgeSequencing;
  /**
   * Writing along this edge performs an ACTION, not a record write
   * (message-write-unification §4.2 resolved: WhatsApp's typing indicator).
   * Still gated by `writable`; the one extra rule is that the write's
   * result cannot be BOUND — nothing materialises to hold a handle to.
   */
  ephemeral?: boolean;
  /**
   * Whether traversing this edge READS anything. Absent ⇒ true. `false`
   * marks a WRITE-ONLY edge — a pure create path with no read API behind it
   * (WhatsApp's `replies`; traversal would silently yield nothing) — and
   * the checker rejects read traversal (MOV_WRITE_ONLY_EDGE). Writes along
   * the edge are unaffected.
   */
  readable?: boolean;
  /**
   * THE write promise for this edge, and it is EXPLICIT.
   * **Absent ⇒ READ-ONLY** — the checker rejects `write …-[:edge]->` /
   * `link …-[:edge]->` (MOV_READ_ONLY_EDGE). `true` ⇒ a linked write may
   * create the target along this edge, or link an existing one.
   *
   * This ONE flag consumed the retired `creatable`: there is no default-true
   * link promise and no separate create fact, because an absent flag must
   * never become an affirmative claim. The two halves of the promise are
   * separable, and `linkable` is where an adapter withdraws the second.
   *
   */
  writable?: boolean;
  /**
   * Whether two records that ALREADY EXIST can be joined along this edge
   * (`link a -[:e]-> b`, and its inverse `unlink`).
   *
   * **Absent ⇒ the `writable` promise covers link too** — that is what the
   * promise says. `false` WITHDRAWS the second half: the edge creates its
   * target and cannot join one that is already there, so a `link` along it is
   * refused (MOV_LINK_UNSUPPORTED_EDGE) instead of failing at run time.
   *
   * Only the source system can say this, and it says it per EDGE: Affinity's
   * list membership is made by adding a company to a list, and there is no way
   * to point an entry that already exists at a different one.
   */
  linkable?: boolean;
  /**
   * Traversing this edge needs the record at its far end to still EXIST
   * (the adapter hydrates it by fetch). Projected from the adapter
   * descriptor's same-named reference fact. An event position whose address
   * pins `action` to the deleted kind (`RECORD_DELETED_ACTION`) drops these
   * edges — the record is gone, so the traversal would return nothing, and
   * the constraint is stated at check time instead.
   */
  requiresLiveRecord?: boolean;
  /**
   * This edge leads from an EVENT to the record the event is ABOUT. Declared by
   * the adapter (never inferred from the edge's name, which is a display name
   * an adapter may spell as it likes); only ever compared here.
   *
   * A listen's `fields:` filter names properties of the RECORD, so the checker
   * validates those names one hop along this edge. An event position with no
   * subject edge keeps the plainer reading — the names belong to the position
   * the listen lands on, which is right for an adapter whose listen fires the
   * record itself.
   *
   */
  subject?: boolean;
  /**
   * The AWAITABLE promise for this edge (asks-as-adapter §A). `true` ⇒ the edge
   * is a promise in type-space: a BARE traversal is a type error
   * (MOV_AWAIT_REQUIRED, did-you-mean `await`), and `await …-[:edge]->`
   * untilNonEmpty waits for its resolution and binds the landed node(s). Such an
   * edge is honestly neither `readable` nor `writable` — you await it, you do
   * not read or write it. Absent ⇒ an ordinary edge, and `await`-ing it is a
   * type error (MOV_NOT_AWAITABLE).
   */
  awaitable?: boolean;
  /**
   * Only meaningful with `awaitable` (F20): whether a resolution along this edge
   * may carry NO landing (an explicit cancel resolves awaiters empty). Chunk B
   * carries the flag; the `T | absent` typing it drives is chunk C.
   */
  resolvesEmpty?: boolean;
  /**
   * THE PUSH promise, and like `writable` it is EXPLICIT: the platform DELIVERS
   * an event when this edge resolves, so a run parked on it is woken rather than
   * polled. Slack's `Replies` (an inbound webhook resolves the park), an ask's
   * `Response` (answering it resumes the run), a callback's `Called` (the tap
   * arrives as an event) are the three that can say this today.
   *
   * **Absent ⇒ NO push**, and `await FIRST(…)` on the edge is refused with the
   * cadence form the author owns instead (`await until(…, every: …)`). Absent
   * cannot mean "maybe": a park with nobody to wake it is a run that never
   * finishes, which is exactly the silent degradation this model refuses — an
   * adapter that has not said stays honest by being polled.
   *
   * Adapter-declared, live-schema data like the filter surface. When an adapter
   * GAINS it, existing polls don't silently improve: the checker nudges (a
   * warning), the author rewrites.
   *
   */
  watchable?: boolean;
  /**
   * This edge's LANDING TYPE is generic over the CONSTRUCTION SITE: the literal
   * value(s) the write body gives `field` fix the landing's shape. An ask's
   * `Response` is generic over the `Options` it offered (`Choose` answers an
   * enum of exactly those) and over `Answer Type` (`Provide` answers the scalar
   * it named).
   *
   * DECLARATIVE, like `discriminated`: the adapter says WHICH body field
   * parameterizes the landing, so the checker never has to know a field by
   * name. What the literals MEAN is the host's synthesis; the checker looks the
   * result up under `genericLandingKey` and retargets. Absent ⇒ the landing is
   * the same type for every construction, which is the ordinary case.
   *
   * `onNonLiteral` says what a COMPUTED value for that field means, and the
   * three states are three different facts:
   *
   *  - `'error'` mirrors a runtime precondition the adapter already enforces (an
   *    ask's `Answer Type` must be one of a closed set, so a create cannot
   *    discover it at run time) — the `WRITE_DISCRIMINANT_NOT_LITERAL` shape;
   *  - `'warn'` is legitimate at run time but COSTS the author the type (a
   *    `Form` built from computed field names answers one opaque value instead
   *    of one property per name) — a warning, because losing a guarantee in
   *    silence is losing it twice;
   *  - absent is the ordinary "I can't see it, and nothing was promised" case
   *    (an ask's `Options`): the base type, said nothing about.
   */
  genericOver?: { field: string; onNonLiteral?: 'error' | 'warn' };
  /**
   * The edge is the one the system declared as its records' resources (the
   * describe's reserved `_resources` reference — the knowledge graph's
   * `Resources`). An ordinary edge, walked by its name like any other; what
   * the flag records is that a pre-version-5 `x-[f:_resources]->` on this
   * system read it, so MOV_RESOURCES_NOT_EXTRACTED can name it. Diagnostics
   * only: nothing resolves `_resources` to it.
   */
  resources?: true;
}

/** A readable position type: its properties and outgoing references. */
export interface PositionSchema {
  properties: Record<string, SchemaFieldType>;
  edges: Record<string, EdgeSchema>;
  /**
   * Author-facing text for a position whose KEY is not author-facing — a
   * grafted event address (`eventAddressKey`) and the table it narrows to.
   * Diagnostics render this; nothing else may read it.
   *
   * It exists so identity can be an opaque key rather than a fabricated name.
   * One string doing both jobs is the magic-naming bug: `refinements.ts` keys
   * on `Table "Deals"`, so two bases each with a `Deals` collide and the second
   * is silently discarded. A key that is only COMPARED cannot collide; a
   * display that is only SHOWN is allowed to.
   *
   * Absent ⇒ the key IS the name (every ordinary position: `Deals`, `message`).
   *
   */
  displayName?: string;
  /**
   * What the source can do with each property server-side — the operators it
   * can filter by, whether it can order by it (adapter-capability-contract
   * chunk 4). Read by the gate (chunk 6) when a hop into this position filters
   * / orders over a `native` edge. Keyed by property name (matching
   * `properties`). Absent for a property ⇒ unknown ⇒ silent best-effort.
   */
  propertyCapabilities?: Record<string, FieldCapability>;
  /**
   * The honesty valve for property-existence checking. By DEFAULT a typed
   * position is CLOSED: reading a property it does not declare is
   * MOV_UNKNOWN_PROPERTY (the projection is expected to enumerate the
   * surface fully). A projection that genuinely cannot enumerate a
   * position's properties — a raw webhook payload, an unstable event bag —
   * marks it `openProperties: true`, and unknown reads stay silent for
   * that position only. Open is a property of the POSITION, not the
   * instance: declare it where the under-description actually is.
   *
   * `openProperties` is a POSITIVE claim — "the surface is genuinely wider than
   * what's enumerated". It is NOT the same fact as `undescribed` below, and
   * conflating the two is a measured bug; see there.
   */
  openProperties?: boolean;
  /**
   * NOBODY HAS LOOKED at this position. No descriptor came back for it — a
   * demand-scoped describe that never fetched the type, an adapter that cannot
   * answer the name, an address that landed nowhere (`never`).
   *
   * DISTINCT FROM `openProperties`, and that separation is the whole point.
   * "I haven't looked" and "anything goes" are DIFFERENT FACTS, and this
   * projection used to spell both `openProperties: true`. So:
   *
   * ```
   * movement intake(e: <at-[:`Record Change`]->>) {
   *   e-[r:record]-> { … r.`Name` … }     # NO diagnostics. null at runtime.
   * }
   * ```
   *
   * `r` targets the meta type `Table` — undescribed in that demand scope, hence
   * OPEN, hence accepting ANY field name. The open-projection rule has a real
   * reason (a scoped describe must not false-positive on types it hasn't
   * fetched) but it cannot serve both facts at once: one of them means "stay
   * silent", the other means "you are guessing".
   *
   * So an undescribed position is the ABSENCE of a claim, and touching the
   * handle is `MOV_UNDESCRIBED_POSITION` rather than an open door — the
   * rule for a `never`: don't error at the narrow, error at the USE.
   *
   */
  undescribed?: boolean;
  /**
   * NOBODY HAS LOOKED **YET** — a fetch for this position is in flight, or the
   * host has not started one but will when asked. The answer is coming.
   *
   * The THIRD member of the family `openProperties` and `undescribed` already
   * split, and separated for the same reason: one value must not mean two
   * facts. "I looked and there is nothing" and "I have not looked yet" are
   * different, and only the first licenses a diagnostic.
   *
   * ```
   *  described   → here is the surface           → check against it
   *  open        → genuinely wider than listed   → stay silent
   *  undescribed → looked, nothing there         → error at the USE
   *  pending     → answer in flight              → stay silent, re-check on arrival
   * ```
   *
   * Spelling this `undescribed` — the obvious shortcut, since neither has a
   * surface to check — would make the EDITOR throw a diagnostic on every
   * keystroke until each fetch landed, errors that appear and clear as you
   * type. Spelling it `openProperties` would accept a typo against a type
   * nobody has fetched. Neither existing flag can carry it.
   *
   * Set ONLY by a host that fills positions lazily (the editor's snapshot,
   * where the checker runs synchronously per keystroke over a cache the walk
   * fills). The server-side compile path finishes its demand rounds before it
   * projects, so nothing is ever pending there and this stays absent.
   *
   * It lives HERE, beside the other two, rather than as a host-side set keyed
   * by position name — which is where it was first sketched, on the reasoning
   * that pending is a fact about the cache rather than about the graph. That
   * reasoning is true and still the wrong conclusion: the checker makes ONE
   * decision ("can I check against this position?") at ONE place, and splitting
   * that decision's inputs across two objects is how the two halves drift out
   * of agreement. Colocate the fact with the decision it feeds.
   *
   */
  pending?: boolean;
  /**
   * Fields that exist on this type's WRITE shape only (`readable: false`
   * in the adapter descriptor) — a value you set when writing, never read
   * back (WhatsApp Message's send-side `File`). Deliberately absent from
   * `properties`, listed here so a read gets the pointed
   * MOV_WRITE_ONLY_PROPERTY diagnostic instead of the generic
   * unknown-property one.
   */
  writeOnlyProperties?: string[];
  /**
   * Display names carried by MORE THAN ONE of the source's fields — an Attio
   * object with both a built-in and a custom attribute titled "Name".
   *
   * The name is still in `properties` and still resolves, to the first field
   * the adapter listed. This is the ambiguity itself, not a second type: the
   * projection cannot invent a distinct name for the shadowed field without
   * minting a nominal one (`Name (name_custom)`), which is exactly the magic
   * naming the model forbids — identity is the ADDRESS, display is separate.
   *
   * So the honest thing is to resolve deterministically and TELL the author at
   * the point of use (MOV_AMBIGUOUS_PROPERTY, warning severity — it never
   * gates a compile). Reading is legal; the author just learns their source
   * has two fields wearing one name.
   */
  ambiguousProperties?: string[];
  /**
   * A record of this type can be DELETED — the system's own promise, declared
   * per type in its describe (`deletable: true`) where its `deleteRecord`
   * removes one. Absent ⇒ it makes no such promise, and since language
   * version 5 `delete x` of this type is MOV_DELETE_NOT_DECLARED (an
   * undescribed or pending position says nothing, so nothing is refused).
   */
  deletable?: boolean;
}

/**
 * May a check state that this position's surface LACKS something?
 *
 * No, on any of the three facts above: an OPEN position says its surface is
 * wider than what's enumerated, an UNDESCRIBED one says nothing at all, and a
 * PENDING one has not been asked yet — none licenses "it has no field X".
 *
 * They stay separate fields because they answer a DIFFERENT question
 * differently: may the author touch the handle? An open position, yes (it is a
 * positive claim); an undescribed one, no (`MOV_UNDESCRIBED_POSITION`); a
 * pending one, yes-for-now — silently, because the answer is still coming and
 * the author has done nothing wrong. This helper is only for the first
 * question, and exists so no call site has to remember to ask about all three.
 */
export function surfaceNotEnumerated(schema: PositionSchema | undefined): boolean {
  return (
    schema?.openProperties === true || schema?.undescribed === true || schema?.pending === true
  );
}

/**
 * A DISCRIMINATED write shape — the write-side dual of read narrowing. On the
 * read side a WHERE's literal selects a variant type (`-[:Base WHERE `Name` ==
 * "Dev Base"]->`); here the LITERAL of one required discriminant FIELD selects
 * the variant of a create's body (a create NAMES its target, it doesn't filter
 * it with a WHERE). What TypeScript would model as:
 *
 * ```ts
 * type ListEntryWrite =
 *   | { listName: "Pipeline" }
 *   | { listName: "VC Deal Flow"; Stage: Stage }
 * ```
 *
 * Each variant is a COMPLETE `WritableRootSchema` — exactly the write shape
 * when the discriminant is that literal (its `fields`/`requiredFields` are that
 * variant's, and it carries the discriminant field itself). The enclosing
 * schema is the fallback shape used when no variant can be selected (the
 * discriminant is missing, typo'd, or not a compile-time literal).
 *
 */
export interface DiscriminatedWriteShape {
  /** The required field whose LITERAL value selects the variant (`listName`). */
  discriminant: string;
  /** literal value → the complete write shape when the discriminant is that literal. */
  variants: Record<string, WritableRootSchema>;
}

/**
 * An UNTAGGED union of write shapes — the other half of the write-side type,
 * and the one with NO discriminant. A Slack message is a file post or an
 * interactive post; nothing in the body names which, so the shape is inferred
 * from what the body SETS. What TypeScript would model as:
 *
 * ```ts
 * type MessageWrite = { Message?: string; File?: File } | { Message?: string; Blocks?: Json }
 * ```
 *
 * Inventing a discriminant field to tag it would be nominal typing smuggled
 * into a structural union, so the rule is assignability, exactly as in TS: the
 * fields a write MAPS must be a subset of at least one variant.
 *
 * Deliberately NOT a `Record<string, WritableRootSchema>` like the
 * discriminated shape: a variant here restricts WHICH FIELDS may be set and
 * nothing else — no per-variant types, requiredness, or narrowing. Every other
 * fact (types, `requiredFields`, edges) stays on the enclosing shape, where it
 * is true of every variant.
 *
 */
export interface WriteUnionShape {
  variants: Array<{
    /** Author-facing name of the shape ("a file post") — what the checker's
     *  error offers the author to choose between. Display only. */
    name: string;
    /** Surface field names (`WritableRootSchema.fields` keys) this shape accepts. */
    fields: string[];
  }>;
}

/** A root the instance accepts writes for, and the shape of the resulting handle. */
export interface WritableRootSchema {
  fields: Record<string, SchemaFieldType>;
  /**
   * When present, this create's body is a DISCRIMINATED UNION: the literal of
   * `discriminated.discriminant` (a required field in `fields`) selects one of
   * `discriminated.variants`, and THAT variant determines the rest of the
   * writable shape. `checkWrite` reads the discriminant literal from the body,
   * selects the variant, and validates the remaining fields against it.
   * ADDITIVE — absent ⇒ one fixed shape (the common case). See
   * `DiscriminatedWriteShape`.
   */
  discriminated?: DiscriminatedWriteShape;
  /**
   * When present, this create's writable surface is an UNTAGGED UNION: the set
   * of fields a body maps must be a subset of at least one variant. Nothing
   * selects the variant — assignability does, as in TS. ADDITIVE and disjoint
   * from `discriminated` (the host rejects declaring both): absent ⇒ every
   * field of `fields` may be set together, the common case. See
   * `WriteUnionShape`.
   */
  writeUnion?: WriteUnionShape;
  /** What a handle from `x = write instance-[:root]-> { … }` carries (`externalId`, `url`, the written fields). */
  resultShape: Record<string, SchemaFieldType>;
  /**
   * The POSITION a handle from a write of this shape stands on, when that is
   * more specific than the root the write was addressed through. Set on a
   * DISCRIMINATED VARIANT: `write org-[:List Entries]-> { listName: "Master
   * Deals List", … }` is addressed at the membership collection, but the record
   * it hands back is a row of that one list — the type that genuinely carries
   * `Owners`. So the handle stands on the variant's own position, and a chained
   * write or `link` off it resolves against that type's edges.
   *
   * Absent ⇒ the handle keeps the type the write's own edge named (the common
   * case, and the case of a variant whose type mints no position at all — its
   * `fields`/`edges` still ride the handle).
   */
  position?: string;
  /**
   * The target system's OWN identity rules for this root, declaratively:
   * an OR-of-AND of surface field names (each inner array is one
   * AND-group; any group matching means "the same record"). Projected
   * from what the adapter honestly exposes — Attio's per-attribute
   * `is_unique`, the KG ontology's uniqueness rules — and enforced by
   * the target regardless of what a write authors. `unique by` is the
   * explicit layer on top; the checker compares the two (redundant /
   * conflicting) and the editor surfaces these on hover. Absent when
   * the adapter exposes no native rules (not proof there are none).
   */
  nativeUniqueness?: string[][];
  /**
   * Edges a write of this root must satisfy, each named by its satisfying
   * authored spelling: a tuple/linked path rooted at a `from`-typed handle
   * walking `edge` (or, where the target also exposes the edge as a
   * writable field, a body field named `edge`). Projected from what the
   * target honestly declares — required FK/reference fields (the FK
   * holder requires the edge) and KG scoping edges (`scopes: true` — the
   * scoped type requires each scoping parent). Absent when the target
   * declares none.
   */
  requiredEdges?: Array<{ edge: string; from: string }>;
  /**
   * The relationships this record participates in — every outgoing edge with
   * its target type and whether it's required. The REQUIRED subset must be
   * satisfied on create (and also appears, with its satisfying spelling, in
   * `requiredEdges`); the rest are OPTIONAL relationships you may author a
   * related record along — a linked write (`write x.<edge> -> …`) or a `link`
   * statement. Surfaced on the WRITE surface so authoring a write shows the
   * full link surface, not just the required edges; mirrors the readable
   * position's `edges`. Absent when the root declares no edges. (Whether the
   * target system accepts a given link is enforced at write time — this is the
   * relationship surface, not a per-edge write guarantee.)
   */
  edges?: Record<string, EdgeSchema>;
  /**
   * Scalar fields a CREATE of this root must give a value — projected
   * from what the target honestly declares (an adapter descriptor's
   * `required` flags; KG identity properties). The checker errors when a
   * write's body never sets one; a field written from a possibly-absent
   * expression (an unguarded `DATE.PARSE`) is caught by typed-absence
   * propagation at the value site (MOV_ABSENT_REQUIRED), not here. Absent
   * when the target declares none.
   */
  requiredFields?: string[];
  /**
   * Per-field authoring guidance, verbatim from the adapter descriptor's
   * field descriptions — value conventions ("channel name or id"), live
   * workspace facts (the actual channel names), formatting hints. Not
   * used by the checker; surfaced to authors (agents read it off
   * describeInstance, the editor can show it on hover). Absent when the
   * adapter describes nothing.
   */
  fieldDocs?: Record<string, string>;
  /**
   * Which fields this target's adapter can resolve by SIMILARITY, not just
   * equality — surfacing close candidates for the engine to arbitrate. Gates
   * the `FUZZY` modifier on a `unique by` component: an author may only mark a
   * component fuzzy where the target can honour it (the KG's pg_trgm search,
   * Attio's `$contains`). `true` ⇒ every field; a list ⇒ only those fields (by
   * their names in `fields`), since a system that searches names by
   * similarity may still compare a city exactly. Absent ⇒ exact only, and
   * FUZZY is rejected at author time.
   */
  fuzzyResolution?: true | readonly string[];
  /**
   * Whether a movement may author `unique by` on this root. Default (absent) ⇒
   * yes. `false` ⇒ the target decides record identity ITSELF and doesn't accept
   * author-defined uniqueness — the adapter does its own native matching that a
   * movement can't meaningfully configure (Affinity: org by domain/name, person
   * by email, with the workspace-vs-global-data nuance the engine can't
   * express). The checker rejects a `unique by` clause on such a root rather
   * than silently ignoring it.
   */
  uniquenessAuthorable?: boolean;
}

/**
 * A collection directly off an instance's meta node (`crm-[c:Companies]->`).
 *
 * The root is a NODE and the meta edge is an EDGE, so it says what it can do
 * the same way any record edge does — `target` is where the hop lands,
 * `capability` is what the source can do across it. Absent capability is the
 * same fact as an absent `EdgeSchema.capability`: nobody declared, so the gate
 * stays silent.
 *
 */
export interface CollectionSchema {
  /** The position type name the collection's members land on. */
  target: string;
  /** Whether — and how — filter / order / limit push across this collection.
   *  Read by the hop gate exactly as `EdgeSchema.capability` is. */
  capability?: EdgeCapability;
}

/**
 * The schema of a constructed instance — produced per construction because
 * which objects and fields an adapter offers depends on the credentials.
 * The same shape also describes configuration-free graphs: the `kg`
 * ontology (the catalog's `kg` slot), declared shape graphs, and (with only
 * `positions`/`collections` populated) extract results and block meta-nodes
 * derived by the checker itself.
 */
export interface InstanceSchema {
  /** Position types by name. */
  positions: Record<string, PositionSchema>;
  /** The bare instance name's meta-position edges: collection name → what the
   *  hop lands on, and what the source can do across it. */
  collections: Record<string, CollectionSchema>;
  /** Union position types: name → variant position type names (e.g. record → [company, person]). */
  unions?: Record<string, string[]>;
  /** Author-facing text for a union whose KEY is not author-facing — a grafted
   *  event address over the event union. The `PositionSchema.displayName` rule,
   *  one level up: identity is a key, display is a separate string. */
  unionDisplayNames?: Record<string, string>;
  /** Roots `write instance.<root> { … }` accepts. */
  writableRoots: Record<string, WritableRootSchema>;
  /**
   * Write shapes for types writable ALONG AN EDGE (`EdgeSchema.writable`)
   * — the per-field-writability projection of a type that has no top-level
   * root. Disjoint lookup from `writableRoots` (which remains the registry
   * of `write instance.<root>` targets): the checker reads
   * `writableRoots[t] ?? createShapes?.[t]` for a linked write's shape.
   */
  createShapes?: Record<string, WritableRootSchema>;
  /**
   * Whether the instance's adapter can update an already-identified record
   * in place (`updateRecord` in its manifest `methods[]`). Gates the
   * position write `write a { … }`: you may only update a record the
   * adapter contract lets you update by id. Absent/false → the checker
   * rejects position writes against this instance (an append-only target
   * like Slack or Drive). Reads/creates are unaffected.
   */
  supportsInPlaceUpdate?: boolean;
  /**
   * Whether this instance's edges can carry INLINE properties — facts that
   * belong to the relationship rather than to either end (a knowledge-graph
   * edge's `role`, a Slack file's `pinned`), which the adapter attaches per
   * traversed record at run time and no describe enumerates.
   *
   * A POSITIVE claim, and the third surface a bare name in a bracket WHERE can
   * address: the walked edge's own property, an outer binding, or a field of
   * the landed type. Two of those the checker can see; this one it cannot, so
   * where it is declared an otherwise-unknown WHERE name stays silent — the
   * same honesty valve `openProperties` is for a read. Absent ⇒ the edge
   * carries nothing but its ends, and such a name is a mistake.
   */
  edgesCarryProperties?: boolean;
  /**
   * Position-aware narrowing (2026-07-05): refined position types, keyed by
   * `refinementKey`. When a hop lands on a type through a WHERE that is a
   * DECIDABLE EQUALITY (`` `Field` == "literal" ``), the checker rebinds the
   * hop target to the named entry — an anonymous subtype registered in
   * `positions` that carries that POSITION's actual surface (e.g. one
   * spreadsheet's table edges) instead of the type's whole-collection union.
   * Produced by the host by WALKING to the type the selector names; absent ⇒ no
   * static narrowing, and position knowledge stays a runtime concern.
   */
  refinements?: Record<string, string>;
  /**
   * The TYPE the member each refinement selected lands, under the SAME
   * `refinementKey` as `refinements` — the name that type is PUBLISHED under,
   * which is exactly what a landed record's `recordType` carries.
   *
   * Not the member's ADDRESSING name. A polymorphic member is addressed by the
   * label the meta walk filed it under (Affinity's `"Portfolio"`) and lands
   * records of a type of its own (`"List Entry — Portfolio"`); those are two
   * strings, and only the second one a record can ever equal.
   *
   * `refinements` is the TYPE half of a narrowing and `selectedMembers` is the
   * RUNTIME half: the checker rebinds the hop to the member's surface, the
   * engine drops any landed record of a different member before reading a
   * field off it. Two facts, one key, one host pass — so the two halves cannot
   * disagree about which member a WHERE chose. Absent ⇒ nothing narrowed, and
   * every landed record faces the whole WHERE as it always has.
   */
  selectedMembers?: Record<string, string>;
  /**
   * The fields a `WHERE` may test to narrow a type to one of its members, keyed
   * by the type — the same `narrowBy` a connection's describe shows on the
   * polymorphic edge, recorded by the host for the types this program's hops
   * land on. A type that has none is not narrowable.
   *
   * Read only to say how to fix a refusal: a field the type itself does not
   * carry may belong to one member, and narrowing is how it becomes readable.
   */
  narrowBy?: Record<string, string[]>;
  /**
   * Construction-site landings (2026-07-30): positions synthesized from ONE
   * write's own literals, keyed by `genericLandingKey`. The refinements
   * mechanism one door over — there the program's WHERE selects a position the
   * host walks to; here the program's write BODY fixes a type the host derives.
   * Both are program-dependent positions the host grafts into a copy of the
   * schema and the checker only looks up, so neither side can decide anything
   * the other disagrees with.
   *
   * Absent ⇒ nobody synthesized anything, and every edge lands on its declared
   * base type.
   *
   */
  genericLandings?: Record<string, string>;
  /** The position a `listen` on this instance fires — the type its events
   *  arrive as. The conformance check (a shape-typed movement parameter)
   *  targets this position. The first declared event edge when the adapter
   *  declares any (`eventPositions`); else the projection's single-readable
   *  heuristic (a poll adapter whose one readable entry IS what a listen
   *  delivers — granola). Undefined when the instance has no single event
   *  position. */
  eventPosition?: string;
  /**
   * The instance's DECLARED event surface: one entry per event edge off the
   * meta node (`SchemaEntryPoint.fires`), in declaration order. THE EVENT IS
   * JUST A NODE — the projection synthesizes nothing; each entry names the
   * node an event edge lands on, and `on` lists the `events:` config values
   * delivered along that edge (a subset of the adapter's subscribable-event
   * vocabulary). `on` absent ⇒ every subscribable event (or the adapter has
   * no vocabulary at all — cron's tick, a messaging Message Received).
   *
   * This replaces `eventActions` + the variant synthesis
   * (`Record Created`/`Updated`/`Deleted` were nominal names for address
   * narrowings — `Record Created` ≡ `` Record Change WHERE `action` ==
   * "record.created" ``). Where a change-kind axis exists it is an ORDINARY
   * FIELD on the event node (`action`, an enum of the same `events:`
   * vocabulary — ONE namespace), and a listen's `events:` selection pins it
   * in the derived address.
   *
   */
  eventPositions?: Array<{ position: string; on?: string[] }>;
  /**
   * The listen-config keys that ADDRESS this instance's events, in hop order —
   * the adapter's `ListenConfigKey.narrows` set (Airtable: `['base','table']`).
   *
   * A listen is a traversal of the event edge with a WHERE, so its config IS an
   * address; these are the keys that say so. The checker reads them to derive
   * the type a listen fires (`listenNarrowing`), which is what a signature's
   * address is compared against. Absent ⇒ this adapter's events aren't
   * addressable and every listen on it fires the plain event type.
   *
   */
  eventNarrowingKeys?: string[];
  /**
   * What may legally be pinned at each event-address hop — keyed by the address
   * PREFIX it is legal under (`narrowingPrefixKey` over the pins fixed so far).
   *
   * `` `table` == "tblDaels" `` is `enum == "a string literal that isn't in the
   * enum"`, and that is where the typo dies: `MOV_ENUM_UNKNOWN_VALUE`, with a
   * did-you-mean, through the same `checkEnumLiteral` every other enum
   * comparison rides. Not a downstream read error, and not an error at the
   * narrow — a narrowing that matches nothing is `never`, which is a TRUE
   * statement about a typo'd address, not a failure.
   *
   * THE VARIANCE IS THE MODEL, not an obstacle to it. `base`'s options are free
   * — the root walk already holds the bases. `table`'s options depend on WHICH
   * base, so they exist only under a prefix that pins one, and cost exactly that
   * base's hop. The drill-down, one level in, at 1 + 1: a base no signature
   * names is never opened, so this can never become the `listTables`-per-base
   * fanout the whole plan exists to kill.
   *
   * Absent (or absent for a prefix) ⇒ nobody published the options, and the pin
   * is unchecked. Silence, never a guess.
   *
   */
  eventNarrowingValues?: Record<string, Record<string, string[]>>;
}

/** Whether a write may land on this edge. The two promises default OPPOSITE
 *  ways — `readable` absent means readable, `writable` absent means read-only
 *  (layer 13) — which is exactly the asymmetry a second reader gets wrong. So
 *  everyone who asks asks HERE: the checker's gate, the diagnostics that list
 *  the writable spellings, and the agent-facing describe surface. They cannot
 *  answer differently if there is only one answer. */
export function edgeIsWritable(edge: EdgeSchema): boolean {
  return edge.writable === true;
}

/** Whether a read traversal may walk this edge — the other half of the pair
 *  above, and the one that defaults TRUE (only `readable: false` withdraws it,
 *  marking a write-only edge). */
export function edgeIsReadable(edge: EdgeSchema): boolean {
  return edge.readable !== false;
}

/** Every WRITABLE edge an instance offers, for diagnostics: the spellings a
 *  write can land on (`channel-[:messages]->`, `message-[:replies]->`). Keys
 *  off the one explicit `writable` promise (layer 13). */
export function writableEdgesOf(
  schema: InstanceSchema,
): Array<{ parent: string; edge: string; target: string }> {
  const out: Array<{ parent: string; edge: string; target: string }> = [];
  for (const [parent, position] of Object.entries(schema.positions)) {
    for (const [edge, edgeSchema] of Object.entries(position.edges)) {
      if (edgeIsWritable(edgeSchema)) out.push({ parent, edge, target: edgeSchema.target });
    }
  }
  return out;
}

/**
 * Structural, key-order-independent serialization of a parsed node. Both sides
 * of a refinement derive their key from the SAME parsed expression, so the only
 * thing that could split them is object key order; sorting removes it. `undefined`
 * members are dropped so an explicitly-absent optional keys like an omitted one.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Canonical key into `InstanceSchema.refinements`: the hop's target type plus
 * the WHERE that selects the position. Shared by the checker (looking
 * refinements up) and the host (registering them), so the two sides can never
 * drift on key shape.
 *
 * The key is the EXPRESSION, not a `{field, value}` selector: narrowing
 * consumes a predicate that evaluates to a Boolean, so any shape the shared
 * filter unit can evaluate keys here — conjunctions included — with nothing to
 * widen. Both sides hold the same AST, so they can key on it directly.
 *
 */
export function refinementKey(input: { type: string; filter: Expression }): string {
  return JSON.stringify([input.type, canonicalize(fieldReadsUnmarked(input.filter))]);
}

/**
 * The filter with its field reads' `fieldOnly` marks dropped. The mark says
 * how a read was SPELLED — through the hop's alias from version 5
 * (`e.action`), bare before (`action`) — and both spellings name the same
 * field, so the key must not tell them apart: a host registers its narrowing
 * once, from its own filter, and every version's program must find it.
 */
function fieldReadsUnmarked(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fieldReadsUnmarked);
  const node = value as Record<string, unknown>;
  const isFieldRead = node['type'] === 'property' || node['type'] === 'edge_property';
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => !(isFieldRead && k === 'fieldOnly'))
      .map(([k, v]) => [k, fieldReadsUnmarked(v)]),
  );
}

/**
 * THE IDENTITY of a union position type — the key it lives under in
 * `InstanceSchema.unions`, and what an `EdgeSchema` whose landing varies per
 * record puts in its `target`.
 *
 * A union IS its member set, exactly as in TypeScript: `A | B` is the same type
 * wherever it is written, so two edges landing on the same types land on ONE
 * type. Sorting makes that literally true of the key, and de-duplication means
 * a set that collapses to one member cannot masquerade as a union.
 *
 * `refinementKey`'s contract: opaque, derived identically by whoever registers
 * the union and whoever resolves it, and only ever COMPARED. Never parse it,
 * never show it to an author — `unionDisplayNames` carries the text, and it is
 * a separate string precisely so no code path can start depending on it.
 *
 * The `'union'` tag is what stops it colliding with the other opaque keys in
 * this namespace (an event address, a refinement): three key families sharing a
 * `positions`/`unions` namespace must not be able to produce one string.
 */
export function unionKey(members: readonly string[]): string {
  return JSON.stringify(['union', unionVariants(members)]);
}

/** THE DISPLAY of a union — author-facing text, and nothing else. TS's own
 *  notation, because that is what the type is. */
export function unionDisplay(members: readonly string[]): string {
  return unionVariants(members).join(' | ');
}

/** A member set in its one canonical form — a set has no order, so the key, the
 *  display and the registered `unions` entry all derive from the same sorted,
 *  de-duplicated list. */
export function unionVariants(members: readonly string[]): string[] {
  return [...new Set(members)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface Catalog {
  adapter(name: string): AdapterSpec | undefined;
  credential(name: string): CredentialSpec | undefined;
  /**
   * Every credential import name this workspace has — what a diagnostic's fix
   * draws on to name the ONE connection an adapter can be constructed with.
   * Undefined ⇒ the catalog cannot list them, and no such fix is offered.
   */
  credentialNames?(): readonly string[];
  plugin(name: string): PluginSpec | undefined;
  /**
   * Every plugin's registered name — what a package import's members are
   * found among (`packageMembers`). Undefined ⇒ the catalog cannot list them,
   * and no import names a package.
   */
  pluginNames?(): readonly string[];
  /**
   * Resolve a constructed instance's schema. An instance's full type exists
   * only under concrete construction arguments (which objects and fields an
   * Attio offers depends on the credential), which is why this is a call and
   * not a static per-adapter schema. `args` carries the construction call's
   * named arguments as raw expression text, keyed by argument name (the
   * credential argument's value is the credential's name).
   *
   * Return undefined when the schema cannot be produced — the checker then
   * leaves every schema-typed check silent for that instance.
   */
  instantiate(adapter: string, args: Record<string, string>): InstanceSchema | undefined;
  /**
   * The valid values for an ENUM-TYPED construction arg — an entry-position arg
   * (Sheets' `spreadsheet:`, whose options are the credential's visible
   * spreadsheets). The value depends on the CREDENTIAL, so it's a call, not
   * static per-adapter metadata. Returns undefined when `arg` isn't enum-typed
   * for this adapter (the checker then leaves the value unchecked); an empty
   * array means "enum-typed but no options resolved" (also left unchecked, so a
   * transient introspection miss never mis-warns). A value outside a non-empty
   * result is a WARNING with a did-you-mean, never an error (grants change).
   */
  constructionArgOptions?(input: {
    adapter: string;
    credentialName?: string;
    arg: string;
  }): readonly string[] | undefined;
  /**
   * The logical model names a movement may ask an LLM call for on THIS
   * deployment — the ones its model map sends somewhere it can call. A
   * deployment property, like the credentials: the same movement can name a
   * model one deployment reaches and another does not, so a name outside this
   * list is refused at validate and at the deploy check, not by language
   * version. Undefined ⇒ the catalog does not know (a hand-built fixture), and
   * a named model is left unchecked.
   */
  models?(): readonly string[];
}

/** A catalog's `models` member over a list, or none when the list is not
 *  known — absent and empty are different facts. */
export function modelsMember(models: readonly string[] | undefined): Pick<Catalog, 'models'> {
  return models !== undefined ? { models: () => models } : {};
}

export function mockCatalog(spec: {
  adapters?: Record<string, AdapterSpec & { schema?: InstanceSchema }>;
  credentials?: Record<string, { adapter: string } | { adapters: string[] }>;
  plugins?: Record<string, PluginSpec>;
  instantiate?: Catalog['instantiate'];
  constructionArgOptions?: Catalog['constructionArgOptions'];
  models?: readonly string[];
}): Catalog {
  return {
    // Fixtures declare the surface they're testing, not the whole manifest, so
    // `canFire` defaults ON here — an omission in a test means "not what this
    // test is about", whereas in the real projection it means "this system has
    // no inbound surface". A fixture opts out by setting it false explicitly.
    adapter(name) {
      const found = spec.adapters?.[name];
      if (found === undefined) return undefined;
      // The fixture's `schema` is how `instantiate` answers, not a member of
      // the adapter's spec: left on it, it would ride into a snapshot as a
      // key no snapshot declares.
      const { schema: _instantiated, ...adapter } = found;
      return { canFire: true, ...adapter };
    },
    credential(name) {
      const c = spec.credentials?.[name];
      if (!c) return undefined;
      return { adapters: 'adapters' in c ? c.adapters : [c.adapter] };
    },
    credentialNames: () => Object.keys(spec.credentials ?? {}),
    plugin: name => spec.plugins?.[name],
    pluginNames: () => Object.keys(spec.plugins ?? {}),
    instantiate: spec.instantiate ?? (adapter => spec.adapters?.[adapter]?.schema),
    ...(spec.constructionArgOptions !== undefined
      ? { constructionArgOptions: spec.constructionArgOptions }
      : {}),
    ...modelsMember(spec.models),
  };
}
