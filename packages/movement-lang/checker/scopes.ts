// Lexical scope structure for the movement checker (M2).
//
// The checker walks the program once, in source order, maintaining a chain
// of `Scope`s. Each scope carries:
//   - `symbols`   — names bound so far (imports, assignments, params,
//                   hoisted movement/node declarations, traversal aliases,
//                   graph instances);
//   - `pending`   — names a *later* statement in the same statement list
//                   will bind (prescanned), so a read before the binding
//                   statement is reported as use-before-bind rather than
//                   unknown-name. TDZ-style: a pending name shadows an
//                   outer binding of the same name;
//   - `escaped`   — names that were bound inside an already-closed
//                   traversal block (out of scope, but remembered so the
//                   diagnostic can hint at the block's meta-node edge);
//   - `declarations` — every binding in source order, with the location it
//                   becomes the answer from. The checker never needs it (it
//                   asks where it stands); the editor does (it asks at a
//                   cursor), so it is kept only when recording.
//
// M2b layers type information onto `ScopeSymbol` (instance schemas via
// `Catalog.instantiate`, write-result handle shapes, narrowed positions)
// without changing the resolution mechanics here: `schema` for graph-like
// symbols (instances, shapes), `posType` for position-like
// symbols (params, aliases, handles, extract/block bindings), `movement`
// for lazy parameter typing at call sites.

import { Loc, MovementDeclaration, ShapeDeclaration, Span } from '../parser/ast';
import { FieldType, InstanceSchema } from './catalog';
import type { EffectRow } from './effects';
import type { CollectionOrder } from './typing';
import type { CallCycle } from './call_cycles';
import { FieldsNeed, PlaneType, PositionTypeRef, ReturnShape } from './typing';

export type SymbolKind =
  /** `import { attio } from adapters` */
  | 'adapter'
  /** `import { acme_main } from credentials` */
  | 'credential'
  /** `import { scrub_sensitive } from plugins` */
  | 'plugin'
  /** `import { Files } from "lib/file-routines"` — category unknown until M3 file resolution. */
  | 'fileImport'
  /** `name = <expr | write | extract | block>` */
  | 'binding'
  /** `crm = attio(credentials: acme_main)` — a constructed instance. */
  | 'instance'
  /** A movement parameter. */
  | 'param'
  /** A movement declaration (hoisted across its statement list). */
  | 'movement'
  /** A node declaration (hoisted across its statement list); the discriminant
   *  keeps its historical spelling — see ShapeDeclaration in the AST. */
  | 'shape'
  /** A traversal-head alias (`-[c:companies]->`), scoped to the block body. */
  | 'alias'
  /** `type Thesis = <"A" | "B">` — an author-declared refinement of text. */
  | 'type';

export interface ScopeSymbol {
  name: string;
  kind: SymbolKind;
  span: Span;
  /** For imports: the name in the source namespace/file — catalog lookups key on this; `name` is the local binding (the alias, when one was given). */
  importedName?: string;
  /** For `instance`: the constructing adapter. */
  adapter?: string;
  /** For `instance`: the construction's credential, as its ORIGINAL import
   *  name — the key a per-credential instance schema (and its failure note)
   *  is filed under. */
  credential?: string;
  /** For a name bound by a FILE import (`import { x } from "lib/y"`): the
   *  import's path, so navigation can target the file. */
  importPath?: string;
  /** For `instance`: the construction's NON-credential args, raw as authored
   *  (`{ base: '"Dev Base"' }`). The entry position rides here — a listen's
   *  address is relative to it, so `checkListen` reads it to know which
   *  required address hops the position already supplies. */
  constructionArgs?: Record<string, string>;
  /** For `credential`: the adapters it can authenticate (set membership). */
  adapters?: string[];
  /** For `movement`: parameter count, for call arity checks. */
  arity?: number;
  /** For `instance` / `shape`: the graph's schema (when resolvable). */
  schema?: InstanceSchema;
  /** For `shape`: the declaration itself — the tree an extraction node taking
   *  it as its shape (`node entry: <Entry>`) spells out. An imported one is
   *  its library's. */
  declaration?: ShapeDeclaration;
  /** Graph identity override for IMPORTED graphs: the symbol the graph was
   *  originally declared by (in its library's file scope). Two positions
   *  are in the same graph iff their tokens match by reference, so an
   *  imported declaration must carry its library symbol — otherwise a handle
   *  written through the import would never fit the library movement's
   *  parameter. Absent = this symbol IS the graph's declaration. */
  graphToken?: ScopeSymbol;
  /** For `param` / `alias` / `binding`: the bound position's type (when derivable). */
  posType?: PositionTypeRef;
  /**
   * True for a `binding` on the ARROW plane whose value is a whole traversal
   * BLOCK's return (`all = graph-[c:companies]-> { return c }`) — the
   * accumulation across every iteration, not the one record a hop alias
   * lands (`-[c:companies]-> { … }`'s own `c`). `posType` carries the SAME
   * type either way (plurality lives in the traversal, not a second type —
   * see `planeOfReturn`), so this is the one place that fact survives past
   * the assignment. A `recordArg` stdlib function (`TEXT.PAIRS`) reads it to
   * refuse a collection it would otherwise mistake for one record.
   *
   * On the VALUE plane, the same fact for a walk read for a field (`pdfs =
   * m-[a:Attachments]->.\`File\``): `fieldType` is the field's own, one value,
   * and the name holds one per landing. A spread reads it as those values.
   */
  plural?: true;
  /** For a `plural` binding on the ARROW plane: the order the block's returns
   *  were collected in — what the name reads as a list under, on the value
   *  plane (a map field, a list member, a call argument). */
  collectedOrder?: CollectionOrder;
  /**
   * The ACCESS PLANE of this binding (asks-as-adapter F13) — set on assignments
   * so a race receipt / block meta can route a name to the right plane. A `node`
   * binding (write / await / block / extract / race — anything producing a
   * position or landing) escapes as an EDGE (arrow: `r-[x:name]->`); a `scalar`
   * binding (a plain value expression) escapes as a PROPERTY (dot: `r.name`),
   * carrying its `fieldType`. Absent for non-assignment symbols. */
  bindingPlane?: 'node' | 'scalar';
  /** For a `scalar`-plane `binding`: the value's field type, so a receipt can
   *  type its property read (`T` present, `T | absent` when partial). For a
   *  `type`: the closed enum the declaration names — the same shape a borrowed
   *  option set resolves to, so an annotation cannot tell the two apart. */
  fieldType?: FieldType;
  /** The text reads through this binding that a guard in scope has proven
   *  not `""` (`x.F != ""`, `LENGTH(x) > 0`) — a narrowing, declared by the
   *  same shadowing move as a presence proof. `value` is the binding's own
   *  value; `fields` its dot-plane reads, by property id. */
  nonBlank?: { value?: true; fields?: ReadonlySet<string> };
  /** For `movement`: the declaration + declaring scope, so call sites can type parameters lazily. */
  movement?: {
    decl: MovementDeclaration;
    declScope: Scope;
    /** Cache — computed on first use. */
    paramTypes?: PlaneType[];
    /**
     * The type of a CALL of this movement: what its body RETURNS
     * (`checker/check.ts` `movementReturnType`). Cached like `paramTypes` and
     * for the same reason — it is a fact about the DECLARATION, so every call
     * site asks once. `done: false` is the in-progress marker, so a cycle in
     * type space answers "unknown" instead of recursing; `done: true` with an
     * EMPTY shape records "asked, and this movement returns nothing" — which
     * is a fact a bound call is refused on, not an absence of information.
     */
    returnType?: { done: boolean; shape: ReturnShape };
    /**
     * What CALLING this movement may do — its inferred effect row
     * (`checker/check.ts` `movementEffects`). Cached on the declaration for
     * the same reason `returnType` is: a call site may sit above the
     * declaration, so the row is computed from the body on first ask and
     * every later caller reads the same answer. This is the per-declaration
     * fact the picture and the language service both read, through the
     * `ScopeSymbol` they already hold.
     */
    effects?: EffectRow;
    /** The type the declaration SAYS a call returns (`): <R>`, language
     *  version 3), resolved in the declaring scope. Cached like `returnType`. */
    declaredReturn?: ReturnShape;
    /** The stack depth this body's inference walk is at, while it runs. */
    walking?: number;
    /** The call cycle (strongly connected component) this function is in,
     *  when it is in one — `checker/call_cycles.ts`. */
    cycle?: CallCycle;
    /** What the body needs of the record each record parameter is handed,
     *  by parameter name — one cell per parameter, shared by every walk of
     *  the body and every call site (`FieldsNeed`). */
    paramNeeds?: Map<string, FieldsNeed>;
  };
}

/** What an AUTHORED declaration of a name would shadow. A binding whose
 *  declaration the walk has already passed carries its symbol (and so its
 *  location); one an enclosing statement list binds LATER is known only by
 *  name, because its declaration has not been walked yet. */
export type Shadowing =
  | { kind: 'bound'; symbol: ScopeSymbol }
  | { kind: 'pending' };

export type Resolution =
  | { kind: 'found'; symbol: ScopeSymbol }
  /** Bound by a later statement in an enclosing statement list. */
  | { kind: 'pending' }
  /** Bound inside a traversal block that has closed; `blockName` is the block's meta-node binding when it was assigned. */
  | { kind: 'escaped'; blockName?: string }
  | { kind: 'unknown' };

export type ScopeKind = 'file' | 'movement' | 'traversal' | 'branch';

/**
 * One `declare` into a scope, kept in source order. `symbols` holds only the
 * LAST binding of a name — enough for the checker, which walks forwards and
 * always asks at the position it has reached, but not for the editor, which
 * asks at an arbitrary cursor. A guard clause re-declares its subject narrowed
 * into the ENCLOSING scope, so the live map answers "narrowed" for the whole
 * scope, including positions before the guard ran.
 */
export interface Declaration {
  symbol: ScopeSymbol;
  /** The location from which this binding is the answer for its name — the
   *  declaration's own end normally; the end of the guard statement for a
   *  narrowing that only holds in the guard's continuation. */
  visibleFrom: Loc;
}

/** A name a call can run: a movement, a plugin, a file import (which may be a
 *  movement the linker could not follow), or a name bound to a closure —
 *  movements and functions are one thing, so a closure's name is a function's
 *  name, case-insensitive and collision-checked like any other (language
 *  version 3, the only version that calls one). */
export function isFunctionSymbol(symbol: ScopeSymbol): boolean {
  return (
    symbol.kind === 'movement'
    || symbol.kind === 'plugin'
    || symbol.kind === 'fileImport'
    || symbol.posType?.kind === 'closure'
  );
}

export class Scope {
  readonly symbols = new Map<string, ScopeSymbol>();
  readonly pending = new Set<string>();
  readonly escaped = new Map<string, string | undefined>();
  /**
   * Append-only log of every `declare`, for cursor queries (`log: true`, set
   * by the checker when the language service asked for a recording and
   * inherited by every child scope). Absent on the compile path, which only
   * ever reads the live map and so pays nothing for the history.
   */
  readonly declarations?: Declaration[];

  constructor(
    readonly kind: ScopeKind,
    readonly parent?: Scope,
    options: { log?: boolean } = {},
  ) {
    if (options.log ?? parent?.declarations !== undefined) this.declarations = [];
  }

  /** Binds a symbol; returns the previously-bound symbol of the same name in THIS scope, if any. */
  declare(symbol: ScopeSymbol, options: { visibleFrom?: Loc } = {}): ScopeSymbol | undefined {
    const existing = this.symbols.get(symbol.name);
    this.symbols.set(symbol.name, symbol);
    this.pending.delete(symbol.name);
    this.declarations?.push({ symbol, visibleFrom: options.visibleFrom ?? symbol.span.end });
    return existing;
  }

  /**
   * What an authored binding of `name` HERE would shadow — the same walk
   * `resolve` makes, minus this scope, which is the same-scope duplicate
   * question and already has its own answer. A NARROWING re-declaration asks
   * this nothing: it is the enclosing binding, sharpened, not a second one.
   */
  shadowing(name: string): Shadowing | undefined {
    let child: Scope = this;
    for (let scope: Scope | undefined = this.parent; scope; child = scope, scope = scope.parent) {
      const symbol = scope.symbols.get(name);
      if (symbol) return { kind: 'bound', symbol };
      if (scope.pending.has(name)) return { kind: 'pending' };
    }
    return undefined;
  }

  /**
   * The FUNCTION in scope written `name` in any letter case — a movement, a
   * plugin, or an imported name that may be one. Function names are
   * case-insensitive from language version 3 (variable names are not), and
   * two functions whose names differ only by case are refused where they are
   * declared, so at most one answers.
   */
  resolveFunction(name: string): ScopeSymbol | undefined {
    const folded = name.toLowerCase();
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      for (const symbol of scope.symbols.values()) {
        if (isFunctionSymbol(symbol) && symbol.name.toLowerCase() === folded) return symbol;
      }
    }
    return undefined;
  }

  /** Every function name visible from here, innermost first. */
  functionNames(): string[] {
    const names: string[] = [];
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      for (const symbol of scope.symbols.values()) {
        if (isFunctionSymbol(symbol) && !names.includes(symbol.name)) names.push(symbol.name);
      }
    }
    return names;
  }

  resolve(name: string): Resolution {
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      const symbol = scope.symbols.get(name);
      if (symbol) return { kind: 'found', symbol };
      if (scope.pending.has(name)) return { kind: 'pending' };
    }
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      if (scope.escaped.has(name)) {
        return { kind: 'escaped', blockName: scope.escaped.get(name) };
      }
    }
    return { kind: 'unknown' };
  }
}
