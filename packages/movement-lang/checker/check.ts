// Checker for the movement language.
// Spec: plans/2026-06-10-data-movement-language/4_type_system.md.
//
// M2a (binding layer): checks 1 (import/construction validity) and 3
// (bound-before-read & parallel sibling isolation) — plus the scoping
// model: file/movement/traversal/branch scopes, traversal-block bindings
// that do NOT escape (only the block's assigned meta-node does), traversal
// aliases scoped to their block body, movement/shape hoisting, calls, and
// `through`-argument phasing inside `extract` trees.
//
// M2b (schema-typed layer, built on checker/typing.ts): checks 2 (write
// root/field validity), 4 (traversal validity), 5 (linked writes), 6 (IS
// narrowing), 7 (call fit), 8 (effect typing: write handles, block
// meta-nodes), 9 (extraction-tree validity + explicit type annotations,
// primitive or BORROWED by dotted path, with write-target adoption
// demoted to an info-severity annotation suggestion). Types attach to
// ScopeSymbols where derivable —
// construction → instance schema, write → handle, extract → inferred
// result graph, block → meta-node, parameter → TypeRef resolution — and
// every typed check fires only where the type is KNOWN; unknown stays
// silent (no false positives from missing schemas).
//
// Diagnostics are COLLECTED, never thrown — the checker is the feedback
// surface of the agent's author → typecheck → repair loop, so it reports
// every problem it can find with the most precise span it has.
//
// Name references inside expression slots come from the expression bridge:
// each slot is read by `expressionOfSlot` / `conditionOfSlot` (a refusal
// becomes MOV_EXPR_PARSE), and the resulting formula
// AST is walked for the names that resolve against statement scope —
// `traverse.aliasRoot` / `alias_ref` nodes, plus slots that are exactly one
// bare identifier. Formula `property` references relative to the ambient
// position (backticked or nested bare names like `AI(prompt_binding)`) are
// NOT scope references and are deliberately not resolved here; ambient
// property validity is M2b's schema work.

import type { Expression, ListElement, TraversalStep } from '@listen-fire/shared/expression/types';
import {
  isObjectSpread,
  listElementExpression,
  objectMemberExpression,
  type ObjectEntry,
} from '@listen-fire/shared/expression/types';
import { quoteName } from '@listen-fire/shared/expression/formula';
import {
  flattenAndConjuncts,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '@listen-fire/shared/expression/filter';
import {
  constructionAsCall,
  EXPRESSION_ROOT_PROBE,
  expandWriteSpreads,
  mapTargetRoots,
  memberPathBindingName,
  pathRootName,
  probePathHead,
  spellName,
  spellPathHead,
  spellPathRoot,
} from '../parser/ast';
import {
  AwaitExpression,
  AwaitSource,
  AssignStatement,
  CallbackExpression,
  CallArg,
  CallbackSubject,
  CallStatement,
  ConstructionCall,
  ErrorStatement,
  ExprSlot,
  UniqueClause,
  ExtractCallExpression,
  ExtractCallShape,
  ExtractExpression,
  ExtractField,
  ExtractStage,
  FieldEntry,
  IfStatement,
  ImportStatement,
  InlineBlockExpression,
  LazyTraversal,
  LinkExpression,
  LinkTarget,
  ListenDeclaration,
  Loc,
  MatchExpression,
  MatchTarget,
  WriteTarget,
  MovementDeclaration,
  MovementParam,
  NamedArg,
  CopyPlan,
  MapSpread,
  NodeEntry,
  NodeLiteral,
  PathHead,
  PluginCall,
  Program,
  CombinatorExpression,
  CollectionOp,
  CollectionOpExpression,
  MembersExpression,
  ArmExpression,
  RefreshStatement,
  RValue,
  ClosureExpression,
  DeclaredExtractNode,
  ShapeDeclaration,
  ShapeNode,
  Span,
  Statement,
  TraversalBlock,
  TypeRef,
  WriteExpression,
  WriteSpread,
  type SpreadPath,
  spreadSourceText,
  type ParamTypeRef,
  type ValueTypeMember,
} from '../parser/ast';
import { argumentBindings, isPositionalCall, isValueTypeRef, spellParamType, spellValueType, typeNameOf } from '../parser/ast';
import { isValidDuration, durationToMs } from '../parser/duration';

export type { ReturnShape } from './typing';

/** The `until` cadence floor (F12 / build-order ops ruling): re-checking faster
 *  than once a minute is refused. */
const UNTIL_CADENCE_FLOOR_MS = 60_000;
import { scanName, unwrapCredentialArg } from '../parser/scan';
import { cronScheduleError, cronTimezoneError } from '@listen-fire/shared/cron';
import {
  BridgeError,
  splitUniquenessConjuncts,
  identityKeyOf,
  MovementCondition,
  conditionOfSlot,
  expressionOfSlot,
  parseMovementExpression,
  authoredStringText,
  slotOfTree,
  treeOfSlot,
} from '../expression/bridge';
import {
  children as expressionChildren,
  endingHop,
  isTransformHop,
  specialRecordField,
} from '../parser/expression/lower';
import { ExpressionSyntaxError, parseExpression } from '../parser/expression/parse_expression';
import { isMapSpread, type At, type Hop, type MapEntry, type MExpr } from '../parser/expression/tree';
import { MovementParseError, parseNestedCall } from '../parser/parse';
import {
  hoistingMemberReads,
  nestedCallName,
  nestedCalls,
  readingBoundNames,
  runsAsCall,
  sortKeyOf,
  type CallNode,
} from './nested_calls';
import {
  builtinNotRun,
  computedArgNotRead,
  nestedMessage,
  readCall,
  resolveCallee,
  sortKeyNestedMessage,
  type CallPosition,
  type CallReading,
  type CallRefusal,
  type CallScope,
} from './calls';
import { builtinArity, describeBuiltin, flatBuiltinNames, lookupBuiltin } from './standard_library';
import { HANDBOOK_POINTERS, seeHandbook, withHandbookPointer } from './handbook_pointers';
import { importLine, insertLineAtTop, type DiagnosticFix, type SourceEdit } from './fixes';
import {
  borrowableFieldsOf,
  borrowedTypeSegments,
  Catalog,
  edgeIsWritable,
  writableEdgesOf,
  credentialArgOf,
  describeFieldType,
  type SchemaFieldType,
  EVENT_ACTION_FIELD,
  RECORD_DELETED_ACTION,
  FieldType,
  InstanceSchema,
  declaredTypeOf,
  parseFieldTypeName,
  type PluginOutput,
  type PluginSpec,
  pluginOutputUnder,
  type PositionSchema,
  type EdgeSchema,
  SUPPRESS_SELF_KEY,
  surfaceNotEnumerated,
  unionKey,
  unionVariants,
  variantOf,
  WritableRootSchema,
} from './catalog';
import {
  LinkDiagnosticCodes,
  linkImports,
  LinkedExport,
  LinkedFile,
  ProgramLink,
  ResolveFile,
} from './link';
import {
  type EventAddress,
  eventAddressDisplay,
  eventAddressKey,
  eventAddressOfHops,
  eventAddressSource,
  narrowingPrefixKey,
  listenNarrowing,
} from './event_address';
import {
  inheritDeclaration,
  inheritSchema,
  type RequiredPosition,
  schemaSurface,
  shapeToSchema,
  type SuppliedSurface,
  surfaceMisfit,
  textRepair,
} from './conformance';
import {
  EffectFrame,
  EMPTY_ROW,
  rowFromDeclaration,
  UNKNOWN_ROW,
  type EffectRow,
} from './effects';
import { InferenceStack } from './call_cycles';
import { neverAsAny } from '../never';
import {
  before,
  since,
  changedBetween,
  CURRENT_LANGUAGE_VERSION,
  describeLanguageVersion,
  languageVersionDiagnostic,
  type LanguageVersion,
} from '../language_version';
import { bodyExits, terminates } from './flow';
import { closestByEditDistance, didYouMean } from './meta';
import { readCollectionConfig } from './collection_config';
import { readExtractCallConfig } from './extract_config';
import { genericLandingKey, literalStringValuesOf } from './generics';
import { parseTraversalPath } from '../service/selectors';
import { isFunctionSymbol, Resolution, Scope, ScopeKind, ScopeSymbol, SymbolKind } from './scopes';
import {
  CALLBACK_CONFIG_KEYS,
  CallbackParams,
  callbackType,
  checkEnumLiteral,
  aggregatedBarePath,
  bareName,
  recordIn,
  checkEnumDomain,
  describePosition,
  checkJsonOpaque,
  fieldsNeededBy,
  type FieldsNeed,
  holdsFieldsInHand,
  holdsReachedFieldsInHand,
  noteFieldsNeeded,
  parameterNeedOf,
  displayNameOf,
  EXTRACT_ROOT_NAME,
  ExpressionTyping,
  type ExpressionEffect,
  ExtractNodeType,
  instanceOfType,
  fieldAssignable,
  fieldTypeCompatible,
  fieldTypeEquals,
  LocalEdge,
  InstanceRef,
  isMaybeAbsent,
  maybeAbsent,
  narrowPresent,
  directFieldRead,
  narrowPresentNode,
  negativePresenceProofs,
  PositionTypeRef,
  ClosureParam,
  closureType,
  type CollectionOrder,
  listOf,
  collectionOrderOf,
  aiTierDiagnostics,
  collectionElementOf,
  type PlaneType,
  type ReturnShape,
  PresenceProof,
  presenceProofs,
  holdsRecords,
  isDictType,
  isEnumType,
  isListType,
  isRecordType,
  isWalkProjection,
  positionRefIn,
  positionsMatch,
  positionSchemaOfRef,
  recordHeadPosition,
  recordOf,
  recordValueOf,
  readsAsPresentText,
  stripAbsent,
  TypedDiagnosticCodes,
  valueUnion,
  mixedTupleMessage,
  widenTuples,
  unifyValueTypes,
  WriteTargetRef,
} from './typing';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  message: string;
  span: Span;
  /** Absent means 'error'. 'warning' and 'info' diagnostics never gate a
   *  compile — warnings flag likely-unintended-but-legal authoring. */
  severity?: DiagnosticSeverity;
  /** Set on a diagnostic the checker emits only BECAUSE this is a check for a
   *  move up (`CheckOptions.upgradingFrom`): it marks a construct whose
   *  meaning changed between the two versions. What keeps a pin where it is,
   *  alongside errors — every other warning (a cost note, say) reads the same
   *  under either version and says nothing about the move. */
  upgrade?: true;
  /** The exact rewrite that resolves it, built from the author's own source —
   *  also spelled out in `message`, which is all a text reader sees. */
  fix?: DiagnosticFix;
}

export function diagnosticSeverity(diagnostic: Diagnostic): DiagnosticSeverity {
  return diagnostic.severity ?? 'error';
}

export const DiagnosticCodes = {
  IMPORT_UNKNOWN: 'MOV_IMPORT_UNKNOWN',
  IMPORT_DUPLICATE: 'MOV_IMPORT_DUPLICATE',
  IMPORT_FILE_UNSUPPORTED: 'MOV_IMPORT_FILE_UNSUPPORTED',
  EXPR_PARSE: 'MOV_EXPR_PARSE',
  /** A closure literal (`(n) => { … }`) written where the formula grammar
   *  takes over — a call argument, a write field, a hop WHERE. The formula
   *  grammar has no closure production (it dies on the bare `>`), so this
   *  gives the real reason instead of that generic parse error. A closure is
   *  only legal in an assignment, a return, a MAP/FILTER/REDUCE-family
   *  function slot, a race or parallel arm, an `await until` condition, or a
   *  callback's subject — all read by the statement parser's own
   *  `atClosure`/`parseClosure`, never by this formula grammar. */
  EXPR_CLOSURE_POSITION: 'MOV_EXPR_CLOSURE_POSITION',
  NAME_UNRESOLVED: 'MOV_NAME_UNRESOLVED',
  USE_BEFORE_BIND: 'MOV_USE_BEFORE_BIND',
  CONSTRUCT_NOT_ADAPTER: 'MOV_CONSTRUCT_NOT_ADAPTER',
  CONSTRUCT_BAD_ARG: 'MOV_CONSTRUCT_BAD_ARG',
  /** Warning severity: an enum-typed construction arg (an entry-position arg
   *  like Sheets' `spreadsheet:`) names a value this connection can't see. */
  CONSTRUCT_UNKNOWN_OPTION: 'MOV_CONSTRUCT_UNKNOWN_OPTION',
  CONSTRUCT_MISSING_CRED: 'MOV_CONSTRUCT_MISSING_CRED',
  CRED_WRONG_ADAPTER: 'MOV_CRED_WRONG_ADAPTER',
  DUPLICATE_DECL: 'MOV_DUPLICATE_DECL',
  /** An authored binding reuses a name an ENCLOSING scope already binds. The
   *  same-scope half of this is DUPLICATE_DECL; this is the cross-scope half,
   *  which used to resolve silently and leave one name meaning two things. */
  SHADOWED_NAME: 'MOV_SHADOWED_NAME',
  CALL_NOT_MOVEMENT: 'MOV_CALL_NOT_MOVEMENT',
  CALL_ARITY: 'MOV_CALL_ARITY',
  // Call resolution against the standard-library scope (language version 3;
  // checker/calls.ts, checker/standard_library.ts).
  /** A called name that nothing in scope declares and the standard library
   *  does not have — with a did-you-mean over both. */
  FUNCTION_UNKNOWN: 'MOV_FUNCTION_UNKNOWN',
  /** A function declared (or imported) under a name another function in scope
   *  already has in another letter case, or under a built-in's name. Function
   *  names are case-insensitive, so either would make one call mean two things. */
  FUNCTION_NAME_COLLISION: 'MOV_FUNCTION_NAME_COLLISION',
  /** A built-in handed an argument it does not take, or the wrong number. */
  BUILTIN_ARGS: 'MOV_BUILTIN_ARGS',
  /** A built-in that only computes a value, written as a whole statement. */
  BUILTIN_UNUSED: 'MOV_BUILTIN_UNUSED',
  /** A call the engine runs — a function's, a collection op, `MEMBERS` —
   *  written in a walk's `WHERE`, `ORDER BY` or settings, which are read once
   *  per landing, or in a `SORT` key, read once per member. Anywhere else in
   *  an expression such a call is a nested call (language version 3;
   *  checker/nested_calls.ts). */
  CALL_NESTED: 'MOV_CALL_NESTED',
  /** `IF … THEN … END` with no `ELSE` (language version 3). Before it, the
   *  missing arm silently read as `""`, whatever the THEN arm held. */
  IF_WITHOUT_ELSE: 'MOV_IF_WITHOUT_ELSE',
  /** A `{ … }` settings object on a hop (language version 3) — no hop reads
   *  one. Before it, the settings were dropped without a word. */
  HOP_CONFIG_UNREAD: 'MOV_HOP_CONFIG_UNREAD',
  /** A walk ending in `-[:_resources]->` that would lose part of what was
   *  written (language version 3): as a value, its root; as a block head,
   *  the hops before it. Before it, both were dropped silently. */
  RESOURCE_WALK_UNREAD: 'MOV_RESOURCE_WALK_UNREAD',
  // Translation-graph reads a movement run has no source for (language
  // version 3). Before it, each was accepted; the movement engine refused the
  // first two at run time, and the last two read the translation graph's
  // context, which a run does not have.
  /** RETIRED: the `-[t:#transform { plugin: … }]->` hop. A plugin is
   *  imported and called. */
  TRANSFORM_HOP_RETIRED: 'MOV_TRANSFORM_HOP_RETIRED',
  /** RETIRED: the `-[#linked WHERE type = "…"]->` hop, which looked a record
   *  up by another system's id. The record a write lands on is its handle. */
  LINKED_HOP_RETIRED: 'MOV_LINKED_HOP_RETIRED',
  /** RETIRED: `@parent.created` / `@parent.external_id` — the parent action
   *  node's result. A child is written off the parent write's handle. */
  PARENT_READ_RETIRED: 'MOV_PARENT_READ_RETIRED',
  /** RETIRED: `@resource.<field>`. Inside a `-[:_resources WHERE …]->` filter
   *  it is the bare field name, which the fix writes; anywhere else it was
   *  always null. */
  RESOURCE_READ_RETIRED: 'MOV_RESOURCE_READ_RETIRED',
  /** A built-in the catalog lists that the movement engine cannot run
   *  (`LLM_AGG`; language version 3). Before it, the call passed the save
   *  check and failed the run. */
  BUILTIN_NOT_RUN: 'MOV_BUILTIN_NOT_RUN',
  /** A call to a function that may WAIT, written inside an expression. A wait
   *  parks the run at a statement, and a position inside an expression is not
   *  one — so a call that can park is a whole statement, or the whole
   *  right-hand side of a binding (language version 3). */
  NESTED_CALL_SUSPENDS: 'MOV_NESTED_CALL_SUSPENDS',
  /** A wait where the run cannot be resumed (language version 3): inside a
   *  callback's body — directly, or through a function it calls — or in an
   *  `await until` condition, through a function it calls. A run resumes by
   *  walking back to the statement it parked at, and neither has one it can
   *  walk to: a fired callback body is a side entry, and a condition is
   *  re-evaluated by the clock rather than resumed. */
  WAIT_NOT_RESUMABLE: 'MOV_WAIT_NOT_RESUMABLE',
  // Named-argument matching (calls and `run` both: parens = callable
  // arguments, always named; the checker matches arguments to parameters
  // by name, so order carries no meaning).
  /** An argument name that is not a parameter of the callee. */
  CALL_ARG_UNKNOWN: 'MOV_CALL_ARG_UNKNOWN',
  /** Parameters the argument list does not supply. */
  CALL_ARG_MISSING: 'MOV_CALL_ARG_MISSING',
  /** The same argument name given twice. */
  CALL_ARG_DUPLICATE: 'MOV_CALL_ARG_DUPLICATE',
  // Node literals (`node { … }` — in-memory node synthesis)
  /** The same entry name written twice in one node literal — one name, one
   *  meaning, and nothing says which of the two the callee would read. */
  NODE_ENTRY_DUPLICATE: 'MOV_NODE_ENTRY_DUPLICATE',
  /** An entry VALUE that is a NODE — `btn: b`, `f: FIRST(b-[:E]->)`. The value
   *  plane is scalar; a child edge is declared by a nested literal or a walk.
   *  Filing the node as an untyped field (the old behavior) went dark exactly
   *  where the author meant an edge. */
  NODE_ENTRY_NODE_VALUE: 'MOV_NODE_ENTRY_NODE_VALUE',
  /** A plural synthesised edge whose landings disagree about an entry's type.
   *  A traversal yields ONE landing type, so the landings must agree on what
   *  they carry; disagreeing silently would leave a read typed by whichever
   *  literal happened to come first. */
  NODE_LANDING_MISMATCH: 'MOV_NODE_LANDING_MISMATCH',
  /** A synthesised node passed where the parameter's declared type needs
   *  something the literal doesn't carry. A node belongs to no graph, so it is
   *  compared STRUCTURALLY: it fits when it has every field and edge the
   *  parameter declares (extras are fine — the callee can't see them). */
  NODE_ARG_SHAPE: 'MOV_NODE_ARG_SHAPE',
  // Graph literals (`graph<Shape> { … }` — a local graph built as a value,
  // checked against the shape the way TypeScript's `satisfies` checks an
  // object literal)
  /** `graph<X>` where `X` is not a node declaration. */
  GRAPH_SHAPE: 'MOV_GRAPH_SHAPE',
  /** An entry the shape doesn't declare — a misspelling, with a did-you-mean.
   *  TS's excess-property check: the literal is the one place the extra name
   *  can only be a mistake. */
  GRAPH_FIELD_UNKNOWN: 'MOV_GRAPH_FIELD_UNKNOWN',
  /** A field value whose type is not the one the shape declares. */
  GRAPH_FIELD_TYPE: 'MOV_GRAPH_FIELD_TYPE',
  /** A required field (not `<T | null>`) the literal never writes. */
  GRAPH_FIELD_MISSING: 'MOV_GRAPH_FIELD_MISSING',
  /** A value where the shape has a child node, or a body/walk where it has a
   *  field. */
  GRAPH_ENTRY_KIND: 'MOV_GRAPH_ENTRY_KIND',
  /** A record spread whose record doesn't carry what the shape's child node
   *  needs. */
  GRAPH_COPY_SHAPE: 'MOV_GRAPH_COPY_SHAPE',
  /** A reference entry — a bare walk or a record — whose records don't carry
   *  what the shape's child node needs. */
  GRAPH_REFERENCE_SHAPE: 'MOV_GRAPH_REFERENCE_SHAPE',
  /** `...v` where `v` is not a map. */
  GRAPH_SPREAD_NOT_MAP: 'MOV_GRAPH_SPREAD_NOT_MAP',
  /** `...v`, without a shape, where nothing says which keys `v` holds (or
   *  whether a key holds a nested map) — so nothing could type the graph. */
  GRAPH_SPREAD_UNTYPED: 'MOV_GRAPH_SPREAD_UNTYPED',
  /** A declared entry (`companies: <Company>`) whose marker names neither a
   *  node this file declares nor an address. An entry that starts EMPTY is an
   *  edge, so its type has to say what LANDS there, and only those two
   *  spellings do. */
  NODE_ENTRY_TYPE: 'MOV_NODE_ENTRY_TYPE',
  /** A `link` onto an edge name the run-local node never declared. The literal
   *  is the whole of what the node has, so the edge is a typo rather than
   *  something a system might know about. */
  NODE_EDGE_UNDECLARED: 'MOV_NODE_EDGE_UNDECLARED',
  /** A `link` onto a `lazy` entry. Its landings come from a walk that runs
   *  again at every read, so an appended one would be gone by the next. */
  NODE_EDGE_DEFERRED: 'MOV_NODE_EDGE_DEFERRED',
  /** A `link` whose landing doesn't carry what the declared edge says its
   *  landings are — the same structural assignability an argument gets. */
  NODE_LINK_SHAPE: 'MOV_NODE_LINK_SHAPE',
  /** A `link` body from a node this run built. The body finds among that
   *  edge's own landings, so what it finds is already linked there. */
  NODE_LINK_BODY: 'MOV_NODE_LINK_BODY',
  THROUGH_NOT_PLUGIN: 'MOV_THROUGH_NOT_PLUGIN',
  THROUGH_BAD_ARG: 'MOV_THROUGH_BAD_ARG',
  /** A required argument (`PluginSpec.requiredArgs`) the call never wrote at
   *  all — distinct from one that resolves absent at run time, which the
   *  engine's skip-on-absent sentinel already covers honestly. Omitting the
   *  argument is an authoring mistake, not a data outcome, so it's refused
   *  here rather than left to skip the stage silently on every firing. */
  THROUGH_ARG_MISSING: 'MOV_THROUGH_ARG_MISSING',
  THROUGH_FORWARD_REF: 'MOV_THROUGH_FORWARD_REF',
  /** A plugin called as an ordinary function whose registry entry declares no
   *  effect row. A plugin is a function whose body nobody can walk, so the row
   *  is the only thing that says what folding a call into a movement would add
   *  — without one the honest place for it is a `through [ … ]` stage, whose
   *  pipeline bounds what it reaches. */
  PLUGIN_ROW_UNDECLARED: 'MOV_PLUGIN_ROW_UNDECLARED',
  /** A plugin called with POSITIONAL arguments. A plugin's parameters are a
   *  registry's flat config with no designed order, so they are named only. */
  PLUGIN_ARGS_NAMED: 'MOV_PLUGIN_ARGS_NAMED',
  /** A plugin called as an ordinary function when the EXTRACTION is what feeds
   *  it — either the extraction is its only way in (nothing a bare call could
   *  pass it), or the one argument a stage gets fed for free was left out of a
   *  call that has no stage behind it. */
  PLUGIN_FED_BY_EXTRACTION: 'MOV_PLUGIN_FED_BY_EXTRACTION',
  /** A plugin called as an ordinary function whose registry entry says nothing
   *  about what it HANDS BACK. A stage's output goes to the extractor and needs
   *  no type; a call's output is bound to a name, and a name whose type nothing
   *  describes is silence every read downstream inherits. */
  PLUGIN_OUTPUT_UNDECLARED: 'MOV_PLUGIN_OUTPUT_UNDECLARED',
  /** Warning, on a check for a move up (`CheckOptions.upgradingFrom`): a
   *  plain call to a plugin whose output changed shape between the two
   *  versions. A program written for the older shape may still validate
   *  against the new one while meaning something else, so it is said rather
   *  than left for a run to find out. */
  PLUGIN_OUTPUT_CHANGED: 'MOV_PLUGIN_OUTPUT_CHANGED',
  /** Warning, on a check for a move up across version 2 (which made an empty
   *  identity key no key): a `unique by` field whose value is text that may
   *  be `""` — a system's or a program's text, not an extracted one (whose ""
   *  was absent before, and no key either way). The record it identifies
   *  matches nothing when the value is empty, where version 1 matched "" like
   *  any other value. */
  UNIQUE_KEY_MAY_BE_BLANK: 'MOV_UNIQUE_KEY_MAY_BE_BLANK',
  /** The same field name declared twice in one extract stage — within a
   *  stage, `buildExtractGraph` keeps the last one and the other silently
   *  vanishes. A LATER stage redeclaring a field is the documented
   *  "transformation wins" semantic and stays legal; this only catches two
   *  fields naming the same thing in the same stage. */
  EXTRACT_FIELD_DUPLICATE: 'MOV_EXTRACT_FIELD_DUPLICATE',
  /** `node entry: <X>` where `X` is not a node declaration — an extraction
   *  node's shape is a declared structure, never a system's record type. */
  EXTRACT_SHAPE_NOT_DECLARED: 'MOV_EXTRACT_SHAPE_NOT_DECLARED',
  /** `extract(content, s)` where `s` is worked out rather than a node
   *  declaration known when the program is checked — the result's type IS
   *  the shape, so a shape nobody can see types nothing. */
  EXTRACT_SHAPE_COMPUTED: 'MOV_EXTRACT_SHAPE_COMPUTED',
  /** `extract(content, …)` where the content is not a list of text and files:
   *  a record, a map or json handed over raw (render it with
   *  `TEXT.SERIALISE`), a number or a date, or one value where a list goes. */
  EXTRACT_CONTENT: 'MOV_EXTRACT_CONTENT',
  /** `extract(content, Shape, { … })` with settings the call cannot run with:
   *  an unknown key, a tier or effort outside its words, a model this
   *  deployment does not reach, or a value worked out rather than written. */
  EXTRACT_CONFIG: 'MOV_EXTRACT_CONFIG',
  /** `node X extends Y` where `Y` is not a node declaration in scope. */
  EXTENDS_NOT_A_NODE: 'MOV_EXTENDS_NOT_A_NODE',
  /** `node A extends B` where `B` extends `A` — directly or further up. */
  EXTENDS_CYCLE: 'MOV_EXTENDS_CYCLE',
  /** `node X extends Y { f: … }` where `Y` already has `f` (a field, or a
   *  nested node): X inherits Y's members whole and cannot restate one. */
  EXTENDS_REDEFINES: 'MOV_EXTENDS_REDEFINES',
  /** `...x` in a write body where `x`'s fields are not known — a spread
   *  writes every field of an extracted record, so it needs one. */
  WRITE_SPREAD_SOURCE: 'MOV_WRITE_SPREAD_SOURCE',
  /** A record whose fields are read from its system one at a time, handed to
   *  a function parameter whose body needs every field in hand (it
   *  serialises, spreads or passes on the record to one that does). */
  CALL_ARG_OPAQUE_RECORD: 'MOV_CALL_ARG_OPAQUE_RECORD',
  // Listeners (trigger rows are derived from `listen` statements)
  LISTEN_FILE_LEVEL: 'MOV_LISTEN_FILE_LEVEL',
  LISTEN_NOT_INSTANCE: 'MOV_LISTEN_NOT_INSTANCE',
  /** An adapter import used where a constructed instance is required — a
   *  movement parameter's position source (`<manual-[:invocation]->>`) or a
   *  `listen to`. Instantiation is explicit: construct + name the instance
   *  first (`go = manual()`), then reference it by name. */
  ADAPTER_NOT_CONSTRUCTED: 'MOV_ADAPTER_NOT_CONSTRUCTED',
  /** A block head rooted at a name bound on the VALUE plane — text, a number, a
   *  list of them — or at an EXPRESSION whose value type is one of those. The
   *  value plane holds no positions, so the hop can never land; a value whose
   *  type is not known stays silent and walks. */
  HEAD_NOT_A_POSITION: 'MOV_HEAD_NOT_A_POSITION',
  /** A head written at a position that needs a NAMED root — an `await`, which
   *  parks on the record it waits at and has to name it again on resume. The
   *  walk itself is fine; bind the expression first. */
  HEAD_NEEDS_A_NAME: 'MOV_HEAD_NEEDS_A_NAME',
  /** The listened system has no inbound surface at all — its manifest names
   *  zero trigger types, so nothing it does can ever reach us. A definite
   *  fact, not an unknown: see `AdapterSpec.canFire`. */
  LISTEN_CANNOT_FIRE: 'MOV_LISTEN_CANNOT_FIRE',
  LISTEN_PARAM_MISMATCH: 'MOV_LISTEN_PARAM_MISMATCH',
  LISTEN_SHAPE_MISMATCH: 'MOV_LISTEN_SHAPE_MISMATCH',
  LISTEN_DUPLICATE: 'MOV_LISTEN_DUPLICATE',
  LISTEN_ALIAS_DUPLICATE: 'MOV_LISTEN_ALIAS_DUPLICATE',
  LISTEN_BAD_CONFIG: 'MOV_LISTEN_BAD_CONFIG',
  /** Info severity: a dispatchable movement with no listen — nothing fires it. */
  LISTEN_MISSING: 'MOV_LISTEN_MISSING',
  // Native uniqueness vs authored `unique by`
  /** Info severity: the authored clause exactly duplicates a native rule.
   *  (The disjoint "conflict" case is intentionally NOT a diagnostic — the
   *  target matching on its own native rules is expected; the editor shows
   *  the native rules as an overlay hint on the write target instead.) */
  UNIQUE_NATIVE_REDUNDANT: 'MOV_UNIQUE_NATIVE_REDUNDANT',
  /** A `FUZZY` modifier on a `unique by` component the target can't resolve
   *  by similarity: the target has no `fuzzyResolution` at all, or lists the
   *  fields it has it for and the component's field is not one of them. */
  UNIQUE_FUZZY_UNSUPPORTED: 'MOV_UNIQUE_FUZZY_UNSUPPORTED',
  /** A `match` with nothing to identify the record by — no `unique by`, and a
   *  target with no identity rules of its own. It could only ever find
   *  "some record of this type". */
  MATCH_NO_IDENTITY: 'MOV_MATCH_NO_IDENTITY',
  /** `unique by (…)` on a target that decides record identity itself and does
   *  not accept author-defined uniqueness (the adapter declared
   *  `uniquenessAuthorable: false` — e.g. Affinity, whose org/person matching
   *  is native and not a thing a movement configures). */
  UNIQUE_NOT_AUTHORABLE: 'MOV_UNIQUE_NOT_AUTHORABLE',
  /** A `unique by` conjunct that is not part of the key and reads something
   *  other than the candidate's own fields — a hop, a call, a value bound
   *  elsewhere in the run. Such a conjunct narrows the candidates by testing
   *  each one's fields and nothing else, so this one could not be honoured;
   *  the target's WHERE reads the candidate with the whole run in scope. */
  UNIQUE_CONJUNCT_NEEDS_WHERE: 'MOV_UNIQUE_CONJUNCT_NEEDS_WHERE',
  /** A write/link target rooted at a name that is not a graph this file
   *  declares (a constructed adapter instance, kg, or a shape). The
   *  canonical case is an instance-typed PARAMETER used as a write
   *  target — permanently rejected: schemas are per-credential, so an
   *  instance can't travel between movements; the writing movement
   *  constructs the instance itself. */
  WRITE_TARGET_NOT_GRAPH: 'MOV_WRITE_TARGET_NOT_GRAPH',
  /** RETIRED: a write whose target graph is a declared `node`
   *  (`write Lead-[:item]-> { … }`). A shape names a structure, not a system
   *  that stores anything, so the construct only ever pretended to be a write.
   *  `node { … }` synthesises the record instead, and carries edges a shape
   *  write never could. Refused at author time; the engine keeps running
   *  programs saved before the retirement until that path is deleted. */
  WRITE_SHAPE_RETIRED: 'MOV_WRITE_SHAPE_RETIRED',
  /** RETIRED: a type annotation that HOPS through a node declaration
   *  (`<Doc-[:item]->>`). A declaration used to wrap its nodes in a meta-node
   *  you had to hop past; it IS its root node now, so `<Doc>` starts where the
   *  author meant to start and the hop names a graph that no longer exists. */
  SHAPE_HOP_RETIRED: 'MOV_SHAPE_HOP_RETIRED',
  // Tuple-path multi-parent writes (`write (a-[:e]->, b-[:f]->) { … }`)
  /** The tuple's paths infer DIFFERENT written types — they must agree. */
  WRITE_TUPLE_MISMATCH: 'MOV_WRITE_TUPLE_MISMATCH',
  /** The written type declares required edges this write form doesn't establish. */
  WRITE_MISSING_REQUIRED_EDGE: 'MOV_WRITE_MISSING_REQUIRED_EDGE',
  /** The written type declares required fields this write's body never sets —
   *  the target would reject the create at runtime. */
  WRITE_MISSING_REQUIRED_FIELD: 'MOV_WRITE_MISSING_REQUIRED_FIELD',
  /** Info severity: a handle assigned directly to a reference-named field —
   *  nudge toward the link / tuple-path forms (one idiomatic spelling). */
  WRITE_LINK_FIELD_NUDGE: 'MOV_WRITE_LINK_FIELD_NUDGE',
  /** `+:` / `+?:` (append / append-if-missing) on a field that isn't a list —
   *  append only has meaning for a multi-valued field. */
  WRITE_APPEND_NOT_MULTI: 'MOV_WRITE_APPEND_NOT_MULTI',
  /** Warning severity: every field of a write is a `?:` (fill) with a
   *  possibly-absent value, so at runtime they can ALL be omitted and the write
   *  reaches the adapter empty. Gate it on presence instead (asks-as-adapter
   *  chunk D, from C's absence gate). */
  WRITE_MAY_BE_EMPTY: 'MOV_WRITE_MAY_BE_EMPTY',
  /** `x = write parent-[:edge]->` where the final edge is ephemeral —
   *  the write is an action (e.g. a typing indicator); nothing is created,
   *  so there is nothing to bind or chain from. */
  WRITE_EPHEMERAL_BOUND: 'MOV_WRITE_EPHEMERAL_BOUND',
  /** A write/link path ends on a READ-ONLY edge (`EdgeSchema.writable:
   *  false`) — the external system materialises those records itself (a
   *  message's inbound `attachments`), so nothing can be created or attached
   *  along it. Fires before the generic target-not-writable gate so the
   *  message names the EDGE's read-only nature, not the target's. */
  WRITE_READ_ONLY_EDGE: 'MOV_WRITE_READ_ONLY_EDGE',
  /** A `WHERE` on a hop of a `match`/`write` target other than the last. The
   *  target's WHERE narrows the records its final hop lands on (the identity
   *  candidates); an earlier hop is one the target only passes through. */
  TARGET_WHERE_NOT_FINAL: 'MOV_TARGET_WHERE_NOT_FINAL',
  /** A `WHERE` on a `match`/`write` target whose edge belongs to a node this
   *  run built — its landings take no WHERE (the read side refuses one too);
   *  `unique by` is how a landing is picked. */
  TARGET_WHERE_LOCAL: 'MOV_TARGET_WHERE_LOCAL',
  /** A `WHERE` on the target of a `bind` write — a bound write's identity IS
   *  the binding, so there are no candidates to narrow (the `WRITE_BIND_UNIQUE`
   *  twin). */
  TARGET_WHERE_BIND: 'MOV_TARGET_WHERE_BIND',
  /** `link` / `unlink` along an edge the source system can only CREATE along
   *  (`EdgeSchema.linkable: false`). The write promise covers making the
   *  relationship as part of writing the target; it does not cover joining two
   *  records that already exist, and the system says so rather than letting
   *  the run find out. */
  LINK_UNSUPPORTED_EDGE: 'MOV_LINK_UNSUPPORTED_EDGE',
  // Position writes (`write a { … }` — update the record bound at alias `a`)
  /** The bare-alias write target doesn't resolve to a writable record
   *  position — a meta/extract/block node, or an unknown name, has no single
   *  record to update in place. */
  WRITE_POSITION_NOT_RECORD: 'MOV_WRITE_POSITION_NOT_RECORD',
  /** A name reached a rule that needs a record and its binding says nothing
   *  about what it holds — on either plane. Every way of binding a name types
   *  it, so this is the checker failing to, and it is said rather than
   *  accepted: an untyped binding would otherwise reach the run, which is
   *  where the disagreement would show. */
  UNTYPED_BINDING: 'MOV_INTERNAL_UNTYPED_BINDING',
  /** The bound position's system can't update records in place — its adapter
   *  doesn't implement `updateRecord` (e.g. an append-only Slack/Drive). */
  WRITE_POSITION_NO_UPDATE: 'MOV_WRITE_POSITION_NO_UPDATE',
  /** `unique by (…)` on a position write — you already hold the exact record,
   *  so there is nothing to resolve. */
  WRITE_POSITION_UNIQUE: 'MOV_WRITE_POSITION_UNIQUE',
  // Bound writes (`write crm-[:Company]-> bind other { … }` — engine-owned
  // correspondence between the written record and `other`'s record)
  /** The `bind` target doesn't resolve to a stable record position — it
   *  must name a record (a traversal alias, a prior write handle, the event
   *  position), the same shape correspondence is keyed on. */
  WRITE_BIND_NOT_RECORD: 'MOV_WRITE_BIND_NOT_RECORD',
  /** `unique by (…)` together with `bind` — the binding IS the identity,
   *  so field uniqueness has no role on a bound write. They don't compose. */
  WRITE_BIND_UNIQUE: 'MOV_WRITE_BIND_UNIQUE',
  /** `bind` on a position write (`write a bind … { … }`) — a position write
   *  already holds the exact record, so there is nothing to correspond. */
  WRITE_BIND_POSITION: 'MOV_WRITE_BIND_POSITION',
  /** `bind` against a target whose system can't update records in place
   *  (`supportsInPlaceUpdate` false — append-only Sheets, write-only Drive). A
   *  bound write re-fires as `updateRecord` when the counterpart recurs, so the
   *  target MUST support update-by-id; otherwise it detonates on the 2nd fire. */
  WRITE_BIND_NO_UPDATE: 'MOV_WRITE_BIND_NO_UPDATE',
  /** A type reference (`graph.position`) names a position the graph's KNOWN
   *  schema does not declare — movement parameters, IS tests, shape-edge
   *  endpoints. Schema-less graphs stay silent (unknown never errors). */
  UNKNOWN_POSITION: 'MOV_UNKNOWN_POSITION',
  /** A bare type annotation names neither a primitive nor a declared type
   *  (`type Thesis = <"A" | "B">`), so it constrains nothing. */
  UNKNOWN_TYPE_NAME: 'MOV_UNKNOWN_TYPE_NAME',
  // Borrowed types (`stage: crm.companies.funding_stage "…"`)
  BORROW_MALFORMED: 'MOV_BORROW_MALFORMED',
  BORROW_UNKNOWN_GRAPH: 'MOV_BORROW_UNKNOWN_GRAPH',
  BORROW_UNKNOWN_ROOT: 'MOV_BORROW_UNKNOWN_ROOT',
  BORROW_UNKNOWN_FIELD: 'MOV_BORROW_UNKNOWN_FIELD',
  // await (asks-as-adapter wake primitive). AWAIT_REQUIRED / AWAIT_IMPURE_WHERE
  // ride in via TypedDiagnosticCodes (fired inside the traversal walk).
  /** `await <traversal>` whose final edge is NOT awaitable — await requires an
   *  edge whose resolution resumes the run (an ask's `Response`). Read an
   *  ordinary edge live, without `await`. */
  AWAIT_NOT_AWAITABLE: 'MOV_AWAIT_NOT_AWAITABLE',
  /** `await FIRST(<traversal>)` on an awaitable edge the platform does NOT
   *  deliver events for. A park needs something to wake it: where the source
   *  pushes, `await FIRST` is the form; where it doesn't, the author owns the
   *  cadence (`await until(…, every: …)`) and the message names it. */
  AWAIT_NEEDS_CADENCE: 'MOV_AWAIT_NEEDS_CADENCE',
  /** WARNING — an `until` poll over an edge the source now pushes. The rewrite
   *  is never made for the author (an adapter gaining webhooks must not change
   *  what a saved movement does), so the checker says so and leaves it. */
  UNTIL_EDGE_WATCHABLE: 'MOV_UNTIL_EDGE_WATCHABLE',
  /** `await <traversal>` — the retired bare-walk spelling. The park IS the
   *  FIRST read, parked, so it is spelled that way: `await FIRST(<traversal>)`.
   *  Hard break (layer 13 C1, ruling 2026-08-05); the message carries the
   *  rewrite. */
  AWAIT_BARE_WALK: 'MOV_AWAIT_BARE_WALK',
  /** `race([…])` / `parallel([…])` outside `await` — a combinator composes a
   *  wait; only `await` parks. The message carries the rewrite. */
  COMBINATOR_NEEDS_AWAIT: 'MOV_COMBINATOR_NEEDS_AWAIT',
  /** An arm of `race`/`parallel` that is not a function — a name bound to a
   *  record, a value, an instance. The combinator's whole job is to CALL its
   *  arms, so there is nothing it could do with one. */
  COMBINATOR_ARM_NOT_FUNCTION: 'MOV_COMBINATOR_ARM_NOT_FUNCTION',
  /** An arm that declares parameters. A combinator calls its arms with nothing
   *  — there is no caller to supply an argument — so a parameter could only
   *  ever arrive null. Capture the value instead: a closure sees what is in
   *  scope where it is written. */
  COMBINATOR_ARM_TAKES_NOTHING: 'MOV_COMBINATOR_ARM_TAKES_NOTHING',
  /** A parameter written with no `: <type>` where nothing supplies one. Only a
   *  collection op does — it hands its function one element, so `MAP(xs, (x)
   *  => …)` knows what `x` is. Everywhere else a parameter's type is the
   *  promise its callers are checked against, so it is written down. */
  PARAM_NEEDS_TYPE: 'MOV_PARAM_NEEDS_TYPE',
  /** A collection op (`MAP`, `FILTER`, `REDUCE`, `GROUPBY`, `KEYBY`) reads
   *  something that is not a collection of values — a single value, or a
   *  position. Positions have their own iteration form (the traversal-headed
   *  block), which is where the null-safety, the provenance and the writes
   *  live; these ops are the VALUES' form. */
  COLLECTION_OP_NOT_A_COLLECTION: 'MOV_COLLECTION_OP_NOT_A_COLLECTION',
  /** A collection op's function takes the wrong number of parameters — one
   *  element for `MAP`/`FILTER`/`GROUPBY`/`KEYBY`, the carried value and the
   *  element for `REDUCE`. */
  COLLECTION_OP_ARITY: 'MOV_COLLECTION_OP_ARITY',
  /** A collection op's function hands nothing back. Every one of them is a
   *  question asked per element — what it becomes, whether it stays, what it
   *  is filed under — so a function with no `return` answers none of them. */
  COLLECTION_OP_RETURNS_NOTHING: 'MOV_COLLECTION_OP_RETURNS_NOTHING',
  /** A collection op's function may PARK the run (it awaits) — refused before
   *  language version 3, whose resume could not re-enter a member. From version
   *  3 a member that waits parks on its own, and the op finishes once every
   *  member has (a join, as a traversal-headed block is). */
  COLLECTION_OP_SUSPENDS: 'MOV_COLLECTION_OP_SUSPENDS',
  /** `MAP(xs, { … }, f)` / `FILTER(xs, { … }, f)` with a settings record the
   *  op cannot run with: a key it has no setting for (TypeScript's
   *  excess-property check), an `onError` that is not one of its three
   *  answers, a concurrency that is not a whole number of at least 1, or a
   *  value worked out rather than written down. */
  COLLECTION_OP_CONFIG: 'MOV_COLLECTION_OP_CONFIG',
  /** `MEMBERS(<T>)` names a type whose membership is not CLOSED — an open
   *  known-values field, whose listed options are what could be enumerated and
   *  not all there are. There is no complete list to iterate. */
  MEMBERS_NOT_CLOSED: 'MOV_MEMBERS_NOT_CLOSED',
  /** `await sleep(<duration>)` with a malformed duration literal. */
  AWAIT_BAD_DURATION: 'MOV_AWAIT_BAD_DURATION',
  /** `await until(…)`'s cadence is below the 1m floor — re-checking faster than
   *  once a minute is refused (the MOV_AWAIT_IMPURE_WHERE family's ops sibling). */
  UNTIL_CADENCE_TOO_SHORT: 'MOV_UNTIL_CADENCE_TOO_SHORT',
  /** A statement inside an `await until(…)` condition is not read-only — a
   *  write/ask/await/race in the condition (extends the MOV_AWAIT_IMPURE_WHERE
   *  family: an await/until condition is evaluated repeatedly and must not act). */
  AWAIT_IMPURE_CONDITION: 'MOV_AWAIT_IMPURE_CONDITION',
  /** `refresh <handle>` on a head that has no re-fetchable record id — the event
   *  payload or an extracted node. Refresh a write handle or a traversed record. */
  REFRESH_UNSTABLE: 'MOV_REFRESH_UNSTABLE',
  // race + receipts + absence (asks-as-adapter chunk C). ABSENT_REQUIRED rides in
  // via TypedDiagnosticCodes (also fired inside the typing layer's comparison
  // check), reached here through the spread below as DiagnosticCodes.ABSENT_REQUIRED.
  /** RETIRED: the inline block expression (`{ … }.name`) — reading a body's
   *  inner binding by name is naming-is-exporting, which `return` replaces.
   *  Still parsed so the refusal can name the replacement. */
  INLINE_BLOCK_RETIRED: 'MOV_INLINE_BLOCK_RETIRED',
  // Explicit returns (core calculus v2). A body hands its value back with
  // `return`; nothing else escapes a scope.
  /** A `return` with no body to return from — at file scope, or inside a
   *  construct whose arms hand nothing back (a `parallel` sibling, a race
   *  branch). */
  RETURN_OUTSIDE_BODY: 'MOV_RETURN_OUTSIDE_BODY',
  /** Two `return`s in one body hand back different KINDS of thing — one a
   *  record position, one a value. A body has one value type. */
  RETURN_PLANE_MISMATCH: 'MOV_RETURN_PLANE_MISMATCH',
  /** A function in a call cycle — it calls itself, directly or through others
   *  — with no declared return type (language version 3). What it returns
   *  cannot be inferred from a body that needs its own answer, so it is
   *  written, as TypeScript requires. */
  RECURSIVE_RETURN_TYPE: 'MOV_RECURSIVE_RETURN_TYPE',
  /** A `return` that does not fit the declared return type (`): <R>`), or a
   *  body that declares one and never returns. */
  RETURN_TYPE: 'MOV_RETURN_TYPE',
  /** A `return` of something that is not a value — a constructed instance.
   *  An instance stands for a live system and its schema is per-credential, so
   *  it cannot travel; the movement that needs one constructs it. */
  RETURN_NOT_A_VALUE: 'MOV_RETURN_NOT_A_VALUE',
  /** RETIRED: reading a block's inner binding off the block's value —
   *  `orgs.name` / `orgs-[o:co]->`. A block's bindings never leave it; the ONE
   *  way a value comes out is `return`. */
  BLOCK_READ_BACK_RETIRED: 'MOV_BLOCK_READ_BACK_RETIRED',
  /** A bound call whose callee returns nothing. A call's value IS its return
   *  value, so there is nothing to bind. */
  CALL_RETURNS_NOTHING: 'MOV_CALL_RETURNS_NOTHING',
  /** A bound traversal block whose body returns nothing. The block's value is
   *  the list of what each iteration returned. */
  BLOCK_RETURNS_NOTHING: 'MOV_BLOCK_RETURNS_NOTHING',
  /** An authored binding whose name starts with `#` — the prefix that marks
   *  the ENGINE's own names in this language (`#resources` is the other one).
   *  The engine binds a run's return under such a name so it survives a park;
   *  refusing the prefix is what makes that slot uncollidable rather than
   *  merely unlikely to collide. */
  RESERVED_NAME: 'MOV_RESERVED_NAME',
  /** A name bound twice in ONE scope. Bindings are immutable — the cross-scope
   *  half of this rule is SHADOWED_NAME. */
  REBOUND_NAME: 'MOV_REBOUND_NAME',
  // callback (the deferred, addressable invocation)
  /** `callback(<name>, …)`'s first argument names something that is not a
   *  movement in scope — with a did-you-mean over the movements that are.
   *  A movement is a VALUE in this one position and nowhere else. */
  CALLBACK_NOT_MOVEMENT: 'MOV_CALLBACK_NOT_MOVEMENT',
  /** A key in `callback(…, { … })`'s config object is not one the vocabulary
   *  has (`once`, `ttl`), is repeated, or carries the wrong kind of value. */
  CALLBACK_BAD_CONFIG: 'MOV_CALLBACK_BAD_CONFIG',
  /** A callback parameter typed against a record position — a fire-time
   *  parameter is a VALUE the platform sends, so it must be a scalar. */
  CALLBACK_PARAM_NOT_VALUE: 'MOV_CALLBACK_PARAM_NOT_VALUE',
  // File imports (the linker — checker/link.ts)
  ...LinkDiagnosticCodes,
  // Schema-typed checks (M2b)
  ...TypedDiagnosticCodes,
} as const;

/**
 * One lexical scope the checker opened, with the source extent it covers —
 * the editor's answer to "which names are in scope HERE". Recorded (opt-in)
 * rather than re-derived by a second walker: the scope is the checker's own,
 * with the types it actually inferred.
 */
export interface RecordedFrame {
  kind: ScopeKind;
  /** The file frame covers the whole program; its span is synthetic. */
  span: Span;
  scope: Scope;
}

/**
 * The instance and record type a write resolved onto — the ADDRESS, as
 * declared strings, never parsed out of `description`.
 */
export interface RecordedTarget {
  /** The constructed instance's BINDING name (`crm`), not its adapter. */
  instance: string;
  /** The written record type, as the schema names it. Absent for a
   *  writable-only type that mints no position. */
  recordType?: string;
}

/**
 * A `write … { … }` body, recorded where the checker knows most about it:
 * after the target's variant selection and the handle's generic landings, so
 * `root` is the shape the body is actually validated against.
 */
export interface RecordedWrite {
  span: Span;
  root?: WritableRootSchema;
  /** Plain-language target name, e.g. `crm.company`. */
  description: string;
  declaredFields: Set<string>;
  /** The body's field lines with any `...` spread written out — what the
   *  write actually carries, for a reader that shows its fields. */
  fields: FieldEntry[];
  hasUniqueBy: boolean;
  /** The scope the write sits in (for `unique by` handle references). */
  scope: Scope;
  /** The name this write's handle was bound to (`a = write …`); absent for a
   *  bare write statement. */
  binding?: string;
  /** Where it lands, resolved. Absent when the target didn't type. */
  target?: RecordedTarget;
  /** A position write updates the record it already holds; every other write
   *  resolves-or-creates one; a `match` — the same body, recorded here for
   *  the same reasons — only finds one. */
  action: 'create' | 'update' | 'find';
  /** The parent edges this write's form establishes (linked / tuple), as the
   *  checker resolved them. Empty for a root or position write. */
  parents: Array<{ edge: string; type?: string }>;
}

/**
 * The remaining effect-bearing constructs, recorded as the one walk passes
 * them. Each carries only what the CHECKER resolved — the AST already says
 * what was written, and the story projection reads it there — plus the scope
 * the construct sits in, so a projected expression's names resolve against
 * the same bindings the checker saw.
 */
export type RecordedNode =
  | RecordedInstance
  | RecordedListen
  | RecordedLink
  | RecordedAwait
  | RecordedCombinator
  | RecordedBranch
  | RecordedExtract
  | RecordedCall
  | RecordedCallReading
  | RecordedTraversal
  | RecordedValuePath
  | RecordedHandleOp;

/** `crm = attio(credentials: …)` — the binding, and the adapter type it
 *  resolved to (after any import alias). */
export interface RecordedInstance {
  kind: 'instance';
  span: Span;
  scope: Scope;
  name: string;
  adapterType?: string;
}

/** `listen to <instance> { … } fire <movement>` — the trigger, with the event
 *  surface the checker derived from the config. */
export interface RecordedListen {
  kind: 'listen';
  span: Span;
  scope: Scope;
  /** The listened name as written. */
  instance: string;
  /** The instance's adapter type. Absent for an instance that didn't resolve. */
  adapterType?: string;
  /** The movement named after `fire`, and whether it resolved to one. */
  fires: string;
  firesMovement: boolean;
  /** The event kinds this listener subscribes to — the config's own selection,
   *  or the adapter's dispatch default where it selected none. Absent ⇒ nobody
   *  published a selection, which is not the same as selecting nothing. */
  events?: string[];
  /** Every SINGLE-literal config value, by key — the address the listen
   *  subscribes to. Opaque declared strings on both sides. */
  narrowing: Record<string, string>;
  /** The event position types this listen derives, by their address key (the
   *  identity) and the display the ref carries. Empty when the instance
   *  declares no event edges. */
  eventTypes: Array<{ key: string; display?: string }>;
}

/** `link a -[:e]-> b` — the edge-only write. */
export interface RecordedLink {
  kind: 'link';
  span: Span;
  scope: Scope;
  from: string;
  edge: string;
  /** The bound name linked to, or — for a body — the match whose record it
   *  links (recorded as that match's own write entry, by this span). */
  to: { kind: 'handle'; name: string } | { kind: 'match'; span: Span };
}

/** `await …` — the wake primitive, in each of its three sources. */
export interface RecordedAwait {
  kind: 'await';
  span: Span;
  scope: Scope;
  binding?: string;
  source: RecordedAwaitSource;
}

export type RecordedAwaitSource =
  /** `await a-[:Response]->` — the awaited edge, resolved. `awaitable` is the
   *  edge's own promise; an ASK is exactly this over a write handle. */
  | {
      kind: 'traversal';
      /** The traversal's root name, when it has one. */
      root?: string;
      /** The final edge's declared name. */
      edge?: string;
      /** Absent ⇒ the edge wasn't typed; nobody looked, so nothing is claimed. */
      awaitable?: boolean;
      resolvesEmpty?: boolean;
    }
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string };

/** `race([…])` / `parallel([…])` — the concurrent wait. Each arm written as a
 *  closure records its body scope, so the arm's own bindings resolve inside it;
 *  an arm that is only a NAME has no scope here (its body was checked where it
 *  was declared). */
export interface RecordedCombinator {
  kind: 'combinator';
  combinator: 'race' | 'parallel';
  span: Span;
  scope: Scope;
  binding?: string;
  arms: Array<{ span: Span; scope?: Scope }>;
}

/** `if … else if … else` — the arm scopes are the point: an arm's condition
 *  narrows INTO it, so its body's names resolve there and nowhere else. */
export interface RecordedBranch {
  kind: 'branch';
  span: Span;
  scope: Scope;
  arms: Array<{ span: Span; scope: Scope; conditionSpan: Span }>;
  otherwise?: { span: Span; scope: Scope };
}

/** `extract from [ … ] { … }` — the resolved result graph (borrowed field
 *  types resolved, working fields separated from the outward shape). */
export interface RecordedExtract {
  kind: 'extract';
  span: Span;
  scope: Scope;
  binding?: string;
  node: ExtractNodeType;
}

/** `log_lead(l: m)` — a movement invoked. */
export interface RecordedCall {
  kind: 'call';
  span: Span;
  scope: Scope;
  binding?: string;
  callee: string;
  /** Whether `callee` resolved to a movement declaration. */
  isMovement: boolean;
  /**
   * The parameter each argument binds, in argument order — what a POSITIONAL
   * argument is called, since the author did not write its name. Absent where
   * the callee's signature is unknown; an entry is undefined for an argument
   * past the last parameter.
   */
  argParams?: Array<string | undefined>;
}

/**
 * A call whose callee resolved to a BUILT-IN, and how it reads there — the
 * value it computes, the collection op or the type query it is (or why it
 * cannot be read). A reader keyed by the call's span sees what the checker
 * saw rather than deciding again by name; a call to a function records a
 * `RecordedCall` instead.
 */
export interface RecordedCallReading {
  kind: 'callReading';
  span: Span;
  scope: Scope;
  reading: Exclude<CallReading, { kind: 'function' }>;
}

/**
 * A traversal HEAD — `chat-[ch:Channels WHERE \`Name\` == "dealflow"]->` — as
 * structure rather than as text. `steps` is the compiler's own parse of the
 * hops (so nothing downstream re-reads the syntax), and `landings` is where the
 * type walk put each of them, so a renderer can name what the walk reaches.
 */
export interface RecordedTraversal {
  kind: 'traversal';
  span: Span;
  scope: Scope;
  /** The name the walk starts from, as written. */
  root?: string;
  /**
   * How the walk STARTS, as the checker typed that name: `graph` fans out over
   * records that live in a system, `result` continues from what an earlier step
   * produced (a race receipt, an awaited response, a callback's landing).
   * ABSENT ⇒ the root did not type, and nothing is claimed.
   */
  from?: 'graph' | 'result';
  /** The hop chain. Empty when the head did not parse (an invalid program). */
  steps: TraversalStep[];
  /** Where each hop lands, POSITIONALLY against `steps`. An entry is absent
   *  where the walk could not type that hop — a silence, not a landing. */
  landings: Array<RecordedLanding | undefined>;
}

/**
 * A traversal written as a VALUE (`n-[:Attendees]->.\`Name\``) rather than as a
 * statement head.
 *
 * Same facts as `RecordedTraversal`, from the one place such a path is ever
 * walked — the expression typer. `span` is the SLOT's, since an expression AST
 * carries no positions of its own, so a slot with two paths in it records two
 * nodes at the same span; `key` tells them apart. It is derived from the hop
 * chain by both sides and only ever COMPARED — nothing reads it.
 */
export interface RecordedValuePath {
  kind: 'valuePath';
  span: Span;
  scope: Scope;
  key: string;
  root?: string;
  steps: TraversalStep[];
  landings: Array<RecordedLanding | undefined>;
}

/** The comparable token for one walked path. Both the checker and the story
 *  projection derive it from the SAME parse of the same slot. */
export function valuePathKey(root: string | undefined, steps: TraversalStep[]): string {
  return JSON.stringify([root ?? null, steps]);
}

/** A landing's ADDRESS: the instance it belongs to and the type the schema
 *  names it by. Both declared strings; display is resolved downstream. */
export interface RecordedLanding {
  instance: string;
  position?: string;
}

/** `delete <handle>` / `refresh <handle>`. */
export interface RecordedHandleOp {
  kind: 'delete' | 'refresh';
  span: Span;
  scope: Scope;
  subject: string;
}

export interface CheckRecording {
  frames: RecordedFrame[];
  writes: RecordedWrite[];
  nodes: RecordedNode[];
}

export interface CheckOptions {
  /**
   * Record scope frames and write regions as the check runs, for the language
   * service to resolve cursors against (`checkProgramWithLink` returns them).
   * Off by default so the compile path pays nothing.
   */
  recordAnalysis?: boolean;
  /**
   * Movement-library resolution (file imports, 3_syntax_sketch.md §H).
   * When present, `import { … } from "<file>"` resolves: each library is
   * parsed and checked in its OWN scope (its error diagnostics surface
   * prefixed with the import path), and the imported names bind as real
   * movements/shapes — callable, usable as types and write targets.
   * Absent, file imports keep the M2 behavior: MOV_IMPORT_FILE_UNSUPPORTED
   * with the names treated as opaque.
   */
  resolveFile?: ResolveFile;
  /**
   * The language version the program is written against — the saved
   * movement's pin. Absent ⇒ the current version. A version this release
   * does not support is an error diagnostic; a deprecated one a warning.
   */
  languageVersion?: LanguageVersion;
  /**
   * The version the program is pinned to, when it is being checked for a
   * move up to `languageVersion` (the deploy check, an explicit upgrade).
   * Turns on the warnings for constructs whose meaning changed between the
   * two and that the new version would otherwise accept in silence — so
   * "clean for the move" means "behaves the same, or is refused". Absent ⇒
   * an ordinary check, and no such warnings.
   */
  upgradingFrom?: LanguageVersion;
}

export function checkProgram(
  program: Program,
  catalog: Catalog,
  options?: CheckOptions,
): Diagnostic[] {
  return checkProgramWithLink(program, catalog, options).diagnostics;
}

/**
 * `checkProgram` plus the resolved import structure (`ProgramLink`) — the
 * movement engine's seam: it validates through this call and then executes
 * imported callees from the SAME resolved link, so resolution lives here
 * (the parse/check layer) and the engine consumes an already-resolved
 * program.
 */
export function checkProgramWithLink(
  program: Program,
  catalog: Catalog,
  options?: CheckOptions,
): { diagnostics: Diagnostic[]; link?: ProgramLink; recording?: CheckRecording } {
  const languageVersion = options?.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  const link = options?.resolveFile
    ? linkImports(program, options.resolveFile, { languageVersion })
    : undefined;
  const recording: CheckRecording | undefined =
    options?.recordAnalysis === true ? { frames: [], writes: [], nodes: [] } : undefined;
  const checker = new Checker(catalog, {
    languageVersion,
    ...(options?.upgradingFrom !== undefined ? { upgradingFrom: options.upgradingFrom } : {}),
    ...(link ? { linkContext: { link, checked: new Map() } } : {}),
    ...(recording ? { recording } : {}),
  });
  checker.run(program);
  const versionDiagnostic = languageVersionDiagnostic(languageVersion);
  const versionDiagnostics = versionDiagnostic ? [versionDiagnostic] : [];
  const found = checker.diagnostics.map(withHandbookPointer);
  if (!link) {
    return {
      diagnostics: [...versionDiagnostics, ...found],
      ...(recording ? { recording } : {}),
    };
  }
  return {
    diagnostics: [...versionDiagnostics, ...link.problems, ...found],
    link,
    ...(recording ? { recording } : {}),
  };
}

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A movement's parameters in declaration order, each typed on its plane —
 *  what a call's arguments bind against, by name or by position. */
type DeclaredParams = Array<{ name: string; type: PlaneType }>;

type BoundParam = DeclaredParams[number];

/** One argument against the parameter it binds, for the fit diagnostics. */
interface ArgFit {
  callee: string;
  param: BoundParam | undefined;
  /** The argument's place in the call, from 0. */
  index: number;
  /** Written without its parameter's name — so the diagnostic says it. */
  positional: boolean;
}

/** Where a positional argument binds, for a diagnostic: the author did not
 *  write the parameter's name, so the message does. A named argument wrote it
 *  already, and its message is unchanged. */
function describeArgPlace(fit: ArgFit): string {
  if (!fit.positional) return '';
  return fit.param !== undefined
    ? ` for '${fit.param.name}' (argument ${fit.index + 1})`
    : ` (argument ${fit.index + 1})`;
}

/** What a value argument's fit is judged with: where it is written, whether it
 *  is a fresh record literal (the excess-property check), and its parse, for a
 *  string literal's own type. */
interface ArgValueOptions {
  span: Span;
  literal?: boolean;
  parsed?: Expression;
  /** The argument as written, where it is an expression — what a fix rewrites. */
  slot?: ExprSlot;
}

/**
 * A value handed where a LIST of its type is expected, rewritten as that list:
 * a walk's values spliced in (`[...m-[a:Attachments]->.File]`), anything else
 * as its one member.
 */
function listArgumentRewrite(slot: ExprSlot): string {
  const raw = slot.raw.trim();
  return raw.includes('->') ? `[...${raw}]` : `[${raw}]`;
}

/** The text of a string LITERAL expression. */
function stringLiteralOf(expr: Expression | undefined): string | undefined {
  return expr?.type === 'static' && typeof expr.value === 'string' ? expr.value : undefined;
}

/** Is this argument slot a record LITERAL (`{ mode: "x" }`) — the fresh value
 *  TypeScript's excess-property check applies to? */
function isRecordLiteralSlot(slot: ExprSlot): boolean {
  return slot.raw.trim().startsWith('{');
}

/** A parameter typed as a VALUE, as the symbol its body reads. */
function valueParamSymbol(param: MovementParam, type: FieldType | undefined): ScopeSymbol {
  return {
    name: param.name,
    kind: 'param',
    span: param.span,
    bindingPlane: 'scalar',
    ...(type !== undefined ? { fieldType: type } : {}),
  };
}
/** Expression-grammar literals a bare slot may legitimately be. */
const EXPR_LITERALS = new Set(['TRUE', 'FALSE', 'NULL']);

/** The field type of a BARE literal RValue (`done = true`, `n = 3`, `s = "x"`) —
 *  checkExprSlot short-circuits these before typing them, but a scalar receipt
 *  property needs the type (`boolean | absent`). Undefined for anything not a
 *  plain literal (a name / expression carries its own type through infer). */
function scalarLiteralType(raw: string): FieldType | undefined {
  const t = raw.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return 'boolean';
  if (upper === 'NULL') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^"(?:[^"\\]|\\.)*"$/.test(t) || /^'(?:[^'\\]|\\.)*'$/.test(t)) return 'text';
  return undefined;
}

/**
 * The address a resolved write/link handle stands on, as declared strings —
 * the recorded form of `describePosition`'s subject. Structural: read off the
 * ref the checker built, never split out of the display text.
 */
/**
 * What a match checks its body against when the type it looks for has no
 * write shape — a record you can find but never create. Its readable fields
 * are the fields; nothing about it promises similarity or native identity,
 * because only a write shape carries those.
 */
function readableMatchRoot(position: PositionSchema | undefined): WritableRootSchema | undefined {
  if (position === undefined) return undefined;
  return {
    fields: position.properties,
    resultShape: { externalId: 'text', url: 'text', ...position.properties },
  };
}

/**
 * The handle a `match` binds: the record, without the write-outcome facts. A
 * write's handle answers "what happened" (`created`, `committed`) as well as
 * "which record"; a match only ever answers the second, so the first is not
 * part of its type rather than a flag that is always false.
 */
function foundHandle(handle: PositionTypeRef | undefined): PositionTypeRef | undefined {
  if (handle?.kind !== 'handle') return handle;
  const { created: _created, committed: _committed, ...resultShape } = handle.resultShape;
  return { ...handle, resultShape };
}

function recordedTargetOf(handle: PositionTypeRef | undefined): RecordedTarget | undefined {
  switch (handle?.kind) {
    case 'handle':
      return {
        instance: handle.instance.name,
        ...(handle.position !== undefined ? { recordType: handle.position } : {}),
      };
    case 'position':
      return { instance: handle.instance.name, recordType: handle.position };
    case 'union':
      return { instance: handle.instance.name, recordType: handle.union };
    default:
      return undefined;
  }
}

/** The primitive type names an annotation may spell — the fixed half of the
 *  candidate set a mistyped annotation is matched against. */
const PRIMITIVE_TYPE_NAMES = ['text', 'number', 'boolean', 'date', 'datetime', 'file', 'json'];

/** Every type name an annotation may spell here: the primitives plus every
 *  refinement declared in scope. */
function typeNamesInScope(scope: Scope): string[] {
  const names = [...PRIMITIVE_TYPE_NAMES];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const symbol of s.symbols.values()) {
      if (symbol.kind === 'type' && !names.includes(symbol.name)) names.push(symbol.name);
    }
  }
  return names;
}

/** An unknown callee, with the closest function in scope or built-in.
 *  Compared with case folded, as function names are. */
/** The function or built-in `name` most likely meant, by edit distance. */
function closestFunctionName(name: string, scope: Scope): string | undefined {
  const folded = new Map<string, string>();
  for (const candidate of [...scope.functionNames(), ...flatBuiltinNames()]) {
    if (!folded.has(candidate.toLowerCase())) folded.set(candidate.toLowerCase(), candidate);
  }
  const closest = closestByEditDistance(name.toLowerCase(), [...folded.keys()]);
  return closest !== undefined ? folded.get(closest) : undefined;
}

/** `corrected`: the author's whole call with the name swapped for the one
 *  meant — the line to paste, where the call's text is known. */
function unknownFunctionMessage(name: string, scope: Scope, corrected?: string): string {
  const closest = closestFunctionName(name, scope);
  const hint =
    closest === undefined ? ''
    : corrected !== undefined ? ` — did you mean '${closest}'? Write '${corrected}'`
    : ` — did you mean '${closest}'?`;
  return `Unknown function '${name}'${hint} — a call names a movement or function declared or imported here, or a built-in`;
}

/** A literal of `type` to fall back to where a value may be absent — one
 *  that reads as "not known" — or undefined where no literal says that. */
function fallbackLiteral(type: FieldType): string | undefined {
  if (type === 'text') return '"unknown"';
  if (type === 'number') return '0';
  if (type === 'boolean') return 'false';
  if (isListType(type)) return '[]';
  return undefined;
}

/** `lenght(xs)` → `LENGTH(xs)`: the call as written, its callee renamed. */
function renamedCallFix(input: {
  slot: ExprSlot;
  call: Extract<MExpr, { kind: 'call' }>;
  to: string | undefined;
}): { corrected: string; edit: SourceEdit } | undefined {
  const { slot, call, to } = input;
  if (to === undefined) return undefined;
  // A built-in's dotted name (`DATE.PARSE`) is written bare; a movement's
  // name with a space in it wears backticks.
  const spelled = /\s/.test(to) ? `\`${to}\`` : to;
  const raw = slot.raw;
  const callee = call.callee.at;
  return {
    corrected: `${raw.slice(call.at.start, callee.start)}${spelled}${raw.slice(callee.end, call.at.end)}`,
    edit: { span: spanOfExtent(slot, callee), text: spelled },
  };
}

/** Every movement name visible from `scope`, innermost first — the candidate
 *  set for a callback's did-you-mean. */
function movementNamesInScope(scope: Scope): string[] {
  const names: string[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const symbol of s.symbols.values()) {
      if (symbol.kind === 'movement' && !names.includes(symbol.name)) names.push(symbol.name);
    }
  }
  return names;
}

/**
 * The universal construction parameter every adapter accepts:
 * `crm = attio(credentials: acme_main, dry_run: true)` marks the INSTANCE
 * for dry-run capture — writes to it are rehearsed, not committed
 * (6_engine.md "Dry-run is movement-level, not trigger-level"). It is a
 * platform argument, not adapter config, so it is validated here (boolean
 * literal only) and filtered out before manifest validation and
 * `Catalog.instantiate`.
 */
export const DRY_RUN_ARG = 'dry_run';
const BOOLEAN_LITERAL = /^(true|false)$/i;

/** A listen `key` a fix-it can offer for a movement: its name as a slug, the
 *  shape an address's plus-suffix takes (`Log Sender` → `log-sender`). */
function suggestedListenKey(movement: string): string {
  return movement.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'intake';
}

const SYNTHETIC_SPAN: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

/** Each collection op as the author writes it — the name every diagnostic uses,
 *  so a message can be pasted back into the program. */
const COLLECTION_OP_SPELLING: Record<CollectionOp, string> = {
  map: 'MAP',
  filter: 'FILTER',
  reduce: 'REDUCE',
  groupby: 'GROUPBY',
  keyby: 'KEYBY',
};

const describeKind: Record<SymbolKind, string> = {
  adapter: 'an adapter type',
  credential: 'a credential',
  plugin: 'a plugin',
  fileImport: 'a file import',
  binding: 'a binding',
  instance: 'a constructed instance',
  param: 'a parameter',
  movement: 'a movement',
  shape: 'a declared node',
  alias: 'a traversal alias',
  type: 'a declared type',
};

// ── Name collection over the formula AST ──

export interface CollectedNames {
  /** `traverse.aliasRoot` and `alias_ref` names — these resolve against statement scope. */
  refs: string[];
  /** Aliases bound by traversal steps within the same expression (locally resolved). */
  aliases: Set<string>;
  /** Every ROOTED read, as its root and the member names it reaches for
   *  (`x-[v:n]->.f` ⇒ root `x`, members `n`, `f`). What a read is FOR, rather
   *  than which names it mentions — the retired block read-back is diagnosed
   *  off this. */
  rooted: Array<{ root: string; members: string[] }>;
}

// Step filters and extract-config slots are evaluated in the traversal head's
// context, so a rootless name in them is a field, not an outer variable —
// collect in `field` position. Rooted reads still surface their root: the
// `traverse` case pushes its aliasRoot regardless of position.
function collectFromSteps(steps: TraversalStep[], out: CollectedNames): void {
  for (const step of steps) {
    if (step.type === 'edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
    } else if (step.type === 'meta_edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
      const config = step.config;
      if (config) {
        if (config.description) collectNames(config.description, out, 'field');
        for (const d of config.data ?? []) collectNames(d, out, 'field');
        if (config.plugin) collectNames(config.plugin, out, 'field');
        for (const e of config.enrichWith ?? []) {
          collectNames(e.transform, out, 'field');
          collectNames(e.argument, out, 'field');
        }
        for (const v of Object.values(config.extra ?? {})) collectNames(v, out, 'field');
      }
    }
  }
}

// A name's *position* decides whether a rootless spelling is a variable or a
// field. In `value` position (an interpolated `${foo}`, an `AI(foo)` prompt, a
// `COALESCE(foo, …)` arg) a bare name is a reference to resolve against scope.
// In `field` position — the tail of a traversal (`msg.`subject``), a step
// filter, an extract-config slot — it is a field of the traversal head, typed
// against the head's schema, so it is NOT a name to resolve here. (Backticks
// are just whitespace-safe quoting and don't change this; position does.)
type NamePosition = 'value' | 'field' | 'member';

function collectNames(expr: Expression, out: CollectedNames, position: NamePosition = 'value'): void {
  switch (expr.type) {
    case 'alias_ref':
      out.refs.push(expr.name);
      return;
    case 'traverse':
      // A dotted read's tail (`m.k.f`'s `k.f`) is rooted at a MEMBER of what
      // the head holds, not at a name in scope.
      if (expr.aliasRoot !== undefined && position !== 'member') {
        out.refs.push(expr.aliasRoot);
        out.rooted.push({ root: expr.aliasRoot, members: memberNames(expr) });
      }
      collectFromSteps(expr.steps, out);
      collectNames(expr.expression, out, expr.steps.length === 0 ? 'member' : 'field');
      return;
    case 'exists':
      collectFromSteps(expr.steps, out);
      if (expr.where) collectNames(expr.where, out, 'field');
      return;
    case 'resource_traverse':
      if (expr.expressionFilter) collectNames(expr.expressionFilter, out, 'field');
      collectNames(expr.expression, out, 'field');
      return;
    case 'llm':
      if (expr.promptExpression) collectNames(expr.promptExpression, out, 'value');
      return;
    case 'list':
      expr.elements.forEach(e => collectNames(listElementExpression(e), out, position));
      return;
    // An object literal's KEYS are the target API's own spelling, never names
    // to resolve; its values carry the position through unchanged.
    case 'object':
      expr.entries.forEach(e => collectNames(objectMemberExpression(e), out, position));
      return;
    case 'arithmetic':
    case 'compare':
      collectNames(expr.left, out, position);
      collectNames(expr.right, out, position);
      return;
    case 'logical':
      expr.operands.forEach(o => collectNames(o, out, position));
      return;
    case 'not':
    case 'negate':
      collectNames(expr.expression, out, position);
      return;
    case 'concat':
      expr.parts.forEach(p => collectNames(p, out, position));
      return;
    case 'conditional':
      collectNames(expr.condition, out, position);
      collectNames(expr.then, out, position);
      collectNames(expr.else, out, position);
      return;
    case 'at':
      collectNames(expr.expression, out, position);
      collectNames(expr.index, out, position);
      return;
    case 'aggregate':
      collectNames(expr.expression, out, position);
      return;
    case 'function':
      expr.args.forEach(a => collectNames(a, out, position));
      return;
    case 'kg_exists':
    case 'kg_value':
      expr.params.forEach(p => collectNames(p, out, position));
      return;
    case 'property':
      if (position === 'value') out.refs.push(expr.propertyTypeId);
      return;
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return;
  }
}

/** The member names a rooted read reaches for: each hop's edge name, then the
 *  property it lands on. */
function memberNames(expr: Extract<Expression, { type: 'traverse' }>): string[] {
  const members = expr.steps.flatMap((step) =>
    'edgeTypeId' in step && step.edgeTypeId !== undefined ? [step.edgeTypeId] : [],
  );
  if (expr.expression.type === 'property') members.push(expr.expression.propertyTypeId);
  return members;
}

export function collectExpressionNames(expr: Expression): CollectedNames {
  const out: CollectedNames = { refs: [], aliases: new Set(), rooted: [] };
  collectNames(expr, out);
  return out;
}

// ── Traversal-head alias extraction ──
//
// Hop aliases (`-[c:companies]->`) must come from the raw hop text: a
// `_resources` head parses to `resource_traverse`, which carries neither
// alias nor root, so the probe AST alone would lose them.

function skipHeadString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

/** The alias opening a hop's interior (`c:` / `` `a b`: ``), read as every
 *  other name is. */
function hopAliasAt(hopsRaw: string, interiorStart: number): string | undefined {
  let i = interiorStart;
  while (i < hopsRaw.length && /\s/.test(hopsRaw[i])) i++;
  const scanned = scanName(hopsRaw, i);
  if (scanned === null) return undefined;
  let j = scanned.end;
  while (j < hopsRaw.length && /\s/.test(hopsRaw[j])) j++;
  return hopsRaw[j] === ':' ? scanned.name : undefined;
}

export function extractHopAliases(hopsRaw: string): string[] {
  const aliases: string[] = [];
  let i = 0;
  while (i < hopsRaw.length) {
    const open = hopsRaw.indexOf('-[', i);
    if (open === -1) break;
    const interiorStart = open + 2;
    const alias = hopAliasAt(hopsRaw, interiorStart);
    if (alias !== undefined) aliases.push(alias);
    // Skip to the hop's closing ']' respecting nesting and literals.
    let depth = 1;
    let j = interiorStart;
    while (j < hopsRaw.length && depth > 0) {
      const ch = hopsRaw[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        j = skipHeadString(hopsRaw, j);
        continue;
      }
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth--;
      j++;
    }
    i = j;
  }
  return aliases;
}

/** Did `member` escape the block that was bound to `blockName`? The scope chain
 *  records exactly that when a block closes. */
function escapedFromBlock(scope: Scope, member: string, blockName: string): boolean {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    if (s.escaped.has(member)) return s.escaped.get(member) === blockName;
  }
  return false;
}

// ── Span helpers ──

/** A path head as the author wrote it — diagnostics currency. */
function rawPath(path: PathHead): string {
  return spellPathHead(path);
}

/** Maps a character offset inside a slot's raw text back to a source location. */
/** The span of `at` — an extent of `slot.raw` — in the file. */
function spanOfExtent(slot: ExprSlot, at: At): Span {
  return { start: spanWithin(slot, at.start).start, end: spanWithin(slot, at.end).start };
}

/**
 * The span of `at` — an extent of a block head's probe text
 * (`probePathHead`) — in the file,
 * where the hops can be placed exactly: the hop chain is the head's source
 * verbatim and ends where the head does, so a chain on one line starts its
 * own length before that. A chain over several lines, or an extent outside
 * the hops (the probe's stand-in root), has no exact place.
 */
function headHopsExtent(head: PathHead, at: At): Span | undefined {
  if (head.hopsRaw.includes('\n')) return undefined;
  const offset = probePathHead(head).length - head.hopsRaw.length;
  if (at.start < offset || at.end > offset + head.hopsRaw.length) return undefined;
  const { end } = head.span;
  const hops: ExprSlot = { raw: head.hopsRaw, span: { start: { line: end.line, col: end.col - head.hopsRaw.length }, end } };
  return spanOfExtent(hops, { start: at.start - offset, end: at.end - offset });
}

function spanWithin(slot: ExprSlot, pos: number | undefined): Span {
  if (pos === undefined || pos < 0 || pos > slot.raw.length) return slot.span;
  let { line, col } = slot.span.start;
  for (let i = 0; i < pos; i++) {
    if (slot.raw[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { start: { line, col }, end: slot.span.end };
}

// ── Listen-config value helpers ──

/**
 * A config value's static string contents: a quoted string yields itself,
 * a list of quoted strings yields its elements — anything else (a binding,
 * a traversal, a mixed list) is undefined, i.e. not validatable against a
 * closed vocabulary.
 */
/** The distinct names a `unique by` clause predicate references (fields and/or
 *  bound handles), for the native-uniqueness comparison. Undefined when the
 *  predicate doesn't parse (the expression check reports that separately). */
function uniqueClauseRefs(clause: UniqueClause): string[] | undefined {
  try {
    const refs = new Set<string>();
    // Split first so a FUZZY modifier is lifted off each component — it isn't an
    // expression token, so the stripped remainder is what parses.
    for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
      for (const ref of collectExpressionNames(parseMovementExpression(part.raw)).refs) {
        refs.add(ref);
      }
    }
    return [...refs];
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
}

function staticStringValues(slot: ExprSlot): string[] | undefined {
  let parsed: Expression;
  try {
    parsed = expressionOfSlot(slot);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  const stringOf = (node: ListElement): string | undefined =>
    node.type === 'static' && typeof node.value === 'string' ? node.value : undefined;
  if (parsed.type === 'static') {
    const value = stringOf(parsed);
    return value !== undefined ? [value] : undefined;
  }
  if (parsed.type === 'list') {
    const values = parsed.elements.map(stringOf);
    return values.every((v): v is string => v !== undefined) ? values : undefined;
  }
  return undefined;
}

/**
 * Whether a config slot is written as a bracketed list literal (`["…"]`).
 * Event-subscription config (`events`, kg `changes`) is authored as a list even
 * when it names a single event, so the syntax is uniform and every reader sees
 * an array — a bare scalar (`events: "…"`) is rejected with a wrap-in-brackets
 * fix-it. Non-parsing slots are handled by the caller's value check.
 */
function isListSlot(slot: ExprSlot): boolean {
  try {
    return expressionOfSlot(slot).type === 'list';
  } catch (e) {
    if (e instanceof BridgeError) return false;
    throw e;
  }
}

/**
 * A config value that is a bare name or a list of bare names
 * (`fields: [domains]`) — the bridge parses a bare name as a root-less
 * `property` node, so a clean list of those yields the names. Undefined
 * for anything else.
 */
function bareNameValues(slot: ExprSlot): string[] | undefined {
  const trimmed = slot.raw.trim();
  if (BARE_IDENT.test(trimmed)) return [trimmed];
  let parsed: Expression;
  try {
    parsed = expressionOfSlot(slot);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  if (parsed.type !== 'list') return undefined;
  const names = parsed.elements.map(element =>
    element.type === 'property' ? element.propertyTypeId : undefined,
  );
  return names.every((n): n is string => n !== undefined) ? names : undefined;
}

/**
 * The string value of a slot that is a bare string LITERAL (`"Open"`),
 * undefined for anything else (a property read, a call, an interpolation). The
 * enum-literal membership check reads this: only a literal carries a value
 * known at author time.
 */
function staticStringLiteralOf(slot: ExprSlot): string | undefined {
  let parsed: Expression;
  try {
    parsed = expressionOfSlot(slot);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  return parsed.type === 'static' && typeof parsed.value === 'string' ? parsed.value : undefined;
}

/** ` (e.g. Answer Type: "text")` — a fix-it spelling the author can paste,
 *  drawn from the field's OWN option set so it can never suggest a value the
 *  field rejects. Empty when the field isn't enum-typed: a made-up example for
 *  a free-text parameter would be a guess dressed as guidance. */
function literalExampleFor(field: string, type: FieldType | undefined): string {
  if (!isEnumType(type) || type.options.length === 0) return '';
  return ` (e.g. ${field}: "${type.options[0]}")`;
}

/** `a`, `a or b`, `a, b, or c` — a prose alternation for a diagnostic. */
function orList(items: string[]): string {
  return joinList(items, 'or');
}

/** `a`, `a and b`, `a, b and c` — a prose conjunction for a diagnostic. */
function andList(items: string[]): string {
  return joinList(items, 'and');
}

function joinList(items: string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  const separator = conjunction === 'or' ? ', or ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${separator}${items[items.length - 1]}`;
}

/**
 * The clause naming the fields that fit no write shape TOGETHER. Always two or
 * more while the host's rule holds (every writable field belongs to some
 * variant); the one-field wording exists so a hand-built schema that breaks
 * that rule still reads as a sentence.
 */
function writeUnionClash(conflict: string[]): string {
  if (conflict.length === 2) return `${conflict[0]} and ${conflict[1]} can't both be set`;
  if (conflict.length > 2) return `${andList(conflict)} can't be set together`;
  return `${andList(conflict)} fits none of them`;
}

// ── `through`-argument phasing context ──

interface ThroughFieldsContext {
  /** Field names of the node's PRIOR stages plus inherited ancestor fields — readable. */
  prior: Set<string>;
  /** Field names of the stage the `through` precedes, and later stages — a forward reference. */
  ownOrLater: Set<string>;
}

// ── Typed-symbol helpers (M2b) ──

/** Options threaded through expression-slot checking. */
interface SlotOptions {
  fields?: ThroughFieldsContext;
  /** The typed write target the slot flows into — drives extract-field
   *  annotation suggestions and annotation-vs-write conflict checks. */
  writeTarget?: WriteTargetRef;
  /** The slot's value is HELD, not read — bound to a name — so a tuple stays
   *  a tuple (`AT(t, 0)` off the name reads the slot). Every other slot reads
   *  its value, and a tuple read is the list it widens to. */
  holdsValue?: true;
  /** The slot is a write field's value, where the target field's own
   *  functions are in scope (`SLACK_MESSAGE(…)`) and the catalog does not
   *  list them — so an unknown callee there is not reported. */
  writeField?: true;
}

interface HeadInfo {
  /** Lexically-scanned hop aliases (robust to `_resources` heads). */
  aliases: string[];
  /** Probe-parsed hop steps, when the head parsed to a property-terminated traverse. */
  steps?: TraversalStep[];
  /** The head root's position type, when the root is typed. */
  rootType?: PositionTypeRef;
  /** The recorded node for this head, when recording is on — the caller that
   *  walks the chain finishes it with the landings it resolves. */
  recorded?: RecordedTraversal;
}

/**
 * Where a traversal STARTS, told apart by the checker's own type of the root:
 * a graph position fans out over records that live in a system; a result node —
 * a race receipt, a write handle, a callback's local landing — continues from
 * what an earlier step produced. Absent ⇒ untyped, so nothing is claimed.
 */
function traversalFrom(type: PositionTypeRef | undefined): 'graph' | 'result' | undefined {
  if (type === undefined) return undefined;
  switch (type.kind) {
    case 'meta':
    case 'position':
    case 'union':
    case 'extract':
      return 'graph';
    case 'handle':
    case 'local':
      return 'result';
    case 'closure':
      // Nothing traverses off a closure; the typing layer refuses the hop.
      return undefined;
    case 'maybeEmpty':
      return traversalFrom(type.of);
  }
}

/** A landing's address, for the kinds a schema actually names. The rest — a
 *  meta node, an extract node, a receipt — have no declared type name to
 *  resolve a label from, and saying nothing is the honest answer. */
function recordedLanding(type: PositionTypeRef | undefined): RecordedLanding | undefined {
  if (type === undefined) return undefined;
  switch (type.kind) {
    case 'position':
      return { instance: type.instance.name, position: type.position };
    case 'union':
      return { instance: type.instance.name, position: type.union };
    case 'handle':
      return {
        instance: type.instance.name,
        ...(type.position !== undefined ? { position: type.position } : {}),
      };
    case 'maybeEmpty':
      return recordedLanding(type.of);
    default:
      return undefined;
  }
}

function isGraphSymbol(symbol: ScopeSymbol): boolean {
  // A graph is a CONSTRUCTED instance or a declared shape. A bare adapter
  // import is NOT a graph — instantiation is explicit now (`go = manual()`),
  // so `<manual-[:invocation]->>` (import as position source) is an error
  // guiding "construct an instance and name it first"
  // (spec plans/2026-06-24-required-instantiation/0_spec.md §"What is removed").
  // The knowledge graph is an instance like any other as of D25 — an instance
  // is already a graph, so there is no third case.
  return symbol.kind === 'instance' || symbol.kind === 'shape';
}

/** Graph identity: the introducing symbol IS the token compared by
 *  reference — for imports, the LIBRARY's declaring symbol (`graphToken`). */
export function instanceRefOf(symbol: ScopeSymbol): InstanceRef | undefined {
  return symbol.schema
    ? { token: symbol.graphToken ?? symbol, name: symbol.name, schema: symbol.schema }
    : undefined;
}

/** The position a bound name denotes: its own type, a record value's record,
 *  or — for a graph — the graph's meta position. The one rule for "what type
 *  is this name?", shared by the checker and the editor so neither can drift
 *  from the other.
 *
 *  A name holding ONE record on the value plane (a collection op's parameter,
 *  `FIRST(…)`) denotes that record, exactly as the alias of the hop it came
 *  off does — otherwise every rule asking "what record is this?" (a position
 *  write's target, a `bind`) hears nothing and stays silent. */
export function positionTypeOf(symbol: ScopeSymbol): PositionTypeRef | undefined {
  if (symbol.posType) return symbol.posType;
  const value = symbol.fieldType;
  if (typeof value === 'object' && value.kind === 'record' && value.position !== undefined) {
    return value.position;
  }
  if (isGraphSymbol(symbol)) {
    const instance = instanceRefOf(symbol);
    if (instance) return { kind: 'meta', instance };
  }
  return undefined;
}

/**
 * What a union becomes once an `IS` chain has ruled members out of it.
 *
 * Structural throughout, so nothing has to be registered anywhere: a union IS
 * its member set (`unionKey`), so the residual is keyed and displayed off the
 * members that remain, and every union rule downstream already reads
 * `variants` rather than looking the key up on the schema.
 *
 * Three cases, all TypeScript's:
 *   - one member left ⇒ that member. A set collapsing to one cannot masquerade
 *     as a union (`unionKey`'s own contract).
 *   - two or more ⇒ the smaller union.
 *   - none ⇒ the empty union, `never`. It is not an error to REACH — `if
 *     (x === "nope")` on `x: "a" | "b"` is a true statement — so it errors
 *     where the handle is USED, which the empty variant list already does.
 */
function residualUnion(
  union: Extract<PositionTypeRef, { kind: 'union' }>,
  remaining: readonly string[],
): PositionTypeRef {
  const variants = unionVariants(remaining);
  if (variants.length === 1) {
    return { kind: 'position', instance: union.instance, position: variants[0] };
  }
  return {
    kind: 'union',
    instance: union.instance,
    union: unionKey(variants),
    variants,
    // No schema ever registered this residual, so it carries its own
    // author-facing text — the `display` escape hatch, never a parsed key.
    display: variants.map(v => displayNameOf(union.instance, v)).join(' | '),
  };
}

/** The position a node declaration's `<name>` annotation denotes — its root. */
function declaredRootPosition(symbol: ScopeSymbol): PositionTypeRef | undefined {
  const instance = instanceRefOf(symbol);
  return instance ? positionRefIn(instance, instance.name) : undefined;
}

/** That same root, as the comparator's required side — so "what does `<Doc>`
 *  mean" is answered once for the parameter and the predicate alike. */
function declaredNodeRequirement(symbol: ScopeSymbol): RequiredPosition | undefined {
  const root = declaredRootPosition(symbol);
  return root?.kind === 'position'
    ? { schema: root.instance.schema, position: root.position }
    : undefined;
}

/**
 * Does `position` structurally satisfy the declared node? The predicate behind
 * `x IS <Doc>`, and the one the arm and the `else` both consult.
 *
 * `undefined` is the THIRD answer, and it has to be one: an undescribed
 * position or a declaration whose schema didn't resolve is "nobody has looked",
 * not "it fits". Collapsing that into `true` would let the `else` eliminate a
 * member on the strength of a comparison that never happened — the silent
 * degradation this language bans. Both sides therefore KEEP an unknown member:
 * the arm can't rule it out, and neither can the else.
 */
function conformsToDeclaredNode(
  instance: InstanceRef,
  position: string,
  declaration: ScopeSymbol,
): boolean | undefined {
  const required = declaredNodeRequirement(declaration);
  if (required === undefined) return undefined;
  if (surfaceNotEnumerated(required.schema.positions[required.position])) return undefined;
  const surface = schemaSurface(instance.schema, position);
  if (surface === undefined) return undefined;
  return surfaceMisfit(surface, required) === undefined;
}

/** Resolves one extract field's explicit annotation to the SURFACE type it
 *  names — a primitive, a declared option set, or another field's. */
type ExtractTypeResolver = (field: ExtractField) => SchemaFieldType | undefined;

/** A node declaration an extraction node takes as its shape, with the schema
 *  its field types were resolved into where it was declared. */
interface DeclaredExtractShape {
  declaration: ShapeDeclaration;
  schema: InstanceSchema;
}

/**
 * A record type's fields, where the PROGRAM says what they are: an extracted
 * record, a record of a declared structure (the root or a nested node), or a
 * node built in memory. Undefined for a system's record — its fields are the
 * system's — and for anything that is not a record.
 */
/** `position` as the type of parameter `param` of the function `fn`: it
 *  carries the parameter's `FieldsNeed` cell, made on first ask and kept in
 *  `cells` (the function's own, shared by every walk of its body) from then
 *  on. Only a position or a union names a record a caller hands over. */
function asParameter(
  position: PositionTypeRef,
  cells: Map<string, FieldsNeed>,
  at: { fn: string; param: string },
): PositionTypeRef {
  if (position.kind !== 'position' && position.kind !== 'union') return position;
  let need = cells.get(at.param);
  if (need === undefined) {
    need = { ...at, passedTo: [] };
    cells.set(at.param, need);
  }
  return { ...position, parameter: need };
}

/** The parameter cells of a declared function. */
function paramNeedsOf(info: NonNullable<ScopeSymbol['movement']>): Map<string, FieldsNeed> {
  info.paramNeeds ??= new Map();
  return info.paramNeeds;
}

/** `position` with no parameter cell — the record once it has left the body. */
function withoutParameter(position: PositionTypeRef): PositionTypeRef {
  if (position.kind === 'maybeEmpty') return { ...position, of: withoutParameter(position.of) };
  if ((position.kind !== 'position' && position.kind !== 'union') || position.parameter === undefined) return position;
  const { parameter: _left, ...rest } = position;
  return rest;
}

function knownFieldsOf(type: PositionTypeRef): string[] | undefined {
  switch (type.kind) {
    case 'extract':
      return [...type.node.properties.keys()];
    case 'local':
      return Object.keys(type.reads);
    case 'position': {
      const { token } = type.instance;
      const declared = 'kind' in token && token.kind === 'shape';
      const properties = type.instance.schema.positions[type.position]?.properties;
      return declared && properties !== undefined ? Object.keys(properties) : undefined;
    }
    case 'maybeEmpty':
      return knownFieldsOf(type.of);
    // A record this program wrote: its type's fields. What the system handed
    // back besides (its id) is the system's identity, not a field to copy.
    case 'handle':
      return Object.keys(positionSchemaOfRef(type)?.properties ?? type.resultShape);
    case 'meta':
    case 'union':
    case 'closure':
      return undefined;
    default:
      return neverAsAny(type);
  }
}

/** `target` takes `source`'s positions — in place, so every holder of the
 *  schema object reads the new ones. */
function adoptSchema(target: InstanceSchema, source: InstanceSchema): void {
  target.positions = source.positions;
  target.collections = source.collections;
  target.writableRoots = source.writableRoots;
}

function declaredExtractShape(resolution: Resolution): DeclaredExtractShape | undefined {
  if (resolution.kind !== 'found' || resolution.symbol.kind !== 'shape') return undefined;
  const { declaration, schema } = resolution.symbol;
  return declaration !== undefined && schema !== undefined ? { declaration, schema } : undefined;
}

interface ExtractGraphResolvers {
  resolveType: ExtractTypeResolver;
  /** The declaration `node entry: <Entry>` names — undefined when it names
   *  none (reported where the tree is checked, not here). */
  resolveDeclared: (type: string) => DeclaredExtractShape | undefined;
}

/** Infers an extract result graph from the tree (4_type_system.md "Extract graphs"). */
function buildExtractGraph(
  name: string,
  stages: ExtractStage[],
  resolvers: ExtractGraphResolvers,
  description?: ExprSlot,
): ExtractNodeType {
  const node: ExtractNodeType = {
    name,
    ...(description !== undefined ? { description: authoredStringText(description.raw) } : {}),
    properties: new Map(),
    children: new Map(),
  };
  applyExtractStages(node, stages, resolvers);
  return node;
}

/**
 * A node that takes a declaration as its shape: the declaration IS its first
 * stage — its fields, typed where the declaration resolved them, and its nested
 * nodes — and the `through` stages that follow apply on top, as they would to
 * the inline block the declaration spells out.
 */
function declaredExtractGraph(
  node: DeclaredExtractNode,
  resolvers: ExtractGraphResolvers,
): ExtractNodeType {
  const shape = resolvers.resolveDeclared(node.declared.type);
  const graph: ExtractNodeType =
    shape === undefined
      ? { name: node.name, properties: new Map(), children: new Map() }
      : shapeExtractGraph(node.name, shape.declaration.root, shape.declaration.name, shape.schema);
  // The use site's words replace the declaration's record-level ones.
  if (node.description !== undefined) graph.description = authoredStringText(node.description.raw);
  applyExtractStages(graph, node.stages, resolvers);
  return graph;
}

/** One node of a declaration, read as the extract node it describes. `key` is
 *  its position in the declaration's schema (`Entry.founder`). */
function shapeExtractGraph(
  name: string,
  shape: ShapeNode,
  key: string,
  schema: InstanceSchema,
): ExtractNodeType {
  const properties = schema.positions[key]?.properties ?? {};
  const graph: ExtractNodeType = {
    name,
    ...(shape.description !== undefined
      ? { description: authoredStringText(shape.description.raw) }
      : {}),
    properties: new Map(),
    children: new Map(),
  };
  for (const child of shape.children) {
    graph.children.set(
      child.name,
      shapeExtractGraph(child.name, child, `${key}.${child.name}`, schema),
    );
  }
  for (const field of shape.fields) {
    // The schema carries `<T | null>` as `T | absent`; an extraction keeps the
    // surface type and the author's `| null` apart, as an inline field does.
    const declared = properties[field.name];
    const explicit = declared !== undefined ? stripAbsent(declared) : undefined;
    graph.properties.set(field.name, {
      span: field.span,
      ...(field.description !== undefined
        ? { description: authoredStringText(field.description.raw) }
        : {}),
      ...(explicit !== undefined ? { explicit } : {}),
      annotationRaw: field.type,
      ...(field.nullable ? { nullable: field.nullable } : {}),
    });
  }
  return graph;
}

function applyExtractStages(
  node: ExtractNodeType,
  stages: ExtractStage[],
  resolvers: ExtractGraphResolvers,
): void {
  // A stage INHERITS the fields of the stage before it and declares only what
  // it transforms, so every field a node declares anywhere is part of its
  // shape; a re-declaration is the transformation, and wins.
  for (const stage of stages) {
    for (const child of stage.children) {
      node.children.set(
        child.name,
        child.declared === undefined
          ? buildExtractGraph(child.name, child.stages, resolvers, child.description)
          : declaredExtractGraph(child, resolvers),
      );
    }
    for (const field of stage.fields) {
      const explicit = resolvers.resolveType(field);
      node.properties.set(field.name, {
        span: field.span,
        description: authoredStringText(field.description.raw),
        ...(explicit !== undefined ? { explicit } : {}),
        ...(field.type !== undefined ? { annotationRaw: field.type } : {}),
        ...(field.nullable ? { nullable: field.nullable } : {}),
      });
    }
  }
}

/**
 * What a body handed back, as a VALUE type — on either plane, because a record
 * is a value type and the two planes are one type universe. A body that
 * returned a record answers `record`; one that returned text answers `text`;
 * one that returned nothing answers nothing.
 */
function valueOfReturn(shape: ReturnShape): FieldType | undefined {
  if (shape.fieldType !== undefined) return shape.fieldType;
  return shape.posType !== undefined ? recordOf(shape.posType) : undefined;
}

/** Where an argument is written, whatever form it takes. */
function callArgSpan(arg: CallArg): Span {
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
  }
}

/**
 * Does a supplied position fit a required one BY STRUCTURE?
 *
 * Asked wherever there is no instance token to compare — the whole point of
 * `positionsMatch` (typing.ts) does not apply. A node literal belongs to no graph; a
 * declared node (`<Company>`) belongs to no system. Either way the required
 * side is typed by its STRUCTURE, and the supplied side fits when it carries
 * every member that structure declares, recursively through edges. That is TS's
 * structural assignability, unchanged: extra entries are fine (the other side
 * cannot see them), missing ones are not.
 *
 * Returns the first thing that doesn't fit, phrased for the author, or
 * `undefined` when it fits (or when the required side's shape isn't known, in
 * which case there is nothing to check against and silence is the honest
 * answer).
 *
 */
function structuralMisfit(
  supplied: PositionTypeRef,
  required: PositionTypeRef,
  path = '',
): string | undefined {
  switch (required.kind) {
    case 'position':
      return nodeMisfitAgainst(supplied, required.instance, required.position, path);
    case 'union': {
      // A union parameter accepts anything one of its variants accepts —
      // exactly what an `IS` test would then narrow. Fitting NO variant is the
      // misfit, and the message names the one that came closest to nothing.
      const misfits: string[] = [];
      for (const variant of required.variants) {
        const misfit = nodeMisfitAgainst(supplied, required.instance, variant, path);
        if (misfit === undefined) return undefined;
        misfits.push(`${variant} (${misfit})`);
      }
      return misfits.length > 0 ? `it fits none of ${orList(misfits)}` : undefined;
    }
    case 'meta':
      return `a synthesised node is a position, not a whole graph`;
    default:
      // Parameters come from TypeRefs; no other kind can be declared.
      return undefined;
  }
}

/**
 * A type ref's surface, in the shared comparator's currency. The only
 * checker-side knowledge here is which type KINDS have a structure to offer;
 * the comparison itself is `surfaceMisfit`, shared with the engine so a
 * predicate cannot mean one thing at author time and another at run time.
 *
 * `undefined` for a position with nothing enumerated behind it — no surface,
 * so no claim in either direction.
 */
function suppliedSurface(type: PositionTypeRef): SuppliedSurface | undefined {
  switch (type.kind) {
    case 'local':
      return {
        properties: type.reads,
        edges: Object.fromEntries(
          Object.entries(type.edges ?? {}).map(([name, edge]) => {
            const { target } = edge;
            return [name, target === undefined ? undefined : () => suppliedSurface(target)];
          }),
        ),
      };
    // Emptiness is discharged by the traversal that reaches this landing, so
    // what it CARRIES is the inner node's surface.
    case 'maybeEmpty':
      return suppliedSurface(type.of);
    case 'position':
      return schemaSurface(type.instance.schema, type.position);
    default:
      return undefined;
  }
}

/**
 * The type of `graph<Shape> { … }`: a run-local node (so writes, links and
 * deletes into it stay in the run) whose planes are the declaration's. Each
 * child edge lands on the declaration's nested node and is compared
 * STRUCTURALLY, as a declared entry's edge is — the nested node belongs to no
 * system either.
 */
function declaredLocalGraph(
  instance: InstanceRef,
  position: string,
): Extract<PositionTypeRef, { kind: 'local' }> {
  const declared = instance.schema.positions[position];
  const edges: Record<string, LocalEdge> = {};
  for (const [name, edge] of Object.entries(declared?.edges ?? {})) {
    const target = positionRefIn(instance, edge.target);
    edges[name] = {
      schema: {
        target: name,
        readable: true,
        ...(edge.sequenced !== undefined ? { sequenced: edge.sequenced } : {}),
      },
      ...(target !== undefined ? { target: runBuiltLanding(target), structural: true as const } : {}),
    };
  }
  return {
    kind: 'local',
    label: `a ${describeShapeNode(position)} graph`,
    reads: { ...declared?.properties },
    edges,
  };
}

/**
 * A shaped graph's type: the value is OF the shape — except where an entry
 * holds references, at any depth (`attachment: { owner: r }`): that edge is
 * typed as the records it holds (which the shape checked fit), so a write or
 * a walk through it is checked against what it really reaches.
 */
function shapedWithReferences(
  declared: Extract<PositionTypeRef, { kind: 'local' }>,
  body: Extract<PositionTypeRef, { kind: 'local' }>,
): Extract<PositionTypeRef, { kind: 'local' }> {
  const edges = { ...declared.edges };
  for (const [name, edge] of Object.entries(body.edges ?? {})) {
    const shaped = edges[name];
    if (shaped === undefined || edge.target === undefined) continue;
    if (edge.references === true) {
      edges[name] = { ...shaped, schema: { ...shaped.schema, ...edge.schema }, target: edge.target, references: true };
      continue;
    }
    // A child body: the shape's child node, retyped where it holds references.
    const child = edge.target;
    const shapedChild = shaped.target;
    if (child.kind !== 'local' || shapedChild?.kind !== 'position' || !holdsReferences(child)) continue;
    edges[name] = {
      ...shaped,
      target: shapedWithReferences(declaredLocalGraph(shapedChild.instance, shapedChild.position), child),
    };
  }
  return { ...declared, edges };
}

/** Whether a graph body holds references on any edge, at any depth. */
function holdsReferences(body: Extract<PositionTypeRef, { kind: 'local' }>): boolean {
  return Object.values(body.edges ?? {}).some(
    edge => edge.references === true || (edge.target?.kind === 'local' && holdsReferences(edge.target)),
  );
}

/** A graph literal's edge holding REFERENCES to records of `records` (unknown
 *  when undefined) — readable, as every run-local edge is. */
function referenceEdge(
  name: string,
  records: PositionTypeRef | undefined,
  sequenced: EdgeSchema['sequenced'],
): LocalEdge {
  return {
    schema: { target: name, readable: true, ...(sequenced !== undefined ? { sequenced } : {}) },
    ...(records !== undefined ? { target: records } : {}),
    references: true,
  };
}

/** What a graph literal's spread supplies: its keys on the two planes. */
interface SpreadKeys {
  reads: Record<string, FieldType | undefined>;
  edges: Record<string, LocalEdge>;
  /** The spread's source may not be there, so it may supply none of these. */
  mayBeAbsent?: boolean;
}

/** A declared node as the author reads it: `<Message>`, or a nested node by
 *  its path (`<Message> → attachment`). The key is a path, so this only
 *  re-spells it; nothing is parsed out of it but its segments for display. */
function describeShapeNode(position: string): string {
  const [root, ...path] = position.split('.');
  return [`<${root}>`, ...path].join(' → ');
}

function isMaybeAbsentType(type: FieldType): boolean {
  return typeof type === 'object' && type.kind === 'maybeAbsent';
}

/** A map's written keys, each `T | absent` — what a spread of a map that may
 *  not be there supplies. */
function absentKeys(keys: Record<string, FieldType | null>): Record<string, FieldType | null> {
  return Object.fromEntries(
    Object.entries(keys).map(([key, type]) => [key, type !== null ? maybeAbsent(type) ?? null : null]),
  );
}

/**
 * The ONE record a name holds, for a spread — off the arrow plane (a landing,
 * a declared or built node) or held as a value (`ONLY(…)`, a `MAP` member) —
 * and whether it may not be there. Undefined for anything else, a list of
 * records included: a spread copies one record's fields.
 */
function spreadRecordOf(
  symbol: ScopeSymbol,
): { position: PositionTypeRef | undefined; mayBeAbsent: boolean } | undefined {
  if (symbol.posType !== undefined) {
    if (symbol.plural === true && symbol.bindingPlane !== 'scalar') return undefined;
    switch (symbol.posType.kind) {
      case 'meta':
      case 'closure':
        return undefined;
      case 'maybeEmpty':
        return { position: symbol.posType.of, mayBeAbsent: true };
      default:
        return { position: symbol.posType, mayBeAbsent: false };
    }
  }
  const held = symbol.fieldType;
  if (held === undefined) return undefined;
  const value = stripAbsent(held);
  if (typeof value !== 'object' || value.kind !== 'record') return undefined;
  return { position: value.position, mayBeAbsent: isMaybeAbsentType(held) };
}

/** What a bare walk copies when a shape node says what to keep: its fields,
 *  and through each nested node the source's edge of the same name. A shape
 *  that cycles back on itself stops at the repeat. */
function copyPlanOf(required: RequiredPosition, seen: ReadonlySet<string> = new Set()): CopyPlan {
  const declared = required.schema.positions[required.position];
  const edges: Record<string, CopyPlan> = {};
  for (const [name, edge] of Object.entries(declared?.edges ?? {})) {
    if (seen.has(edge.target)) continue;
    edges[name] = copyPlanOf(
      { schema: required.schema, position: edge.target },
      new Set([...seen, required.position]),
    );
  }
  return { fields: Object.keys(declared?.properties ?? {}), edges };
}

/** The keys of a map value whose keys were written down — itself, or the
 *  members of a list of them (a plural child). */
function nestedMapKeys(type: FieldType): Record<string, FieldType | null> | undefined {
  const bare = stripAbsent(type);
  if (typeof bare !== 'object') return undefined;
  if (bare.kind === 'dict') return bare.shape;
  if (bare.kind === 'list') return nestedMapKeys(bare.of);
  if (bare.kind !== 'tuple') return undefined;
  // A list literal of maps is a tuple of them: the child lands on what EVERY
  // member carries, as a plural child written as bodies does.
  const members = [...bare.of, ...(bare.rest !== undefined ? [bare.rest.of] : [])];
  const keyed = members.map(member => (member !== null ? nestedMapKeys(member) : undefined));
  const [first, ...rest] = keyed;
  if (first === undefined || rest.some(keys => keys === undefined)) return undefined;
  const common: Record<string, FieldType | null> = {};
  for (const [key, keyType] of Object.entries(first)) {
    const others = rest.map(keys => keys?.[key]);
    if (others.some(other => other === undefined)) continue;
    const agreed = others.every(other => other != null && keyType !== null && fieldTypeEquals(other, keyType));
    common[key] = agreed ? keyType : null;
  }
  return common;
}

/** Could a value of this type be a map (or a list of them) at run time? */
function mayHoldMap(type: FieldType): boolean {
  const bare = stripAbsent(type);
  if (bare === 'json') return true;
  if (typeof bare !== 'object') return false;
  if (bare.kind === 'dict') return true;
  if (bare.kind === 'list') return mayHoldMap(bare.of);
  if (bare.kind === 'tuple') {
    return [...bare.of, bare.rest?.of ?? null].some(member => member !== null && mayHoldMap(member));
  }
  return false;
}

/** Is this graph a node DECLARATION (rather than a constructed system)? */
/** What `write e { … }` may set on a record the run holds on one of its own
 *  edges — every field its landing type carries — or undefined when `type` is
 *  not such a record. */
function runBuiltWriteShape(
  type: PositionTypeRef,
): { fields: Record<string, SchemaFieldType>; declared: boolean } | undefined {
  // An extracted record is one this run built: it carries the fields the
  // extraction declared, typed by this program, and updates in place.
  if (type.kind === 'local' && type.extracted !== undefined) {
    return { fields: type.extracted.fields, declared: true };
  }
  const landing =
    type.kind === 'position' && type.runBuilt === true
      ? type
      : type.kind === 'local'
        ? type.runBuilt?.landing
        : undefined;
  if (landing === undefined) return undefined;
  const schema = positionSchemaOfRef(landing);
  const instance = instanceOfType(landing);
  if (schema === undefined || instance === undefined) return undefined;
  return { fields: schema.properties, declared: isDeclaredNode(instance) };
}

/** A declared node's records as they land on an appendable edge of a node the
 *  run built — records with identity in the run's own graph. */
function runBuiltLanding(target: PositionTypeRef): PositionTypeRef {
  return target.kind === 'position' ? { ...target, runBuilt: true } : target;
}

function isDeclaredNode(instance: InstanceRef): boolean {
  const { token } = instance;
  return 'kind' in token && token.kind === 'shape';
}

/**
 * Why an argument does not fit a parameter typed on a declared node, or
 * undefined when it does. Every kind of record is judged by what it carries —
 * a system's record, an extracted one, one of another declaration, one built
 * here — so two declarations spelling the same structure fit each other, and
 * `node X extends Y`'s records fit `<Y>`. A union fits only when EVERY member
 * does: the callee reads the parameter without narrowing it.
 */
function declaredParamMisfit(
  arg: PositionTypeRef,
  param: Extract<PositionTypeRef, { kind: 'position' }>,
): string | undefined {
  const required: RequiredPosition = { schema: param.instance.schema, position: param.position };
  switch (arg.kind) {
    case 'union': {
      for (const variant of arg.variants) {
        const misfit = surfaceMisfit(schemaSurface(arg.instance.schema, variant), required);
        if (misfit !== undefined) {
          return `${displayNameOf(arg.instance, variant)}, one of what this argument may be, does not fit: ${misfit}`;
        }
      }
      return undefined;
    }
    case 'meta':
    case 'closure':
      return `this argument is ${describePosition(arg)}, not a record`;
    case 'position':
    case 'handle':
    case 'extract':
    case 'local':
    case 'maybeEmpty':
      return surfaceMisfit(recordSurface(arg), required);
    default:
      return neverAsAny(arg);
  }
}

/**
 * What a record OFFERS, whatever made it. `suppliedSurface` plus the two kinds
 * only a declared parameter compares: a write's handle (the record it wrote)
 * and an extracted record (its fields as annotated — an unannotated one is
 * text — and its nested nodes as edges).
 */
function recordSurface(type: PositionTypeRef): SuppliedSurface | undefined {
  switch (type.kind) {
    case 'handle':
      return type.position !== undefined
        ? schemaSurface(type.instance.schema, type.position)
        : { properties: type.resultShape, edges: {} };
    case 'extract':
      return extractSurface(type.node);
    case 'maybeEmpty':
      return recordSurface(type.of);
    default:
      return suppliedSurface(type);
  }
}

/**
 * One record `extract(content, Shape)` hands back: a run-local record (the
 * graph literal's kind, so it walks, filters, takes writes and links in the
 * run) whose fields read by the keyword's rule for the same declaration —
 * plain text present, anything typed `T | absent`, an annotation that did not
 * resolve here unknown. Each nested node is an edge of records of its own,
 * in the order the content gave them.
 */
function extractedRecordType(node: ExtractNodeType): Extract<PositionTypeRef, { kind: 'local' }> {
  const reads: Record<string, FieldType | undefined> = {};
  const fields: Record<string, SchemaFieldType> = {};
  for (const [name, field] of node.properties) {
    fields[name] = field.explicit ?? 'text';
    reads[name] = readsAsPresentText(field)
      ? 'text'
      : field.explicit !== undefined
        ? maybeAbsent(field.explicit)
        : undefined;
  }
  const edges: Record<string, LocalEdge> = {};
  for (const [name, child] of node.children) {
    edges[name] = {
      schema: { target: name, readable: true, sequenced: 'document' },
      target: extractedRecordType(child),
      structural: true,
    };
  }
  return { kind: 'local', label: `an extracted '${node.name}' record`, reads, edges, extracted: { fields } };
}

/** Why `extract` cannot read this content as it is, or undefined. `written` is
 *  the content as the author wrote it, for the fix. */
function extractContentProblem(type: FieldType, written: string): string | undefined {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'list':
      return extractContentItemProblem(variant.of, 'each item');
    case 'tuple': {
      for (const [index, slot] of variant.of.entries()) {
        if (slot === null) continue;
        const problem = extractContentItemProblem(slot, `item ${index}`);
        if (problem !== undefined) return problem;
      }
      return variant.rest?.of != null
        ? extractContentItemProblem(variant.rest.of, 'each item the spread adds')
        : undefined;
    }
    case 'record':
      return `'extract' reads text and files, and this is a record — render it as text in the content list: \`extract([TEXT.SERIALISE(${written}, 'JSON')], …)\``;
    default:
      return `'extract' reads a LIST of text and files, and this is ${describeFieldType(type)} — write it as a list: \`extract([${written}], …)\``;
  }
}

function extractContentItemProblem(type: FieldType, which: string): string | undefined {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'text':
    case 'enum':
    case 'file':
    case 'absent':
      return undefined;
    case 'union': {
      for (const member of variant.of) {
        const problem = extractContentItemProblem(member, which);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case 'record':
      return `${which} of the content is a record, and 'extract' reads text and files — render the record as text first: \`TEXT.SERIALISE(record, 'JSON')\``;
    case 'dict':
    case 'json':
      return `${which} of the content is ${describeFieldType(type)}, and 'extract' reads text and files — render it as text first: \`TEXT.SERIALISE(value, 'JSON')\``;
    case 'list':
    case 'tuple':
      return `${which} of the content is itself a list — spread it into the content so each of its items is one item: \`[a, ...items]\``;
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
      return `${which} of the content is ${describeFieldType(type)}, and 'extract' reads text and files — write it into text (\`"… \${value} …"\`) or render it with \`TEXT.SERIALISE(value, 'JSON')\``;
    case 'maybeAbsent':
      return extractContentItemProblem(variant.of, which);
    default:
      return neverAsAny(variant);
  }
}

function extractSurface(node: ExtractNodeType): SuppliedSurface {
  return {
    properties: Object.fromEntries(
      [...node.properties].map(([name, field]) => [name, field.explicit ?? 'text']),
    ),
    edges: Object.fromEntries(
      [...node.children].map(([name, child]) => [name, () => extractSurface(child)]),
    ),
  };
}

/**
 * Does `supplied` carry everything the required position declares? The
 * checker's doorway into the shared comparator.
 */
function nodeMisfitAgainst(
  supplied: PositionTypeRef | undefined,
  instance: InstanceRef,
  position: string,
  path: string,
): string | undefined {
  // An entry we couldn't type is UNKNOWN, and unknown fits anything — the same
  // benefit of the doubt every other unchecked read gets.
  if (supplied === undefined) return undefined;
  return surfaceMisfit(suppliedSurface(supplied), { schema: instance.schema, position }, { path });
}

/**
 * "No address on the param accepts any listen" — an unnarrowed signature is not
 * a mechanism, it is a WIDER TYPE. So a parameter that pins nothing accepts an
 * argument narrowed from the event it names; a parameter that pins an address
 * accepts only that exact address, which is what makes a listen watching another
 * table a type error rather than a silence.
 *
 */

/**
 * A parameter's ADDRESS (`<at-[:`Record Change` WHERE `action` == "record.created"]->>`)
 * → the position it names.
 *
 * Resolving a type ref becomes a WALK, which is what layer 5's rule says every
 * address already is — so this runs the REAL hop parser rather than a second
 * grammar, and the position it lands on is the one the HOST grafted for this
 * same address (both sides name it through `eventAddressPositionName`).
 *
 * Silence, not an error, on anything that doesn't resolve: an address the host
 * didn't graft is one it couldn't walk, and the unknown-stays-silent contract
 * is what keeps a missing schema from reading as a broken movement.
 *
 */
function addressOfTypeRef(hopsRaw: string): EventAddress | undefined {
  // ONE hop, shared reading (`eventAddressOfHops`). An event edge is not
  // traversable, so there is nothing to walk on from the event node at author
  // time — the address names the edge and pins it.
  return eventAddressOfHops(hopsRaw);
}

/**
 * The variant of `union` that a FAILED `IS` rules out — the one a passing test
 * would have narrowed to, which is the only thing failing it disproves.
 *
 * A record test names its variant outright. An ADDRESS test names it by pins,
 * and the variant is that address's KEY — merged with the subject's own pins,
 * exactly as the positive narrowing merges them (`A & B`), so a test never has
 * to restate what the signature already pinned. The key is CONSTRUCTED from the
 * merged address and compared; the variants' own keys are never parsed.
 *
 * Undefined where nothing is ruled out: pins that CONTRADICT the subject's
 * (`never` — a test that could not have passed disproves nothing), a different
 * event, or an address whose key is not one of these variants. That last case
 * covers the unpinned test (`ev IS <crm-[:`Webhook Event`]->>`, whose key is the
 * union's own): always true at run time, so its `else` is unreachable, but
 * saying so would need each variant's address and the keys are opaque. Nothing
 * eliminated is the conservative answer, and it costs only an unreachability
 * warning on a test no author writes.
 */
function ruledOutVariant(
  type: Pick<TypeRef, 'position' | 'hopsRaw'>,
  union: Extract<PositionTypeRef, { kind: 'union' }>,
): string | undefined {
  if (type.hopsRaw === undefined) return type.position;
  const test = addressOfTypeRef(type.hopsRaw);
  if (test === undefined) return undefined;
  const subjectAddress: EventAddress = union.address ?? { event: union.union, narrowing: {} };
  if (subjectAddress.event !== test.event) return undefined;
  const merged: Record<string, string> = { ...subjectAddress.narrowing };
  for (const [key, value] of Object.entries(test.narrowing)) {
    if (merged[key] !== undefined && merged[key] !== value) return undefined;
    merged[key] = value;
  }
  const key = eventAddressKey({ event: test.event, narrowing: merged });
  return union.variants.includes(key) ? key : undefined;
}

function positionFromAddress(instance: InstanceRef, hopsRaw: string): PositionTypeRef | undefined {
  const address = addressOfTypeRef(hopsRaw);
  if (address === undefined) return undefined;
  // The IDENTITY of the position this address names — the same key the host
  // grafted it under. Opaque: compared, never parsed.
  const key = eventAddressKey(address);
  const resolved = positionRefIn(instance, key);
  // An address that resolves to NOTHING is not an error here, and that is
  // a rule rather than a tolerance: a narrowing that matches nothing is
  // `never`, exactly as `if (x === "nope")` on `x: "a" | "b"` is, and erroring
  // at the narrow would be erroring at a true statement. The typo dies at the
  // pin (`checkAddressPins` — `enum == "not in the enum"`), and the handle dies
  // where it is USED (`MOV_UNDESCRIBED_POSITION`).
  if (resolved === undefined) return undefined;
  // A pinned address is a NARROWER type than the event it names; an unpinned one
  // IS that event, so it carries no `narrowsEvent` and accepts any listen.
  // Either way the parsed address rides along, so an IS test can narrow by
  // EXTENDING it (subject pins ∪ test pins).
  if (resolved.kind === 'position' || resolved.kind === 'union') {
    const narrowed = Object.keys(address.narrowing).length > 0;
    return { ...resolved, address, ...(narrowed ? { narrowsEvent: address.event } : {}) };
  }
  return resolved;
}

/**
 * The record an event position is ABOUT — the edge the adapter marked
 * `subject`, and where it lands.
 *
 * `undefined` for anything that is not an event node with such an edge: a
 * position that fires the record itself, and a delete-narrowed event (whose
 * `requiresLiveRecord` edges the host drops — the record is gone, so there is
 * nothing one hop away). Both cases mean "this position IS the subject",
 * which is what every caller falls back to.
 *
 * The marker is DECLARED by the adapter and only compared here; nothing reads
 * the edge's name, because a name is a display string an adapter may spell as
 * it likes.
 *
 */
function subjectOf(
  instance: InstanceRef,
  event: PositionSchema,
): { edge: string; target: string; position: PositionSchema } | undefined {
  for (const [edge, schema] of Object.entries(event.edges)) {
    if (schema.subject !== true) continue;
    const position = instance.schema.positions[schema.target];
    if (position === undefined) continue;
    return { edge, target: schema.target, position };
  }
  return undefined;
}

/** Renders a derived event type for a diagnostic — a config-scoped union
 *  reads as its variant list (the per-action displays), a single
 *  action as the variant name. Always the DISPLAY, never the key a narrowed
 *  event address is identified by. */
function describeEventType(type: PositionTypeRef): string {
  if (type.kind === 'union') {
    return type.display ?? type.variants.map((v) => displayNameOf(type.instance, v)).join(' | ');
  }
  if (type.kind === 'position') {
    return type.display ?? displayNameOf(type.instance, type.position);
  }
  return describePosition(type);
}

// ── The checker ──

/**
 * The `return`s of ONE body, collected while its statements are walked. A
 * `return` belongs to the nearest enclosing body — a movement/function, a
 * traversal-headed block, or a closure. An `if` arm pushes nothing: it is
 * transparent, exactly as in TypeScript.
 *
 * `refuses` is set where a statement list is NOT a body — a `parallel`
 * sibling, a race branch — so a `return` there is refused with the reason
 * rather than silently returning from something further out.
 */
interface ReturnCollector {
  /** Author-facing name of the construct, for diagnostics. */
  what: string;
  refuses?: string;
  returns: Array<ReturnShape & { span: Span }>;
}

/** The prefix the ENGINE's own names wear (`#resources`, and the slot a
 *  `return` binds into so it survives a park). Authored bindings may not use
 *  it, which is what makes those slots uncollidable. */
const RESERVED_NAME_PREFIX = '#';

/** A function in a call cycle with no declared return type. `chain` is the
 *  loop as seen from `name`; `example` is the declaration with the type added. */
function recursiveReturnTypeMessage(name: string, chain: readonly string[], example: string): string {
  const loop = chain.length <= 2 ? 'calls itself' : `calls itself through ${chain.slice(1, -1).map(n => `'${n}'`).join(', ')}`;
  return `'${name}' ${loop} (${chain.join(' → ')}), so it declares what it returns, as TypeScript requires — what its body returns cannot be worked out from a body that needs its own answer. Write the type after the parameters: '${example}'`;
}

/** Why a returned value does not fit a declared record type, or undefined
 *  when it does: every required key present, each one assignable. */
function recordReturnMisfit(keys: Record<string, FieldType | null>, source: FieldType): string | undefined {
  if (!isDictType(source)) return `this returns ${describeFieldType(source)}`;
  const supplied = source.shape;
  const required = Object.entries(keys)
    .filter(([, type]) => type !== null && !isMaybeAbsent(type))
    .map(([key]) => key);
  if (supplied === undefined) {
    return required.length > 0
      ? `this returns ${describeFieldType(source)}, whose keys are data — nothing says it has ${required.map(k => `'${k}'`).join(', ')}`
      : undefined;
  }
  const missing = required.filter(key => !Object.hasOwn(supplied, key));
  if (missing.length > 0) {
    return `this is missing ${missing.length === 1 ? 'the key' : 'the keys'} ${missing.map(k => `'${k}'`).join(', ')}`;
  }
  for (const [key, keyType] of Object.entries(keys)) {
    const given = supplied[key];
    if (keyType === null || given === undefined || given === null) continue;
    if (isMaybeAbsent(given) && !isMaybeAbsent(keyType)) return `its key '${key}' is required, but the value given for it may be absent`;
    if (!fieldAssignable(given, keyType)) {
      return `its key '${key}' takes ${describeFieldType(stripAbsent(keyType))}, but the value given for it is ${describeFieldType(stripAbsent(given))}`;
    }
  }
  return undefined;
}

/** A body with no `return` at all. */
const NO_RETURN: ReturnShape = { returns: false };

/** We could not tell whether this returns — an unresolved callee, a cycle in
 *  type space. Neither a claim that it does nor that it doesn't, so no site
 *  refuses on it. */
const UNKNOWN_RETURN: ReturnShape = { returns: true };

/** A `MAP` closure with no `return` — legal (FILTER/REDUCE still require
 *  one). Each slot is absent, exactly as an extracted field with no
 *  explicit value is: known, not unknown, so `MAP(...)` types `list of
 *  absent` rather than falling silent. */
const MAP_SLOT_ABSENT: ReturnShape = { returns: true, fieldType: 'absent' };

/** A plugin output's shape in words, for a diagnostic. */
function describePluginOutput(output: PluginOutput): string {
  const fields = (of: Record<string, SchemaFieldType>): string => Object.keys(of).map(f => `\`${f}\``).join(', ');
  switch (output.kind) {
    case 'value':
      return `one ${describeFieldType(output.type)}`;
    case 'record':
      return `one record (${fields(output.fields)})`;
    case 'records':
      return `a list of records, one per thing it found (${fields(output.fields)})`;
    default:
      return neverAsAny(output);
  }
}

/** Which plane a return sits on — `undefined` for a return whose value the
 *  checker could not type (unknown is not a plane). */
function returnPlane(shape: ReturnShape): 'node' | 'scalar' | undefined {
  if (shape.posType !== undefined) return 'node';
  if (shape.fieldType !== undefined) return 'scalar';
  return undefined;
}

/** One checked library: its file scope (the exported symbols live there)
 *  and the diagnostics its importer must see — errors and warnings (raw,
 *  library-file spans). */
interface CheckedLibrary {
  scope: Scope;
  surfaced: Diagnostic[];
}

/** Shared across the root checker and every nested library checker of one
 *  `checkProgram` call: the resolved link plus the per-path check memo. */
interface LinkContext {
  link: ProgramLink;
  checked: Map<string, CheckedLibrary>;
}

interface CheckerOptions {
  /** The compile context's language version — what every `since`/`before`
   *  conditional in the checker reads. */
  languageVersion: LanguageVersion;
  /** See `CheckOptions.upgradingFrom`. */
  upgradingFrom?: LanguageVersion;
  linkContext?: LinkContext;
  /** The file being checked, when it is an imported library (its imports
   *  resolve through `file.imports` rather than `link.imports`). */
  currentFile?: LinkedFile;
  /** Library mode: suppress whole-file invoker advice (LISTEN_MISSING) —
   *  a library is invoker-less by definition. */
  library?: boolean;
  /** Collects scope frames + write regions for the language service. Absent =
   *  the compile path, which records nothing. Imported libraries are checked
   *  by their own Checker without one, so a recording stays file-local. */
  recording?: CheckRecording;
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];

  /** Node declarations made in the files being checked, by the symbol that
   *  declares them — how `extends` reaches a base declared in the same file,
   *  whose own statement may not have been checked yet. */
  private readonly localShapes = new WeakMap<
    ScopeSymbol,
    { statement: ShapeDeclaration; scope: Scope }
  >();
  /** Declarations `settleShape` has already settled. */
  private readonly settledShapes = new WeakSet<ShapeDeclaration>();
  /**
   * Graph IDENTITY tokens (`InstanceRef.token`) minted for a `node X {…}`
   * declaration — compared by reference only, never parsed, same discipline
   * as `token` itself. The one reader is `checkStdlibRecordArg`
   * (`TEXT.PAIRS`'s argument): a declared shape's landings are the program's
   * own words (a `node {…}` literal, a write into it), never a live system
   * read one field at a time, and the schema the two share carries no other
   * way to tell them apart (`InstanceSchema` describes both alike, by
   * design — a graph is a graph). An imported shape's token is its LIBRARY's
   * declaring symbol, minted in that library's own `Checker`, so it is not a
   * member here — a cross-file `TEXT.PAIRS` on one refuses rather than risks
   * accepting a live position it mistook for a declared one.
   */
  private readonly declaredShapeTokens = new WeakSet<object>();

  /** Listens seen anywhere in the file (any listen suppresses LISTEN_MISSING). */
  private listenCount = 0;
  /** Canonical (instance, config) identities for duplicate detection. */
  private readonly listenIdentities = new Set<string>();
  /** `${movement}::${alias}` keys for per-movement alias uniqueness. */
  private readonly listenAliases = new Set<string>();
  /** File-level single-param movements typed against a constructed instance
   *  — the dispatchable ones LISTEN_MISSING reports on when no listen
   *  exists. */
  private readonly dispatchables: Array<{
    movement: string;
    instanceName: string;
    adapter?: string;
    /** The parameter's position — the type the listen's address must land on. */
    position?: string;
    /** The instance's event-address hops, for filling the suggested config. */
    narrowingKeys?: string[];
    span: Span;
  }> = [];

  constructor(
    private readonly catalog: Catalog,
    private readonly options: CheckerOptions,
  ) {}

  private get languageVersion(): LanguageVersion {
    return this.options.languageVersion;
  }

  /** This check is for a move up across the change version `n` made — see
   *  `CheckOptions.upgradingFrom`. */
  private upgradeCrosses(n: LanguageVersion): boolean {
    const from = this.options.upgradingFrom;
    return from !== undefined && changedBetween(from, this.languageVersion, n);
  }

  /** Notes a scope the editor may resolve a cursor inside. Every `new Scope`
   *  the checker opens has one of these beside it — the pairing IS the
   *  guarantee that the editor sees what the checker saw. */
  private recordFrame(kind: ScopeKind, span: Span, scope: Scope): void {
    if (this.typeOnly) return;
    this.options.recording?.frames.push({ kind, span, scope });
  }

  /**
   * Notes an effect-bearing construct the story projection reads. Returns the
   * recorded object (or undefined when nothing is recording), so a site that
   * learns more further down — a listen's derived event types — can finish it
   * where it knows, instead of the walk being re-shaped around one consumer.
   */
  private recordNode<T extends RecordedNode>(node: T): T | undefined {
    if (this.typeOnly) return undefined;
    const recording = this.options.recording;
    if (recording === undefined) return undefined;
    recording.nodes.push(node);
    return node;
  }

  run(program: Program): Scope {
    // Every scope below inherits the declaration log from this one, so a
    // recorded frame always has the history a cursor query resolves against.
    const file = new Scope('file', undefined, { log: this.options.recording !== undefined });
    this.recordFrame('file', SYNTHETIC_SPAN, file);
    // Nothing is ambient. The knowledge graph is an ordinary adapter as of
    // D25 — imported, then CONSTRUCTED against a connection like any other
    // (`graph = kg(credentials: native_knowledge)`); an unconstructed `kg`
    // used as a graph is ADAPTER_NOT_CONSTRUCTED, the true diagnosis.
    this.checkStatementList(program.statements, file);
    if (!this.options.library) this.reportMissingListens();
    return file;
  }

  /**
   * A file that declares a dispatchable movement but no `listen` saves fine
   * (it is a library), but nothing will ever fire the movement — surface
   * that as an INFO diagnostic with a ready-to-paste listen line.
   */
  private reportMissingListens(): void {
    if (this.listenCount > 0) return;
    for (const d of this.dispatchables) {
      const spec = d.adapter !== undefined ? this.catalog.adapter(d.adapter) : undefined;
      const vocabulary = spec?.triggerConfig;
      // A ready-to-paste line means filling the keys a listen MUST carry.
      // Where a required key is the last hop of the event address, the
      // parameter's own position IS the value that address lands on — which
      // is how a graph listen gets `{ type: "Company" }` suggested without
      // anything here knowing what a graph is.
      const required = spec?.triggerConfigRequired ?? [];
      const addressTail = d.narrowingKeys?.[d.narrowingKeys.length - 1];
      const config =
        spec?.triggerConfigFormats?.['schedule'] === 'cron' ? ' { schedule: "0 9 * * 1" }'
        : required.length > 0
          ? ` { ${required
              .map(key =>
                key === addressTail && d.position !== undefined
                  ? `${key}: "${d.position}"`
                  : key === 'key'
                    ? `key: "${suggestedListenKey(d.movement)}"`
                    : `${key}: "…"`,
              )
              .join(', ')} }`
        : vocabulary?.includes('key') ? ` { key: "${suggestedListenKey(d.movement)}" }`
        : '';
      this.reportInfo(
        DiagnosticCodes.LISTEN_MISSING,
        `'${d.movement}' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to ${d.instanceName}${config} fire ${d.movement}`,
        d.span,
      );
    }
  }

  /**
   * Depth of TYPE-ONLY walks in progress (`movementValueType`). A callee's body
   * is walked to learn what its bindings are, and everything that walk would
   * say is said again — at the declaration, where the author wrote it — when
   * the body is checked for real. So a type-only walk reports nothing and
   * records nothing: it is `silentTyping`, one level up.
   */
  private typeOnlyDepth = 0;

  private get typeOnly(): boolean {
    return this.typeOnlyDepth > 0;
  }

  private report(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span });
  }

  /** An error that carries its exact rewrite. */
  private reportWithFix(diagnostic: { code: string; message: string; span: Span; fix?: DiagnosticFix }): void {
    if (this.typeOnly) return;
    this.diagnostics.push(diagnostic);
  }

  private reportInfo(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span, severity: 'info' });
  }

  private reportWarning(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span, severity: 'warning' });
  }

  /** A warning for a construct whose meaning changed across the move up this
   *  check is for — the only way such a diagnostic is emitted, so it always
   *  carries the tag the deploy check and an upgrade block on. */
  private reportUpgradeWarning(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span, severity: 'warning', upgrade: true });
  }

  /**
   * Declares a binding the AUTHOR wrote, refusing a name an enclosing scope
   * already binds. Shadowing is the one remaining place a name could silently
   * mean two things, so it is a save error — the cross-scope half of the
   * same-scope duplicate rule, not a resolution nicety.
   *
   * A NARROWING is not shadowing and does not come through here: it re-declares
   * the SAME symbol with a sharper type (a guard clause narrowing its subject
   * into the arm, or into the guard's continuation), and calls `scope.declare`
   * directly. Two entry points rather than a flag, because they are two
   * different acts: authoring a name, and sharpening one that exists.
   *
   * Returns the same-scope binding this replaced, exactly as `declare` does, so
   * callers keep reporting their own duplicate errors.
   */
  private declareAuthored(
    scope: Scope,
    symbol: ScopeSymbol,
    span: Span,
    options: { visibleFrom?: Loc } = {},
  ): ScopeSymbol | undefined {
    const shadowing = scope.shadowing(symbol.name);
    if (shadowing !== undefined) {
      const where =
        shadowing.kind === 'bound'
          ? `${describeKind[shadowing.symbol.kind]} at line ${shadowing.symbol.span.start.line}`
          : 'bound further down this file';
      this.report(
        DiagnosticCodes.SHADOWED_NAME,
        `'${symbol.name}' is already ${where} — a name means one thing everywhere it is visible, so this one would hide it. Rename it.`,
        span,
      );
    }
    return scope.declare(symbol, options);
  }

  /** The refinement a name declares (`type Thesis = <"A" | "B">`), when it
   *  declares one — resolved like every other name, so a type is shadowed,
   *  imported and duplicated by the same rules. */
  private declaredTypeIn(name: string, scope: Scope): SchemaFieldType | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found' || resolution.symbol.kind !== 'type') return undefined;
    // A `type` declaration is a closed option set (`declaredTypeOf`), which is
    // a surface type — the symbol slot it rides in holds any value type.
    const declared = resolution.symbol.fieldType;
    return isEnumType(declared) ? declared : undefined;
  }

  /**
   * The record a name is bound to, for a rule that needs one (a position
   * write's target, a linked write's parent, a `bind`, a `refresh`). One
   * reading of every binding path — an alias, a pick, a parameter, a map
   * field, a write handle — through `positionTypeOf`, so no rule asks where
   * the name came from:
   *   - `record` — its record type;
   *   - `value` — it holds a value, not a record (the rule refuses it, by its
   *     own code);
   *   - `undescribed` — a record whose system describes nothing (a schema-less
   *     graph): unknown, never an error;
   *   - undefined — the binding carries no type at all, reported here as the
   *     internal error it is.
   */
  private recordOfName(
    symbol: ScopeSymbol,
    name: string,
    span: Span,
  ):
    | { kind: 'record'; type: PositionTypeRef }
    | { kind: 'value'; what: string }
    | { kind: 'undescribed' }
    | undefined {
    const type = this.symbolPositionType(symbol);
    if (type !== undefined) return { kind: 'record', type };
    if (symbol.fieldType !== undefined) {
      // One record that may not be there (an unguarded pick) is the
      // maybe-empty landing it is, as a pick off a walk is.
      const held = stripAbsent(symbol.fieldType);
      if (typeof held === 'object' && held.kind === 'record' && held.position !== undefined) {
        return {
          kind: 'record',
          type: isMaybeAbsent(symbol.fieldType) ? { kind: 'maybeEmpty', of: held.position } : held.position,
        };
      }
      return holdsRecords(symbol.fieldType)
        ? { kind: 'undescribed' }
        : { kind: 'value', what: describeFieldType(symbol.fieldType) };
    }
    if (symbol.kind !== 'binding' || symbol.bindingPlane === 'node' || symbol.plural === true) {
      return symbol.kind === 'alias' || symbol.kind === 'param' || symbol.kind === 'binding'
        ? { kind: 'undescribed' }
        : { kind: 'value', what: describeKind[symbol.kind] };
    }
    this.report(
      DiagnosticCodes.UNTYPED_BINDING,
      `internal: '${name}' is bound, but its binding says nothing about what it holds, so this can't be checked — please report this program`,
      span,
    );
    return undefined;
  }

  /** A slot's value type, read without reporting — for a rule asked of a slot
   *  the checker has already walked. A bare name reads as the walker reads it,
   *  whichever plane it is bound on. */
  private slotValueTypeSilently(slot: ExprSlot, scope: Scope): FieldType | undefined {
    const trimmed = slot.raw.trim();
    if (BARE_IDENT.test(trimmed)) return this.bareNameValueType(scope, trimmed);
    let parsed: Expression;
    try {
      parsed = expressionOfSlot(slot);
    } catch {
      return undefined; // the syntax error is reported where the slot is read
    }
    return this.silentTyping(scope, slot.span).infer(parsed);
  }

  /** A bound name's position type, where one is derivable. */
  private symbolPositionType(symbol: ScopeSymbol): PositionTypeRef | undefined {
    return positionTypeOf(symbol);
  }

  /** A typed expression walker that reports NOTHING — for a second pass over an
   *  expression the checker has already walked (presence narrowing), where
   *  re-reporting would duplicate every diagnostic. */
  private silentTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      languageVersion: this.languageVersion,
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      isRecordName: name => this.nodePlaneSymbol(name, scope) !== undefined,
      pluralOrderOf: name => this.pluralOrderOf(name, scope),
      isManyValuedName: name => this.isManyValuedSymbol(name, scope),
      isDeclaredGraphToken: token => this.declaredShapeTokens.has(token),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: () => {},
      span,
    });
  }

  /**
   * A bare NAME's value type, whichever plane it is bound on — the statement
   * layer's half of the walker's `bareNameType`, and the same answer. One type
   * universe: a record read where a value goes IS a record, so the write-field
   * rule, the absence rule and the mixed-list rule all see it without a second
   * vocabulary for "this is a position".
   */
  private bareNameValueType(scope: Scope, name: string): FieldType | undefined {
    const scalar = this.symbolScalarType(scope, name);
    if (scalar !== undefined) return scalar;
    const symbol = this.nodePlaneSymbol(name, scope);
    if (symbol === undefined) return undefined;
    const record = recordValueOf(this.symbolPositionType(symbol)) ?? recordOf(undefined);
    // A block's returned records are a LIST of them, as the walker reads them.
    const collected = this.pluralOrderOf(name, scope);
    return collected !== undefined ? listOf(record, collected) : record;
  }

  /** A bound name's SCALAR (dot-plane) type — the seam that lets a binding's
   *  `T | absent` be read back where the name is USED. Only a scalar-plane
   *  binding answers: a node binding's absence is its position type's. */
  private symbolScalarType(scope: Scope, name: string): FieldType | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    return resolution.symbol.bindingPlane === 'scalar' ? resolution.symbol.fieldType : undefined;
  }

  /** A typed expression walker rooted at `scope` that REPORTS and nothing else
   *  — for a walk the program never runs, where a read effect or a recorded
   *  path would claim something happened. */
  private reportingTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      languageVersion: this.languageVersion,
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      isRecordName: name => this.nodePlaneSymbol(name, scope) !== undefined,
      pluralOrderOf: name => this.pluralOrderOf(name, scope),
      isManyValuedName: name => this.isManyValuedSymbol(name, scope),
      isDeclaredGraphToken: token => this.declaredShapeTokens.has(token),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: (code, message, at, severity) =>
        severity === 'info'
          ? this.reportInfo(code, message, at)
          : severity === 'warning'
            ? this.reportWarning(code, message, at)
            : this.report(code, message, at),
      span,
    });
  }

  /** A typed expression walker rooted at `scope`, reporting at `span`. */
  private slotTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      languageVersion: this.languageVersion,
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      isRecordName: name => this.nodePlaneSymbol(name, scope) !== undefined,
      pluralOrderOf: name => this.pluralOrderOf(name, scope),
      isManyValuedName: name => this.isManyValuedSymbol(name, scope),
      isDeclaredGraphToken: token => this.declaredShapeTokens.has(token),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: (code, message, at, severity) =>
        severity === 'info'
          ? this.reportInfo(code, message, at)
          : severity === 'warning'
            ? this.reportWarning(code, message, at)
            : this.report(code, message, at),
      span,
      onEffect: (effect) => this.absorbExpressionEffect(effect),
      onWatchableRead: (edge) => this.polledWatchableEdges?.add(edge),
      recordPath: (path) => {
        this.recordNode<RecordedValuePath>({
          kind: 'valuePath',
          span,
          scope,
          key: valuePathKey(path.root, path.steps),
          ...(path.root !== undefined ? { root: path.root } : {}),
          steps: path.steps,
          landings: path.landings.map(recordedLanding),
        });
      },
    });
  }

  /** Resolves `graph.position` / `graph-[:edge WHERE …]->` / bare `graph`
   *  against the graph symbol's schema. */
  private positionFromTypeRef(symbol: ScopeSymbol, type: TypeRef): PositionTypeRef | undefined {
    const instance = instanceRefOf(symbol);
    if (!instance) return undefined;
    // A DECLARATION is its root node, so `<doc>` starts there; a hop off the
    // name is the retired meta-node form (refused at the declaration site).
    if (symbol.kind === 'shape') {
      return type.hopsRaw === undefined ? declaredRootPosition(symbol) : undefined;
    }
    if (type.hopsRaw !== undefined) return positionFromAddress(instance, type.hopsRaw);
    if (type.position === undefined) return { kind: 'meta', instance };
    return positionRefIn(instance, type.position);
  }

  /**
   * `positionFromTypeRef` at a DECLARATION site: when the graph's schema IS
   * known and the named position does not exist, that is an error — the
   * author typed a position the system does not have, and every downstream
   * check would otherwise silently degrade to untyped. Schema-less graph
   * symbols keep the silent contract. Call-site resolutions
   * (`movementParamTypes`) stay non-reporting so a bad declaration is
   * reported once, where it is written.
   *
   * An ADDRESS is checked differently, and deliberately: not "does this resolve"
   * — a narrowing that matches nothing is `never`, a true statement — but "is
   * every value it pins one this hop actually offers". That is where a typo
   * lives, and it is an ordinary enum comparison.
   */
  private positionFromTypeRefStrict(
    symbol: ScopeSymbol,
    type: TypeRef,
    span: Span,
  ): PositionTypeRef | undefined {
    // A node declaration used to be reached through a meta hop
    // (`<Doc-[:item]->>`). The declaration IS the node now, so the hop names a
    // graph that no longer exists — and silently typing the parameter as the
    // root would make the author's `item` mean something they didn't write.
    if (symbol.kind === 'shape' && type.hopsRaw !== undefined) {
      this.report(
        DiagnosticCodes.SHAPE_HOP_RETIRED,
        `'${type.graph}' is a declared node — the structure a parameter is checked against — and it IS the record it describes, so there is nothing to hop through: write '<${type.graph}>'. Its nested nodes are edges you traverse off the parameter instead ('d-[x:${type.position ?? 'name'}]->')`,
        span,
      );
      return undefined;
    }
    const resolved = this.positionFromTypeRef(symbol, type);
    if (type.hopsRaw !== undefined) {
      const instance = instanceRefOf(symbol);
      const address = addressOfTypeRef(type.hopsRaw);
      if (instance && address) this.checkAddressPins(instance, address, span);
      // An UNPINNED address (`position` set) is the bare name it keys as, so a
      // name the schema doesn't have is the same typo the dotted form used to
      // catch — MOV_UNKNOWN_POSITION, with the schema's actual types. A PINNED
      // address that lands nowhere stays silent deliberately: a narrowing that
      // matches nothing is `never`, and its typos die at the pins above.
      if (resolved === undefined && type.position !== undefined) {
        this.reportUnknownPosition(symbol, type.graph, type.position, span);
      }
      return resolved;
    }
    if (resolved === undefined && type.position !== undefined) {
      this.reportUnknownPosition(symbol, type.graph, type.position, span);
    }
    return resolved;
  }

  /**
   * Each pin of an address, checked against what this hop actually offers.
   *
   * `` `table` == "tblDaels" `` is `enum == "a string literal that isn't in the
   * enum"`, so it rides `checkEnumLiteral` — the same membership rule and the
   * same did-you-mean phrasing as every other enum comparison in the language.
   * There is nothing special about an address; the check simply never reached
   * the event node before.
   *
   * THE VARIANCE IS THE MODEL, and it is why this is a LOOP rather than a
   * lookup. `base` is checked against the bases the root walk already holds;
   * `table` only becomes checkable once `base` is pinned, and then only against
   * THAT base's tables. So a pin we can't vouch for ends the walk: a typo'd base
   * makes every table id unknowable, and guessing would mean a `listTables` per
   * base — the 1 + N this whole plan exists to kill, arrived at while
   * diagnosing a typo.
   *
   * Silent where the options weren't published (an adapter that declares no
   * address hops, a prefix the host couldn't walk). Unknown never becomes an
   * accusation.
   *
   */
  private checkAddressPins(instance: InstanceRef, address: EventAddress, span: Span): void {
    // The `action` pin dies at the EVENT NODE'S OWN ENUM — the change-kind
    // axis is an ordinary field there, its options the `events:` vocabulary,
    // so `` `action` == "record.deletd" `` is `enum == "a literal that isn't
    // in the enum"` like any other. Independent of the hop pins below.
    const actionPin = address.narrowing[EVENT_ACTION_FIELD];
    const actionType = instance.schema.positions[address.event]?.properties[EVENT_ACTION_FIELD];
    if (actionPin !== undefined && isEnumType(actionType)) {
      const diagnostic = checkEnumLiteral(actionPin, actionType);
      if (diagnostic) {
        if (diagnostic.severity === 'warning') {
          this.reportWarning(diagnostic.code, diagnostic.message, span);
        } else {
          this.report(diagnostic.code, diagnostic.message, span);
          return;
        }
      }
    }
    this.checkHopPins(instance, address.narrowing, () => span);
  }

  /**
   * The hop pins of an event address, each against what the adapter published
   * as legal UNDER THE PINS SO FAR (`eventNarrowingValues`, keyed by prefix).
   * A typo'd hop is `enum == "a literal that isn't in the enum"` — the same
   * `checkEnumLiteral` with the same did-you-mean every other enum comparison
   * rides, never a downstream read error.
   *
   * Shared by the two places an address is WRITTEN: a signature's type ref,
   * and a listen's config. They are the same address in two spellings, so a
   * typo has to die the same way in both — it did not, until D25 made the
   * graph's `type:` an ordinary hop and the asymmetry became visible.
   */
  private checkHopPins(
    instance: InstanceRef,
    pins: Record<string, string | undefined>,
    spanFor: (key: string) => Span,
  ): void {
    const keys = instance.schema.eventNarrowingKeys;
    const values = instance.schema.eventNarrowingValues;
    if (keys === undefined || values === undefined) return;
    const pinned: Record<string, string> = {};
    for (const key of keys) {
      const value = pins[key];
      if (value === undefined) return; // the address pins nothing further
      const options = values[narrowingPrefixKey(pinned)]?.[key];
      if (options === undefined) return; // nobody published what's legal here
      const diagnostic = checkEnumLiteral(value, { kind: 'enum', options });
      if (diagnostic) {
        if (diagnostic.severity === 'warning') {
          this.reportWarning(diagnostic.code, diagnostic.message, spanFor(key));
        } else {
          this.report(diagnostic.code, diagnostic.message, spanFor(key));
        }
        return;
      }
      pinned[key] = value;
    }
  }

  /** MOV_UNKNOWN_POSITION, listing the schema's actual position types. */
  private reportUnknownPosition(
    symbol: ScopeSymbol,
    graphName: string,
    position: string,
    span: Span,
  ): void {
    const schema = isGraphSymbol(symbol) ? symbol.schema : undefined;
    if (!schema) return; // no schema → every schema-typed check stays silent
    const available = [
      ...new Set([...Object.keys(schema.unions ?? {}), ...Object.keys(schema.positions)]),
    ];
    this.report(
      DiagnosticCodes.UNKNOWN_POSITION,
      `'${graphName}' has no position type '${position}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
      span,
    );
  }

  /** Lazily types a movement's parameters in its declaring scope (cached on the
   *  symbol), each on its plane: a value type, or a position. */
  private movementParamTypes(symbol: ScopeSymbol): PlaneType[] | undefined {
    const info = symbol.movement;
    if (!info) return undefined;
    if (!info.paramTypes) {
      // An unannotated parameter is refused where it is DECLARED; here it
      // simply has no type to offer.
      info.paramTypes = info.decl.params.map(param => {
        if (param.type === undefined) return {};
        const plane = this.planeTypeOf(param.type, info.declScope);
        return plane.posType !== undefined ? { ...plane, posType: asParameter(plane.posType, paramNeedsOf(info), { fn: info.decl.name, param: param.name }) } : plane;
      });
    }
    return info.paramTypes;
  }

  /** A written parameter (or return) type on its plane — a value type, or a
   *  position — resolved in `scope` without reporting. */
  private planeTypeOf(type: ParamTypeRef, scope: Scope): PlaneType {
    const value = this.movementParamValueType(type, scope, false);
    if (value !== undefined) return value.type !== undefined ? { fieldType: value.type } : {};
    const paramType = typeNameOf(type);
    if (paramType === undefined) return {};
    const resolution = scope.resolve(paramType.graph);
    if (resolution.kind !== 'found') return {};
    const posType = this.positionFromTypeRef(resolution.symbol, paramType);
    return posType !== undefined ? { posType } : {};
  }

  /**
   * The VALUE type a parameter's written type names — a scalar (`<text>`), a
   * declared refinement (`<Thesis>`), or a list or record of them spelled out
   * (`<text[]>`, `<{ mode: text, owner?: text }>`) — or undefined when it names
   * a POSITION instead. `{ type: undefined }` is a value type nobody could type
   * (a member that names nothing, reported when `report` is set).
   *
   * A record type is a dict whose keys were written down — the type a dict
   * literal already has — and an optional key's type is `T | absent`, so a read
   * of it inside the callee is possibly absent, as TypeScript's `owner?: string`
   * reads `string | undefined`.
   */
  private paramValueType(
    type: ParamTypeRef,
    scope: Scope,
    report: boolean,
  ): { type: FieldType | undefined } | undefined {
    if (isValueTypeRef(type)) return { type: this.valueMemberType(type, scope, report) };
    if (type.hopsRaw !== undefined) return undefined;
    const scalar = parseFieldTypeName(type.graph);
    if (scalar !== undefined) return { type: scalar };
    // A refinement-typed parameter is a value from version 3; before it the
    // name resolved as a position source, as every non-scalar name did.
    if (!since(this.languageVersion, 3)) return undefined;
    const declared = this.declaredTypeIn(type.graph, scope);
    return declared !== undefined ? { type: declared } : undefined;
  }

  /**
   * `paramValueType` for a MOVEMENT's parameter. A movement's parameters became
   * able to take values with language version 3; before it every one named a
   * position (a scalar there resolved as a name, and failed as one), and a
   * version's meaning is its own.
   */
  private movementParamValueType(
    type: ParamTypeRef,
    scope: Scope,
    report: boolean,
  ): { type: FieldType | undefined } | undefined {
    return since(this.languageVersion, 3) ? this.paramValueType(type, scope, report) : undefined;
  }

  private valueMemberType(member: ValueTypeMember, scope: Scope, report: boolean): FieldType | undefined {
    switch (member.kind) {
      case 'name': {
        const named = parseFieldTypeName(member.name) ?? this.declaredTypeIn(member.name, scope);
        if (named === undefined && report) {
          this.report(
            DiagnosticCodes.UNKNOWN_TYPE_NAME,
            `'${member.name}' is not a value type — a list or record type holds values: a primitive (${PRIMITIVE_TYPE_NAMES.join(', ')}), a type you declare (\`type ${member.name} = <"A" | "B">\`), or a list or record of them${didYouMean(member.name, typeNamesInScope(scope))}`,
            member.span,
          );
        }
        return named;
      }
      case 'list': {
        const of = this.valueMemberType(member.of, scope, report);
        return of !== undefined ? { kind: 'list', of } : undefined;
      }
      case 'record': {
        const shape: Record<string, FieldType> = {};
        let typed = true;
        for (const key of member.keys) {
          const keyType = this.valueMemberType(key.type, scope, report);
          if (keyType === undefined) {
            typed = false;
            continue;
          }
          shape[key.name] = key.optional === true ? (maybeAbsent(keyType) ?? keyType) : keyType;
        }
        if (!typed) return undefined;
        const of = unifyValueTypes(Object.values(shape).map(t => stripAbsent(t))) ?? 'json';
        return { kind: 'dict', of, shape };
      }
      default:
        return neverAsAny(member);
    }
  }

  /**
   * The bodies whose `return`s are currently being collected — innermost last.
   * A movement/function, a traversal-headed block and a closure each push one;
   * an `if` arm pushes nothing (it is transparent, as in TypeScript).
   */
  private readonly returnStack: ReturnCollector[] = [];

  // ── The effect row ──

  /**
   * The FUNCTION bodies whose effects are being collected — innermost last. A
   * movement declaration and a closure each push one; an `if` arm, a race
   * branch and a traversal-headed block push nothing, because they are part of
   * the function around them. That is what makes a closure's row its own: its
   * body's effects land in its frame, not in the frame of whoever wrote it.
   */
  private readonly effectStack: EffectFrame[] = [];

  /** The function currently being walked, when there is one. Effects at file
   *  level belong to no function and are dropped. */
  private get effects(): EffectFrame | undefined {
    return this.effectStack[this.effectStack.length - 1];
  }

  /** Walks `body` as one FUNCTION and hands back what it may do. */
  private withEffectFrame<T>(body: () => T): { value: T; row: EffectRow } {
    const frame = new EffectFrame();
    this.effectStack.push(frame);
    let value: T;
    try {
      value = body();
    } finally {
      this.effectStack.pop();
    }
    return { value, row: frame.close() };
  }

  /**
   * The push-backed edges an `until` condition READ, while one is being checked
   * — undefined everywhere else, which is what keeps the nudge to the one place
   * it means something. A set, so a condition that reads the same edge twice
   * says it once.
   */
  private polledWatchableEdges: Set<string> | undefined = undefined;

  /** The effects an expression walk passed, folded into the function around it. */
  private absorbExpressionEffect(effect: ExpressionEffect): void {
    const frame = this.effects;
    if (frame === undefined) return;
    if (effect.kind === 'read') frame.addRead(...effect.instances);
    else if (effect.kind === 'declared') frame.absorb(rowFromDeclaration(effect.row));
    else frame.flag(effect.kind);
  }

  /** A read/write of whatever graph `type` belongs to. */
  private noteTypedEffect(kind: 'read' | 'write', type: PositionTypeRef | undefined): void {
    const instance = type !== undefined ? instanceOfType(type) : undefined;
    if (kind === 'read') this.effects?.addRead(instance);
    else this.effects?.addWrite(instance);
  }

  /** A read/write against whatever graph a BOUND NAME denotes — the shape
   *  `delete` / `unlink` reach an instance by. */
  private noteNamedEffect(kind: 'read' | 'write', name: string, scope: Scope): void {
    const resolution = scope.resolve(name);
    this.noteTypedEffect(
      kind,
      resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined,
    );
  }

  /**
   * What calling `symbol` may do. Computed from the body exactly as
   * `movementReturnType` computes what it hands back — bottom-up over the call
   * graph, and with the same laziness, because a call site may sit above the
   * declaration.
   *
   * Before version 3 there is no recursion, so there is no fixpoint to
   * iterate: a movement whose row is asked for while its own body is being
   * walked answers "unknown" rather than looping. From version 3 that call
   * closes a cycle, and every function in the cycle shares one row
   * (`call_cycles.ts`); the call itself adds nothing here, because the shared
   * row will hold it.
   */
  private movementEffects(symbol: ScopeSymbol): EffectRow {
    const info = symbol.movement;
    if (info === undefined) return UNKNOWN_ROW;
    if (since(this.languageVersion, 3) && this.inference.reaches(info)) return EMPTY_ROW;
    if (info.effects !== undefined) return info.effects;
    // Fills `info.effects` as a side effect of walking the body; before version
    // 3 a cycle leaves it unset, and unknown is the honest answer there.
    if (info.returnType === undefined) this.inferMovement(symbol);
    // Walked, and found to be in a cycle that is still being worked out: its
    // row arrives with the cycle's, which this caller is part of.
    if (since(this.languageVersion, 3) && this.inference.reaches(info)) return EMPTY_ROW;
    return info.effects ?? UNKNOWN_ROW;
  }

  /** Walks `symbol`'s body as one function's, and files the row on the
   *  declaration so every call site reads the same answer — unless the
   *  function is in a call cycle, whose members share the row the cycle
   *  worked out. */
  private recordMovementRow(symbol: ScopeSymbol | undefined, walk: () => ReturnShape): ReturnShape {
    const { value, row } = this.withEffectFrame(walk);
    if (symbol?.movement !== undefined && symbol.movement.cycle === undefined) symbol.movement.effects = row;
    return value;
  }

  /** The bodies being walked to infer what a function returns and does — where
   *  a call cycle is found. */
  private readonly inference = new InferenceStack();

  /** Walks `statements` as ONE body and returns what it hands back. */
  private checkBody(
    statements: Statement[],
    scope: Scope,
    collector: ReturnCollector,
  ): ReturnShape {
    this.returnStack.push(collector);
    try {
      this.checkStatementList(statements, scope);
    } finally {
      this.returnStack.pop();
    }
    return this.closeReturns(collector);
  }

  /**
   * One body's collected `return`s, as its value. A body has ONE value, so
   * returns that disagree about which PLANE they are on — a record position
   * versus a value — is an error naming both. (Returns that agree on the plane
   * but differ in type take the first one's; a real union of position types
   * arrives with the type-model wave.)
   */
  private closeReturns(collector: ReturnCollector): ReturnShape {
    const first = collector.returns[0];
    if (first === undefined) return NO_RETURN;
    const firstPlane = returnPlane(first);
    for (const later of collector.returns.slice(1)) {
      const plane = returnPlane(later);
      if (plane === undefined || firstPlane === undefined || plane === firstPlane) continue;
      this.report(
        DiagnosticCodes.RETURN_PLANE_MISMATCH,
        `${collector.what} returns ${firstPlane === 'node' ? 'a record' : 'a value'} on line ${first.span.start.line} and ${plane === 'node' ? 'a record' : 'a value'} here — a body has one value, so every 'return' in it hands back the same kind of thing`,
        later.span,
      );
    }
    return {
      returns: true,
      ...(first.posType !== undefined ? { posType: first.posType } : {}),
      ...(first.fieldType !== undefined ? { fieldType: first.fieldType } : {}),
    };
  }

  /** `return <value>` — records what this body hands back, against the nearest
   *  enclosing body. */
  private checkReturn(statement: Extract<Statement, { kind: 'return' }>, scope: Scope): void {
    const shape = this.checkRValue(statement.value, scope, undefined, statement.span);
    const collector = this.returnStack[this.returnStack.length - 1];
    if (collector === undefined) {
      this.report(
        DiagnosticCodes.RETURN_OUTSIDE_BODY,
        `'return' hands a value back from a body — there is none here. A movement, a traversal-headed block and a closure each return; file-level statements do not.`,
        statement.span,
      );
      return;
    }
    if (collector.refuses !== undefined) {
      this.report(DiagnosticCodes.RETURN_OUTSIDE_BODY, collector.refuses, statement.span);
      return;
    }
    collector.returns.push({
      returns: true,
      span: statement.span,
      ...(shape.posType !== undefined ? { posType: shape.posType } : {}),
      ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
    });
  }

  /**
   * The type of a CALL of this movement — what its body RETURNS, and nothing
   * else. A callee that never returns hands nothing back: its call is a
   * statement, and binding it is an error at the call site.
   *
   * Computed by walking the body in a fresh scope, lazily and cached exactly as
   * `movementParamTypes` is: a signature is a fact about the declaration, and a
   * call site may sit ABOVE the declaration in the file, so it cannot wait for
   * the body's own check to have happened. The walk is TYPE-ONLY — it reports
   * nothing, because the real check of that body reports everything, at the
   * declaration where the author can act on it.
   */
  private movementReturnType(symbol: ScopeSymbol): ReturnShape {
    const info = symbol.movement;
    if (!info) return UNKNOWN_RETURN;
    // What the declaration SAYS it returns is what a call is (version 3) — the
    // body is checked against it at the declaration, not consulted here.
    return this.declaredReturn(info) ?? this.inferMovement(symbol);
  }

  /**
   * `): <R>` resolved in the declaring scope, silently — the declaration's own
   * check reports a type that names nothing. Undefined when none is written
   * (and always before version 3, which has no such syntax).
   */
  private declaredReturn(info: NonNullable<ScopeSymbol['movement']>): ReturnShape | undefined {
    if (info.decl.returnType === undefined || !since(this.languageVersion, 3)) return undefined;
    info.declaredReturn ??= { returns: true, ...this.planeTypeOf(info.decl.returnType, info.declScope) };
    return info.declaredReturn;
  }

  /** What the body of `symbol` hands back, learned by walking it TYPE-ONLY —
   *  and, on the same walk, what it may do (its effect row). */
  private inferMovement(symbol: ScopeSymbol): ReturnShape {
    const info = symbol.movement;
    if (!info) return UNKNOWN_RETURN;
    if (info.returnType) {
      if (info.returnType.done) return info.returnType.shape;
      // A body that needs its own answer. Before version 3 recursion is refused
      // at run time, so "unknown" is the same answer arrived at earlier; from
      // version 3 this closes a call cycle, whose members must declare what
      // they return (reported at each declaration).
      if (since(this.languageVersion, 3)) this.inference.reaches(info);
      return UNKNOWN_RETURN;
    }
    info.returnType = { done: false, shape: UNKNOWN_RETURN };
    const bodyScope = new Scope('movement', info.declScope);
    for (const param of info.decl.params) {
      const value = param.type !== undefined
        ? this.movementParamValueType(param.type, info.declScope, false)
        : undefined;
      // A type-only re-walk of a declaration the real walk also visits, so it
      // declares without reporting — the shadowing (and duplicate) errors are
      // this movement's own, raised where the author wrote it.
      if (value !== undefined) {
        bodyScope.declare(valueParamSymbol(param, value.type));
        continue;
      }
      const paramType = typeNameOf(param.type);
      const graphSymbol = paramType !== undefined
        ? info.declScope.resolve(paramType.graph)
        : undefined;
      const posType =
        paramType !== undefined
        && graphSymbol?.kind === 'found'
        && graphSymbol.symbol.kind !== 'adapter'
          ? this.positionFromTypeRef(graphSymbol.symbol, paramType)
          : undefined;
      bodyScope.declare({
        name: param.name,
        kind: 'param',
        span: param.span,
        ...(posType ? { posType: asParameter(posType, paramNeedsOf(info), { fn: info.decl.name, param: param.name }) } : {}),
      });
    }
    this.typeOnlyDepth++;
    let shape: ReturnShape;
    try {
      // The row is collected on this walk too — it is the same body, and the
      // type-only pass is what a call ABOVE the declaration has to go through.
      // Silence is about reporting, not about inference.
      const walk = (): ReturnShape =>
        this.checkBody(info.decl.body, bodyScope, {
          what: `'${info.decl.name}'`,
          returns: [],
        });
      if (since(this.languageVersion, 3)) {
        // On the inference stack, so a call back into this body is seen as
        // the cycle it is; the stack files the row (shared, in a cycle).
        this.inference.enter(info);
        let row: EffectRow = UNKNOWN_ROW;
        try {
          const walked = this.withEffectFrame(walk);
          shape = walked.value;
          row = walked.row;
        } finally {
          this.inference.leave(info, row);
        }
      } else {
        shape = this.recordMovementRow(symbol, walk);
      }
    } finally {
      this.typeOnlyDepth--;
    }
    // A returned checker-local node carries a free-text label, and at a call
    // site the useful text is WHOSE value this is. Nothing else about the type
    // changes — a local node IS its structure.
    // A parameter handed back is the caller's record again: what this body
    // needs of it was said at the call that handed it over.
    const returned = shape.posType !== undefined ? { ...shape, posType: withoutParameter(shape.posType) } : shape;
    const labelled: ReturnShape =
      returned.posType?.kind === 'local'
        ? { ...returned, posType: { ...returned.posType, label: `the value of '${info.decl.name}'` } }
        : returned;
    info.returnType = { done: true, shape: labelled };
    return labelled;
  }

  /** The movement's parameters, in declaration order, with their types — what
   *  argument binding resolves against, by name or by position. */
  private movementParams(symbol: ScopeSymbol): DeclaredParams | undefined {
    const info = symbol.movement;
    if (!info) return undefined;
    const types = this.movementParamTypes(symbol) ?? [];
    return info.decl.params.map((param, i) => ({ name: param.name, type: types[i] ?? {} }));
  }

  // ── Statement lists: hoisting, pending prescan, source-order walk ──

  private checkStatementList(statements: Statement[], scope: Scope): void {
    this.hoistDeclarations(statements, scope);
    this.prescanPending(statements, scope);
    for (const statement of statements) {
      this.checkStatement(statement, scope);
    }
  }

  /** Movement, node and type names are visible across their whole statement
   *  list. Types are hoisted FIRST: a node declaration's field annotation may
   *  name one, and `shapeToSchema` resolves annotations as it builds. */
  private hoistDeclarations(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind !== 'type') continue;
      const existing = this.declareAuthored(
        scope,
        {
          name: statement.name,
          kind: 'type',
          span: statement.span,
          fieldType: declaredTypeOf(statement),
        },
        statement.span,
      );
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `'${statement.name}' is already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      }
    }
    for (const statement of statements) {
      if (statement.kind !== 'movement' && statement.kind !== 'shape') continue;
      const symbol: ScopeSymbol = {
        name: statement.name,
        kind: statement.kind,
        span: statement.span,
        ...(statement.kind === 'movement'
          ? { arity: statement.params.length, movement: { decl: statement, declScope: scope } }
          : {
              schema: shapeToSchema(statement, name => this.declaredTypeIn(name, scope)),
              declaration: statement,
            }),
      };
      if (statement.kind === 'movement') this.checkFunctionName(statement.name, statement.span, scope);
      const existing = this.declareAuthored(scope, symbol, statement.span);
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `'${statement.name}' is already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      } else if (statement.kind === 'shape') {
        this.localShapes.set(symbol, { statement, scope });
        this.declaredShapeTokens.add(symbol);
      }
    }
    const visited = new Set<ShapeDeclaration>();
    for (const statement of statements) {
      if (statement.kind === 'shape') this.inheritAtHoist(statement, scope, visited);
    }
  }

  /**
   * `node X extends Y` — X's whole tree, as early as it can be known, so a use
   * of `<X>` checked before X's own statement already sees Y's members. Only a
   * base declared in this list is in reach here (an imported one binds when its
   * `import` statement is checked), and nothing is reported: `settleShape`
   * does it again at X's statement, with Y's types settled, and says what is
   * wrong.
   */
  private inheritAtHoist(
    statement: ShapeDeclaration,
    scope: Scope,
    visited: Set<ShapeDeclaration>,
  ): void {
    if (statement.extends === undefined || visited.has(statement)) return;
    visited.add(statement);
    if (this.extendsCycle(statement, scope) !== undefined) return;
    const base = this.extendsTarget(statement, scope);
    if (base?.local === undefined) return;
    this.inheritAtHoist(base.local.statement, base.local.scope, visited);
    const symbol = scope.symbols.get(statement.name);
    if (symbol === undefined || this.localShapes.get(symbol)?.statement !== statement) return;
    this.adoptInheritance(
      symbol,
      statement,
      base.symbol,
      shapeToSchema(statement, name => this.declaredTypeIn(name, scope)),
    );
  }

  /** The node declaration `statement` extends, where its base names one in
   *  scope — with its statement when it was declared in this file. */
  private extendsTarget(
    statement: ShapeDeclaration,
    scope: Scope,
  ): { symbol: ScopeSymbol; local?: { statement: ShapeDeclaration; scope: Scope } } | undefined {
    if (statement.extends === undefined) return undefined;
    const resolution = scope.resolve(statement.extends.name);
    if (resolution.kind !== 'found' || resolution.symbol.kind !== 'shape') return undefined;
    const local = this.localShapes.get(resolution.symbol);
    return { symbol: resolution.symbol, ...(local !== undefined ? { local } : {}) };
  }

  /**
   * The names around an `extends` cycle `statement` sits on (`A`, `B`, `A`),
   * or undefined. Only this file's declarations are walked: an imported base
   * was settled in its own file, and files cannot import each other in a
   * circle, so no cycle passes through one.
   */
  private extendsCycle(statement: ShapeDeclaration, scope: Scope): string[] | undefined {
    const path = [statement.name];
    const seen = new Set<ShapeDeclaration>([statement]);
    let current = { statement, scope };
    for (;;) {
      const next = this.extendsTarget(current.statement, current.scope)?.local;
      if (next === undefined) return undefined;
      path.push(next.statement.name);
      if (next.statement === statement) return path;
      // A cycle further up that does not come back here is reported on the
      // declarations that ARE on it.
      if (seen.has(next.statement)) return undefined;
      seen.add(next.statement);
      current = next;
    }
  }

  /** X's symbol takes the whole tree: `own` (X's schema as parsed, its types
   *  resolved) with the base's folded in. The schema object is updated in
   *  place, so anything that took it from the symbol earlier reads the result. */
  private adoptInheritance(
    symbol: ScopeSymbol,
    statement: ShapeDeclaration,
    base: ScopeSymbol,
    own: InstanceSchema,
  ): void {
    if (symbol.schema === undefined || base.schema === undefined || base.declaration === undefined) {
      return;
    }
    adoptSchema(
      symbol.schema,
      inheritSchema(own, statement.name, { name: base.declaration.name, schema: base.schema }),
    );
    symbol.declaration = inheritDeclaration(statement, base.declaration);
  }

  /**
   * A node declaration at its own statement: its field types resolve here (a
   * borrowed one's graph is bound by now), its words are checked in this scope,
   * and an `extends` is resolved — the base settled first, so what X inherits
   * carries the base's final types — and refused, naming the problem, when the
   * base is not a node declaration, when the chain comes back round, or when X
   * restates a member the base already has.
   *
   * Once per declaration: a base declared further down is settled early, when
   * the declaration extending it is reached.
   */
  private settleShape(statement: ShapeDeclaration, scope: Scope): void {
    if (this.settledShapes.has(statement)) return;
    this.settledShapes.add(statement);
    const found = scope.symbols.get(statement.name);
    const symbol =
      found?.kind === 'shape' && this.localShapes.get(found)?.statement === statement
        ? found
        : undefined;
    if (statement.extends === undefined) {
      // Borrowed field types (`crm_stage: crm.companies.funding_stage`)
      // resolve at the declaration's source position — the same dotted
      // paths extract annotations take — and patch the hoisted schema in
      // place (positions/writableRoots/resultShape alias one object).
      if (symbol?.schema) {
        this.resolveShapeFieldTypes(statement.root, statement.name, symbol.schema, scope);
      }
      this.checkShapeDescriptions(statement.root, scope);
      return;
    }
    const own = shapeToSchema(statement, name => this.declaredTypeIn(name, scope));
    this.resolveShapeFieldTypes(statement.root, statement.name, own, scope);
    this.checkShapeDescriptions(statement.root, scope);
    const base = this.settledBase(statement, scope);
    if (base?.declaration === undefined) {
      // Nothing to inherit: X is what it says itself, and a use of `<X>` is
      // checked against that rather than against a guess.
      if (symbol?.schema) {
        adoptSchema(symbol.schema, own);
        symbol.declaration = statement;
      }
      return;
    }
    this.refuseRedefinitions(statement, base.declaration);
    if (symbol !== undefined) this.adoptInheritance(symbol, statement, base, own);
  }

  /** The base `statement` extends, settled — or undefined, reported, when it
   *  names no node declaration in scope or the chain comes back round. */
  private settledBase(statement: ShapeDeclaration, scope: Scope): ScopeSymbol | undefined {
    if (statement.extends === undefined) return undefined;
    const { name, span } = statement.extends;
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(name, span, resolution);
      return undefined;
    }
    if (resolution.symbol.kind !== 'shape') {
      this.report(
        DiagnosticCodes.EXTENDS_NOT_A_NODE,
        `'${name}' is ${describeKind[resolution.symbol.kind]}, not a node declaration — '${statement.name}' extends a node declared with 'node ${name} { … }', in this file or imported`,
        span,
      );
      return undefined;
    }
    const cycle = this.extendsCycle(statement, scope);
    if (cycle !== undefined) {
      this.report(
        DiagnosticCodes.EXTENDS_CYCLE,
        cycle.length === 2
          ? `'${statement.name}' extends itself — a node declaration extends a different one`
          : `'${statement.name}' extends itself through ${cycle
              .slice(1, -1)
              .map(n => `'${n}'`)
              .join(', ')} (${cycle.join(' extends ')}) — one of them has to stand on its own`,
        span,
      );
      return undefined;
    }
    const local = this.localShapes.get(resolution.symbol);
    if (local !== undefined) this.settleShape(local.statement, local.scope);
    return resolution.symbol;
  }

  /** X inherits its base's members whole — with their types, their words and a
   *  nested node's order — so restating one is refused rather than read as an
   *  override. */
  private refuseRedefinitions(statement: ShapeDeclaration, base: ShapeDeclaration): void {
    const baseName = statement.extends?.name ?? base.name;
    for (const field of statement.root.fields) {
      if (!base.root.fields.some(f => f.name === field.name)) continue;
      this.report(
        DiagnosticCodes.EXTENDS_REDEFINES,
        `'${field.name}' is already a field of '${baseName}' — '${statement.name}' inherits it, with its type and its words, and cannot redefine it; a field of its own needs a name '${baseName}' does not use`,
        field.span,
      );
    }
    for (const child of statement.root.children) {
      if (!base.root.children.some(c => c.name === child.name)) continue;
      this.report(
        DiagnosticCodes.EXTENDS_REDEFINES,
        `'${child.name}' is already a nested node of '${baseName}' — '${statement.name}' inherits it whole, with its fields, its words and its order, and cannot restate it; a nested node of its own needs a name '${baseName}' does not use`,
        child.span,
      );
    }
  }

  /** Names later statements will bind, for use-before-bind detection. */
  private prescanPending(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === 'assign') {
        if (!scope.symbols.has(statement.name)) scope.pending.add(statement.name);
      } else if (statement.kind === 'import') {
        for (const { name, alias } of statement.names) {
          const local = alias ?? name;
          if (!scope.symbols.has(local)) scope.pending.add(local);
        }
      }
    }
  }

  private checkStatement(statement: Statement, scope: Scope): void {
    switch (statement.kind) {
      case 'import':
        this.checkImport(statement, scope);
        return;
      case 'assign':
        this.checkAssign(statement, scope);
        return;
      case 'type':
        // Hoisted by `hoistDeclarations` (before nodes, which may annotate a
        // field with one). Nothing else to check: a closed set of text values
        // says all of itself.
        return;
      case 'shape': {
        // Hoisted normally. When reached outside a hoisted list (e.g. as a
        // parallel sibling), declare here with its derived schema.
        if (!scope.symbols.has(statement.name)) {
          const symbol: ScopeSymbol = {
            name: statement.name,
            kind: 'shape',
            span: statement.span,
            schema: shapeToSchema(statement, name => this.declaredTypeIn(name, scope)),
            declaration: statement,
          };
          this.declareAuthored(scope, symbol, statement.span);
          this.localShapes.set(symbol, { statement, scope });
          this.declaredShapeTokens.add(symbol);
        }
        this.settleShape(statement, scope);
        return;
      }
      case 'movement':
        this.checkMovement(statement, scope);
        return;
      case 'listen':
        this.checkListen(statement, scope);
        return;
      case 'write':
        this.checkWrite(statement.write, scope);
        return;
      case 'match':
        this.checkMatch(statement.match, scope);
        return;
      case 'call': {
        // A call is read once its callee is resolved: a function runs; `MAP`
        // run bare iterates for its function's effects, as the bare
        // collection statement does.
        const reading = this.readCallAt(statement, scope, 'statement');
        switch (reading.kind) {
          case 'function':
            this.checkCall(statement, scope);
            return;
          case 'collection':
            this.checkCollectionOp(reading.collection, scope);
            return;
          case 'refused':
            this.reportCallRefusal(reading.refusal);
            return;
          // A statement position reads neither (`readCall` refuses both as
          // unused); typed for completeness, checked as what they are.
          case 'value':
            this.checkExprSlot(reading.expr, scope);
            return;
          case 'members':
            this.checkMembers(reading.members, scope);
            return;
          default:
            neverAsAny(reading);
            return;
        }
      }
      case 'block':
        this.checkTraversalBlock(statement.block, scope, undefined);
        return;
      case 'link':
        this.checkLink(statement.link, scope);
        return;
      case 'unlink':
        // Mirror name checks, plus the one edge fact a system can state: an
        // edge it only creates along cannot be severed between two records
        // that already exist. The rest of graph/edge validation stays the
        // runtime's (the inverse of the bare-handle `link`).
        this.resolveName(statement.from, statement.span, scope);
        this.resolveName(statement.to, statement.span, scope);
        this.checkBareLinkEdge(
          { from: statement.from, edge: statement.edge, span: statement.span, verb: 'unlink' },
          scope,
        );
        this.noteNamedEffect('write', statement.from, scope);
        return;
      case 'delete':
        this.recordNode({
          kind: 'delete',
          span: statement.span,
          scope,
          subject: statement.name,
        });
        this.resolveName(statement.name, statement.span, scope);
        this.noteNamedEffect('write', statement.name, scope);
        return;
      case 'refresh':
        this.checkRefresh(statement, scope);
        return;
      case 'if':
        this.checkIf(statement, scope);
        return;
      case 'await':
        this.checkAwait(statement.await, scope, undefined);
        return;
      case 'return':
        this.checkReturn(statement, scope);
        return;
      case 'combinator':
        this.reportCombinatorNeedsAwait(statement.combinator);
        this.checkCombinator(statement.combinator, scope, undefined);
        return;
      case 'collection':
        // Bare, unbound — run for the function's effects; the answer (if any)
        // is discarded exactly as an unbound 'call' statement's is.
        this.checkCollectionOp(statement.collection, scope);
        return;
      case 'error':
        this.checkExprSlot(statement.message, scope);
        return;
    }
  }

  // ── Imports ──

  /** The current file's resolved file-imports (root program vs library). */
  private fileImportsMap(): Map<string, LinkedExport> | undefined {
    if (!this.options.linkContext) return undefined;
    return this.options.currentFile?.imports ?? this.options.linkContext.link.imports;
  }

  /**
   * Check (and memoize) one imported library in its OWN scope: same
   * catalog, library mode (no invoker advice), its imports resolved
   * through its own `LinkedFile`. The library's errors and warnings surface
   * ONCE, prefixed with the import path, at the import site that first
   * pulled it in, keeping their severity — a warning inside a library (an
   * upgrade's meaning-changed construct, say) is the importer's concern too,
   * and keeps its `upgrade` tag, so it holds the importer's pin as surely.
   * Its info diagnostics belong to the library's own editing session and
   * are dropped here.
   */
  private checkLibrary(file: LinkedFile, at: Span): CheckedLibrary {
    const context = this.options.linkContext;
    if (!context) throw new Error('checkLibrary without a link context');
    const cached = context.checked.get(file.path);
    if (cached) return cached;
    const checker = new Checker(this.catalog, {
      languageVersion: this.languageVersion,
      ...(this.options.upgradingFrom !== undefined ? { upgradingFrom: this.options.upgradingFrom } : {}),
      linkContext: context,
      currentFile: file,
      library: true,
    });
    const scope = checker.run(file.program);
    const surfaced = checker.diagnostics.filter(d => diagnosticSeverity(d) !== 'info');
    const result: CheckedLibrary = { scope, surfaced };
    context.checked.set(file.path, result);
    for (const diagnostic of this.typeOnly ? [] : surfaced) {
      this.diagnostics.push({
        ...diagnostic,
        message: `"${file.path}" line ${diagnostic.span.start.line}: ${diagnostic.message}`,
        span: at,
      });
    }
    return result;
  }

  /** An imported name's local symbol — a real movement/declaration symbol when
   *  the link resolved it, an opaque `fileImport` otherwise (the linker
   *  already reported why). */
  private fileImportSymbol(input: {
    local: string;
    name: string;
    span: Span;
    imports: Map<string, LinkedExport>;
  }): ScopeSymbol {
    const opaque: ScopeSymbol = {
      name: input.local,
      importedName: input.name,
      kind: 'fileImport',
      span: input.span,
    };
    const exported = input.imports.get(input.local);
    if (!exported) return opaque;
    const library = this.checkLibrary(exported.file, input.span);
    const librarySymbol = library.scope.symbols.get(exported.name);
    if (exported.kind === 'movement' && librarySymbol?.kind === 'movement') {
      return {
        name: input.local,
        importedName: input.name,
        kind: 'movement',
        span: input.span,
        ...(librarySymbol.arity !== undefined ? { arity: librarySymbol.arity } : {}),
        // The library's own movement info: decl + declScope (the library
        // file scope), so call-fit types parameters against the library's
        // instances and shapes.
        ...(librarySymbol.movement ? { movement: librarySymbol.movement } : {}),
      };
    }
    if (exported.kind === 'shape' && librarySymbol?.kind === 'shape') {
      return {
        name: input.local,
        importedName: input.name,
        kind: 'shape',
        span: input.span,
        ...(librarySymbol.schema ? { schema: librarySymbol.schema } : {}),
        ...(librarySymbol.declaration ? { declaration: librarySymbol.declaration } : {}),
        // Graph identity stays the LIBRARY's declaring symbol, so positions
        // made through this import fit the library movements' parameters.
        graphToken: librarySymbol.graphToken ?? librarySymbol,
      };
    }
    return opaque;
  }

  private checkImport(statement: ImportStatement, scope: Scope): void {
    const fileImports = this.fileImportsMap();
    if (statement.source.kind === 'file' && fileImports === undefined) {
      this.report(
        DiagnosticCodes.IMPORT_FILE_UNSUPPORTED,
        `File imports are not resolved here — "${statement.source.path}" needs a file resolver; its names are treated as opaque`,
        statement.span,
      );
    }
    const kindByNamespace: Record<string, SymbolKind> = {
      adapters: 'adapter',
      credentials: 'credential',
      plugins: 'plugin',
    };
    for (const { name, alias } of statement.names) {
      const local = alias ?? name;
      let symbol: ScopeSymbol;
      if (statement.source.kind === 'file') {
        const resolved = fileImports
          ? this.fileImportSymbol({ local, name, span: statement.span, imports: fileImports })
          : { name: local, importedName: name, kind: 'fileImport' as const, span: statement.span };
        symbol = { ...resolved, importPath: statement.source.path };
      } else {
        const namespace = statement.source.namespace;
        const known =
          namespace === 'adapters'
            ? this.catalog.adapter(name) !== undefined
            : namespace === 'credentials'
              ? this.catalog.credential(name) !== undefined
              : this.catalog.plugin(name) !== undefined;
        if (!known) {
          this.report(
            DiagnosticCodes.IMPORT_UNKNOWN,
            `Unknown ${namespace === 'adapters' ? 'adapter' : namespace === 'credentials' ? 'credential' : 'plugin'} '${name}' in '${namespace}'`,
            statement.span,
          );
        }
        // A bare adapter import is NOT an instance — instantiation is
        // explicit (`go = manual()`). The import name carries no schema; using
        // it in a type slot or `listen to` is an error guiding the
        // named-construction fix (spec §"What is removed").
        symbol = {
          name: local,
          importedName: name,
          kind: kindByNamespace[namespace],
          span: statement.span,
          ...(namespace === 'credentials' ? { adapters: this.catalog.credential(name)?.adapters } : {}),
        };
      }
      if (isFunctionSymbol(symbol)) this.checkFunctionName(local, statement.span, scope);
      const existing = this.declareAuthored(scope, symbol, statement.span);
      if (existing) {
        this.report(
          DiagnosticCodes.IMPORT_DUPLICATE,
          `Duplicate import '${local}' — already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      }
    }
  }

  // ── Assignment ──

  private checkAssign(statement: AssignStatement, scope: Scope): void {
    // `#` marks the engine's own names (`#resources` is the other one), and the
    // engine binds a body's `return` under such a name so it survives a park.
    // Refusing the prefix here is what makes that slot uncollidable — a
    // backtick-quoted name could otherwise spell anything.
    if (statement.name.startsWith(RESERVED_NAME_PREFIX)) {
      this.report(
        DiagnosticCodes.RESERVED_NAME,
        `'${statement.name}' starts with '${RESERVED_NAME_PREFIX}', which marks the engine's own names — pick a name of your own`,
        statement.span,
      );
    }
    const shape = this.checkRValue(statement.value, scope, statement.name, statement.span);
    const symbol: ScopeSymbol = {
      name: statement.name,
      kind: 'binding',
      span: statement.span,
      ...shape,
    };
    // A closure's name is a function's name (it is called like one), so it
    // keeps the function-name rules: no built-in's name, and no other
    // function's name in another letter case.
    if (isFunctionSymbol(symbol)) this.checkFunctionName(statement.name, statement.span, scope);
    const existing = this.declareAuthored(scope, symbol, statement.span);
    // Bindings are immutable: a name means one thing for the whole scope it is
    // visible in. The cross-scope half of that rule is SHADOWED_NAME; this is
    // the same-scope half. A NARROWING re-declaration never reaches here — it
    // goes through `scope.declare` directly, because it is the same symbol
    // sharpened, not a second binding.
    if (existing !== undefined) {
      this.report(
        DiagnosticCodes.REBOUND_NAME,
        `'${statement.name}' is already ${describeKind[existing.kind]} at line ${existing.span.start.line} — a binding never changes, so this second one would make the name mean two things. Give it a different name.`,
        statement.span,
      );
    }
  }

  /**
   * The right-hand side of a binding — and, since `return <value>` takes the
   * same grammar, of a return. Returns the SHAPE the value carries: its plane
   * and its type, plus (for a construction) the instance facts a graph symbol
   * needs. `name` is the binding's name where there is one, for the sites that
   * label their result with it; a `return` has none.
   */
  private checkRValue(
    value: RValue,
    scope: Scope,
    name: string | undefined,
    span: Span,
  ): Partial<ScopeSymbol> {
    // A positional call is read once its callee is resolved: a built-in is
    // the value, collection op or type query it computes, checked as that
    // form is everywhere else; a function's call stays a call.
    if (value.kind === 'call') {
      const reading = this.readCallAt(value.call, scope, 'value');
      switch (reading.kind) {
        case 'function':
          break;
        case 'value':
          return this.checkRValue({ kind: 'expr', expr: reading.expr }, scope, name, span);
        case 'collection':
          return this.checkRValue({ kind: 'collection', collection: reading.collection }, scope, name, span);
        case 'members':
          return this.checkRValue({ kind: 'members', members: reading.members }, scope, name, span);
        case 'refused':
          this.reportCallRefusal(reading.refusal);
          return {};
        default:
          return neverAsAny(reading);
      }
    }
    let symbol: Partial<ScopeSymbol> = {};
    switch (value.kind) {
      case 'construct': {
        // `name(args)` is ONE surface form, and only RESOLUTION can say what it
        // means: an adapter TYPE constructs an instance, a movement RUNS and
        // its value is what it returned. The grammar cannot tell them apart —
        // they are spelled identically — so it does not try.
        const called = this.callInConstructPosition(value.construct, scope);
        if (called !== undefined) {
          symbol = { ...symbol, ...this.boundCallShape(called, scope, name, span) };
          break;
        }
        const { adapter, credential, schema } = this.checkConstruction(value.construct, scope);
        if (name === undefined) {
          // A construction DECLARES an instance, so it needs the name it
          // declares. Returning one is meaningless twice over: an instance
          // stands for a live system and its schema is per-credential, so it
          // cannot travel between movements.
          this.report(
            DiagnosticCodes.RETURN_NOT_A_VALUE,
            `'${value.construct.callee}(…)' constructs an instance, and an instance is not a value to hand back — its schema belongs to the credential it was built with. Construct it in the movement that uses it.`,
            span,
          );
          break;
        }
        this.recordNode({
          kind: 'instance',
          span,
          scope,
          name,
          ...(adapter !== undefined ? { adapterType: adapter } : {}),
        });
        // The non-credential args, raw — the instance's entry position rides
        // here, and a listen's required address hops read it (`checkListen`).
        const constructionArgs: Record<string, string> = {};
        for (const arg of value.construct.args) {
          if (arg.name === 'credentials') continue;
          constructionArgs[arg.name] = arg.value.raw;
        }
        symbol = {
          ...symbol,
          kind: 'instance',
          ...(adapter ? { adapter } : {}),
          ...(credential !== undefined ? { credential } : {}),
          ...(schema ? { schema } : {}),
          ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
        };
        break;
      }
      case 'write': {
        const handle = this.checkWrite(value.write, scope, {
          isBound: true,
          binding: name,
        });
        symbol = { ...symbol, ...(handle ? { posType: handle } : {}), bindingPlane: 'node' };
        break;
      }
      case 'match': {
        const handle = this.checkMatch(value.match, scope, { binding: name });
        symbol = { ...symbol, ...(handle ? { posType: handle } : {}), bindingPlane: 'node' };
        break;
      }
      case 'link': {
        const handle = this.checkLink(value.link, scope, name);
        symbol = { ...symbol, ...(handle ? { posType: handle } : {}), bindingPlane: 'node' };
        break;
      }
      case 'extract': {
        const result = this.checkExtract(value.extract, scope, name);
        symbol = { ...symbol, posType: result, bindingPlane: 'node' };
        break;
      }
      case 'extractCall': {
        // A list of records (or, for `extractOne`, one that may be absent), on
        // the value plane — the currency a plugin's records and a MAP's
        // answers already travel in.
        const records = this.checkExtractCall(value.extractCall, scope, name);
        symbol = {
          ...symbol,
          ...(records !== undefined ? { fieldType: records } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'block': {
        // A bound block's value is what each iteration RETURNED, collected: a
        // list of values on the dot plane, or the returned POSITION on the
        // arrow plane (positions are many-valued already, so plurality lives in
        // the traversal, not in a second type).
        //
        // The PLANE is the returned expression's own, and a return nobody
        // could type has none — unknown is not a plane. Reading that unknown as
        // the arrow plane says "this is a record" about a block whose head
        // merely WALKS records, and every value rule downstream then refuses
        // the binding as one.
        const returned = this.checkTraversalBlock(value.block, scope, name);
        if (!returned.returns) {
          this.report(
            DiagnosticCodes.BLOCK_RETURNS_NOTHING,
            `this block hands nothing back, so there is nothing to bind — 'return' the value you want out of it (\`${name ?? 'names'} = ${rawPath(value.block.head)} { … return <value> }\`), or drop the binding and let it run for its effects`,
            value.block.span,
          );
          break;
        }
        symbol = this.planeOfReturn(symbol, returned, returned.headOrdering, true);
        break;
      }
      case 'await': {
        const result = this.checkAwait(value.await, scope, name);
        // A traversal / maybe-empty landing binds a NODE (arrow plane); an
        // `until` that resolves a scalar condition binds a SCALAR (dot plane).
        symbol =
          result.fieldType !== undefined
            ? { ...symbol, fieldType: result.fieldType, bindingPlane: 'scalar' }
            : { ...symbol, ...(result.posType ? { posType: result.posType } : {}), bindingPlane: 'node' };
        break;
      }
      case 'combinator': {
        this.reportCombinatorNeedsAwait(value.combinator);
        const receipt = this.checkCombinator(value.combinator, scope, name);
        symbol = {
          ...symbol,
          ...(receipt !== undefined ? { fieldType: receipt } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'collection': {
        const result = this.checkCollectionOp(value.collection, scope);
        symbol = {
          ...symbol,
          ...(result !== undefined ? { fieldType: result } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'members': {
        const members = this.checkMembers(value.members, scope);
        symbol = {
          ...symbol,
          ...(members !== undefined ? { fieldType: members } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'inlineBlock': {
        this.reportInlineBlockRetired(value.inlineBlock, scope);
        break;
      }
      case 'closure': {
        const { params, returns, effects } = this.checkClosure(value.closure, scope, {
          label: name !== undefined ? `the closure '${name}'` : 'this closure',
          ...(name !== undefined ? { self: name } : {}),
        });
        symbol = {
          ...symbol,
          posType: closureType(params, returns, effects),
          bindingPlane: 'node',
        };
        break;
      }
      case 'callback': {
        symbol = {
          ...symbol,
          posType: this.checkCallback(value.callback, scope),
          bindingPlane: 'node',
        };
        break;
      }
      case 'call': {
        // The other route to a bound call — the one the parser could tell apart
        // (an argument only a call accepts). Same check, same value.
        symbol = { ...symbol, ...this.boundCallShape(value.call, scope, name, span) };
        break;
      }
      case 'node': {
        symbol = {
          ...symbol,
          posType: this.checkNodeLiteral(value.node, scope),
          bindingPlane: 'node',
        };
        break;
      }
      case 'lazy': {
        // Laziness is evaluation TIME, not type: a deferred traversal binds
        // exactly what the same traversal binds eagerly — the landed node(s),
        // on the arrow plane, awaitability and absence rules included.
        const landed = this.checkLazyTraversal(value.lazy, scope);
        symbol = { ...symbol, ...(landed ? { posType: landed } : {}), bindingPlane: 'node' };
        break;
      }
      case 'expr': {
        // A NAME holds the value as written — a list literal stays the tuple it
        // is, so `AT(t, 0)` off the name reads its slot. A value handed back
        // (`return`, no name) is read, and a returned tuple is the list it
        // widens to: a body's return type stays a list.
        const { valueType, parsed } = this.checkExprSlot(
          value.expr,
          scope,
          name !== undefined ? { holdsValue: true } : undefined,
        );
        // `channel = ONLY(chat-[ch:Channels WHERE …]->)` picks a POSITION, not
        // a value: it binds the landed node (arrow plane), maybe-empty because
        // the selection may match nothing. The same absence an awaited
        // `resolvesEmpty` landing carries, from the other direction.
        // `S = Company`: a declaration's name, read as a value, is the shape
        // itself (language version 3) — a second name for it, as an import's
        // `as` is, so `extract(content, S)` fills the same declaration.
        const shape = since(this.languageVersion, 3) ? this.shapeNamed(value.expr.raw, parsed, scope) : undefined;
        if (shape !== undefined) {
          symbol = {
            ...symbol,
            kind: 'shape',
            ...(shape.schema !== undefined ? { schema: shape.schema } : {}),
            ...(shape.declaration !== undefined ? { declaration: shape.declaration } : {}),
            graphToken: shape.graphToken ?? shape,
          };
          break;
        }
        const landed =
          parsed !== undefined
            ? this.landedAggregatePosition(parsed, scope, span)
            : undefined;
        if (landed !== undefined) {
          symbol = { ...symbol, posType: landed, bindingPlane: 'node' };
          break;
        }
        // `btn = a` where `a` is a node: a second NAME for the same position —
        // an alias, carrying the type. Falling through to the scalar plane
        // would bind the name with NO type and everything downstream (chains,
        // awaits) would check silently dark.
        const aliased = this.bareNodeSymbol(value.expr.raw, parsed, scope);
        if (aliased !== undefined) {
          symbol = {
            ...symbol,
            ...(aliased.posType !== undefined ? { posType: aliased.posType } : {}),
            bindingPlane: 'node',
          };
          break;
        }
        // A plain value binding is a SCALAR (F13, dot plane) — capture its type
        // so a race receipt / block meta can type its property read. Bare
        // literals (`done = true`) short-circuit name resolution in
        // checkExprSlot and yield no valueType, so type them directly here.
        const fieldType = valueType ?? scalarLiteralType(value.expr.raw);
        symbol = {
          ...symbol,
          bindingPlane: 'scalar',
          ...(fieldType !== undefined ? { fieldType } : {}),
          ...(this.isManyValuedValue(value.expr, parsed, scope) ? { plural: true as const } : {}),
        };
        break;
      }
    }
    return symbol;
  }

  /**
   * A call whose value is USED — bound to a name, or returned. A call's value
   * IS the callee's return value, so a callee that returns nothing has nothing
   * to give: that is an error here rather than a name bound to nothing.
   */
  private boundCallShape(
    call: CallStatement,
    scope: Scope,
    name: string | undefined,
    span: Span,
  ): Partial<ScopeSymbol> {
    const returned = this.checkCall(call, scope, name);
    const resolution = this.calleeResolution(call.callee, scope);
    if (resolution.kind === 'found' && this.undeclaredSelves.has(resolution.symbol)) {
      // A closure calling itself by name before its body has said whether it
      // returns anything: whether this binding binds nothing is known once
      // the body has been walked (`checkClosure`).
      const uses = this.boundSelfCalls.get(resolution.symbol) ?? [];
      uses.push({ callee: call.callee, span });
      this.boundSelfCalls.set(resolution.symbol, uses);
    }
    if (!returned.returns) {
      // Silent when the callee is unknown (an unresolved name, a file import
      // the linker could not follow): nobody here knows what it returns, and
      // unknown is not a claim.
      if (this.calleeReturnKnown(call, scope)) this.reportCallReturnsNothing(call.callee, span);
      return {};
    }
    // Same rule as a block's: the plane is the RETURNED expression's, and a
    // callee whose return nobody could type binds a name nobody can type.
    return this.planeOfReturn({}, returned);
  }

  /**
   * What binding a body's value means — the shape a `return` hands back, put on
   * the plane that `return` was written on.
   *
   * A VALUE return collects (a block's per-iteration values are a list of them;
   * a call's value is the one value). A RECORD return binds the position. A
   * return the checker could not type binds NEITHER: unknown is not a plane,
   * and claiming one here is how an untyped answer turns into a record nobody
   * wrote.
   */
  private planeOfReturn(
    symbol: Partial<ScopeSymbol>,
    returned: ReturnShape,
    collectAs?: CollectionOrder,
    /** True from a traversal BLOCK specifically — see `ScopeSymbol.plural`. A
     *  bound call never sets it: its return is the one value the callee handed
     *  back, whatever that callee's own body did internally. */
    plural?: true,
  ): Partial<ScopeSymbol> {
    const { fieldType, posType } = returned;
    if (fieldType !== undefined) {
      return {
        ...symbol,
        fieldType: collectAs !== undefined ? listOf(fieldType, collectAs) : fieldType,
        bindingPlane: 'scalar',
      };
    }
    if (posType !== undefined) {
      return {
        ...symbol,
        posType,
        bindingPlane: 'node',
        ...(plural ? { plural, collectedOrder: collectAs ?? 'unknown' } : {}),
      };
    }
    return symbol;
  }

  private reportCallReturnsNothing(callee: string, span: Span): void {
    this.report(
      DiagnosticCodes.CALL_RETURNS_NOTHING,
      `'${callee}' returns nothing, so there is no value to bind — a call's value is what it returns. Add a 'return' to '${callee}', or call it as a statement.`,
      span,
    );
  }

  /** Whether we can vouch for what a callee returns — a movement declared (or
   *  imported and linked) in this program, or a closure bound to a name (from
   *  version 3, the only version that calls one), whose body is right there.
   *  An unresolved callee has already been reported as unresolved; saying it
   *  "returns nothing" on top would be a second, wrong accusation. */
  private calleeReturnKnown(call: CallStatement, scope: Scope): boolean {
    const resolution = this.calleeResolution(call.callee, scope);
    if (resolution.kind !== 'found') return false;
    const { symbol } = resolution;
    return symbol.movement !== undefined
      || (this.calledClosure(symbol) !== undefined && !this.undeclaredSelves.has(symbol));
  }

  // ── Call resolution (checker/calls.ts) ──

  /** What a call site can see: this scope chain, asked exactly, and its
   *  functions in any letter case. The standard library is `resolveCallee`'s. */
  private callScope(scope: Scope): CallScope {
    return {
      binds: name => scope.resolve(name).kind !== 'unknown',
      functionSpelled: name => scope.resolveFunction(name)?.name,
    };
  }

  /** How a call reads where it is written, once its callee is looked up. */
  private readCallAt(call: CallStatement, scope: Scope, position: CallPosition): CallReading {
    const callScope = this.callScope(scope);
    const reading = readCall(call, callee => resolveCallee(callee, callScope, this.languageVersion), position);
    if (reading.kind !== 'function') {
      this.recordNode<RecordedCallReading>({ kind: 'callReading', span: call.span, scope, reading });
    }
    return reading;
  }

  /** The scope's answer for a callee — under the name it was DECLARED with,
   *  which from version 3 may differ from the call's by letter case. */
  private calleeResolution(written: string, scope: Scope): Resolution {
    return scope.resolve(this.calleeName(written, scope));
  }

  /** The closure a callee names, when it names one (language version 3 —
   *  before it, a name bound to a closure is passed, never called). */
  private calledClosure(callee: ScopeSymbol): Extract<PositionTypeRef, { kind: 'closure' }> | undefined {
    if (before(this.languageVersion, 3)) return undefined;
    return callee.posType?.kind === 'closure' ? callee.posType : undefined;
  }

  /** The name a callee was declared with (`written` when nothing declares it). */
  private calleeName(written: string, scope: Scope): string {
    const resolved = resolveCallee(written, this.callScope(scope), this.languageVersion);
    return resolved.kind === 'declared' ? resolved.name : written;
  }

  private reportCallRefusal(refusal: CallRefusal): void {
    switch (refusal.kind) {
      case 'args':
        this.report(DiagnosticCodes.BUILTIN_ARGS, refusal.message, refusal.span);
        return;
      case 'unused':
        this.report(DiagnosticCodes.BUILTIN_UNUSED, refusal.message, refusal.span);
        return;
      default:
        neverAsAny(refusal.kind);
    }
  }

  /**
   * A callee nothing resolves. From version 3 the standard library is the
   * outermost scope, so an unknown name is unknown everywhere: the message
   * offers the closest function in scope or built-in. A name that is a system
   * or a plugin the file never imported keeps its two-line fix.
   */
  private reportCalleeUnresolved(
    name: string,
    span: Span,
    resolution: Exclude<Resolution, { kind: 'found' }>,
    scope: Scope,
  ): void {
    if (
      resolution.kind !== 'unknown'
      || before(this.languageVersion, 3)
      || this.catalog.adapter(name) !== undefined
      || this.catalog.plugin(name) !== undefined
    ) {
      this.reportResolutionFailure(name, span, resolution);
      return;
    }
    this.report(DiagnosticCodes.FUNCTION_UNKNOWN, unknownFunctionMessage(name, scope), span);
  }

  /**
   * A function declared or imported under `name` (version 3): function names
   * are case-insensitive, so it may not share a built-in's name, nor differ
   * from another function in scope only by letter case. Asked BEFORE the
   * symbol is declared, so the scope holds only the others.
   */
  private checkFunctionName(name: string, span: Span, scope: Scope): void {
    if (before(this.languageVersion, 3)) return;
    const builtin = lookupBuiltin(name);
    if (builtin !== undefined && !builtin.name.includes('.')) {
      this.report(
        DiagnosticCodes.FUNCTION_NAME_COLLISION,
        `'${name}' is the built-in ${builtin.name} — function names are case-insensitive, so a function cannot share a built-in's name in any letter case. Name it something else (an import can rename one: \`import { x as y }\`)`,
        span,
      );
      return;
    }
    const other = scope.resolveFunction(name);
    if (other !== undefined && other.name !== name) {
      this.report(
        DiagnosticCodes.FUNCTION_NAME_COLLISION,
        `'${name}' and '${other.name}' differ only by letter case — function names are case-insensitive, so they would be one name. Rename one of them`,
        span,
      );
    }
  }

  /**
   * The calls in a slot the engine runs, standing where a value is read
   * (language version 3; ./nested_calls.ts). Each is checked as the
   * right-hand side of a binding to a name only the engine can spell, in
   * `scope`, and the slot comes back reading those names in the calls' places
   * — so every reader of the slot after this sees the rewritten one. Its
   * effects are the function's around it; a call that may WAIT is refused
   * here, where it has no address to park at. Undefined when the slot holds
   * no such call.
   */
  private hoistNestedCalls(slot: ExprSlot, scope: Scope): ExprSlot | undefined {
    if (before(this.languageVersion, 3)) return undefined;
    let tree: MExpr;
    try {
      tree = treeOfSlot(slot);
    } catch {
      return undefined; // the syntax error is reported where the slot is read
    }
    const calls = nestedCalls(tree, hoistingMemberReads(tree, call => this.runsAsCall(call, scope)));
    if (calls.length === 0) return undefined;
    for (const call of calls) {
      const span = spanOfExtent(slot, call.at);
      const name = nestedCallName(span);
      let shape: Partial<ScopeSymbol> = {};
      let value: RValue | undefined;
      try {
        value = parseNestedCall(slot, call.at, this.languageVersion);
      } catch (e) {
        if (!(e instanceof MovementParseError)) throw e;
        this.report(DiagnosticCodes.EXPR_PARSE, e.message, span);
      }
      if (value !== undefined) {
        const checked = value;
        const { value: bound, row } = this.withEffectFrame(() => this.checkRValue(checked, scope, undefined, span));
        shape = bound;
        if (row.suspend && (checked.kind === 'call' || checked.kind === 'construct')) {
          const callee = checked.kind === 'call' ? checked.call.callee : checked.construct.callee;
          this.report(
            DiagnosticCodes.NESTED_CALL_SUSPENDS,
            `'${callee}' may wait ('await'), and a wait parks the run where it is written — inside an expression there is no place to come back to. Call it on its own line and use the name: \`answer = ${callee}(…)\``,
            span,
          );
        }
        this.effects?.absorb(row);
      }
      scope.declare({ name, kind: 'binding', span, ...shape });
    }
    return slotOfTree(slot, readingBoundNames(tree, calls, call => nestedCallName(spanOfExtent(slot, call.at))));
  }

  private isExtractCall(written: string, scope: Scope): boolean {
    const resolution = resolveCallee(written, this.callScope(scope), this.languageVersion);
    return resolution.kind === 'builtin' && resolution.builtin.form.kind === 'extract';
  }

  /** Whether a call in an expression is one the engine runs (./nested_calls.ts). */
  private runsAsCall(call: CallNode, scope: Scope): boolean {
    const callScope = this.callScope(scope);
    return runsAsCall(
      call,
      callee => resolveCallee(callee, callScope, this.languageVersion),
      declared => {
        const found = scope.resolve(declared);
        return found.kind === 'found' && isFunctionSymbol(found.symbol);
      },
    );
  }

  /**
   * What version 3 says of an expression's tree — what the lowering to the
   * shared expression tree would otherwise decide silently:
   *
   *   - every call is resolved by scope as a statement-level call is. An
   *     unknown name is an error, with a did-you-mean — except inside a write
   *     field, whose target may advertise functions of its own (a Slack
   *     message's `SLACK_MESSAGE(…)`), which the catalog does not list;
   *   - a function's call, or a built-in that takes a function or a type, is
   *     not written where it would be read per landing or per member;
   *   - a built-in is handed exactly the arguments its signature takes, in
   *     the form it reads them, and is one the engine runs;
   *   - an `IF` says what it is when its condition fails (`ELSE`);
   *   - a walk keeps everything written in it: no hop settings (no hop reads
   *     them), no root or hops a resource hop would drop;
   *   - nothing reads the translation graph's context, which a run does not
   *     have: no `#transform` or `#linked` hop, no `@parent.…` or
   *     `@resource.…`.
   */
  private checkSlotExpression(slot: ExprSlot, scope: Scope, options?: { writeField?: true }): void {
    if (before(this.languageVersion, 3)) return;
    let tree: MExpr;
    try {
      tree = treeOfSlot(slot);
    } catch {
      return; // the syntax error is reported where the slot is read
    }
    this.checkExpressionTree(tree, {
      spanOf: (at) => spanWithin(slot, at.start),
      extentOf: (at) => spanOfExtent(slot, at),
      slot,
      scope,
      writeField: options?.writeField === true,
    });
  }

  /** `checkSlotExpression` over a tree that is not a slot's — a block head's
   *  hops, read through the probe the head is parsed as (`head`: the walk the
   *  head IS, as opposed to a walk written inside one of its hops).
   *  `extentOf` places an extent of the tree exactly in the file, where it
   *  can — what an exact rewrite needs. */
  private checkExpressionTree(
    tree: MExpr,
    at: {
      spanOf: (at: At) => Span;
      extentOf: (at: At) => Span | undefined;
      slot?: ExprSlot;
      scope: Scope;
      writeField: boolean;
      head?: MExpr;
    },
  ): void {
    const visit = (expr: MExpr, perMember: boolean, inResourceWhere: boolean): void => {
      if (expr.kind === 'path') this.checkWalkKeepsWhatIsWritten(expr, at.spanOf(expr.at), expr === at.head);
      if (expr.kind === 'special') this.checkSpecialRecordRead(expr, { ...at, inResourceWhere });
      if (expr.kind === 'if' && expr.else === undefined) {
        this.report(
          DiagnosticCodes.IF_WITHOUT_ELSE,
          "this IF has no ELSE, so where its condition fails it is \"\" (empty text), whatever THEN gives — say what it is there: 'IF … THEN … ELSE … END'",
          at.spanOf(expr.at),
        );
      }
      if (expr.kind === 'call' && expr.callee.kind === 'name') {
        const written = expr.callee.name.text;
        // The extraction call has its own refusal wherever it is not hoisted,
        // said by the typing walk (`checkCallInExpression` leaves it too).
        if (perMember && this.runsAsCall(expr, at.scope) && !this.isExtractCall(written, at.scope)) {
          this.report(DiagnosticCodes.CALL_NESTED, sortKeyNestedMessage(written), at.spanOf(expr.at));
          return;
        }
        this.checkCallInExpression(expr, written, at);
      }
      const key = expr.kind === 'call' ? sortKeyOf(expr) : undefined;
      // A resource hop's WHERE reads the resource's own fields by bare name.
      const resourceWheres: ReadonlySet<MExpr> = new Set(
        expr.kind === 'path'
          ? expr.hops.flatMap(hop => (hop.where !== undefined && endingHop(hop) === 'resources' ? [hop.where] : []))
          : [],
      );
      for (const child of expressionChildren(expr)) {
        visit(child, perMember || child === key, inResourceWhere || resourceWheres.has(child));
      }
    };
    visit(tree, false, false);
  }

  /**
   * What the lowering would drop or never run in a walk (language version 3):
   * a `#transform` or `#linked` hop; settings on a hop, which none reads; and
   * — for a walk ending in a resource hop, which lowers to a node of its own —
   * the root of a walk read as a value, or the hops before it in a block
   * head. A block head's root is read by the engine from the head itself, so
   * a one-hop head keeps it.
   */
  private checkWalkKeepsWhatIsWritten(walk: Extract<MExpr, { kind: 'path' }>, span: Span, isHead: boolean): void {
    for (const hop of walk.hops) {
      if (isTransformHop(hop)) {
        this.report(DiagnosticCodes.TRANSFORM_HOP_RETIRED, this.transformHopRetiredMessage(hop), span);
        continue;
      }
      if (endingHop(hop) === 'linked') {
        this.report(
          DiagnosticCodes.LINKED_HOP_RETIRED,
          "the '-[#linked …]->' hop is retired — it looked a record up by the id another system gave it, not by the record this run wrote. "
            + "Keep the write's handle and read from it: 'rec = write crm-[:Companies]-> { … }', then 'rec.<field>' or 'rec-[:…]->'; "
            + "or tie a write to a record you hold with 'write … bind other { … }'",
          span,
        );
        continue;
      }
      if (hop.config === undefined) continue;
      this.report(
        DiagnosticCodes.HOP_CONFIG_UNREAD,
        `the settings '{ … }' on the hop '${hop.label.text}' are not read — a hop takes no settings. Remove them, or say what they mean in the hop's WHERE`,
        span,
      );
    }
    const last = walk.hops[walk.hops.length - 1];
    if (last === undefined || endingHop(last) !== 'resources') return;
    if (isHead && walk.hops.length > 1) {
      this.report(
        DiagnosticCodes.RESOURCE_WALK_UNREAD,
        "a block head that ends in -[:_resources]-> walks only the hops before it — the -[:_resources]-> hop is never read, so the body would run once per record those hops reach, not once per resource. "
          + "Walk to the record in one block, then its resources as the one hop of a block inside: '…-[m:…]-> { m-[f:_resources]-> { … } }'",
        span,
      );
      return;
    }
    if (isHead || walk.root === undefined) return;
    const root = walk.root.kind === 'name' ? walk.root.name.text : 'the root';
    this.report(
      DiagnosticCodes.RESOURCE_WALK_UNREAD,
      `a walk that ends in -[:_resources]-> is read here from no record — '${root}' would be dropped, and the resources read would not be ${root}'s. Walk ${root}'s resources as a block: '${root}-[f:_resources]-> { … f.\`url\` … }'`,
      span,
    );
  }

  /** The plugin call a `#transform` hop is written as instead — named, with
   *  its required arguments, when its `plugin:` setting names one the catalog
   *  has. */
  private transformHopRetiredMessage(hop: Hop): string {
    const lead = "the '#transform' hop is retired — the movement engine never runs it. Import the plugin and call it with the value it reads";
    const named = hop.config?.entries.find((entry): entry is MapEntry => !isMapSpread(entry) && entry.key.text === 'plugin');
    const plugin = named?.value.kind === 'string' && named.value.parts.length === 1 && typeof named.value.parts[0] === 'string'
      ? named.value.parts[0]
      : undefined;
    const spec = plugin === undefined ? undefined : this.catalog.plugin(plugin);
    if (plugin === undefined || spec === undefined) {
      return `${lead}, e.g. '${importLine('fetch_url', 'plugins')}', then 'page = fetch_url(url: m.u)'`;
    }
    const args = (spec.requiredArgs ?? []).map(arg => `${arg}: …`).join(', ');
    return `${lead}: '${importLine(plugin, 'plugins')}', then 'out = ${spellName(plugin)}(${args.length > 0 ? args : '…'})'`;
  }

  /**
   * `@parent.<field>` and `@resource.<field>` (language version 3): the
   * translation graph's parent result and resource, which a run does not
   * have. Inside a resource hop's WHERE, `@resource.<field>` is the bare field
   * name — the one place it ever read a value — so the rewrite is exact. Any
   * other `@` value is the meta-key check's.
   */
  private checkSpecialRecordRead(
    special: Extract<MExpr, { kind: 'special' }>,
    at: { spanOf: (at: At) => Span; extentOf: (at: At) => Span | undefined; inResourceWhere: boolean },
  ): void {
    const read = specialRecordField(special.text);
    if (read === undefined) return;
    const span = at.spanOf(special.at);
    switch (read.record) {
      case 'parent':
        this.report(
          DiagnosticCodes.PARENT_READ_RETIRED,
          `'@parent.${read.field}' is retired — it read the translation graph's parent result, which a movement run does not have. `
            + "Keep the parent write's handle and write the child off it: 'co = write crm-[:Companies]-> { … }', then 'write co-[:Team]-> { … }'",
          span,
        );
        return;
      case 'resource': {
        const known = read.known.includes(read.field);
        if (!at.inResourceWhere || !known) {
          this.report(
            DiagnosticCodes.RESOURCE_READ_RETIRED,
            at.inResourceWhere
              ? `'@resource.${read.field}' is retired, and a resource has no field '${read.field}' — it has ${read.known.join(', ')}${didYouMean(read.field, read.known)}. Inside a -[:_resources WHERE …]-> filter, write the field's bare name`
              : `'@resource.${read.field}' is retired — outside a -[:_resources WHERE …]-> filter it was always null. Walk the record's resources and read the field off the landing: 'r-[f:_resources]-> { … f.\`${known ? read.field : 'url'}\` … }'`,
            span,
          );
          return;
        }
        const extent = at.extentOf(special.at);
        this.reportWithFix({
          code: DiagnosticCodes.RESOURCE_READ_RETIRED,
          message: `'@resource.${read.field}' is retired — inside a -[:_resources WHERE …]-> filter, write the field's bare name: '${read.field}'`,
          span,
          ...(extent !== undefined ? { fix: { edits: [{ span: extent, text: read.field }] } } : {}),
        });
        return;
      }
      default:
        neverAsAny(read.record);
    }
  }

  private checkCallInExpression(
    call: Extract<MExpr, { kind: 'call' }>,
    written: string,
    at: { spanOf: (at: At) => Span; slot?: ExprSlot; scope: Scope; writeField: boolean },
  ): void {
    const span = at.spanOf(call.at);
    const resolution = resolveCallee(written, this.callScope(at.scope), this.languageVersion);
    switch (resolution.kind) {
      case 'builtin': {
        const { builtin } = resolution;
        // The extraction call has its own refusal, said by the typing walk.
        if (builtin.form.kind === 'extract') return;
        if (builtin.form.kind !== 'value') {
          this.report(DiagnosticCodes.CALL_NESTED, nestedMessage(written), span);
          return;
        }
        const { min, max } = builtinArity(builtin);
        const count = call.args.length;
        if (count < min || count > max) {
          const expected = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
          this.report(
            DiagnosticCodes.BUILTIN_ARGS,
            `'${written}' takes ${expected} argument${max === 1 ? '' : 's'}, got ${count} — ${describeBuiltin(builtin)}`,
            span,
          );
          return;
        }
        const notRun = builtinNotRun(builtin);
        if (notRun !== undefined) {
          this.report(DiagnosticCodes.BUILTIN_NOT_RUN, `'${written}' ${notRun}`, span);
          return;
        }
        const unread = computedArgNotRead(builtin, call);
        if (unread !== undefined) {
          this.report(DiagnosticCodes.BUILTIN_ARGS, `'${written}' ${unread.message}`, at.spanOf(unread.arg.at));
        }
        return;
      }
      case 'declared': {
        const found = at.scope.resolve(resolution.name);
        if (found.kind !== 'found') return; // reported where the name is read
        if (isFunctionSymbol(found.symbol)) {
          this.report(DiagnosticCodes.CALL_NESTED, nestedMessage(written), span);
          return;
        }
        this.report(
          DiagnosticCodes.CALL_NOT_MOVEMENT,
          `'${written}' is ${describeKind[found.symbol.kind]}, not a function — only functions are called`,
          span,
        );
        return;
      }
      case 'unknown': {
        if (at.writeField) return;
        const fix = at.slot !== undefined ? renamedCallFix({ slot: at.slot, call, to: closestFunctionName(written, at.scope) }) : undefined;
        this.reportWithFix({
          code: DiagnosticCodes.FUNCTION_UNKNOWN,
          message: unknownFunctionMessage(written, at.scope, fix?.corrected),
          span,
          ...(fix !== undefined ? { fix: { edits: [fix.edit] } } : {}),
        });
        return;
      }
      default:
        neverAsAny(resolution);
    }
  }

  /** `{ … }.name` — the retired inline block. Its body is still walked, so the
   *  names inside it are checked and the author sees every problem at once. */
  private reportInlineBlockRetired(inline: InlineBlockExpression, scope: Scope): void {
    const blockScope = new Scope('branch', scope);
    this.checkStatementList(inline.body, blockScope);
    this.report(
      DiagnosticCodes.INLINE_BLOCK_RETIRED,
      `reading a block's inner binding by name ('{ … }.${inline.binding}') is retired — a body hands its value back with 'return'. Bind the value directly, or write a closure ('() => { … return ${inline.binding} }') where the body should run later.`,
      inline.span,
    );
  }

  /**
   * `(d: <date>) => { … }` — an anonymous closure. Its body is checked in a
   * CHILD of the enclosing scope (JS closure semantics, which is also the
   * park's capture rule: whatever an `await` park carries, a closure captures),
   * with its parameters bound inside; its `return`s are its own, so the
   * closure's type carries what calling it yields.
   *
   * `valueParamsOnly` is the CALLBACK's extra rule, not the closure's: what a
   * platform sends at fire time is a value, never a record.
   */
  private checkClosure(
    closure: ClosureExpression,
    scope: Scope,
    options: {
      label: string;
      valueParamsOnly?: boolean;
      /** The name the closure is bound to — by which its body may call it. */
      self?: string;
      /**
       * The types the CALLER supplies, by position — a collection op knows
       * what it hands its function. An annotation still wins where one is
       * written (it is the author saying something narrower); an unannotated
       * parameter takes this, and one with neither is refused.
       */
      suppliedParams?: ReadonlyArray<PlaneType>;
    },
  ): { params: ClosureParam[]; returns: ReturnShape; effects: EffectRow } {
    const bodyScope = new Scope('branch', scope);
    this.recordFrame('branch', closure.span, bodyScope);
    const params: ClosureParam[] = [];
    for (const [index, param] of closure.params.entries()) {
      const supplied = options.suppliedParams?.[index];
      const shape: PlaneType = param.type === undefined && supplied !== undefined
        ? this.asShape(supplied)
        : options.valueParamsOnly === true
        ? this.asShape({ fieldType: this.checkCallbackParamType(param.type, param.name, scope) })
        : this.closureParamShape(param, scope, closure, options.self);
      if (param.type === undefined && supplied === undefined) {
        this.reportParamNeedsType(param.name, param.span, options.label);
      }
      params.push({ name: param.name, ...shape });
      const existing = this.declareAuthored(
        bodyScope,
        {
          name: param.name,
          kind: 'param',
          span: param.span,
          ...(shape.posType !== undefined
            ? { posType: shape.posType }
            : {
                bindingPlane: 'scalar' as const,
                ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
              }),
        },
        param.span,
      );
      if (existing) {
        this.report(DiagnosticCodes.DUPLICATE_DECL, `Duplicate parameter '${param.name}'`, param.span);
      }
    }
    // What it SAYS it returns (version 3) is its type, as in TypeScript.
    const declared = closure.returnType !== undefined && since(this.languageVersion, 3)
      ? this.closureParamShape({ name: 'return', type: closure.returnType, span: closure.returnType.span }, scope)
      : undefined;
    const self = options.self !== undefined
      ? this.declareClosureSelf(options.self, closure, params, declared, bodyScope)
      : undefined;
    // The body is its OWN function: what it does belongs to the closure's type,
    // not to whoever wrote it down. Writing a closure has no effects; calling
    // one has the closure's.
    const collector: ReturnCollector = { what: options.label, returns: [] };
    const { value: inferred, row: effects } = this.withEffectFrame(() =>
      this.checkBody(closure.body, bodyScope, collector),
    );
    // Reported once, where it is written: a type-only walk sees the same body.
    if (declared !== undefined && closure.returnType !== undefined) {
      this.checkDeclaredReturn(closure.returnType, collector, scope, closure.span);
    }
    // A self-call needs the type being worked out — unless the body hands
    // nothing back, when there is nothing to declare (TypeScript's `void`).
    const selfCall = self !== undefined ? this.undeclaredSelfCalls.get(self) : undefined;
    if (self !== undefined && selfCall !== undefined && collector.returns.length > 0) {
      this.report(
        DiagnosticCodes.RECURSIVE_RETURN_TYPE,
        recursiveReturnTypeMessage(self.name, [self.name, self.name], `${self.name} = (…): <number> => …`),
        selfCall,
      );
    }
    // A body that hands nothing back gave its own bound self-calls nothing to
    // bind — refused as binding any call that returns nothing is.
    if (self !== undefined && collector.returns.length === 0) {
      for (const use of this.boundSelfCalls.get(self) ?? []) this.reportCallReturnsNothing(use.callee, use.span);
    }
    // A parameter handed back is the caller's record again (as a declared
    // function's is).
    const returns = declared !== undefined
      ? { returns: true, ...declared }
      : inferred.posType !== undefined
      ? { ...inferred, posType: withoutParameter(inferred.posType) }
      : inferred;
    return { params, returns, effects };
  }

  /**
   * A closure bound to a name may call itself by that name, as a TypeScript
   * `const f = (n: number): number => … f(n - 1) …` does (version 3). The name
   * is declared inside its own body — a parameter of the same name shadows it
   * — typed by what the closure declares it returns. A self-call adds nothing
   * to the closure's row: its effects are the body's own, which the row holds.
   *
   * Undeclared, the type a self-call would have is the one being worked out,
   * so the first such call is refused (`MOV_RECURSIVE_RETURN_TYPE`) — when the
   * body returns a value at all.
   */
  private declareClosureSelf(
    name: string,
    closure: ClosureExpression,
    params: ClosureParam[],
    declared: PlaneType | undefined,
    bodyScope: Scope,
  ): ScopeSymbol | undefined {
    if (!since(this.languageVersion, 3) || params.some(param => param.name === name)) return undefined;
    const self: ScopeSymbol = {
      name,
      kind: 'binding',
      span: closure.span,
      posType: closureType(params, declared !== undefined ? { returns: true, ...declared } : UNKNOWN_RETURN, EMPTY_ROW),
      bindingPlane: 'node',
    };
    if (declared === undefined) this.undeclaredSelves.add(self);
    bodyScope.declare(self);
    return self;
  }

  /** Self-names of closures that declared no return type. */
  private readonly undeclaredSelves = new WeakSet<ScopeSymbol>();

  /** Where each such closure first called itself. */
  private readonly undeclaredSelfCalls = new WeakMap<ScopeSymbol, Span>();

  /** Where each such closure's self-calls are bound — refused once its body
   *  turns out to return nothing. */
  private readonly boundSelfCalls = new WeakMap<ScopeSymbol, Array<{ callee: string; span: Span }>>();

  /** A call through a closure's own name, when that closure declared nothing. */
  private noteUndeclaredSelfCall(callee: ScopeSymbol, span: Span): void {
    if (this.undeclaredSelves.has(callee) && !this.undeclaredSelfCalls.has(callee)) {
      this.undeclaredSelfCalls.set(callee, span);
    }
  }

  /** Drops the undefined halves of a shape, so an absent type never reaches a
   *  symbol as a present-but-undefined key. */
  private asShape(shape: PlaneType): PlaneType {
    return {
      ...(shape.posType !== undefined ? { posType: shape.posType } : {}),
      ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
    };
  }

  /** A closure parameter's type — the same two things a movement parameter may
   *  be: a scalar, or an address into a graph in scope. A record parameter
   *  carries what the body needs of it, as a declared function's does: its
   *  cell lives with the closure, so every walk of the body shares it. */
  private closureParamShape(
    param: MovementParam,
    scope: Scope,
    closure?: ClosureExpression,
    self?: string,
  ): PlaneType {
    const written = param.type;
    // No annotation ⇒ nothing written to resolve. The caller decides whether
    // something SUPPLIES the type (a collection op does) or the parameter is
    // simply missing one.
    if (written === undefined) return {};
    const value = this.paramValueType(written, scope, true);
    if (value !== undefined) return value.type !== undefined ? { fieldType: value.type } : {};
    if (isValueTypeRef(written)) return {};
    const graphSymbol = this.resolveName(written.graph, written.span, scope);
    if (graphSymbol === undefined || graphSymbol.kind === 'adapter') return {};
    const posType = this.positionFromTypeRefStrict(graphSymbol, written, written.span);
    if (posType === undefined) return {};
    if (closure === undefined) return { posType };
    let cells = this.closureParamNeeds.get(closure);
    if (cells === undefined) {
      cells = new Map();
      this.closureParamNeeds.set(closure, cells);
    }
    return { posType: asParameter(posType, cells, { fn: self ?? 'the closure', param: param.name }) };
  }

  /** What each closure's body needs of its record parameters — the closure's
   *  `paramNeeds`. */
  private readonly closureParamNeeds = new WeakMap<ClosureExpression, Map<string, FieldsNeed>>();

  /**
   * The symbol a bare-name slot refers to, when that name is bound on the NODE
   * plane — the `btn = a` / `btn: a` shapes. Bare plain names short-circuit
   * `checkExprSlot`'s parse, so the raw spelling is checked first; backtick
   * names only exist parsed, so the bridged expression is the fallback.
   */
  private bareNodeSymbol(
    raw: string,
    parsed: Expression | undefined,
    scope: Scope,
  ): ScopeSymbol | undefined {
    const trimmed = raw.trim();
    const name =
      BARE_IDENT.test(trimmed) && !EXPR_LITERALS.has(trimmed.toUpperCase())
        ? trimmed
        : parsed !== undefined
          ? bareName(parsed)
          : undefined;
    if (name === undefined) return undefined;
    return this.nodePlaneSymbol(name, scope);
  }

  /** The shape a value slot names, when it is a declaration's bare name. */
  private shapeNamed(raw: string, parsed: Expression | undefined, scope: Scope): ScopeSymbol | undefined {
    const trimmed = raw.trim();
    const name = BARE_IDENT.test(trimmed) ? trimmed : parsed !== undefined ? bareName(parsed) : undefined;
    if (name === undefined) return undefined;
    const resolution = scope.resolve(name);
    return resolution.kind === 'found' && resolution.symbol.kind === 'shape' ? resolution.symbol : undefined;
  }

  /** The symbol `name` is bound to, when it is bound on the NODE plane — a
   *  record, rather than a value. */
  private nodePlaneSymbol(name: string, scope: Scope): ScopeSymbol | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    const { symbol } = resolution;
    return symbol.posType !== undefined || symbol.bindingPlane === 'node' ? symbol : undefined;
  }

  /** A value that is many values under one value's type — a walk read for a
   *  field, or a name already bound to one (`ScopeSymbol.plural`) — so the
   *  name it is bound to keeps the fact the type does not carry. */
  private isManyValuedValue(slot: ExprSlot, parsed: Expression | undefined, scope: Scope): boolean {
    if (parsed !== undefined) return isWalkProjection(parsed);
    // A bare name never reaches the parse (`checkExprSlot`).
    const name = slot.raw.trim();
    return BARE_IDENT.test(name) && this.isManyValuedSymbol(name, scope);
  }

  /** Is `name` a value-plane binding of a walk read for a field
   *  (`ScopeSymbol.plural`) — many values, typed as one? Read by a spread. */
  private isManyValuedSymbol(name: string, scope: Scope): boolean {
    const resolution = scope.resolve(name);
    return resolution.kind === 'found'
      && resolution.symbol.plural === true
      && resolution.symbol.bindingPlane === 'scalar';
  }

  /** The order `name`'s records were collected in, when it is bound to a whole
   *  traversal block's return (`ScopeSymbol.plural`) — a collection, not the
   *  one record its position type says. Undefined for every other name. Read
   *  as a value, the name is the list of those records. */
  private pluralOrderOf(name: string, scope: Scope): CollectionOrder | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    const { symbol } = resolution;
    if (symbol.plural !== true || symbol.bindingPlane === 'scalar') return undefined;
    return symbol.collectedOrder ?? 'unknown';
  }

  /**
   * The position `ONLY(<bare traversal>)` / `FIRST(…)` / `LAST(…)` lands on, as a
   * maybe-empty node — undefined for every other expression (which binds a
   * scalar as before). The walk is the ordinary hop walk; the only new fact is
   * WHICH plane the result belongs to, which the aggregate's shape decides:
   * a bare path aggregates POSITIONS (the bridge's sentinel terminal), a
   * property path aggregates values.
   *
   * Walked silently — `checkExprSlot` has already reported everything this walk
   * would say.
   */
  private landedAggregatePosition(
    expr: Expression,
    scope: Scope,
    span: Span,
  ): PositionTypeRef | undefined {
    const path = aggregatedBarePath(expr);
    if (path === undefined) return undefined;
    const rootSymbol =
      path.aliasRoot !== undefined ? scope.resolve(path.aliasRoot) : undefined;
    const start =
      rootSymbol?.kind === 'found' ? this.symbolPositionType(rootSymbol.symbol) : undefined;
    if (start === undefined) return undefined;
    const landed = this.silentTyping(scope, span).walkSteps(start, path.steps);
    return landed !== undefined ? { kind: 'maybeEmpty', of: landed } : undefined;
  }

  /**
   * `lazy <traversal>` — the walk, deferred. There is nothing type-side to
   * defer: this is `checkAwait`'s traversal branch with the wake removed, so
   * the hop chain is walked, its WHERE is typed, an awaitable edge still
   * demands `await` (the walk reports that), and the result is the landed
   * position. Every downstream rule — FIRST over it, `== null`, emptiness as
   * a gate — is then the ordinary traversal rule, because the type is the
   * ordinary traversal's type.
   *
   */
  private checkLazyTraversal(lazy: LazyTraversal, scope: Scope): PositionTypeRef | undefined {
    const head = this.checkPathHead(lazy.head, scope);
    const typing = this.slotTyping(scope, lazy.head.span);
    const landed =
      head.steps && head.rootType !== undefined
        ? typing.walkSteps(head.rootType, head.steps)
        : undefined;
    if (lazy.mapping === undefined) return landed;
    // PER-ITEM synthesis: the tail is a node literal typed in the LANDING's
    // scope, so the hop's alias names what the walk reached and its fields read
    // there. The mapped landing IS the literal's structure — the source's names
    // are gone by construction, which is the whole point (a callee couples to
    // the mapping, never to the source).
    return this.checkNodeLiteral(lazy.mapping, this.landingScope(lazy, head, typing, scope));
  }

  /**
   * The scope a per-item tail is written in: a child of where the traversal was
   * written, carrying the head's hop aliases and nothing else. Exactly the
   * scope a traversal BLOCK gives its body — the tail is that body, written as
   * a position instead of statements — so the alias is in scope inside the tail
   * and nowhere outside it.
   */
  private landingScope(
    lazy: LazyTraversal,
    head: HeadInfo,
    typing: ExpressionTyping,
    scope: Scope,
  ): Scope {
    const landing = new Scope('traversal', scope);
    this.recordFrame('traversal', lazy.mapping?.span ?? lazy.span, landing);
    for (const alias of head.aliases) {
      const aliasType = typing.locals.get(alias);
      this.declareAuthored(
        landing,
        {
          name: alias,
          kind: 'alias',
          span: lazy.head.span,
          ...(aliasType ? { posType: aliasType } : {}),
        },
        lazy.head.span,
      );
    }
    return landing;
  }

  // ── await (asks-as-adapter wake primitive) ──

  /**
   * `await <traversal>` / `await sleep(<duration>)` — the wake primitive
   * (asks-as-adapter §A, P18). A traversal await must target an AWAITABLE edge
   * (else MOV_NOT_AWAITABLE); a bare traversal of one is the inverse error
   * (MOV_AWAIT_REQUIRED, fired in the walk), and its WHERE must be pure
   * (MOV_AWAIT_IMPURE_WHERE, also in the walk). The bound result types as the
   * landed node(s) — `r.answer` reads a field, `r-[x:E]->` traverses — and an
   * empty resolution binds an empty match (downstream runs zero times; the
   * `T | absent` typing that difference wants is chunk C). `await sleep(…)`
   * binds `true` once woken (typed boolean since language version 3).
   */
  private checkAwait(
    awaitExpr: AwaitExpression,
    scope: Scope,
    binding: string | undefined,
  ): { posType?: PositionTypeRef; fieldType?: FieldType } {
    const source = awaitExpr.source;
    // Every spelling of `await` parks the run. Where it parks is an address in
    // the body, which is why `suspend` is a flag and not a set.
    this.effects?.flag('suspend');
    /** Filled in below, once the source is known well enough to describe. */
    const record = (recorded: RecordedAwaitSource): void => {
      this.recordNode({
        kind: 'await',
        span: awaitExpr.span,
        scope,
        ...(binding !== undefined ? { binding } : {}),
        source: recorded,
      });
    };
    if (source.kind === 'sleep') {
      record({ kind: 'sleep', duration: source.duration.raw });
      if (!isValidDuration(source.duration.raw)) {
        this.report(
          DiagnosticCodes.AWAIT_BAD_DURATION,
          `'${source.duration.raw}' is not a valid duration — use unit-suffixed literals like 4h, 2d, 90m, 1h30m`,
          source.duration.span,
        );
      }
      // A woken sleep binds `true` (the engine's contract), so v3 types it; v1
      // and v2 left it untyped and a comparison against it is unchanged there.
      return since(this.languageVersion, 3) ? { fieldType: 'boolean' } : {};
    }
    if (source.kind === 'until') {
      record({ kind: 'until', ...(source.every !== undefined ? { every: source.every.raw } : {}) });
      return this.checkUntil(source, scope);
    }
    // The combinators (core calculus v2 R5): `race`/`parallel` compose the
    // wait, and the `await` is what parks. The value is the positional receipt.
    if (source.kind === 'combinator') {
      const receipt = this.checkCombinator(source.combinator, scope, binding);
      return receipt !== undefined ? { fieldType: receipt } : {};
    }
    // The bare-walk spelling is retired: the park IS the FIRST read, parked,
    // and the language spells it that way. Refuse with the rewrite, then keep
    // typing as the FIRST form would — one error, no cascade.
    if (source.kind === 'traversal') {
      this.report(
        DiagnosticCodes.AWAIT_BARE_WALK,
        `'await ${rawPath(source.head)}' — a bare walk under 'await' is retired. The park is the FIRST read, parked: write 'await FIRST(${rawPath(source.head)})'`,
        source.span,
      );
    }
    // `await` parks ON the record it waits at: the run stops, and what resumes
    // it has to find that record again by name. An expression root has no name
    // to resume against, so the walk is fine and the park is not — refused
    // here, with the repair, rather than left to fail on resume.
    if (source.head.root?.kind === 'expression') {
      this.report(
        DiagnosticCodes.HEAD_NEEDS_A_NAME,
        `'await' parks on the record it waits at, and a parked run finds that record again by NAME — so this one is bound first: 'waiting = ${source.head.root.expr.raw}', then 'await FIRST(waiting${source.head.hopsRaw})'.`,
        source.head.span,
      );
    }
    const head = this.checkPathHead(source.head, scope);
    if (!head.steps || head.rootType === undefined) {
      record({
        kind: 'traversal',
        ...(pathRootName(source.head) !== undefined ? { root: pathRootName(source.head) } : {}),
      });
      return {};
    }
    const typing = this.slotTyping(scope, source.head.span);
    const landed = typing.walkSteps(head.rootType, head.steps, { awaited: true });
    const finalEdge = typing.lastEdgeSchema;
    const lastStep = head.steps[head.steps.length - 1];
    record({
      kind: 'traversal',
      ...(pathRootName(source.head) !== undefined ? { root: pathRootName(source.head) } : {}),
      ...(lastStep?.type === 'edge' ? { edge: lastStep.edgeTypeId } : {}),
      // An undescribed edge claims nothing — the flags stay ABSENT rather than
      // defaulting to false, so "we didn't look" reads differently from "no".
      ...(finalEdge !== undefined
        ? { awaitable: finalEdge.awaitable === true, resolvesEmpty: finalEdge.resolvesEmpty === true }
        : {}),
    });
    // Only error when the final edge is KNOWN and non-awaitable; an undescribed
    // or untyped edge stays silent (the checker's honesty rule — unknown is not
    // a claim).
    if (finalEdge !== undefined && finalEdge.awaitable !== true) {
      this.report(
        DiagnosticCodes.AWAIT_NOT_AWAITABLE,
        `'FIRST(${rawPath(source.head)})' can't be awaited — 'await' waits on an edge whose resolution resumes the run (an ask's Response). This is an ordinary edge; read it live, without 'await'.`,
        source.head.span,
      );
    } else if (finalEdge?.awaitable === true && finalEdge.watchable !== true) {
      // A bare `await FIRST(…)` states no cadence, which is only honest where
      // the source WAKES the run. Where it doesn't, the cadence is the author's
      // and the language has one spelling for it.
      const edgeName = lastStep?.type === 'edge' ? lastStep.edgeTypeId : undefined;
      this.report(
        DiagnosticCodes.AWAIT_NEEDS_CADENCE,
        `${edgeName !== undefined ? `'-[:${edgeName}]->'` : 'This edge'} resolves, but nothing tells the run when — this source sends no event, so a bare 'await' would wait forever. Say how often to look: \`await until(() => { return EXISTS(${rawPath(source.head)}) }, every: 15m)\`.`,
        source.head.span,
      );
    }
    // F19/F20: an edge that declares `resolvesEmpty` (an ask `Response` a cancel
    // can settle empty) lands a MAYBE-EMPTY node — its field reads type
    // `T | absent`. A traversal-as-gate INTO it (`r-[x:E]-> { … }`) discharges
    // that (the block runs zero times when empty). Slack `Replies` (a reply
    // always has content) does not declare it, so its landing is plain.
    if (landed !== undefined && finalEdge?.resolvesEmpty === true) {
      return { posType: { kind: 'maybeEmpty', of: landed } };
    }
    return landed !== undefined ? { posType: landed } : {};
  }

  /**
   * `await until(<condition>, every: <duration>)` (F12) — the recurring-clock
   * wake source. The condition is evaluated each tick; the await resolves when it
   * holds, binding the condition's value. Checks: the cadence is a valid duration
   * ≥ 1m (floor); the condition is READ-ONLY (an inline-block body may only read /
   * `refresh` — a write/ask/await/race inside is MOV_AWAIT_IMPURE_CONDITION).
   * Returns the condition's type so the binding types correctly.
   */
  private checkUntil(
    source: Extract<AwaitSource, { kind: 'until' }>,
    scope: Scope,
  ): ReturnShape {
    if (source.every !== undefined) {
      if (!isValidDuration(source.every.raw)) {
        this.report(
          DiagnosticCodes.AWAIT_BAD_DURATION,
          `'${source.every.raw}' is not a valid cadence — use unit-suffixed literals like 5m, 1h, 2d`,
          source.every.span,
        );
      } else if (durationToMs(source.every.raw) < UNTIL_CADENCE_FLOOR_MS) {
        this.report(
          DiagnosticCodes.UNTIL_CADENCE_TOO_SHORT,
          `'${source.every.raw}' re-checks faster than the 1m floor — an 'until' condition is re-evaluated on a timer, so its cadence must be at least 1m. Use a longer interval (5m, 1h).`,
          source.every.span,
        );
      }
    }
    const conditionSpan =
      source.condition.kind === 'expr' ? source.condition.expr.span : source.condition.closure.span;
    const outer = this.polledWatchableEdges;
    this.polledWatchableEdges = new Set();
    try {
      return this.checkUntilCondition(source, scope);
    } finally {
      const watchable = [...this.polledWatchableEdges];
      this.polledWatchableEdges = outer;
      if (watchable.length > 0) {
        // The rewrite is the AUTHOR's — an adapter growing webhooks must not
        // quietly change when a saved movement wakes up.
        this.reportWarning(
          DiagnosticCodes.UNTIL_EDGE_WATCHABLE,
          `${watchable.map(edge => `'-[:${edge}]->'`).join(', ')} now arrives as it happens, so this doesn't have to be checked on a timer — 'await FIRST(…)' on it waits without polling.`,
          conditionSpan,
        );
      }
    }
  }

  /** The condition itself: a bound closure, a plain boolean expression, or a
   *  closure written inline. Split out so the watchable-edge nudge can bracket
   *  all three from one place. */
  private checkUntilCondition(
    source: Extract<AwaitSource, { kind: 'until' }>,
    scope: Scope,
  ): ReturnShape {
    if (source.condition.kind === 'expr') {
      // A NAMED closure is the same condition, bound earlier: what it returns
      // is what the tick tests. Anything else is the boolean expression form —
      // the closure with its ceremony elided.
      const named = this.bareNodeSymbol(source.condition.expr.raw, undefined, scope);
      if (named?.posType?.kind === 'closure') {
        this.checkExprSlot(source.condition.expr, scope);
        // The clock CALLS this condition, so its effects are the movement's —
        // naming it earlier changed where it was written, not what it does.
        this.effects?.absorb(named.posType.effects);
        return named.posType.returns;
      }
      const { valueType } = this.checkExprSlot(source.condition.expr, scope);
      return { returns: true, ...(valueType !== undefined ? { fieldType: valueType } : {}) };
    }
    // A CLOSURE condition: an ordinary closure, plus the two things being a
    // condition adds — its body must be read-only (it runs every tick) and it
    // must take no parameters (nothing supplies them; the clock just calls it).
    const closure = source.condition.closure;
    if (closure.params.length > 0) {
      this.report(
        DiagnosticCodes.AWAIT_IMPURE_CONDITION,
        `an 'until' condition is called by the clock, so nothing can supply '${closure.params[0].name}' — write it with no parameters: 'until(() => { … }, every: …)'`,
        closure.params[0].span,
      );
    }
    const impure = this.checkUntilPurity(closure.body);
    const condition = this.checkClosure(closure, scope, { label: "this 'until' condition" });
    this.effects?.absorb(condition.effects);
    // A wait written in the condition is already refused as impure; one reached
    // through a function it calls (`return check()`) is caught here.
    if (condition.effects.suspend && !impure) {
      this.refuseUnresumableWait("this 'until' condition", closure.span);
    }
    return condition.returns;
  }

  /**
   * An `await until(…)` condition is re-evaluated on a timer, so its inline-block
   * body must be READ-ONLY (extends the MOV_AWAIT_IMPURE_WHERE family). Allowed:
   * value reads (`ok = …`), `refresh` (a read that moves a snapshot to now), and
   * `if` over the same (recursed). Refused: any effect — a write, an ask, a
   * nested await/race, a link/unlink/delete. Each offending statement is flagged
   * where it sits. Answers whether it flagged anything.
   */
  private checkUntilPurity(body: Statement[]): boolean {
    let impure = false;
    for (const statement of body) {
      switch (statement.kind) {
        case 'refresh':
          break;
        case 'return':
          // Handing the answer back IS the condition; what it hands back is
          // checked as an ordinary value.
          break;
        case 'assign':
          // A read binding (`ok = expr`) or a nested inline block is fine; an
          // effectful RValue is not.
          if (statement.value.kind !== 'expr' && statement.value.kind !== 'inlineBlock') {
            this.reportImpureCondition(statement.value.kind, statement.span);
            impure = true;
          }
          break;
        case 'if':
          for (const arm of statement.arms) impure = this.checkUntilPurity(arm.body) || impure;
          if (statement.elseArm) impure = this.checkUntilPurity(statement.elseArm.body) || impure;
          break;
        default:
          this.reportImpureCondition(statement.kind, statement.span);
          impure = true;
      }
    }
    return impure;
  }

  /**
   * A wait where the run cannot come back to it (`WAIT_NOT_RESUMABLE`). Before
   * language version 3 such a program was accepted and failed when it parked;
   * the refusal is version 3's, so a saved movement never sees it.
   */
  private refuseUnresumableWait(where: string, span: Span): void {
    if (before(this.languageVersion, 3)) return;
    this.report(
      DiagnosticCodes.WAIT_NOT_RESUMABLE,
      `${where} may wait ('await', or a call to a function that awaits), and a run cannot be resumed there — ` +
        "it would park and never come back. Do the waiting in the movement itself, before or after this, " +
        "and keep the callback body or condition to work that finishes without waiting.",
      span,
    );
  }

  private reportImpureCondition(what: string, span: Span): void {
    this.report(
      DiagnosticCodes.AWAIT_IMPURE_CONDITION,
      `an 'until' condition is re-evaluated on a timer, so it must be read-only — a '${what}' here would act every tick. Keep the condition to reads and 'refresh'; do the effect after the await resolves.`,
      span,
    );
  }

  // ── refresh (asks-as-adapter F5) ──

  /**
   * `refresh <handle>` — re-fetch the record behind a STABLE handle, moving its
   * field snapshot to now. Refresh needs a re-fetchable record id, so the head
   * must be a write handle or a traversed record (`handle` / `position` /
   * `union`). Refusing (MOV_REFRESH_UNSTABLE): the EVENT payload (a movement
   * `param` — inline event data with no stored record to re-read) and an
   * EXTRACTED node (`extract` — synthesized, not stored). A graph root / receipt
   * / block-meta is not a record either, nor is a value. A record whose system
   * describes nothing stays silent (the honesty rule); a binding that says
   * nothing at all is an internal error (`recordOfName`). The since-deleted
   * case is a RUN error, not an author-time one (F22).
   */
  private checkRefresh(statement: RefreshStatement, scope: Scope): void {
    this.recordNode({
      kind: 'refresh',
      span: statement.span,
      scope,
      subject: statement.name,
    });
    // `refresh` re-FETCHES the record behind a handle — it moves a snapshot to
    // now and changes nothing at the source, so it rows as a read. (The engine
    // resolves its adapter with role 'source', and an `until` condition, which
    // must be read-only, admits it.)
    this.noteNamedEffect('read', statement.name, scope);
    const resolution = scope.resolve(statement.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(statement.name, statement.nameSpan, resolution);
      return;
    }
    const symbol = resolution.symbol;
    if (symbol.kind === 'param') {
      this.report(
        DiagnosticCodes.REFRESH_UNSTABLE,
        `'${statement.name}' is the event payload — 'refresh' re-fetches a stored record by its id, and the event has none. Refresh a write handle or a traversed record instead.`,
        statement.nameSpan,
      );
      return;
    }
    const record = this.recordOfName(symbol, statement.name, statement.nameSpan);
    if (record?.kind === 'value') {
      this.report(
        DiagnosticCodes.REFRESH_UNSTABLE,
        `'${statement.name}' is ${record.what} — 'refresh' re-fetches a stored record by its id. Refresh a write handle or a traversed record instead.`,
        statement.nameSpan,
      );
      return;
    }
    // A record whose system describes nothing: unknown never errors.
    if (record?.kind !== 'record') return;
    const posType = record.type;
    if (posType.kind === 'handle' || posType.kind === 'position' || posType.kind === 'union') {
      return; // a re-fetchable record
    }
    const what =
      posType.kind === 'extract'
        ? 'an extracted node — synthesized during extraction, not a stored record'
        : `${describePosition(posType)} — not a re-fetchable record`;
    this.report(
      DiagnosticCodes.REFRESH_UNSTABLE,
      `'${statement.name}' is ${what}. 'refresh' re-fetches a stored record by its id — refresh a write handle or a traversed record instead.`,
      statement.nameSpan,
    );
  }

  // ── the collection ops (core calculus v2, wave 4b) ──

  /** A parameter with no type, where nothing supplies one. */
  private reportParamNeedsType(name: string, span: Span, what: string): void {
    this.report(
      DiagnosticCodes.PARAM_NEEDS_TYPE,
      `'${name}' needs a type — ${what} declares what it accepts, so a caller can be checked against it: write '${name}: <text>' (or whatever it takes). A parameter goes untyped only where the caller supplies the type, which is the function a collection op is given.`,
      span,
    );
  }

  /**
   * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)`
   * / `KEYBY(xs, key)` — iteration over a VALUE collection.
   *
   * The function is called once per element, so the element's type is the
   * parameter's (TypeScript's contextual typing, and the reason the annotation
   * is optional there); its row folds in, exactly as a combinator arm's does,
   * because what a movement causes to run is what it does.
   *
   * Ordering (wave 4a) propagates rather than being decided here: `MAP` and
   * `FILTER` hand back a list ordered exactly as far as the input was, because
   * neither reorders anything. `REDUCE` is order-SENSITIVE — it reads the
   * elements one after another and the answer changes when they are permuted —
   * so it is refused over a collection whose order means nothing, the same
   * refusal `JOIN` gets. `GROUPBY`'s groups each keep the source's ordering;
   * the dict around them has none, because a dict is looked up, not folded.
   */
  private checkCollectionOp(expr: CollectionOpExpression, scope: Scope): FieldType | undefined {
    const spelling = COLLECTION_OP_SPELLING[expr.op];
    const source = this.checkExprSlot(expr.source, scope);
    const init = expr.init !== undefined ? this.checkExprSlot(expr.init, scope) : undefined;
    if (expr.config !== undefined) this.checkCollectionConfig(expr.config, spelling);
    // A name bound on the NODE plane to ONE record is not a collection — the
    // one mistake worth naming. A block's returned records are many, and a
    // collection everywhere (`COUNT`, `FIRST`, a block head, and here).
    const asPosition = this.bareNodeSymbol(expr.source.raw, source.parsed, scope);
    if (asPosition !== undefined && asPosition.plural !== true) {
      this.reportNotACollection(spelling, describeKind[asPosition.kind], expr.source.span);
      return undefined;
    }
    const element = this.collectionElementType(source.valueType, spelling, expr.source.span);
    const ordering = collectionOrderOf(source.valueType);

    // The order-sensitive one, held to the same rule every order-sensitive fold
    // is held to.
    if (expr.op === 'reduce' && ordering === 'unordered') {
      this.report(
        DiagnosticCodes.FOLD_NEEDS_ORDER,
        `'REDUCE' reads the members one after another, so the answer depends on the order they are in — and nothing has given this collection one. Order the traversal it came from ('ORDER BY'), or fold it with something that answers the same over any order ('COUNT', 'SUM', 'MIN', 'MAX', 'ONLY').`,
        expr.source.span,
      );
    }

    const carried = expr.op === 'reduce' ? (init?.valueType) : undefined;
    const shape = this.checkCollectionFunction(expr, spelling, scope, element, carried);
    // What the function hands back, on whichever plane it handed it back on. A
    // record is a value type, so a closure that returns one (`(p) => { return
    // extract … }`, `(t) => { return t }`) answers in the same currency as one
    // that returns text — there is no second type for "a collection of
    // records" and no second rule for what an op does with one.
    const returned = valueOfReturn(shape);

    switch (expr.op) {
      case 'map':
        return returned !== undefined ? listOf(returned, ordering) : undefined;
      case 'filter':
        // What survives is what went in, in the order it was in.
        return element !== undefined ? listOf(element, ordering) : undefined;
      case 'reduce':
        // The carried value's type, which is the function's return where it
        // typed and the starting value's where it did not.
        return returned ?? carried;
      case 'groupby':
        this.requireDictKeyIn(scope, expr.fn, returned, `filed under by '${spelling}'`);
        return element !== undefined
          ? { kind: 'dict', of: listOf(element, ordering) }
          : undefined;
      case 'keyby':
        this.requireDictKeyIn(scope, expr.fn, returned, `filed under by '${spelling}'`);
        return element !== undefined ? { kind: 'dict', of: element } : undefined;
    }
  }

  /** A settings record is read, not typed: every value in it is written down,
   *  so the engine's own reader settles it here, once, the same way. */
  private checkCollectionConfig(config: ExprSlot, spelling: string): void {
    let parsed: Expression;
    try {
      parsed = expressionOfSlot(config);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(e.code ?? DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(config, e.pos));
      return;
    }
    const reading = readCollectionConfig(parsed, spelling);
    if (reading.ok) return;
    for (const problem of reading.problems) {
      this.report(DiagnosticCodes.COLLECTION_OP_CONFIG, problem, config.span);
    }
  }

  /** What one member of the collection an op reads is. */
  private collectionElementType(
    source: FieldType | undefined,
    spelling: string,
    span: Span,
  ): FieldType | undefined {
    if (source === undefined) return undefined; // unknown stays silent
    const element = collectionElementOf(source);
    if (element === undefined) this.reportNotACollection(spelling, describeFieldType(source), span);
    return element;
  }

  private reportNotACollection(spelling: string, what: string, span: Span): void {
    this.report(
      DiagnosticCodes.COLLECTION_OP_NOT_A_COLLECTION,
      `'${spelling}' reads a collection, and this is ${what} — one thing, not several. A hop's landings are a collection ('${spelling}(r-[:edge]->, …)'), and so is a list, a block's returns or another op's answer; walk one record in a traversal-headed block instead ('r-[x:edge]-> { … }').`,
      span,
    );
  }

  /**
   * The function a collection op is given: checked as an arm (a closure in
   * place, or a name bound to one), but CALLED WITH arguments — so its
   * parameters take their types from the collection where the author left them
   * unwritten.
   */
  private checkCollectionFunction(
    expr: CollectionOpExpression,
    spelling: string,
    scope: Scope,
    element: FieldType | undefined,
    carried: FieldType | undefined,
  ): ReturnShape {
    const supplied = expr.op === 'reduce'
      ? [{ fieldType: carried }, { fieldType: element }]
      : [{ fieldType: element }];
    const arity = supplied.length;
    if (expr.fn.kind === 'closure') {
      const params = expr.fn.closure.params;
      if (params.length !== arity) {
        this.reportArmArity(spelling, arity, params.length, params[0]?.name, expr.fn.span);
      }
      const { params: bound, returns, effects } = this.checkClosure(expr.fn.closure, scope, {
        label: `the function for '${spelling}'`,
        suppliedParams: supplied,
      });
      this.checkMembersFieldsInHand(spelling, `the function for '${spelling}'`, bound, supplied, expr.fn.span);
      this.absorbCollectionRow(effects, spelling, expr.fn.span);
      if (expr.op === 'map' && !returns.returns) return MAP_SLOT_ABSENT;
      this.requireCollectionReturn(returns, spelling, expr.fn.span);
      return returns;
    }
    const named = this.checkArm(expr.fn, spelling, scope, undefined, arity);
    const resolved = scope.resolve(expr.fn.name);
    const symbol = resolved.kind === 'found' ? resolved.symbol : undefined;
    // What a function's body needs of each record parameter is learned on the
    // inference walk, which a declared return type otherwise skips.
    if (symbol?.movement !== undefined && symbol.movement.returnType === undefined) this.inferMovement(symbol);
    const namedParams = symbol?.posType?.kind === 'closure'
      ? symbol.posType.params
      : symbol?.kind === 'movement'
      ? (this.movementParams(symbol) ?? []).map(param => ({ name: param.name, ...param.type }))
      : [];
    this.checkMembersFieldsInHand(spelling, `'${expr.fn.name}'`, namedParams, supplied, expr.fn.span);
    if (expr.op === 'map' && !named.returns) return MAP_SLOT_ABSENT;
    this.requireCollectionReturn(named, spelling, expr.fn.span);
    return named;
  }

  /**
   * The members a collection op binds to its function's parameters, against
   * what the function's body needs of each record parameter — the call-site
   * check (`checkArgFieldsInHand`) where the op, not the author, makes the
   * call.
   */
  private checkMembersFieldsInHand(
    spelling: string,
    fn: string,
    params: ReadonlyArray<{ name: string; posType?: PositionTypeRef }>,
    supplied: ReadonlyArray<PlaneType>,
    span: Span,
  ): void {
    for (const [index, param] of params.entries()) {
      const need = parameterNeedOf(param.posType);
      const member = recordIn(supplied[index]?.fieldType)?.position;
      if (need === undefined || member === undefined) continue;
      const shortfall = this.fieldsInHandShortfall(
        need,
        member,
        `hands it to ${fn} as '${need.param}' (line ${span.start.line})`,
      );
      if (shortfall === undefined) continue;
      this.report(
        DiagnosticCodes.CALL_ARG_OPAQUE_RECORD,
        `${fn} needs every field of ${shortfall.what} in hand — its body ${shortfall.why} — and '${spelling}' hands it each member of the collection, ${describePosition(member)}, ${shortfall.whose}. Copy the fields it needs into records the program holds first ('MAP(…, (r) => { return node { name: r.name, … } })'), or have the function read the fields it uses one by one`,
        span,
      );
    }
  }

  /** A collection op runs its function to completion, once per member. */
  private absorbCollectionRow(row: EffectRow, spelling: string, span: Span): void {
    if (row.suspend && before(this.languageVersion, 3)) {
      this.report(
        DiagnosticCodes.COLLECTION_OP_SUSPENDS,
        `the function for '${spelling}' waits ('await'), and '${spelling}' runs it over every member to build one value — there is no answer for what the collection is while it waits. Wait outside it: walk the positions in a traversal-headed block, or run the waits together with 'await parallel([…])'.`,
        span,
      );
    }
    this.effects?.absorb(row);
  }

  private requireCollectionReturn(shape: ReturnShape, spelling: string, span: Span): void {
    if (shape.returns) return;
    this.report(
      DiagnosticCodes.COLLECTION_OP_RETURNS_NOTHING,
      `the function for '${spelling}' hands nothing back, so there is nothing for '${spelling}' to do with each member — 'return' the answer for one.`,
      span,
    );
  }

  /**
   * A written field's value against what the field holds. One site for both
   * write forms, so the two cannot drift.
   *
   * A RECORD gets its own words. A record is a place in a graph, not data —
   * there is no spelling of one to put in a field — and the repair is one of
   * exactly two things: write a field OFF the record, or join the two records
   * with a link. Saying "produces slack.message" and leaving the author to
   * infer that is the silence this checker exists to refuse.
   */
  private reportFieldValueType(
    fieldName: string,
    subject: string,
    targetType: FieldType | undefined,
    valueType: FieldType | undefined,
    span: Span,
    options?: { relationship?: boolean; declared?: boolean },
  ): void {
    if (targetType === undefined || valueType === undefined) return;
    if (isRecordType(valueType) && options?.relationship === true) return;
    // A field a node DECLARATION types holds what it says, as a parameter
    // typed on the declaration does (`surfaceMisfit`): the program wrote the
    // type, so there is no system on the far side to render a number or a
    // yes/no into text. A system's field keeps the lenient write rule.
    if (options?.declared === true && valueType !== 'absent' && !isRecordType(valueType)) {
      if (fieldAssignable(valueType, targetType)) return;
      this.report(
        DiagnosticCodes.WRITE_FIELD_TYPE,
        `'${fieldName}' on ${subject} is ${describeFieldType(targetType)}, and this is ${describeFieldType(valueType)}${textRepair(valueType, targetType)}`,
        span,
      );
      return;
    }
    if (fieldTypeCompatible(valueType, targetType)) return;
    if (isRecordType(valueType)) {
      this.report(
        DiagnosticCodes.WRITE_FIELD_TYPE,
        `'${fieldName}' on ${subject} is ${describeFieldType(targetType)}, and this is ${describeFieldType(valueType)} — a record, not a value. Write a field off it ('${fieldName}: r.\`Name\`'), or join the two records with a link ('link … -[:edge]-> r').`,
        span,
      );
      return;
    }
    this.report(
      DiagnosticCodes.WRITE_FIELD_TYPE,
      `'${fieldName}' on ${subject} is ${describeFieldType(targetType)}, but this expression produces ${describeFieldType(valueType)}`,
      span,
    );
  }

  /** A key function's answer, held to the dict key rule. */
  private requireDictKeyIn(
    scope: Scope,
    fn: ArmExpression,
    key: FieldType | undefined,
    where: string,
  ): void {
    this.slotTyping(scope, fn.span).requireDictKey(key, where);
  }

  /**
   * `MEMBERS(<Thesis>)` — a closed type's values, as an ORDERED list: the order
   * they were declared in, which is a fact about the type and is exactly why
   * this exists (sections in a report come from the declaration, not from a
   * hand-kept list beside it).
   *
   * An OPEN known-values set is refused: its options are what could be listed,
   * not all there are, so there is no complete membership to walk.
   */
  private checkMembers(expr: MembersExpression, scope: Scope): FieldType | undefined {
    const type = this.resolveNamedType(expr.type, expr.typeSpan, scope);
    if (type === undefined) return undefined;
    const named = stripAbsent(type);
    if (!isEnumType(named)) {
      this.report(
        DiagnosticCodes.MEMBERS_NOT_CLOSED,
        `'MEMBERS' lists the values of a closed set, and '${expr.type}' is ${describeFieldType(named)} — there is nothing to list. Declare the set ('type ${expr.type} = <"A" | "B">'), or name a field whose options the system holds.`,
        expr.typeSpan,
      );
      return undefined;
    }
    if (named.open !== undefined) {
      this.report(
        DiagnosticCodes.MEMBERS_NOT_CLOSED,
        `'${expr.type}' is a known-values field: those options are the ones we could read, and other values are legal there too — so there is no complete list of them to walk. Declare the set you mean ('type Thesis = <"A" | "B">') and iterate that.`,
        expr.typeSpan,
      );
      return undefined;
    }
    // Ordered by construction: declaration order is the whole point.
    return { kind: 'list', of: named };
  }

  // ── the concurrency combinators (core calculus v2 R5) ──

  /** A combinator composes a wait; `await` is what parks. */
  private reportCombinatorNeedsAwait(expr: CombinatorExpression): void {
    this.report(
      DiagnosticCodes.COMBINATOR_NEEDS_AWAIT,
      `'${expr.kind}([…])' does not park by itself — it composes a wait, and 'await' is what parks: write 'await ${expr.kind}([…])'`,
      expr.span,
    );
  }

  /**
   * `await race([…])` / `await parallel([…])` — and the retired unawaited
   * spellings, which type identically for recovery.
   *
   * The arms are FUNCTION values and the combinator calls them, so an arm's
   * effects are this movement's (the callback-folding rule: what a movement
   * causes to run is what it does) and a combinator always adds `suspend`.
   *
   * The value is POSITIONAL — one slot per arm, in the order written:
   * - `parallel` joins everything, so each slot holds what its arm returned.
   * - `race` settles on the first arm to settle, so each slot is `T | null`;
   *   an arm that hands nothing back (a bare `sleep`) is an always-null slot,
   *   which is a different fact from "we could not type this arm" and typed
   *   differently (`absent` vs an untyped slot).
   *
   * Literal arms are a fixed, written-down set, so the receipt is a TUPLE and a
   * literal-index read types exactly. Arms built at run time are same-typed by
   * construction but nothing here can see their type — the receipt is untyped
   * and the row says the row is a lower bound.
   */
  private checkCombinator(
    expr: CombinatorExpression,
    scope: Scope,
    binding: string | undefined,
  ): FieldType | undefined {
    const recorded = this.recordNode<RecordedCombinator>({
      kind: 'combinator',
      combinator: expr.kind,
      span: expr.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      arms: [],
    });
    // Running arms concurrently is still running them: the combinator waits,
    // so it parks. Where it parks is an address in the body, which is why
    // `suspend` is a flag.
    this.effects?.flag('suspend');

    if (expr.arms.kind === 'dynamic') {
      this.checkExprSlot(expr.arms.expr, scope);
      // A collection built at run time holds functions, and a function is not a
      // value type here — so what its arms return cannot be seen from the
      // collection. Untyped, and the row says so; claiming a shape would be the
      // lie this checker never tells.
      this.effects?.markPartial();
      return undefined;
    }

    const slots = expr.arms.arms.map(arm => this.checkArm(arm, expr.kind, scope, recorded));
    return {
      kind: 'tuple',
      of: slots.map(slot => {
        // An arm that hands nothing back is an always-null slot under BOTH
        // combinators — `parallel` introduces no nulls, but it cannot invent a
        // value the arm never produced.
        if (!slot.returns) return 'absent';
        if (slot.fieldType === undefined) return null;
        return (expr.kind === 'race' ? maybeAbsent(slot.fieldType) : slot.fieldType) ?? null;
      }),
    };
  }

  /**
   * One arm: a closure written in place, or the name of a function bound
   * earlier. Either way the combinator CALLS it, so the arm's row folds into
   * this movement's and its return shape becomes the slot.
   *
   * An arm that returns a record POSITION types its slot as unknown: a tuple
   * joins the VALUE sorts, and there is no honest slot type for a position.
   * The run still carries it; the checker simply says nothing about it.
   */
  private checkArm(
    arm: ArmExpression,
    kind: string,
    scope: Scope,
    recorded: RecordedCombinator | undefined,
    /** How many arguments the caller supplies. A combinator supplies none —
     *  there is no caller to take them from — and a collection op supplies the
     *  member (and, for `REDUCE`, the value carried so far). */
    expectedArity = 0,
  ): ReturnShape {
    if (arm.kind === 'closure') {
      const armScope = new Scope('branch', scope);
      const { params, returns, effects } = this.checkClosure(arm.closure, scope, {
        label: `an arm of '${kind}'`,
      });
      recorded?.arms.push({ span: arm.span, ...(armScope ? { scope: armScope } : {}) });
      if (params.length !== expectedArity) {
        this.reportArmArity(kind, expectedArity, params.length, params[0]?.name, arm.span);
      }
      this.effects?.absorb(effects);
      return returns;
    }

    recorded?.arms.push({ span: arm.span });
    const resolution = scope.resolve(arm.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(arm.name, arm.span, resolution);
      this.effects?.markPartial();
      return UNKNOWN_RETURN;
    }
    const symbol = resolution.symbol;
    if (symbol.kind === 'movement') {
      if (symbol.arity !== undefined && symbol.arity !== expectedArity) {
        this.reportArmArity(
          kind,
          expectedArity,
          symbol.arity,
          this.movementParams(symbol)?.keys().next().value,
          arm.span,
        );
      }
      this.effects?.absorb(this.movementEffects(symbol));
      return this.movementReturnType(symbol);
    }
    if (symbol.posType?.kind === 'closure') {
      const closure = symbol.posType;
      if (closure.params.length !== expectedArity) {
        this.reportArmArity(
          kind,
          expectedArity,
          closure.params.length,
          closure.params[0]?.name,
          arm.span,
        );
      }
      this.effects?.absorb(closure.effects);
      return closure.returns;
    }
    if (symbol.kind === 'fileImport') {
      // A file import may be a movement — M3 resolves it; give it the benefit
      // of the doubt, exactly as a call site does.
      this.effects?.markPartial();
      return UNKNOWN_RETURN;
    }
    this.effects?.markPartial();
    this.report(
      DiagnosticCodes.COMBINATOR_ARM_NOT_FUNCTION,
      `'${arm.name}' is ${describeKind[symbol.kind]}, and '${kind}' RUNS its arms — an arm has to be a function. Name a movement, or write the work as a closure: \`() => { … }\`.`,
      arm.span,
    );
    return UNKNOWN_RETURN;
  }

  /** The function's parameters and what the caller supplies disagree. A caller
   *  that supplies NOTHING is the combinators' case and gets their message —
   *  a parameter there could only ever arrive null. */
  private reportArmArity(
    kind: string,
    expected: number,
    got: number,
    param: string | undefined,
    span: Span,
  ): void {
    if (expected === 0) {
      this.report(
        DiagnosticCodes.COMBINATOR_ARM_TAKES_NOTHING,
        `'${kind}' calls its arms with nothing, so ${param !== undefined ? `'${param}'` : 'a parameter'} could only ever arrive null. Take no parameters — a closure already sees everything in scope where it is written.`,
        span,
      );
      return;
    }
    this.report(
      DiagnosticCodes.COLLECTION_OP_ARITY,
      expected === 1
        ? `'${kind}' calls its function with one member at a time, and this one takes ${got}: write '(member) => { … }'`
        : `'${kind}' calls its function with two things — the value carried so far and the next member — and this one takes ${got}: write '(carried, member) => { … }'`,
      span,
    );
  }

  // ── callback (the deferred, addressable invocation) ──

  /**
   * `callback(<subject>)` / `callback(<subject>, { once, ttl })` — mints a
   * deferred invocation and types the binding it yields.
   *
   * The binding is a CHECKER-LOCAL node (`kind: 'local'`): `.id` / `.url`
   * reads, plus a `Called` edge whose landing carries `At` and one field per
   * FIRE-TIME parameter — derived here, at the construction site, from the
   * subject's own signature. Nothing is grafted and nothing is looked up: a
   * callback belongs to no system.
   *
   * The body is checked in a CHILD of the enclosing scope — JS closure
   * semantics, which is also the park's capture rule: whatever an `await` park
   * carries across a park, a callback body captures, and every existing capture
   * diagnostic (use-before-bind, a `parallel` sibling's binding, an escaped
   * block alias) applies inside the body unchanged. The body produces no value:
   * there is no `.binding` accessor to read one with.
   *
   */
  private checkCallback(callback: CallbackExpression, scope: Scope): PositionTypeRef {
    const subject = callback.subject;
    const fireTimeParams =
      subject.kind === 'inline'
        ? this.checkCallbackInline(subject, scope)
        : this.checkCallbackNamed(subject, scope);
    this.checkCallbackConfig(callback.config, scope);
    return callbackType(fireTimeParams);
  }

  /** The inline subject IS an ordinary closure — the deferred body a callback
   *  wraps. Its parameters are the FIRE-TIME signature (none is supplied here),
   *  and what the body returns goes nowhere: firing a callback resumes a run,
   *  it does not hand a value to whoever minted it. */
  private checkCallbackInline(
    subject: Extract<CallbackSubject, { kind: 'inline' }>,
    scope: Scope,
  ): CallbackParams {
    const { params, effects } = this.checkClosure(subject.closure, scope, {
      label: 'a callback body',
      valueParamsOnly: true,
    });
    if (effects.suspend) this.refuseUnresumableWait('a callback body', subject.closure.span);
    // Minting a callback SCHEDULES the body — the platform calls it, but this
    // movement is what causes the call, so the body's effects are the
    // movement's. A row that said "writes nothing" for a movement whose
    // callback writes to the CRM would be the silent-degradation failure.
    this.effects?.absorb(effects);
    return params.map((param) => ({ name: param.name, type: param.fieldType }));
  }

  /**
   * The named subject — the ONE position where a movement is a value.
   * Arguments type against the movement's parameters exactly as a listen types
   * against a signature (parameter vs argument), with one difference that IS
   * the feature: only the FIXED arguments are supplied here, so a parameter the
   * author leaves out is not missing — it is the callback's fire-time
   * signature, bound by the router from what the platform sends.
   */
  private checkCallbackNamed(
    subject: Extract<CallbackSubject, { kind: 'named' }>,
    scope: Scope,
  ): CallbackParams {
    const resolution = this.calleeResolution(subject.movement, scope);
    const callee = resolution.kind === 'found' ? resolution.symbol : undefined;
    if (callee === undefined || (callee.kind !== 'movement' && callee.kind !== 'fileImport')) {
      // A file import may be a movement — the linker resolves it; benefit of
      // the doubt, exactly as a call site gives.
      this.report(
        DiagnosticCodes.CALLBACK_NOT_MOVEMENT,
        callee === undefined
          ? `'${subject.movement}' is not a movement in this file${didYouMean(subject.movement, movementNamesInScope(scope))} — a callback defers an inline body ('callback({ … })') or a movement by name`
          : `'${subject.movement}' is ${describeKind[callee.kind]}, not a movement — a callback defers an inline body ('callback({ … })') or a movement by name`,
        subject.nameSpan,
      );
    }
    // Deferring a movement by name schedules the same run a call would — same
    // reasoning as the inline body above.
    if (callee?.kind === 'movement') {
      const effects = this.movementEffects(callee);
      this.effects?.absorb(effects);
      if (effects.suspend) this.refuseUnresumableWait(`'${subject.movement}', run as a callback`, subject.nameSpan);
    }
    else if (callee?.kind === 'fileImport') this.effects?.markPartial();
    const declared = callee?.kind === 'movement' ? this.movementParams(callee) : undefined;
    const bound = this.checkArgumentBindings({
      callee: subject.movement,
      args: subject.args,
      params: declared,
      span: subject.span,
      // Unsupplied parameters are the fire-time signature, not omissions —
      // by name, any of them; by position, the ones after the last argument.
      partial: true,
    });
    for (const { arg, param, index } of bound) {
      this.checkCallArg(subject.movement, arg, param, index, scope);
    }
    if (declared === undefined || callee?.movement === undefined) return [];
    const supplied = new Set(bound.flatMap(b => (b.param !== undefined ? [b.param.name] : [])));
    const params: Array<{ name: string; type: FieldType | undefined }> = [];
    for (const param of callee.movement.decl.params) {
      if (supplied.has(param.name)) continue;
      params.push({
        name: param.name,
        // The declaration checked its own parameter types; here we only ask
        // whether what is LEFT can come from a platform.
        type: this.checkCallbackParamType(param.type, param.name, undefined, subject.nameSpan),
      });
    }
    return params;
  }

  /**
   * A callback's fire-time parameter is a VALUE a platform sends (a picked
   * date, entered text) — so its declared type must be a scalar. A record
   * position is a legitimate movement parameter and an impossible callback one:
   * no platform can hand us a record, so say so at the callback rather than
   * letting the `Called` landing quietly lose the field.
   */
  private checkCallbackParamType(
    type: ParamTypeRef | undefined,
    name: string,
    /** The DECLARING scope, when this callback declares the parameter itself
     *  (the inline form) — a named movement already checked its own. */
    scope: Scope | undefined,
    at?: Span,
  ): FieldType | undefined {
    // No annotation: reported where the parameter was DECLARED (a closure's
    // by `checkClosure`, a movement's by its declaration), so this only has to
    // say it has no type to offer.
    if (type === undefined) return undefined;
    // A platform sends one scalar per control — a picked date, entered text —
    // and nothing that could fill a list or a record.
    if (isValueTypeRef(type)) {
      this.report(
        DiagnosticCodes.CALLBACK_PARAM_NOT_VALUE,
        `a callback's parameter '${name}' is a value the platform sends when the callback fires, one per control, so it has to be a single scalar type (<text>, <number>, <boolean>, <date>, <datetime>, <json>, <file>) — '<${spellValueType(type)}>' is more than one. Supply it as a fixed argument instead.`,
        at ?? type.span,
      );
      return undefined;
    }
    const scalar = type.hopsRaw === undefined ? parseFieldTypeName(type.graph) : undefined;
    if (scalar !== undefined) return scalar;
    // Keep the graph name honest (an unresolvable one is still reported), then
    // refuse it as a fire-time value.
    if (scope !== undefined) this.resolveName(type.graph, at ?? type.span, scope);
    this.report(
      DiagnosticCodes.CALLBACK_PARAM_NOT_VALUE,
      `a callback's parameter '${name}' is a value the platform sends when the callback fires, so it has to be a scalar type (<text>, <number>, <boolean>, <date>, <datetime>, <json>, <file>) — '<${type.graph}${type.hopsRaw ?? ''}>' is a record position, which nothing can hand us. Supply it as a fixed argument instead.`,
      at ?? type.span,
    );
    return undefined;
  }

  /**
   * `{ once: <boolean>, ttl: <duration> }` — a CLOSED vocabulary, so an unknown
   * key is an enum error with a did-you-mean rather than a silently-ignored
   * setting. `once` defaults TRUE (a callback fires once unless it says
   * otherwise); the default lives in the engine, not here.
   */
  private checkCallbackConfig(config: NamedArg[], scope: Scope): void {
    const seen = new Set<string>();
    for (const entry of config) {
      if (seen.has(entry.name)) {
        this.report(
          DiagnosticCodes.CALLBACK_BAD_CONFIG,
          `Duplicate callback config '${entry.name}' — each setting is given once`,
          entry.value.span,
        );
      }
      seen.add(entry.name);
      switch (entry.name) {
        case 'once': {
          const literal = scalarLiteralType(entry.value.raw);
          if (literal !== undefined && literal !== 'boolean') {
            this.report(
              DiagnosticCodes.CALLBACK_BAD_CONFIG,
              `'once' says whether the callback may fire more than once — write TRUE or FALSE, not ${entry.value.raw.trim()}`,
              entry.value.span,
            );
            break;
          }
          if (literal === undefined) this.checkExprSlot(entry.value, scope);
          break;
        }
        case 'ttl':
          if (!isValidDuration(entry.value.raw.trim())) {
            this.report(
              DiagnosticCodes.CALLBACK_BAD_CONFIG,
              `'${entry.value.raw.trim()}' is not a valid ttl — use unit-suffixed duration literals like 4h, 2d, 90m, 1h30m`,
              entry.value.span,
            );
          }
          break;
        default:
          this.report(
            DiagnosticCodes.CALLBACK_BAD_CONFIG,
            `'${entry.name}' is not a callback setting${didYouMean(entry.name, CALLBACK_CONFIG_KEYS)} — a callback takes: ${CALLBACK_CONFIG_KEYS.join(', ')}`,
            entry.value.span,
          );
      }
    }
  }

  // ── Construction ──

  /** `doc = email_to_doc(m: msg)` — the construction-shaped form, when the name
   *  it invokes is a FUNCTION. One sort, so one test: a movement and a plugin
   *  are both called here, and only an adapter type constructs. Undefined for
   *  everything else, which is the construction the parser recorded. */
  private callInConstructPosition(
    construct: ConstructionCall,
    scope: Scope,
  ): CallStatement | undefined {
    const resolution = this.calleeResolution(construct.callee, scope);
    if (resolution.kind !== 'found') return undefined;
    const kind = resolution.symbol.kind;
    if (kind !== 'movement' && kind !== 'plugin' && this.calledClosure(resolution.symbol) === undefined) {
      return undefined;
    }
    return constructionAsCall(construct);
  }

  /** Returns the adapter name (when the callee is a known adapter import), the
   *  credential the construction names (catalog-side), and the instance schema. */
  private checkConstruction(
    construct: ConstructionCall,
    scope: Scope,
  ): { adapter?: string; credential?: string; schema?: InstanceSchema } {
    const resolution = scope.resolve(construct.callee);
    if (resolution.kind !== 'found') {
      if (resolution.kind === 'unknown' && this.catalog.adapter(construct.callee) !== undefined) {
        this.reportUnimportedAdapterConstruction(construct, scope);
        return {};
      }
      this.reportResolutionFailure(construct.callee, construct.span, resolution);
      return {};
    }
    const callee = resolution.symbol;
    if (callee.kind !== 'adapter') {
      this.report(
        DiagnosticCodes.CONSTRUCT_NOT_ADAPTER,
        callee.kind === 'fileImport'
          ? `'${construct.callee}' is imported from a file (a movement or a node declaration) — only adapter types are constructed`
          : `'${construct.callee}' is ${describeKind[callee.kind]}, not an adapter type — only adapter types are constructed`,
        construct.span,
      );
      return {};
    }

    const adapterName = callee.importedName ?? construct.callee;
    const spec = this.catalog.adapter(adapterName);
    if (!spec) return { adapter: adapterName }; // unknown import already reported

    const credArg = credentialArgOf(spec);

    const instantiate = (): InstanceSchema | undefined => {
      const args: Record<string, string> = {};
      for (const arg of construct.args) {
        if (arg.name === DRY_RUN_ARG) continue; // platform arg, not adapter config
        const raw = arg.value.raw.trim();
        args[arg.name] = arg.name === credArg?.name ? this.importedCredentialName(raw, scope) : raw;
      }
      return this.catalog.instantiate(adapterName, args);
    };

    // Resolve the credential name up front — an enum-typed arg's options
    // depend on it (which spreadsheets THIS connection can see), and the
    // credential arg may appear after the position arg in source order.
    const credArgRaw = credArg
      ? construct.args.find((a) => a.name === credArg.name)?.value.raw.trim()
      : undefined;
    const credentialName =
      credArgRaw !== undefined ? this.importedCredentialName(credArgRaw, scope) : undefined;

    let sawCredentialArg = false;
    for (const arg of construct.args) {
      if (arg.name === DRY_RUN_ARG) {
        if (!BOOLEAN_LITERAL.test(arg.value.raw.trim())) {
          this.report(
            DiagnosticCodes.CONSTRUCT_BAD_ARG,
            `'${DRY_RUN_ARG}' takes a boolean literal — write ${DRY_RUN_ARG}: true (or false)`,
            arg.value.span,
          );
        }
        continue;
      }
      if (!spec.constructionArgs.some((a) => a.name === arg.name)) {
        this.report(
          DiagnosticCodes.CONSTRUCT_BAD_ARG,
          `'${construct.callee}' does not accept a construction argument '${arg.name}' — it accepts: ${spec.constructionArgs
            .map((a) => a.name)
            .join(', ')}`,
          arg.value.span,
        );
        continue;
      }
      if (credArg && arg.name === credArg.name) {
        sawCredentialArg = true;
        this.checkCredentialArg(adapterName, arg.value, scope);
      } else {
        this.checkExprSlot(arg.value, scope);
        // Enum-typed (entry-position) arg: warn on a value this connection
        // can't see. Soft — grants change, so it never blocks a save.
        const options = this.catalog.constructionArgOptions?.({
          adapter: adapterName,
          ...(credentialName !== undefined ? { credentialName } : {}),
          arg: arg.name,
        });
        const literal = staticStringLiteralOf(arg.value);
        if (options && options.length > 0 && literal !== undefined && !options.includes(literal)) {
          this.reportWarning(
            DiagnosticCodes.CONSTRUCT_UNKNOWN_OPTION,
            `'${arg.name}' value "${literal}" isn't one this connection can see — try: ${options
              .map((o) => `"${o}"`)
              .join(', ')}`,
            arg.value.span,
          );
        }
      }
    }
    if (credArg?.required && !sawCredentialArg) {
      this.report(
        DiagnosticCodes.CONSTRUCT_MISSING_CRED,
        `'${construct.callee}' requires a '${credArg.name}' argument naming an imported ${construct.callee} credential`,
        construct.span,
      );
    }
    return {
      adapter: adapterName,
      ...(credentialName !== undefined ? { credential: credentialName } : {}),
      schema: instantiate(),
    };
  }

  /** The catalog-side name of a credential referenced by a (possibly aliased or backtick-quoted) local name. */
  private importedCredentialName(local: string, scope: Scope): string {
    // Unwrap backtick-quoted names before scope lookup — the scope registers
    // credentials by their verbatim (backtick-stripped) name.
    const name = unwrapCredentialArg(local) ?? local;
    const resolution = scope.resolve(name);
    return resolution.kind === 'found' && resolution.symbol.kind === 'credential'
      ? (resolution.symbol.importedName ?? name)
      : name;
  }

  private checkCredentialArg(adapter: string, slot: ExprSlot, scope: Scope): void {
    const raw = slot.raw.trim();
    const name = unwrapCredentialArg(raw);
    if (name === null) {
      const repair = this.credentialArgRepair(slot, scope);
      this.reportWithFix({
        code: DiagnosticCodes.CRED_WRONG_ADAPTER,
        message: `The credential argument must be an imported credential name, not an expression${repair !== undefined ? ` — ${repair.instruction}` : ''}`,
        span: slot.span,
        ...(repair !== undefined ? { fix: { edits: repair.edits } } : {}),
      });
      return;
    }
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(name, slot.span, resolution);
      return;
    }
    const symbol = resolution.symbol;
    if (symbol.kind !== 'credential') {
      this.report(
        DiagnosticCodes.CRED_WRONG_ADAPTER,
        `'${name}' is ${describeKind[symbol.kind]}, not a credential`,
        slot.span,
      );
      return;
    }
    if (symbol.adapters !== undefined && !symbol.adapters.includes(adapter)) {
      const served = symbol.adapters.join(', ');
      this.report(
        DiagnosticCodes.CRED_WRONG_ADAPTER,
        `'${name}' is a ${served} credential — '${adapter}' needs a ${adapter} credential`,
        slot.span,
      );
    }
  }

  // ── Writes ──

  /**
   * `write a { … }` — update the record bound at alias `a` in place. The
   * alias must resolve to a record position (a traversal alias or a prior
   * write result — both are positions), and that position's adapter must be
   * able to update records by id (`supportsInPlaceUpdate`). No entity
   * resolution happens: the record is already identified, so the
   * required-field/edge create-gates don't apply and `unique by` is rejected
   * (handled by the caller). Returns the position itself as the result type —
   * a written position is still a position.
   */
  /**
   * `write … bind other { … }` — the engine-owned correspondence
   * declaration. Three rules (3b_explicit_link_model.md):
   *   - `bind` is meaningless on a position write — that write already
   *     holds the exact record; reject.
   *   - `unique by` and `bind` don't compose — the binding IS the identity;
   *     reject the `unique by`.
   *   - `other` must resolve to a stable record position (a traversal
   *     alias, a prior write handle, the event position, an extracted /
   *     traversed record) — the same record-shaped binding correspondence
   *     keys on. A meta/block/value/import binding has no single record.
   * One bind per write is structural (the AST holds a single clause), so
   * compound binding can't be expressed — no diagnostic needed.
   */
  private checkBindClause(
    write: WriteExpression,
    scope: Scope,
    target: PositionTypeRef | undefined,
  ): void {
    const bind = write.bind;
    if (bind === undefined) return;
    if (write.target.kind === 'position') {
      this.report(
        DiagnosticCodes.WRITE_BIND_POSITION,
        `'bind' has no meaning on a position write — 'write ${spellPathRoot(write.target.root)} { … }' already holds the exact record, so there is no counterpart to establish. Drop the 'bind ${bind.name}'`,
        bind.span,
      );
      return;
    }
    // A bound write re-fires as `updateRecord` when the counterpart recurs — so
    // the TARGET system must support update-by-id. An append-only / write-only
    // target (`supportsInPlaceUpdate` false) would typecheck and then throw on
    // the second fire; reject it at author time instead.
    if (
      target !== undefined &&
      'instance' in target &&
      target.instance.schema.supportsInPlaceUpdate !== true
    ) {
      this.report(
        DiagnosticCodes.WRITE_BIND_NO_UPDATE,
        `'${target.instance.name}' can't update records in place — but a 'bind' write re-fires as an update when '${bind.name}' recurs, so the target needs update-by-id. Drop the 'bind ${bind.name}' (a plain create/append), or bind to a system that supports updates`,
        bind.span,
      );
      return;
    }
    if (write.uniqueBy.length > 0) {
      this.report(
        DiagnosticCodes.WRITE_BIND_UNIQUE,
        `'unique by' and 'bind ${bind.name}' don't combine — a bound write's identity IS the binding, so field uniqueness has no role. Drop the 'unique by' clause (it applies only to writes without a bind)`,
        write.uniqueBy[0].span,
      );
    }
    const resolution = scope.resolve(bind.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(bind.name, bind.span, resolution);
      return;
    }
    const record = this.recordOfName(resolution.symbol, bind.name, bind.span);
    if (record?.kind === 'value') {
      this.report(
        DiagnosticCodes.WRITE_BIND_NOT_RECORD,
        `'${bind.name}' is ${record.what} — 'bind' names the counterpart RECORD this write corresponds to, so it needs a record position: a traversal alias, a prior write result, or the event position`,
        bind.span,
      );
      return;
    }
    // A record whose system describes nothing: unknown never errors.
    if (record?.kind !== 'record') return;
    const posType = record.type;
    if (posType.kind !== 'position' && posType.kind !== 'handle' && posType.kind !== 'union') {
      this.report(
        DiagnosticCodes.WRITE_BIND_NOT_RECORD,
        `'${bind.name}' is ${describePosition(posType)} — 'bind' names the counterpart RECORD this write corresponds to, so it needs a record position: a traversal alias, a prior write result, or the event position`,
        bind.span,
      );
    }
  }

  private checkPositionWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'position' }>,
    scope: Scope,
  ): {
    root?: WritableRootSchema;
    handle?: PositionTypeRef;
    description: string;
    /** The record is on an edge of a node this run built. */
    local?: true;
    /** …and is a node declaration's record, typed by this program. */
    declared?: true;
  } {
    // A member-path root is bound to a name before a target is checked
    // (`bindTargetRoots`), so the root here is a name.
    const alias = pathRootName(target);
    if (alias === undefined) return { description: `'${spellPathRoot(target.root)}'` };
    const resolution = scope.resolve(alias);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(alias, target.span, resolution);
      return { description: `'${alias}'` };
    }
    const record = this.recordOfName(resolution.symbol, alias, target.span);
    if (record?.kind === 'value') {
      this.report(
        DiagnosticCodes.WRITE_POSITION_NOT_RECORD,
        `'${alias}' is ${record.what} — 'write ${alias} { … }' updates an already-identified record in place, so it needs a record: a traversal alias, a prior write result, or a record picked from either`,
        target.span,
      );
      return { description: `'${alias}'` };
    }
    // A record whose system describes nothing: unknown never errors — the
    // body is checked against nothing.
    if (record?.kind !== 'record') return { description: `'${alias}'` };
    const posType = record.type;
    // A record the run holds on one of its own edges: the run's graph is its
    // system, and that system updates by id. What it may set is what it
    // carries — the landing type IS the write shape, as for the write that
    // put it there.
    const runBuilt = runBuiltWriteShape(posType);
    if (runBuilt !== undefined) {
      const description = `'${alias}' (${describePosition(posType)} this run built)`;
      return {
        root: { fields: runBuilt.fields, resultShape: runBuilt.fields },
        handle: posType,
        description,
        local: true,
        ...(runBuilt.declared ? { declared: true as const } : {}),
      };
    }
    if (posType.kind !== 'position' && posType.kind !== 'handle' && posType.kind !== 'union') {
      this.report(
        DiagnosticCodes.WRITE_POSITION_NOT_RECORD,
        `'${alias}' is ${describePosition(posType)} — 'write ${alias} { … }' updates an already-identified record in place, so it needs a record position: a traversal alias or a prior write result`,
        target.span,
      );
      return { description: `'${alias}'` };
    }
    if (!posType.instance.schema.supportsInPlaceUpdate) {
      this.report(
        DiagnosticCodes.WRITE_POSITION_NO_UPDATE,
        `'${posType.instance.name}' can't update records in place — its system has no update-by-id. To change ${describePosition(posType)}, create a new record (a graph-root, linked, or tuple-path write) instead of 'write ${alias} { … }'`,
        target.span,
      );
      return { description: describePosition(posType) };
    }
    const recordType =
      posType.kind === 'union' ? posType.union : posType.position;
    const root = recordType !== undefined ? posType.instance.schema.writableRoots[recordType] : undefined;
    return { root, handle: posType, description: describePosition(posType) };
  }

  /**
   * Selects the variant of a DISCRIMINATED write shape from the body's
   * discriminant literal — the write-side dual of read narrowing (a literal
   * picks a variant). Returns the selected variant as the effective root (its
   * `fields`/`requiredFields` govern the rest of the check) and a description
   * that names the variant, so a wrong-variant field reads clearly ("no 'Stage'
   * on … (listName: \"Pipeline\")"). Falls back to the enclosing schema —
   * unchanged root and description — for a non-discriminated write, or when the
   * discriminant can't select a variant:
   *
   *  - MISSING → the fallback's `requiredFields` (the discriminant is required)
   *    reports the missing-field error; nothing to select.
   *  - present but NOT a compile-time literal → ERROR here (a create must know
   *    its shape at author time), then fall back.
   *  - a literal that names no variant → the fallback's enum discriminant field
   *    reports MOV_ENUM_UNKNOWN_VALUE (the typo); nothing to select.
   */
  private selectWriteVariant(
    root: WritableRootSchema | undefined,
    body: { fields: FieldEntry[] },
    rootDescription: string,
  ): { root: WritableRootSchema | undefined; description: string; variant?: WritableRootSchema } {
    const discriminated = root?.discriminated;
    if (root === undefined || discriminated === undefined) {
      return { root, description: rootDescription };
    }
    const discBody = body.fields.find((f) => f.name === discriminated.discriminant);
    if (discBody === undefined) return { root, description: rootDescription };
    const literal = staticStringLiteralOf(discBody.value);
    if (literal === undefined) {
      this.report(
        DiagnosticCodes.WRITE_DISCRIMINANT_NOT_LITERAL,
        `'${discriminated.discriminant}' selects what ${rootDescription} can carry, so it must be a fixed value known here — name it with a literal (e.g. ${discriminated.discriminant}: "${Object.keys(discriminated.variants)[0] ?? '…'}"), not an expression. A create names its target; it can't discover the shape at run time`,
        discBody.value.span,
      );
      return { root, description: rootDescription };
    }
    const variant = discriminated.variants[literal];
    if (variant === undefined) return { root, description: rootDescription };
    return {
      root: variant,
      variant,
      description: `${rootDescription} (${discriminated.discriminant}: "${literal}")`,
    };
  }

  /**
   * The handle a DISCRIMINATED write hands back stands on the VARIANT, not on
   * the collection the write was addressed through. `entry = write org-[:List
   * Entries]-> { listName: "Deal Pipeline", … }` is addressed at the
   * membership collection — which publishes nothing but the discriminant,
   * because it is the intersection of every list — while the record it created
   * is a row of one named list, and that type is the one carrying `Owners`. So
   * a chained write or a `link` off `entry` resolves its edge against the list's
   * own type, exactly as a READ narrowed by the same literal already does
   * (layer 1b). One literal, one type, both directions.
   *
   * The variant's `position` is the type name; when the variant mints no
   * position at all its fields and edges still ride the handle, which is what a
   * writable-only landing already does.
   */
  private handleOfVariant(
    handle: PositionTypeRef | undefined,
    variant: WritableRootSchema,
  ): PositionTypeRef | undefined {
    if (handle === undefined || handle.kind !== 'handle') return handle;
    const position = variant.position;
    const minted = position !== undefined && handle.instance.schema.positions[position] !== undefined;
    return {
      ...handle,
      ...(minted ? { position: position! } : {}),
      resultShape: variant.resultShape,
      ...(variant.edges !== undefined ? { edges: variant.edges } : {}),
    };
  }

  /**
   * An UNTAGGED write union (`WritableRootSchema.writeUnion`): the fields the
   * body MAPS must be a subset of at least one variant. Plain assignability —
   * nothing discriminates the variants, so there is nothing to select and
   * nothing to narrow; a body that fits several (only shared fields set) is
   * fine, and a body that fits none is an error naming the shapes.
   *
   * Only fields the root DECLARES count: an unknown name is
   * MOV_WRITE_UNKNOWN_FIELD's to report, and counting it here would blame the
   * union for a typo. Requiredness is untouched and orthogonal.
   */
  private checkWriteUnion(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
  }): void {
    const { root, write, rootDescription } = input;
    const union = root?.writeUnion;
    if (root === undefined || union === undefined || union.variants.length === 0) return;
    const authored = [...new Set(write.fields.map((f) => f.name).filter((n) => n in root.fields))];
    if (union.variants.some((v) => authored.every((n) => v.fields.includes(n)))) return;

    // What forced each shape out, in body order: the union of every variant's
    // EXCESS. Two fields at minimum whenever the host's rule holds (every
    // writable field is in some variant), and exactly the pair an author needs
    // to see — "File and Blocks", not the whole body.
    const forcing = new Set(
      union.variants.flatMap((v) => authored.filter((n) => !v.fields.includes(n))),
    );
    const conflict = authored.filter((n) => forcing.has(n));
    const shapes = union.variants.map((v) => `${v.name} (${v.fields.join(', ')})`);
    this.report(
      DiagnosticCodes.WRITE_UNION_UNSATISFIED,
      `${rootDescription} is either ${orList(shapes)} — ${writeUnionClash(conflict)}. Set the fields of one shape only, or split this into separate writes`,
      write.target.span,
    );
  }

  /**
   * A landing type GENERIC OVER THIS CONSTRUCTION SITE (asks-as-adapter layer
   * 5, chunk B). An edge may declare that the literal value(s) a body gives one
   * field fix what it lands on (`EdgeSchema.genericOver`): an ask's `Response`
   * is generic over the `Options` it offered, so `Choose` with
   * `["Seed","Series A"]` answers an enum of exactly those two.
   *
   * The checker DECIDES nothing, mirroring `refineSelected`. The host resolved
   * every write it could see and grafted the synthesized position under
   * `genericLandingKey`; here we derive the same key from the same literals and
   * look it up. Both sides read the body through `literalStringValuesOf`, so
   * they cannot disagree about what a literal is.
   *
   * A parameter that ISN'T a literal is the "I can't see it" case, and what that
   * costs is the edge's own declaration (`genericOver.onNonLiteral`): nothing
   * for computed options, which are legitimate and promised nothing;
   * MOV_WRITE_GENERIC_NOT_LITERAL where the adapter refuses a computed value at
   * run time anyway; MOV_WRITE_GENERIC_UNTYPED — a warning — where the write
   * still runs but the author has just traded a typed landing for an opaque one.
   * A guarantee lost in silence is lost twice.
   */
  private applyGenericLandings(
    handle: PositionTypeRef | undefined,
    write: WriteExpression,
    root: WritableRootSchema | undefined,
    rootDescription: string,
  ): PositionTypeRef | undefined {
    if (handle === undefined || handle.kind !== 'handle') return handle;
    const edges = handle.edges ?? positionSchemaOfRef(handle)?.edges;
    if (edges === undefined) return handle;

    const landings: Record<string, string> = {};
    for (const [edgeName, edgeSchema] of Object.entries(edges)) {
      const generic = edgeSchema.genericOver;
      if (generic === undefined) continue;
      const slot = write.fields.find((f) => f.name === generic.field)?.value;
      // An ABSENT parameter is the required-field check's business, not ours —
      // reporting it here too would blame the landing for a missing body field.
      if (slot === undefined) continue;
      const values = literalStringValuesOf(slot.raw);
      if (values === undefined) {
        if (generic.onNonLiteral === 'error') {
          this.report(
            DiagnosticCodes.WRITE_GENERIC_NOT_LITERAL,
            `'${generic.field}' fixes the type of what '-[:${edgeName}]->' delivers on ${rootDescription}, so it must be a fixed value known here — name it with a literal${literalExampleFor(generic.field, root?.fields[generic.field])}, not an expression. The type is decided when the record is written; it can't be discovered at run time`,
            slot.span,
          );
        } else if (generic.onNonLiteral === 'warn') {
          this.reportWarning(
            DiagnosticCodes.WRITE_GENERIC_UNTYPED,
            `'${generic.field}' is built at run time, so what '-[:${edgeName}]->' delivers on ${rootDescription} cannot be typed here — it stays one opaque value you cannot read a part out of. Name '${generic.field}' with a literal${literalExampleFor(generic.field, root?.fields[generic.field])} to read the answer back by name`,
            slot.span,
          );
        }
        continue;
      }
      const key = genericLandingKey({ target: edgeSchema.target, values });
      const landed = handle.instance.schema.genericLandings?.[key];
      // A key nobody registered means the host couldn't synthesize this one (a
      // different adapter, an unresolvable instance) — the base type stands.
      if (landed !== undefined && handle.instance.schema.positions[landed] !== undefined) {
        landings[edgeName] = landed;
      }
    }
    if (Object.keys(landings).length === 0) return handle;
    return { ...handle, genericLandings: landings };
  }

  /** Checks the write and returns the resulting handle's type, when derivable (check 8). */
  /**
   * The shape-WRITE construct, retired.
   *
   * `write Lead-[:item]-> { … }` was the only way to build a record out of
   * nothing, so it was spelled as a write to a graph that stores nothing — a
   * write with no target system, which is not a write. `node { … }` says the
   * same thing without the pretence, and says more: a literal carries edges,
   * pass-through traversals and `lazy`, none of which a shape write could
   * express.
   *
   * Refused HERE, where a program is checked — at save, and in the editor as
   * it is typed. The engine's own path outlives this by one wave, so a program
   * saved before the retirement keeps running while its author is told, once,
   * what to write instead. Silence and a runtime surprise were the two things
   * the layer-7 audit ruled out.
   *
   * The DECLARATION survives: it is the nominal annotation a callee's parameter
   * may wear, checked structurally against whatever the caller synthesises.
   *
   */
  private refuseShapeWrite(write: WriteExpression, scope: Scope): boolean {
    const roots =
      write.target.kind === 'linked'
        ? [pathRootName(write.target.path)]
        : write.target.kind === 'tuple'
          ? write.target.paths.map((path) => pathRootName(path))
          : [];
    const shapeRoot = roots.find((root) => {
      if (root === undefined) return false;
      const resolution = scope.resolve(root);
      return resolution.kind === 'found' && resolution.symbol.kind === 'shape';
    });
    if (shapeRoot === undefined) return false;
    // The replacement, spelled with THIS write's own entries — the correction
    // is the program the author meant, not a grammar rule to go and look up.
    const entries = write.fields.map((field) => `${field.name}: …`).join(', ');
    this.report(
      DiagnosticCodes.WRITE_SHAPE_RETIRED,
      `'${shapeRoot}' is a declared node — the structure a parameter is checked against, not a system that stores anything, so this write has nowhere to land. Synthesise the record instead: 'node { ${entries.length > 0 ? entries : '…'} }' — the same entries, and it can carry what a write to a declaration never could: a nested 'node { … }' for a related record, or a traversal off a position you hold ('files: lazy a-[f:…]->') to pass real records through untouched. Keep the declaration if the callee's parameter names it`,
      write.span,
    );
    return true;
  }

  /**
   * A target that starts at a MEMBER PATH (`write m.k { … }`,
   * `write m.k-[:child]-> { … }`) starts at the record the path holds, bound
   * exactly as `x = m.k` binds it — the same right-hand side, checked into a
   * scope of the write's own under the path's spelling — so every rule after
   * this reads a name, whichever way the author reached the record.
   */
  private bindTargetRoots(target: MatchTarget, scope: Scope): { target: MatchTarget; scope: Scope };
  private bindTargetRoots(target: WriteTarget, scope: Scope): { target: WriteTarget; scope: Scope };
  private bindTargetRoots(target: WriteTarget, scope: Scope): { target: WriteTarget; scope: Scope } {
    let own: Scope | undefined;
    const named = mapTargetRoots(target, (root) => {
      if (root.kind === 'name') return root;
      const name = memberPathBindingName(root.expr);
      if (name === undefined) return root;
      own ??= new Scope('branch', scope);
      const shape = this.checkRValue({ kind: 'expr', expr: root.expr }, scope, name, root.expr.span);
      own.declare({ name, kind: 'binding', span: root.expr.span, ...shape });
      return { kind: 'name', name };
    });
    return { target: named, scope: own ?? scope };
  }

  private checkWrite(
    authored: WriteExpression,
    scope: Scope,
    options?: { isBound?: boolean; binding?: string },
  ): PositionTypeRef | undefined {
    const rooted = this.bindTargetRoots(authored.target, scope);
    if (rooted.scope !== scope) return this.checkWrite({ ...authored, target: rooted.target }, rooted.scope, options);
    // A spread is the field lines it stands for, so every check below — an
    // excess field, a maybe-absent value, a required field — reads them as if
    // they had been written out.
    const write: WriteExpression =
      authored.spreads === undefined
        ? authored
        : { ...authored, fields: expandWriteSpreads(authored, s => this.spreadFields(s, scope)) };
    if (this.refuseShapeWrite(write, scope)) return undefined;
    const isBound = options?.isBound === true;
    let root: WritableRootSchema | undefined;
    let rootDescription = 'the write target';
    let handle: PositionTypeRef | undefined;
    /** The target is an edge of a node this run built — the run's own graph. */
    let local = false;
    /** …whose landings are a node declaration's records (a collecting node's
     *  `<Entry>` entries): their fields are this program's own types. */
    let declaredTarget = false;
    /** The write form's parent paths (linked / tuple) — required-edge satisfaction. */
    const parents: Array<{ type?: string; edge: string }> = [];

    if (write.target.kind === 'linked') {
      const linked = this.checkLinkedPath(
        {
          path: write.target.path,
          explicitType: write.target.explicitType,
          span: write.target.span,
          purpose: 'write',
          isBound,
          ...(write.bind !== undefined ? { bindName: write.bind.name } : {}),
        },
        scope,
      );
      root = linked.root;
      handle = linked.handle;
      local = linked.local === true;
      declaredTarget = linked.declared === true;
      if (linked.description !== undefined) rootDescription = linked.description;
      if (linked.resolved) {
        parents.push({
          ...(linked.resolved.parentType !== undefined ? { type: linked.resolved.parentType } : {}),
          edge: linked.resolved.edgeName,
        });
      }
    } else if (write.target.kind === 'tuple') {
      const tuple = this.checkTupleWriteTarget(write.target, scope, parents, {
        purpose: 'write',
        isBound,
        ...(write.bind !== undefined ? { bindName: write.bind.name } : {}),
      });
      root = tuple.root;
      handle = tuple.handle;
      if (tuple.description !== undefined) rootDescription = tuple.description;
    } else {
      const position = this.checkPositionWriteTarget(write.target, scope);
      root = position.root;
      handle = position.handle;
      rootDescription = position.description;
      local = position.local === true;
      declaredTarget = position.declared === true;
    }

    // A DISCRIMINATED write shape (the write-side dual of read narrowing): the
    // body's shape varies by the LITERAL of a required discriminant field. Read
    // the literal, select the variant, and validate everything below —
    // required fields/edges, `unique by`, the body — against THAT variant, on a
    // handle that stands on the variant's own type. When no variant is
    // selectable (discriminant missing/typo'd/non-literal), `root` stays the
    // fallback shape: a missing discriminant surfaces as the required-field
    // error, a typo'd one as MOV_ENUM_UNKNOWN_VALUE (both off the fallback's own
    // `requiredFields`/enum field), and a non-literal one is the caught-not-
    // silent error inside `selectWriteVariant`.
    //
    // FIRST, before anything reads the handle: the effect row, the bind clause
    // and the generic landings all ask what type this write lands on, and the
    // variant is the answer to that question.
    const selected = this.selectWriteVariant(root, write, rootDescription);
    root = selected.root;
    rootDescription = selected.description;
    if (selected.variant !== undefined) handle = this.handleOfVariant(handle, selected.variant);

    // This write's own literals decide what its generic edges LAND on (an ask's
    // `Options` fixing its `Response`'s enum). Done here, where the body and the
    // handle are both in hand, and carried on the handle so `await a-[:Response]->`
    // steps onto the specialized position.
    handle = this.applyGenericLandings(handle, write, root, rootDescription);

    // The write's own effect: whichever graph the handle lands in. An ask is a
    // write like any other — its adapter is the one it is addressed to. A write
    // into a node this run built lands in NO graph: the row carries the systems
    // a run touches, and this one touches none — the same silence `link` on a
    // local node keeps. Noting it would mark the row incomplete ("a site nobody
    // could place"), which is a different fact and a false one.
    if (!local) this.noteTypedEffect('write', handle);

    if (write.bind !== undefined) this.checkBindClause(write, scope, handle);

    // The OTHER write-side union — untagged, so assignability decides rather
    // than a literal. Independent of everything below: it constrains WHICH
    // fields may appear together, and leaves their types, requiredness and
    // edges to the checks that follow.
    this.checkWriteUnion({ write, root, rootDescription });

    if (!this.typeOnly) {
      const target = recordedTargetOf(handle);
      this.options.recording?.writes.push({
        span: write.span,
        ...(root ? { root } : {}),
        description: rootDescription,
        declaredFields: new Set(write.fields.map(f => f.name)),
        fields: write.fields,
        hasUniqueBy: write.uniqueBy.length > 0,
        scope,
        ...(options?.binding !== undefined ? { binding: options.binding } : {}),
        ...(target ? { target } : {}),
        action: write.target.kind === 'position' ? 'update' : 'create',
        parents: [...parents],
      });
    }

    // A position write updates an already-identified record: the
    // required-field / required-edge create-gates don't apply, and there is
    // nothing to resolve, so `unique by` is rejected outright.
    if (write.target.kind === 'position') {
      if (write.uniqueBy.length > 0) {
        this.report(
          DiagnosticCodes.WRITE_POSITION_UNIQUE,
          `'unique by' has no meaning on a position write — 'write ${spellPathRoot(write.target.root)} { … }' already holds the exact record. Drop the 'unique by' clause`,
          write.uniqueBy[0].span,
        );
      }
    } else if (write.bind !== undefined) {
      // A bound write's identity IS the binding — `unique by` doesn't
      // compose with it (3b: bind wins outright). The required-field /
      // required-edge create-gates still apply: a create can still happen
      // (self-heal mints a fresh record), so the body must satisfy them.
      this.checkRequiredEdges({ write, root, rootDescription, parents, handle });
      this.checkRequiredFields({ write, root, rootDescription, parents });
    } else {
      this.checkRequiredEdges({ write, root, rootDescription, parents, handle });
      this.checkRequiredFields({ write, root, rootDescription, parents });

      this.checkIdentity({ uniqueBy: write.uniqueBy, root, rootDescription, scope, local });
    }
    const writtenSchema = handle !== undefined ? positionSchemaOfRef(handle) : undefined;
    // Empty-write watch (chunk D): count fields that can DISCHARGE TO OMISSION —
    // a `?:` fill whose value may be absent writes nothing when the value isn't
    // there. If EVERY field is such, the write can reach the adapter empty.
    let omittableFields = 0;
    for (const field of write.fields) {
      const targetType = root?.fields[field.name];
      if (root && targetType === undefined) {
        const available = Object.keys(root.fields);
        this.report(
          DiagnosticCodes.WRITE_UNKNOWN_FIELD,
          `${rootDescription} has no field '${field.name}'${available.length ? ` — it has: ${available.join(', ')}` : ''}${field.spread !== undefined ? ` ('...${field.spread}' writes every field of '${field.spread}', '${field.name}' included — write the fields that belong here one per line instead)` : ''}`,
          field.span,
        );
      }
      // `+:` / `+?:` (append) only make sense for a multi-valued (list) field —
      // there is no list to append to on a scalar. `replace` and `?:` apply to
      // both, so they're unrestricted.
      if (
        (field.semantics === 'append' || field.semantics === 'append-missing') &&
        targetType !== undefined &&
        !isListType(targetType)
      ) {
        const op = field.semantics === 'append' ? '+:' : '+?:';
        this.report(
          DiagnosticCodes.WRITE_APPEND_NOT_MULTI,
          `'${field.name}' on ${rootDescription} is ${describeFieldType(targetType)}, not a list — '${op}' (append) applies only to multi-valued fields. Use ':' to set it, or '?:' to set it only when empty`,
          field.span,
        );
      }
      // A handle assigned directly to a reference-named field — legal where
      // the target exposes the reference as a writable field, but the
      // idiomatic spelling is structural: nudge toward the link forms.
      const handleValue = this.bareHandleName(field.value, scope);
      if (writtenSchema?.edges[field.name] !== undefined && handleValue !== undefined) {
        this.reportInfo(
          DiagnosticCodes.WRITE_LINK_FIELD_NUDGE,
          `'${field.name}' is a relationship of ${rootDescription} — rather than assigning the handle '${handleValue}' to a field, establish the connection structurally: put the parent in the write target (a linked or tuple-path write) or assert it afterwards with a link statement`,
          field.span,
        );
      }
      // The borrowable spelling of this target field — `crm.companies.stage`
      // — when the target graph is known (`rootDescription` is `graph.type`).
      const writeTarget: WriteTargetRef | undefined =
        targetType !== undefined
          ? {
              type: targetType,
              ...(rootDescription.includes('.')
                ? { path: `${rootDescription}.${field.name}` }
                : {}),
            }
          : undefined;
      const { valueType } = this.checkExprSlot(field.value, scope, {
        ...(writeTarget !== undefined ? { writeTarget } : {}),
        writeField: true,
      });
      // A possibly-absent value (a partial-receipt read, a maybe-empty node's
      // field) can't fill a PLAIN write field — the `?:` (fill) marker is its
      // one legal home (S21): fill tolerates a missing source (it only writes
      // when the value is there). A traversal-as-gate discharges it upstream
      // instead. This is the checker firing at the REQUIRED-VALUE site, per F13.
      // A field that may itself be absent (a declaration's `<T | null>`) takes
      // one as-is — TS's `x: T | undefined` accepting `T | undefined`.
      if (isMaybeAbsent(valueType) && field.semantics !== 'fill' && !isMaybeAbsent(targetType)) {
        if (field.spread !== undefined) {
          this.report(
            DiagnosticCodes.ABSENT_REQUIRED,
            `'${field.name}' on ${rootDescription} needs a value, but '...${field.spread}' writes '${field.spread}.${field.name}', which may be absent (${describeFieldType(valueType!)}). Spread it set-if-empty ('?...${field.spread}'), or write '${field.name}' on its own line with a value that is always there`,
            field.value.span,
          );
        } else {
          this.reportAbsentWriteField({
            field,
            valueType: valueType!,
            rootDescription,
            // An update leaves an unset field as it was; a create must fill the
            // fields the target requires.
            mayLeaveUnset: write.target.kind === 'position' || root?.requiredFields?.includes(field.name) !== true,
            identifies: write.uniqueBy.some(clause => uniqueClauseRefs(clause)?.includes(field.name) === true),
          });
        }
      }
      if (field.semantics === 'fill' && isMaybeAbsent(valueType)) omittableFields += 1;
      this.reportBlankableIdentityKey({ uniqueBy: write.uniqueBy, field, valueType, rootDescription, scope });
      this.reportFieldValueType(field.name, rootDescription, targetType, valueType, field.value.span, {
        // The field NAMES a relationship of the written type, so a record is
        // what belongs in it — the adapter exposes the reference as a writable
        // field. The idiomatic spelling is still structural, which the nudge
        // above already says; refusing it here would be a second, harsher word
        // about the same line.
        relationship: writtenSchema?.edges[field.name] !== undefined,
        declared: declaredTarget,
      });
      this.checkEnumLiteralWrite(field.value, {
        targetType,
        subject: `'${field.name}' on ${rootDescription}`,
      });
    }
    if (write.fields.length > 0 && omittableFields === write.fields.length) {
      this.reportWarning(
        DiagnosticCodes.WRITE_MAY_BE_EMPTY,
        `every field of this write to ${rootDescription} is a '?:' fill of a possibly-absent value, so at runtime they can all be omitted and the write reaches the system empty. Gate the write on presence instead (e.g. 'r-[x:…]-> { write … }'), so it only runs when there's something to write.`,
        write.target.span,
      );
    }
    return handle;
  }

  /**
   * The fields `...e` writes: every field of `e`'s type, where that type is one
   * the program itself spells out — an extracted record, a record of a declared
   * structure (`d: <Deal>`), a `node { … }` literal. The list is recorded on the
   * spread so the engine writes exactly these, whatever the value it is handed
   * carries besides (TS spreads a value by its declared object type the same
   * way). A system's record is refused: its field list is the system's to say.
   */
  private spreadFields(spread: WriteSpread, scope: Scope): readonly string[] | undefined {
    const symbol = this.spreadSourceSymbol(spread, scope);
    if (symbol === undefined) return undefined;
    // Whichever plane the record was bound on — a traversal alias, a pick, a
    // collection op's parameter, an extraction's answer, a map's key. A
    // block's whole return is many records, not one to copy.
    const type = symbol.plural === true ? undefined : this.symbolPositionType(symbol);
    const fields = type !== undefined ? knownFieldsOf(type) : undefined;
    if (fields !== undefined) {
      noteFieldsNeeded(type, `writes every field of it with '...${spread.source}' (line ${spread.span.start.line})`);
      spread.fields = fields;
      return fields;
    }
    // A binding that says nothing at all is the internal error, not this rule.
    if (type === undefined && symbol.plural !== true && this.recordOfName(symbol, spread.source, spread.span) === undefined) {
      return undefined;
    }
    this.report(
      DiagnosticCodes.WRITE_SPREAD_SOURCE,
      `'...${spread.source}' writes every field of a record whose fields this program spells out — an extracted record, a declared structure, or a 'node { … }' — and '${spread.source}' is ${symbol.plural === true ? "a block's returned records, several of them" : type !== undefined ? describePosition(type) : describeKind[symbol.kind]}${type !== undefined && instanceOfType(type) !== undefined ? ", whose fields are the system's to say, not this program's" : ''}. Write the fields it should carry one per line ('name: ${spread.source}.name')`,
      spread.span,
    );
    return undefined;
  }

  /**
   * The binding a spread copies from: its name's, or — for `...m.k` — the
   * binding `x = m.k` would make, so a record held under a key spreads as
   * any record does. Undefined (reported) when the name is not in scope.
   */
  private spreadSourceSymbol(
    spread: { source: string; path?: SpreadPath; span: Span },
    scope: Scope,
  ): ScopeSymbol | undefined {
    const root = spread.path?.root ?? spread.source;
    const resolution = scope.resolve(root);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(root, spread.span, resolution);
      return undefined;
    }
    if (spread.path === undefined) return resolution.symbol;
    const { valueType } = this.checkExprSlot({ raw: spreadSourceText(spread), span: spread.span }, scope);
    return {
      name: spread.source,
      kind: 'binding',
      span: spread.span,
      bindingPlane: 'scalar',
      ...(valueType !== undefined ? { fieldType: valueType } : {}),
    };
  }

  /**
   * The identity rules `write` and `match` share — one routine, because they
   * are one rule set: a match IS a write's identity half on its own.
   *
   *   - a target that decides identity itself refuses authored `unique by`;
   *   - `FUZZY` only on a component the target can resolve by similarity;
   *   - every name a component references is a field of the record or a
   *     bound parent handle (edge-scoped identity);
   *   - an authored clause that duplicates a native rule is noted.
   */
  private checkIdentity(input: {
    uniqueBy: UniqueClause[];
    root: WritableRootSchema | undefined;
    rootDescription: string;
    scope: Scope;
    /** The record lands on an edge of a node this run built — no parent a
     *  bare name could stand for. */
    local: boolean;
  }): void {
    const { uniqueBy, root, rootDescription, scope, local } = input;
    // Some targets decide identity themselves and don't accept author-defined
    // uniqueness (the adapter declared `uniquenessAuthorable: false` — e.g.
    // Affinity, whose org/person matching is native). Reject the clause
    // outright rather than silently ignore it; native matching still happens.
    if (root?.uniquenessAuthorable === false && uniqueBy.length > 0) {
      this.report(
        DiagnosticCodes.UNIQUE_NOT_AUTHORABLE,
        `${rootDescription} decides record identity itself — 'unique by' isn't configurable here. Drop the clause; matching on the system's own keys happens automatically`,
        uniqueBy[0].span,
      );
      return;
    }
    // The clause is a predicate that finds the existing record. Each name it
    // references must be a field of the record (`\`email\``,
    // `\`stage\` == "Open"`) or a bound handle in scope (edge-scoped
    // identity). A literal RHS / operators need no resolution.
    for (const clause of uniqueBy) {
      // Whether the clause has anything to search by — undefined once a part
      // fails to parse (that is EXPR_PARSE's to report).
      let hasKey: boolean | undefined = false;
      // A FUZZY modifier rides on a textual component, so split first and
      // strip it before parsing each part as an ordinary expression.
      for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
        let parsed: Expression;
        try {
          parsed = parseMovementExpression(part.raw);
        } catch (e) {
          if (!(e instanceof BridgeError)) throw e;
          this.report(
            DiagnosticCodes.EXPR_PARSE,
            e.message,
            spanWithin(clause.predicate, part.offset + (e.pos ?? 0)),
          );
          hasKey = undefined;
          continue;
        }
        if (hasKey === false && flattenAndConjuncts(parsed).some(c => identityKeyOf(c) !== undefined)) {
          hasKey = true;
        }
        this.checkIdentityNarrowing({
          parsed,
          root,
          scope,
          text: part.raw,
          span: spanWithin(clause.predicate, part.offset),
        });
        if (root === undefined) continue; // schema unknown ⇒ stay silent
        const names = collectExpressionNames(parsed);
        const refs = [...new Set(names.refs)].filter((ref) => !names.aliases.has(ref));
        if (part.fuzzy) {
          this.checkFuzzyComponent({
            root,
            rootDescription,
            fields: refs.filter((ref) => ref in root.fields),
            span: spanWithin(clause.predicate, part.offset),
          });
        }
        for (const ref of refs) {
          if (ref in root.fields) continue;
          // A bare name that is a bound handle is the EDGE-SCOPED identity
          // spelling: identify the record by the parent it hangs off. A
          // landing on a local node's edge hangs off nothing, so there is no
          // parent for the name to be — it can only be a field of the
          // landing, and letting it through would identify by nothing at all.
          if (!local && scope.resolve(ref).kind === 'found') continue; // a bound handle
          this.report(
            DiagnosticCodes.UNIQUE_UNKNOWN_FIELD,
            `'${ref}' is not a field of ${rootDescription} or a bound handle — a 'unique by' predicate identifies by fields of the record or by a bound parent`,
            clause.span,
          );
        }
      }
      if (hasKey === false) {
        this.report(
          DiagnosticCodes.UNIQUE_CONJUNCT_NEEDS_WHERE,
          `'unique by (${clause.predicate.raw})' has nothing to find the record by — its tests only narrow the candidates a key finds. Add the field or parent that identifies the record ('unique by (\`Name\`, …)'), or use a WHERE on the target instead`,
          clause.span,
        );
      }
    }
    this.checkNativeUniqueness(uniqueBy, root, rootDescription);
  }

  /**
   * A conjunct of a `unique by` component that is not part of the key narrows
   * the candidates the lookup found, and it does so by testing each candidate's
   * own fields — nothing else is in reach there. A conjunct that walks a hop,
   * calls something, or reads a value bound elsewhere in the run could not be
   * honoured, so it is refused, pointing at the target's WHERE, which reads the
   * candidate with the whole run in scope. A name that is neither a field nor
   * bound is `UNIQUE_UNKNOWN_FIELD`'s to report.
   */
  private checkIdentityNarrowing(input: {
    parsed: Expression;
    root: WritableRootSchema | undefined;
    scope: Scope;
    text: string;
    span: Span;
  }): void {
    const { root, scope } = input;
    for (const conjunct of flattenAndConjuncts(input.parsed)) {
      if (identityKeyOf(conjunct) !== undefined) continue;
      let reason: string | undefined;
      if (!isPurePredicate(conjunct)) {
        reason = 'it reads beyond the record — a hop, a call, or a value computed per candidate';
      } else if (root !== undefined) {
        const outer = pureLeafReads(conjunct).find(leaf => {
          if (leaf.type === 'property' || leaf.type === 'edge_property') {
            return !(leaf.propertyTypeId in root.fields) && scope.resolve(leaf.propertyTypeId).kind === 'found';
          }
          return true;
        });
        if (outer !== undefined) {
          reason = `'${leafReadKey(outer)}' is not a field of the record — it names a value from elsewhere in the run`;
        }
      }
      if (reason === undefined) continue;
      this.report(
        DiagnosticCodes.UNIQUE_CONJUNCT_NEEDS_WHERE,
        `'${input.text}' in 'unique by' can't narrow the candidates: ${reason}. A 'unique by' component that isn't a key can only test the candidate's own fields — use a WHERE on the target instead ('write crm-[c:Companies WHERE …]-> { … }'), where the candidate is named by the hop's alias and the rest of the run is in scope`,
        input.span,
      );
    }
  }

  /**
   * An identity key whose value is text that may be `""`, on a check for a
   * move up across the version that made an empty key no key. Only where the checker cannot rule
   * the blank out: a non-empty literal cannot be blank, a read a guard in
   * scope proved not "" is not (`if x.F != "" { … }`), and an extracted text
   * that was not found is no key under either version (absent before, `""`
   * now). A value the checker could not type says nothing.
   */
  /**
   * A maybe-absent value in a plain write field, with the line to write
   * instead — the author's own expression, falling back to a value of its own
   * type. Not for a field that IDENTIFIES the record: one fallback value
   * there would merge every record written without it into one, so that
   * write is gated instead, which only the author can place.
   */
  private reportAbsentWriteField(input: {
    field: FieldEntry;
    valueType: FieldType;
    rootDescription: string;
    mayLeaveUnset: boolean;
    identifies: boolean;
  }): void {
    const { field, valueType, rootDescription } = input;
    const raw = field.value.raw.trim();
    const label = spellName(field.name);
    const fallback = input.identifies ? undefined : fallbackLiteral(stripAbsent(valueType));
    const lead = `'${field.name}' on ${rootDescription} needs a value, but '${raw}' may be absent (${describeFieldType(valueType)})`;
    if (input.identifies) {
      this.report(
        DiagnosticCodes.ABSENT_REQUIRED,
        `${lead}, and it identifies the record, so a fallback would merge every record written without it into one — write only when it is there: put the write inside 'if ${raw} != null { … }'`,
        field.value.span,
      );
      return;
    }
    const unset = input.mayLeaveUnset ? `'${label} ?: ${raw}' to leave it unset when absent` : undefined;
    if (fallback === undefined) {
      this.report(
        DiagnosticCodes.ABSENT_REQUIRED,
        `${lead} — it comes from a branch that might not have run, or an answer that might not be there. ${unset !== undefined ? `Write ${unset}, or` : 'Either'} test it with '==' and write inside that branch, or gate on it first ('r-[x:…]-> { write … }')`,
        field.value.span,
      );
      return;
    }
    const coalesced = `COALESCE(${raw}, ${fallback})`;
    this.reportWithFix({
      code: DiagnosticCodes.ABSENT_REQUIRED,
      message: `${lead} — write '${label}: ${coalesced}' to fall back to a value that is always there${unset !== undefined ? `, or ${unset}` : ''}`,
      span: field.value.span,
      fix: { edits: [{ span: field.value.span, text: coalesced }] },
    });
  }

  private reportBlankableIdentityKey(input: {
    uniqueBy: UniqueClause[];
    field: FieldEntry;
    valueType: FieldType | undefined;
    rootDescription: string;
    scope: Scope;
  }): void {
    const { field, valueType, scope } = input;
    if (!this.upgradeCrosses(2)) return;
    if (valueType === undefined || stripAbsent(valueType) !== 'text') return;
    if (!input.uniqueBy.some(clause => uniqueClauseRefs(clause)?.includes(field.name) === true)) return;
    let value: Expression;
    try {
      value = expressionOfSlot(field.value);
    } catch (e) {
      if (e instanceof BridgeError) return;
      throw e;
    }
    if (value.type === 'static' && typeof value.value === 'string' && value.value.trim() !== '') return;
    const read = directFieldRead(value);
    if (read !== undefined) {
      const resolution = scope.resolve(read.root);
      if (resolution.kind === 'found' && this.symbolPositionType(resolution.symbol)?.kind === 'extract') return;
      // A guard in scope proved it not "" (`if x.F != "" { … }`).
      if (resolution.kind === 'found' && resolution.symbol.nonBlank?.fields?.has(read.propertyId) === true) return;
    }
    const name = bareName(value);
    if (name !== undefined) {
      const resolution = scope.resolve(name);
      if (resolution.kind === 'found' && resolution.symbol.nonBlank?.value === true) return;
    }
    this.reportUpgradeWarning(
      DiagnosticCodes.UNIQUE_KEY_MAY_BE_BLANK,
      `'${field.name}' identifies ${input.rootDescription}, and its value may be "" — since language version ${describeLanguageVersion(2)} an empty key is no key, so when it is "" nothing is matched by it (a write creates a new record each time). Before it, "" matched another record whose '${field.name}' was "". If that matters here, guard the write on '${field.name}' != "".`,
      field.value.span,
    );
  }

  /**
   * FUZZY is the target's promise to make, and it makes it per FIELD: a
   * target resolves every field by similarity (`true`), only the fields it
   * lists, or none. One code for all three: each is "this component can't be
   * matched by similarity here", and the message names which case it is.
   */
  private checkFuzzyComponent(input: {
    root: WritableRootSchema;
    rootDescription: string;
    /** The record fields the component names (bound handles excluded). */
    fields: string[];
    span: Span;
  }): void {
    const support = input.root.fuzzyResolution;
    if (support === true) return;
    if (support === undefined) {
      this.report(
        DiagnosticCodes.UNIQUE_FUZZY_UNSUPPORTED,
        `FUZZY isn't available on ${input.rootDescription} — it matches identity exactly, not by similarity. Drop FUZZY and identify by an exact field, or pick a target that supports fuzzy matching`,
        input.span,
      );
      return;
    }
    const listed = support.map((field) => `\`${field}\``).join(', ');
    for (const field of input.fields) {
      if (support.includes(field)) continue;
      this.report(
        DiagnosticCodes.UNIQUE_FUZZY_UNSUPPORTED,
        `FUZZY isn't available for \`${field}\` on ${input.rootDescription} — it matches \`${field}\` exactly. Similarity covers ${listed}: drop FUZZY here, or match by similarity on one of those`,
        input.span,
      );
    }
  }

  /**
   * `x = match <path> { unique by (…) … }` — the identity half of a write,
   * checked by the same rules: the target resolves as a write's does, the
   * `unique by` clauses pass `checkIdentity`, and the body's fields must be
   * fields of the record with values of the right type.
   *
   * Everything a CREATE needs is absent, because nothing is created: no
   * required fields or edges, no write promise on the hop (a match reads), no
   * write union. It notes a READ of the graph it looks in.
   *
   * The handle stands on the record FOUND: its result shape is the record's,
   * without `created` / `committed` — those are facts about a write's
   * outcome, and a match has no outcome to report beyond the record itself
   * (a miss ends the scope, so no handle exists to ask).
   */
  private checkMatch(
    match: MatchExpression,
    scope: Scope,
    options?: {
      binding?: string;
      /** The `unique by` is a link body's all-fields rule, not the author's —
       *  its names are the body's own fields (checked below as fields), and a
       *  target that decides identity itself still takes it as the lookup, as
       *  it takes a write's fields. */
      impliedIdentity?: boolean;
    },
  ): PositionTypeRef | undefined {
    const rooted = this.bindTargetRoots(match.target, scope);
    if (rooted.scope !== scope) return this.checkMatch({ ...match, target: rooted.target }, rooted.scope, options);
    let root: WritableRootSchema | undefined;
    let rootDescription = 'the match target';
    let handle: PositionTypeRef | undefined;
    let local = false;
    const parents: Array<{ type?: string; edge: string }> = [];
    if (match.target.kind === 'linked') {
      const linked = this.checkLinkedPath(
        {
          path: match.target.path,
          explicitType: match.target.explicitType,
          span: match.target.span,
          purpose: 'match',
        },
        scope,
      );
      root = linked.root;
      handle = linked.handle;
      local = linked.local === true;
      if (linked.description !== undefined) rootDescription = linked.description;
      if (linked.resolved) {
        parents.push({
          ...(linked.resolved.parentType !== undefined ? { type: linked.resolved.parentType } : {}),
          edge: linked.resolved.edgeName,
        });
      }
    } else {
      const tuple = this.checkTupleWriteTarget(match.target, scope, parents, { purpose: 'match' });
      root = tuple.root;
      handle = tuple.handle;
      if (tuple.description !== undefined) rootDescription = tuple.description;
    }

    // A discriminated collection: the body's literal picks the type the
    // record found IS, exactly as it picks the type a write creates.
    const selected = this.selectWriteVariant(root, match, rootDescription);
    root = selected.root;
    rootDescription = selected.description;
    if (selected.variant !== undefined) handle = this.handleOfVariant(handle, selected.variant);

    // A match against a node this run built looks in no graph — the same
    // silence a local write keeps.
    if (!local) this.noteTypedEffect('read', handle);

    if (!this.typeOnly) {
      const target = recordedTargetOf(handle);
      this.options.recording?.writes.push({
        span: match.span,
        ...(root ? { root } : {}),
        description: rootDescription,
        declaredFields: new Set(match.fields.map((f) => f.name)),
        fields: match.fields,
        hasUniqueBy: match.uniqueBy.length > 0,
        scope,
        ...(options?.binding !== undefined ? { binding: options.binding } : {}),
        ...(target ? { target } : {}),
        action: 'find',
        parents: [...parents],
      });
    }

    // Identity has to come from somewhere: the author's `unique by`, or the
    // target's own rules (a target that decides identity itself, or declares
    // native uniqueness). With neither, "match" would mean "any record of this
    // type". An untyped target says nothing either way, so it stays silent.
    const nativeIdentity =
      root?.uniquenessAuthorable === false || (root?.nativeUniqueness?.length ?? 0) > 0;
    if (root !== undefined && match.uniqueBy.length === 0 && !nativeIdentity) {
      this.report(
        DiagnosticCodes.MATCH_NO_IDENTITY,
        `this match has nothing to identify ${rootDescription} by — add 'unique by (…)' naming the field(s) that make it the same record (e.g. 'unique by (${Object.keys(root.fields)[0] !== undefined ? `\`${Object.keys(root.fields)[0]}\`` : '…'})')`,
        match.target.span,
      );
    }
    this.checkIdentity({
      uniqueBy: options?.impliedIdentity === true ? [] : match.uniqueBy,
      root,
      rootDescription,
      scope,
      local,
    });

    for (const field of match.fields) {
      const targetType = root?.fields[field.name];
      if (root && targetType === undefined) {
        const available = Object.keys(root.fields);
        this.report(
          DiagnosticCodes.WRITE_UNKNOWN_FIELD,
          `${rootDescription} has no field '${field.name}' — a match's fields are fields of the record it finds${available.length ? `; it has: ${available.join(', ')}` : ''}`,
          field.span,
        );
      }
      const { valueType } = this.checkExprSlot(field.value, scope, {
        ...(targetType !== undefined ? { writeTarget: { type: targetType } } : {}),
        writeField: true,
      });
      this.reportBlankableIdentityKey({ uniqueBy: match.uniqueBy, field, valueType, rootDescription, scope });
      this.reportFieldValueType(field.name, rootDescription, targetType, valueType, field.value.span);
      this.checkEnumLiteralWrite(field.value, {
        targetType,
        subject: `'${field.name}' on ${rootDescription}`,
      });
    }
    return foundHandle(handle);
  }

  /**
   * A string LITERAL written into an enum field must be one of its options —
   * the write-side use of the shared membership helper (a typo'd value parses
   * fine and is text-compatible with the enum, so only the option set catches
   * it). Silent for a non-enum target, and for a non-literal value UNLESS the
   * enum's domain is empty: "the value isn't known at author time" is only a
   * reason for silence while some value could still have been right.
   */
  private checkEnumLiteralWrite(
    value: ExprSlot,
    options: { targetType: FieldType | undefined; subject?: string },
  ): void {
    const { targetType, subject } = options;
    if (!isEnumType(targetType)) return;
    const literal = staticStringLiteralOf(value);
    const diagnostic =
      checkEnumDomain(targetType, subject)
      ?? (literal !== undefined ? checkEnumLiteral(literal, targetType) : null);
    if (diagnostic) {
      if (diagnostic.severity === 'warning') {
        this.reportWarning(diagnostic.code, diagnostic.message, value.span);
      } else {
        this.report(diagnostic.code, diagnostic.message, value.span);
      }
    }
  }

  /**
   * Authored `unique by` vs the target's declared native identity
   * (`WritableRootSchema.nativeUniqueness` — what the adapter enforces
   * regardless of authoring):
   *
   *   - REDUNDANT (info): an authored field-only clause whose field set
   *     exactly equals a native AND-group — the target already matches by
   *     it, so the clause can be dropped.
   *
   * The CONFLICT case (an authored identity disjoint from the native rules)
   * is EXPECTED, not a problem — the native layer matching on its own fields
   * is the target doing its job, not a mistake to warn about. The editor
   * surfaces the native rules as an overlay HINT on the write target instead
   * (see the service's `getHoverInfo` → `nativeUniquenessHint`), so the author
   * sees "matched natively by …" without a diagnostic.
   *
   * Clauses with handle (`ref`) components express edge-scoped identity
   * the native layer can't see; they never count as a duplicate.
   */
  private checkNativeUniqueness(
    uniqueBy: UniqueClause[],
    root: WritableRootSchema | undefined,
    rootDescription: string,
  ): void {
    const native = root?.nativeUniqueness;
    if (!native || native.length === 0 || uniqueBy.length === 0) return;
    const describeRule = (group: string[]): string => group.map(f => `\`${f}\``).join(' + ');

    for (const clause of uniqueBy) {
      const refs = uniqueClauseRefs(clause);
      if (refs === undefined) continue; // unparseable — the expr check reports it
      const fieldComponents = refs.filter(r => root !== undefined && r in root.fields);
      if (fieldComponents.length !== refs.length) continue; // handle/edge-scoped — not comparable
      const authored = new Set(fieldComponents);
      const duplicated = native.find(
        group => group.length === authored.size && group.every(f => authored.has(f)),
      );
      if (duplicated) {
        this.reportInfo(
          DiagnosticCodes.UNIQUE_NATIVE_REDUNDANT,
          `${rootDescription} already matches records by ${describeRule(duplicated)} natively — this 'unique by' duplicates the built-in rule and can be dropped`,
          clause.span,
        );
      }
    }
  }

  /**
   * `write deduped-[:companies]-> { … }` — a write into an edge of a node THIS
   * RUN BUILT. The run's own graph is the target: the landing either joins one
   * already on the edge or becomes a new one, and nothing reaches a system.
   *
   * There is therefore no adapter to ask what may be set, and no need for one:
   * the EDGE already says what its landings carry, so the landing type IS the
   * write shape. A body may set exactly its fields, a `unique by` component may
   * name exactly those fields, and the handle stands on a local node — because
   * that is precisely what the run appends.
   *
   * FUZZY is available here without a capability. Everywhere else it is gated
   * because only some systems can search by similarity; here the ENGINE is the
   * store, so the promise is the engine's own to make.
   */
  private localWriteTarget(
    from: Extract<PositionTypeRef, { kind: 'local' }>,
    edgeName: string,
    span: Span,
    subject?: string,
  ): {
    root?: WritableRootSchema;
    handle?: PositionTypeRef;
    description?: string;
    local?: true;
    /** The landing is a node declaration's (`<Entry>`), not a system's. */
    declared?: true;
  } {
    const edge = from.edges?.[edgeName];
    if (edge === undefined) {
      this.reportUndeclaredLocalEdge({ from, edgeName, span, ...(subject !== undefined ? { subject } : {}) });
      return { local: true };
    }
    if (edge.deferred === true) {
      this.report(
        DiagnosticCodes.NODE_EDGE_DEFERRED,
        `'${edgeName}' is a lazy entry — its landings come from a walk that runs again at every read, so a written one would be gone by the next. Declare a separate edge for what this run writes ('${edgeName}Written: <SomeNode>')`,
        span,
      );
      return { local: true };
    }
    const description = `'${edgeName}' on ${from.label} this run built`;
    const landing = edge.target;
    const schema = landing !== undefined ? positionSchemaOfRef(landing) : undefined;
    // An edge nobody could type says nothing about the body — the write still
    // happens, and silence is the honest answer for what it may set.
    if (schema === undefined || landing === undefined) return { local: true, description };
    const nested = edge.structural === true ? this.nestedLocalEdges(landing, schema) : undefined;
    const landingInstance = instanceOfType(landing);
    return {
      local: true,
      ...(landingInstance !== undefined && isDeclaredNode(landingInstance) ? { declared: true as const } : {}),
      description,
      root: {
        fields: schema.properties,
        resultShape: schema.properties,
        fuzzyResolution: true,
      },
      // The landing the write appends belongs to no graph, so the handle is a
      // LOCAL node and every later use of it (a dot read, a `link` onto another
      // edge) is judged by the structure it really has. That structure is the
      // whole of what the landing type declares: the fields the body set, and
      // the nested nodes the declaration named, each an empty appendable edge —
      // a landing IS one of those, so it carries what one carries.
      handle: {
        kind: 'local',
        label: `a '${edgeName}' landing`,
        runBuilt: { landing },
        reads: schema.properties,
        ...(nested !== undefined ? { edges: nested } : {}),
      },
    };
  }

  /**
   * The nested declared nodes of a landing type, as the landing's own edges.
   *
   * Only for a landing typed by a DECLARED NODE. A declaration is a tree, so
   * one of its nodes carries its children the same way the root does — and the
   * run appends a whole node, not a root with its branches cut off. An
   * ADDRESS-typed edge mints none: its landings are one system's records, and a
   * record's edges are that system's to offer, not the run's to invent.
   */
  private nestedLocalEdges(
    landing: PositionTypeRef,
    schema: PositionSchema,
  ): Record<string, LocalEdge> | undefined {
    if (!('instance' in landing)) return undefined;
    const { instance } = landing;
    const edges: Record<string, LocalEdge> = {};
    for (const [name, declared] of Object.entries(schema.edges)) {
      const target = positionRefIn(instance, declared.target);
      if (target === undefined) continue;
      edges[name] = {
        // Same promises every synthesised edge carries — readable, and nothing
        // else — plus the declaration's own sequencing claim (`order by
        // arrival`), copied through so a written landing's nested edge reads
        // back ordered exactly as the declared type says it should.
        schema: {
          target: name,
          readable: true,
          ...(declared.sequenced !== undefined ? { sequenced: declared.sequenced } : {}),
        },
        target: runBuiltLanding(target),
        structural: true,
      };
    }
    return Object.keys(edges).length > 0 ? edges : undefined;
  }

  /**
   * `link h -[:founder]-> f` / `write h-[:founder]-> { … }` onto a name the
   * node does not have. ONE sentence for both, because it is one fact: a local
   * node's edges are exactly what declared it, so a name that isn't among them
   * is a typo whichever statement spelled it.
   */
  private reportUndeclaredLocalEdge(input: {
    from: Extract<PositionTypeRef, { kind: 'local' }>;
    edgeName: string;
    span: Span;
    /** The author's own name for the node, where the statement has one. */
    subject?: string;
  }): void {
    const declared = Object.keys(input.from.edges ?? {});
    const subject = input.subject !== undefined ? `'${input.subject}'` : input.from.label;
    this.report(
      DiagnosticCodes.NODE_EDGE_UNDECLARED,
      `${subject} declares no edge '${input.edgeName}'${
        declared.length > 0
          ? ` — it has: ${declared.join(', ')}`
          : ` — declare it where the node is built ('${input.edgeName}: <SomeNode>' or '${input.edgeName}: <source-[:Edge]->>')`
      }`,
      input.span,
    );
  }

  /**
   * A linked path's destination (check 5) — shared by linked writes, every
   * tuple-write path, and `match`: the path must start from a typed
   * handle/position, every hop must be a declared edge, and the target type
   * is inferred from the final edge (explicit only for polymorphic edges).
   * A write needs the edge's write promise; a match only reads along it.
   */
  private checkLinkedPath(
    input: {
      path: PathHead;
      explicitType: string | undefined;
      span: Span;
      /** What the path is for: a write creates along the edge, a match only
       *  looks along it. */
      purpose: 'write' | 'match';
      /** Whether this path's result is bound to a name (`x = write …`) —
       *  the only form an ephemeral final edge rejects. Bare statements and
       *  matches never trip the gate. */
      isBound?: boolean;
      /** The write's `bind` counterpart, when it has one — a bound write's
       *  identity IS the binding, so a target WHERE would have nothing to
       *  narrow. */
      bindName?: string;
    },
    scope: Scope,
  ): {
    root?: WritableRootSchema;
    handle?: PositionTypeRef;
    description?: string;
    /** The path landed on an edge of a node THIS RUN BUILT — no system behind
     *  it, so the write touches nothing the effect row carries and no bound
     *  parent can stand in for a component of its identity. */
    local?: true;
    /** …and that node's edge lands on a node declaration's records. */
    declared?: true;
    /** The fully-typed resolution — tuple agreement and required-edge satisfaction. */
    resolved?: {
      instanceToken: object;
      instanceName: string;
      written: string;
      parentType?: string;
      edgeName: string;
    };
  } {
    const head = this.checkPathHead(input.path, scope);
    const rootName = pathRootName(input.path);
    if (head.rootType === undefined && rootName !== undefined) {
      // A value root is the head's own refusal; a binding that says nothing
      // at all is the internal error `recordOfName` reports.
      const resolution = scope.resolve(rootName);
      if (resolution.kind === 'found') this.recordOfName(resolution.symbol, rootName, input.span);
    }
    if (!head.steps || head.steps.length === 0 || head.rootType === undefined) return {};
    // A write/link needs a record that IS there. Traversing INTO a maybe-empty
    // node is gate-discharged (the block runs zero times), but a write is not a
    // block: nothing about the statement says it might not happen, and the
    // engine has no record to parent it to. This is the require-present site for
    // the node plane, mirroring a plain write FIELD on the scalar plane.
    if (head.rootType.kind === 'maybeEmpty' && rootName !== undefined) {
      this.report(
        DiagnosticCodes.ABSENT_REQUIRED,
        `'${rootName}' is ${describePosition(head.rootType.of)} that may not be there, so a ${input.purpose} off it can't be guaranteed to happen — and nothing in this statement says it might be skipped. Test it first ('if ${rootName} == null { ERROR("…") }', or 'if EXISTS(${rootName})'), or gate on it with a traversal block ('${rootName}-[x:…]-> { … }'), which runs zero times when it's empty.`,
        input.span,
      );
      return {};
    }

    // A WHERE on a target says which existing records the find may take, and
    // those are the records the FINAL hop lands on. On any earlier hop it
    // would narrow a parent the target never walks from at run time.
    for (const step of head.steps.slice(0, -1)) {
      if (step.type !== 'edge' || step.expressionFilter === undefined) continue;
      this.report(
        DiagnosticCodes.TARGET_WHERE_NOT_FINAL,
        `the WHERE on '-[:${step.edgeTypeId}]->' narrows a hop the ${input.purpose} only passes through — a ${input.purpose} target's WHERE goes on its final hop, where it says which existing records may be matched ('${input.purpose} parent-[x:Edge WHERE …]-> { … }')`,
        input.span,
      );
    }

    const typing = this.slotTyping(scope, input.span);
    const parent = typing.walkSteps(head.rootType, head.steps.slice(0, -1));
    if (parent === undefined) return {};
    const linkStep = head.steps[head.steps.length - 1];
    if (linkStep.type !== 'edge') return {}; // a meta-edge is not a linkable reference
    const edgeName = linkStep.edgeTypeId;

    // A node THIS RUN built. Its edges are not a system's collections, so none
    // of what follows — the instance, the write promise, the target's own
    // writability — has anything to consult. The edge's landing type is the
    // whole answer, and `localWriteTarget` is where it is read.
    if (parent.kind === 'local') {
      // The root's NAME is the subject only when the parent IS the root — one
      // hop further along and the author's name is for a different node.
      const subject = head.steps.length === 1 ? rootName : undefined;
      if (linkStep.expressionFilter !== undefined) {
        this.report(
          DiagnosticCodes.TARGET_WHERE_LOCAL,
          `'${edgeName}' is an edge of a node this run built, and its landings take no WHERE — say which one you mean in 'unique by (…)' instead`,
          input.span,
        );
      }
      return this.localWriteTarget(parent, edgeName, input.span, subject);
    }

    // A write handle to a WRITABLE-ONLY type mints no position (an ask family:
    // you can raise one, you can never enumerate them), so its relationship
    // table lives on the handle. `TypeWalker.stepEdge` makes exactly this
    // fallback for the read side; without its twin here, `write a-[:Response]->`
    // off a fresh ask resolves to nothing and checks NOTHING — silence where a
    // type error belongs.
    const parentSchema =
      positionSchemaOfRef(parent) ??
      (parent.kind === 'handle' && parent.edges !== undefined
        ? { properties: {}, edges: parent.edges }
        : undefined);
    if (parent.kind === 'meta') {
      // A meta parent — the instance's OWN position. It resolves via its
      // synthesized collection edges (positionSchemaOfRef), so a top-level write
      // `<instance>-[:Collection]-> { … }` validates like any linked write. The
      // one exception is the instance-param door: a meta-typed name that stands
      // for a whole system (an instance-typed PARAMETER, not a constructed
      // instance) — schemas are per-credential, so instances don't travel
      // between movements; error rather than resolve.
      const root = rootName;
      if (root !== undefined) {
        const resolution = scope.resolve(root);
        if (resolution.kind === 'found' && !isGraphSymbol(resolution.symbol)) {
          this.report(
            DiagnosticCodes.WRITE_TARGET_NOT_GRAPH,
            `'${root}' is ${describeKind[resolution.symbol.kind]} standing for a whole system, not a record — a ${input.purpose === 'write' ? 'linked write' : 'match'} starts from a record handle or the instance's own edge: construct the instance in this file — instances don't pass between movements`,
            input.span,
          );
          return {};
        }
      }
    } else if (!parentSchema || (parent.kind !== 'position' && parent.kind !== 'handle')) {
      return {};
    }
    if (!parentSchema) return {};
    const instance = parent.instance;

    const edge = parentSchema.edges[edgeName];
    if (!edge) {
      // The parent's edge surface isn't enumerated — open (wider than
      // declared) or undescribed (nothing looked). Neither licenses 'it has no
      // edge X', so unknown stays silent; the undescribed handle is reported
      // where it is READ, not here.
      if (surfaceNotEnumerated(parentSchema)) return {};
      const available = Object.keys(parentSchema.edges);
      this.report(
        DiagnosticCodes.LINKED_UNKNOWN_EDGE,
        `${describePosition(parent)} has no edge '${edgeName}' — ${
          input.purpose === 'write'
            ? "a linked write creates the record AND the edge, so the parent's type must declare it"
            : "a match looks along an edge the parent's type declares"
        }${available.length ? `; it declares: ${available.join(', ')}` : ''}`,
        input.span,
      );
      return {};
    }

    // THE write gate (layer 13): one explicit promise. Absent ⇒ read-only —
    // an edge that never declared a write promise makes none, so a write OR a
    // link is rejected here rather than on the target's writability.
    //
    // But "no write promise" arrives here as one value standing for three
    // different facts, and only the first is the source's fault:
    //
    //   - the edge is genuinely a read-only collection (the instance fills it);
    //   - the target was DESCRIBED and has no writable fields — the system
    //     accepts writes to it in principle, but there is nothing to set;
    //   - the target was never described at all, so nobody has looked.
    //
    // Reporting all three as "the instance fills it itself" sent an author
    // hunting for a missing capability when the real answer was, for a bare
    // Google Sheets tab, that row 1 was blank. The target's own position says
    // which case this is; the message now asks.
    if (input.purpose === 'write' && !edgeIsWritable(edge)) {
      const available = writableEdgesOf(instance.schema).map((e) => `${e.parent}-[:${e.edge}]->`);
      const target = edge.target;
      const targetSchema = target !== undefined ? instance.schema.positions[target] : undefined;
      const targetName = target ?? edgeName;
      const cause =
        target !== undefined && (targetSchema === undefined || targetSchema.undescribed === true)
          ? `nothing has described '${targetName}' yet, so its writable fields aren't known here`
          : targetSchema !== undefined && Object.keys(targetSchema.properties).length === 0
            ? `'${targetName}' has no fields to write`
            : `'${instance.name}' fills it itself`;
      this.report(
        DiagnosticCodes.WRITE_READ_ONLY_EDGE,
        `'-[:${edgeName}]->' is read-only on ${describePosition(parent)} — ${cause}, so a ${input.purpose} can't create or attach along it${available.length ? `; '${instance.name}' writes along: ${available.join(', ')}` : ''}`,
        input.span,
      );
      return {};
    }

    if (edge.ephemeral === true && input.purpose === 'write' && input.isBound === true) {
      this.report(
        DiagnosticCodes.WRITE_EPHEMERAL_BOUND,
        `nothing to bind — 'write …-[:${edgeName}]->' is an action, not a record; ` +
          'drop the binding and write it as a bare statement',
        input.span,
      );
    }

    let written: string;
    if (edge.polymorphic) {
      if (input.explicitType === undefined) {
        this.report(
          DiagnosticCodes.LINKED_NEEDS_TYPE,
          `'${edgeName}' is polymorphic — say which type this ${input.purpose === 'write' ? 'write creates' : 'match finds'}: ${input.purpose} …-[:${edgeName}]-><type> { … }`,
          input.span,
        );
        return {};
      }
      const variants = instance.schema.unions?.[edge.target];
      if (variants ? !variants.includes(input.explicitType) : !instance.schema.positions[input.explicitType]) {
        this.report(
          DiagnosticCodes.LINKED_TYPE_MISMATCH,
          variants
            ? // The target may be a DERIVED union key (the adapter projection's
              // shape) — opaque, and never something to read back to an author.
              `'${edgeName}' targets ${instance.schema.unionDisplayNames?.[edge.target] ?? edge.target} (${variants.join(' | ')}) — '${input.explicitType}' is not one of its types`
            : `'${instance.name}' has no position type '${input.explicitType}'`,
          input.span,
        );
        return {};
      }
      written = input.explicitType;
    } else {
      if (input.explicitType !== undefined && input.explicitType !== edge.target) {
        this.report(
          DiagnosticCodes.LINKED_TYPE_MISMATCH,
          `'${edgeName}' targets ${instance.name}.${edge.target} — the explicit type '${input.explicitType}' contradicts it`,
          input.span,
        );
        return {};
      }
      // A landing the PARENT's own construction fixed (an ask's `Options`
      // narrowing its `Response` to those exact options) is the same landing
      // whichever direction you travel it — `TypeWalker.stepEdge` reads it for
      // the read side, and this reads it for the write side, off the same
      // handle. So writing `Answer: "Sead"` to a Choose offering "Seed" is the
      // enum did-you-mean AT THE WRITE, not a surprise at the read.
      written =
        (parent.kind === 'handle' ? parent.genericLandings?.[edgeName] : undefined) ?? edge.target;
    }

    // The final hop's WHERE narrows the identity candidates — each one read as
    // the record it is, so it types like a read hop's WHERE at the type the
    // target lands on. The formula grammar has no write and no ask, so a
    // filter that type-checks here is read-only by construction.
    if (linkStep.expressionFilter !== undefined) {
      if (input.bindName !== undefined) {
        this.report(
          DiagnosticCodes.TARGET_WHERE_BIND,
          `a WHERE on the target and 'bind ${input.bindName}' don't combine — a bound write's identity IS the binding, so there are no candidates for the WHERE to narrow. Drop the WHERE, or the 'bind' to find the record by 'unique by (…)'`,
          input.span,
        );
      }
      typing.typeTargetFilter({
        filter: linkStep.expressionFilter,
        landing: positionRefIn(instance, written),
        alias: linkStep.alias,
      });
    }

    const root =
      instance.schema.writableRoots[written] ??
      instance.schema.createShapes?.[written] ??
      (input.purpose === 'match' ? readableMatchRoot(instance.schema.positions[written]) : undefined);
    // No second gate. Layer 13 collapsed the two promises into one: reaching
    // here means the edge declared `writable: true`, which IS the permission to
    // write along it — there is no separate create fact to re-check, and no
    // fallback onto the target's own writability (an edge that makes no promise
    // was already rejected above, rather than inheriting one from its target).
    // The link-vs-create distinction is PARKED: an edge that can only link
    // over-promises create and fails loudly at run time.
    const handle: PositionTypeRef = {
      kind: 'handle',
      instance,
      ...(instance.schema.positions[written] ? { position: written } : {}),
      resultShape: root?.resultShape ?? instance.schema.positions[written]?.properties ?? {},
      // The write shape's relationship table, so a handle to a writable-only
      // type (no minted position) can still traverse its edges — `await
      // a-[:Response]->` off an ask's `Check`. When a position IS minted the
      // hop resolves through it first; these are the same edges either way.
      ...(root?.edges !== undefined ? { edges: root.edges } : {}),
    };
    // The meta position isn't a record type, so a meta-rooted write has no
    // parent record type for required-edge satisfaction.
    const parentType = parent.kind === 'meta' ? undefined : parent.position;
    return {
      root,
      handle,
      description: `${instance.name}.${written}`,
      resolved: {
        instanceToken: instance.token,
        instanceName: instance.name,
        written,
        ...(parentType !== undefined ? { parentType } : {}),
        edgeName,
      },
    };
  }

  /**
   * A tuple-path write target: every path resolves like a linked write's,
   * the inferred written types must AGREE across paths (one record at the
   * convergence of N edges), and each path contributes a parent for
   * identity (`unique by` handle components) and required-edge
   * satisfaction. `parents` is appended in path order.
   */
  private checkTupleWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'tuple' }>,
    scope: Scope,
    parents: Array<{ type?: string; edge: string }>,
    options: { purpose: 'write' | 'match'; isBound?: boolean; bindName?: string },
  ): { root?: WritableRootSchema; handle?: PositionTypeRef; description?: string } {
    let agreed:
      | { root?: WritableRootSchema; handle?: PositionTypeRef; description?: string; instanceToken: object; written: string; pathIndex: number }
      | undefined;
    let mismatched = false;
    for (let i = 0; i < target.paths.length; i++) {
      const path = target.paths[i];
      const linked = this.checkLinkedPath(
        { path, explicitType: target.explicitType, span: path.span, ...options },
        scope,
      );
      const resolved = linked.resolved;
      if (!resolved) continue; // untyped path — stays silent (its own diagnostics already fired)
      parents.push({
        ...(resolved.parentType !== undefined ? { type: resolved.parentType } : {}),
        edge: resolved.edgeName,
      });
      if (agreed === undefined) {
        agreed = {
          ...(linked.root !== undefined ? { root: linked.root } : {}),
          ...(linked.handle !== undefined ? { handle: linked.handle } : {}),
          ...(linked.description !== undefined ? { description: linked.description } : {}),
          instanceToken: resolved.instanceToken,
          written: resolved.written,
          pathIndex: i,
        };
      } else if (
        agreed.instanceToken !== resolved.instanceToken ||
        agreed.written !== resolved.written
      ) {
        if (!mismatched) {
          mismatched = true;
          const first = target.paths[agreed.pathIndex];
          this.report(
            DiagnosticCodes.WRITE_TUPLE_MISMATCH,
            `the tuple's paths must converge on ONE written type — '${rawPath(first)}' infers ${agreed.description ?? agreed.written}, but '${rawPath(path)}' infers ${linked.description ?? resolved.written}`,
            target.span,
          );
        }
      }
    }
    if (mismatched || agreed === undefined) return {};
    return {
      ...(agreed.root !== undefined ? { root: agreed.root } : {}),
      ...(agreed.handle !== undefined ? { handle: agreed.handle } : {}),
      ...(agreed.description !== undefined ? { description: agreed.description } : {}),
    };
  }

  /**
   * The written type's declared required edges vs what this write form
   * establishes (the tuple paths / the linked-write parent / a body field
   * carrying the reference). A write that satisfies none of an entry's
   * spellings errors, listing the missing edges with the tuple spelling.
   */
  private checkRequiredEdges(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
    parents: Array<{ type?: string; edge: string }>;
    /** The graph the write lands in — the required edges' `from` types are ITS
     *  type names, and one of them may be a union. */
    handle: PositionTypeRef | undefined;
  }): void {
    const required = input.root?.requiredEdges;
    if (!required || required.length === 0) return;
    const schema = input.handle !== undefined && 'instance' in input.handle
      ? input.handle.instance.schema
      : undefined;
    // A required edge whose landing is a UNION is satisfied by a parent of ANY
    // member — that is what the union means, and `from` holds the union's
    // derived key, which no parent type can equal.
    const isFrom = (parentType: string, from: string): boolean =>
      parentType === from || schema?.unions?.[from]?.includes(parentType) === true;
    /** `from` as an author reads it — never the derived key. */
    const fromDisplay = (from: string): string => schema?.unionDisplayNames?.[from] ?? from;
    const fieldNames = new Set(input.write.fields.map((f) => f.name));
    // A parent satisfies an entry by TYPE (the primary rule — two scoping
    // parents may share an outbound edge name, so the name alone can't
    // distinguish them); an UNTYPED parent gets the benefit of an
    // edge-name match. A body field named like the edge is the field
    // spelling of the same connection.
    const missing = required.filter(
      (entry) =>
        !input.parents.some(
          (p) =>
            (p.type !== undefined && isFrom(p.type, entry.from))
            || (p.type === undefined && p.edge === entry.edge),
        ) && !fieldNames.has(entry.edge),
    );
    if (missing.length === 0) return;
    const describeMissing = missing
      .map((m) => `'${m.edge}' (a ${fromDisplay(m.from)} parent)`)
      .join(', ');
    const spelling = missing.map((m) => `<${fromDisplay(m.from)} handle>-[:${m.edge}]->`).join(', ');
    this.report(
      DiagnosticCodes.WRITE_MISSING_REQUIRED_EDGE,
      `${input.rootDescription} requires ${missing.length === 1 ? 'an edge' : 'edges'} this write doesn't establish: ${describeMissing} — write the record at the convergence of its required edges, e.g. write (${spelling}) { … }`,
      input.write.target.span,
    );
  }

  /**
   * Required FIELDS (scalars — required edges are the sibling check):
   * a write that can create must give every target-required field a
   * value, or the target rejects the create at runtime. A required
   * reference satisfied structurally (parent link, tuple path) is the
   * edge check's business and excluded here by name.
   *
   * Missing entirely → error (the run WILL fail on the create branch). A field
   * PRESENT but possibly-absent (an unguarded `DATE.PARSE`, a partial-receipt
   * read) is no longer a bespoke source-regex heuristic here — typed absence
   * (`T | absent`) propagates and fires MOV_ABSENT_REQUIRED at the write-field
   * value site (checkWriteFields), discharged by `?:`, a gate, or an `==` guard
   * (F13/P20; layer 6).
   */
  private checkRequiredFields(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
    parents: Array<{ type?: string; edge: string }>;
  }): void {
    const required = input.root?.requiredFields;
    if (!required || required.length === 0) return;
    const bodyFields = new Map(input.write.fields.map((f) => [f.name, f]));
    const parentEdges = new Set(input.parents.map((p) => p.edge));
    const missing = required.filter(
      (name) => !bodyFields.has(name) && !parentEdges.has(name),
    );
    if (missing.length > 0) {
      this.report(
        DiagnosticCodes.WRITE_MISSING_REQUIRED_FIELD,
        `${input.rootDescription} requires ${missing.length === 1 ? 'a field' : 'fields'} this write never sets: ${missing
          .map((m) => `'${m}'`)
          .join(', ')} — the target rejects creates without ${missing.length === 1 ? 'it' : 'them'}; add ${missing.length === 1 ? 'it' : 'them'} to the write body`,
        input.write.target.span,
      );
    }
  }

  /** A slot that is exactly one bare name bound to a write handle — the
   *  handle-into-reference-field nudge's trigger. */
  private bareHandleName(slot: ExprSlot, scope: Scope): string | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const resolution = scope.resolve(trimmed);
    if (resolution.kind !== 'found') return undefined;
    return resolution.symbol.posType?.kind === 'handle' ? trimmed : undefined;
  }

  // ── Link statements (the edge-only write) ──

  /**
   * `link`/`unlink` along an edge that only CREATES its target. The edge's
   * write promise covers making the relationship as part of writing the
   * record; it does not cover joining two that already exist, and the system
   * is the only thing that knows which — so it says so here rather than
   * letting the run discover it.
   */
  private reportUnlinkableEdge(input: {
    edgeName: string;
    parent: PositionTypeRef;
    instanceName: string;
    root: string | undefined;
    span: Span;
    verb?: 'link' | 'unlink';
  }): void {
    const from = input.root ?? 'the record';
    this.report(
      DiagnosticCodes.LINK_UNSUPPORTED_EDGE,
      `'${input.instanceName}' makes '-[:${input.edgeName}]->' on ${describePosition(input.parent)} by WRITING along it — 'write ${from}-[:${input.edgeName}]-> { … }' creates the record and the relationship together — so there is nothing to ${input.verb ?? 'link'} two records that already exist with`,
      input.span,
    );
  }

  /**
   * The same gate for the BARE-HANDLE forms (`link a -[:e]-> b`, `unlink a
   * -[:e]-> b`), which resolve no path: look the edge up on the from side's
   * own position and refuse it where the system says it cannot be linked.
   * Everything else about those forms stays the runtime's, as before.
   */
  private checkBareLinkEdge(
    input: { from: string; edge: string; span: Span; verb: 'link' | 'unlink' },
    scope: Scope,
  ): void {
    const symbol = scope.resolve(input.from);
    if (symbol.kind !== 'found') return;
    const fromType = this.symbolPositionType(symbol.symbol);
    // Only a type that BELONGS to an instance can carry a system's promise —
    // a run-local node or an extract node has no adapter to have made one.
    if (fromType === undefined || !('instance' in fromType)) return;
    const edge = positionSchemaOfRef(fromType)?.edges[input.edge];
    if (edge?.linkable !== false) return;
    this.reportUnlinkableEdge({
      edgeName: input.edge,
      parent: fromType,
      instanceName: fromType.instance.name,
      root: input.from,
      span: input.span,
      verb: input.verb,
    });
  }

  /**
   * `link a -[:e]-> b` — mirror name checks plus the one edge fact a system
   * can state (the runtime owns the rest of graph/edge validation, as it does
   * for `unlink`). A link onto a node this run built is checked structurally.
   *
   * `link a -[:e]-> { … }` is `match a-[:e]-> { … }` then the link, and is
   * checked as exactly that: the parser has already made the body the match
   * of the hop (with the all-fields identity where the author named none), so
   * `checkMatch` checks it as it checks any match, and the link is then the
   * handle form's, onto the record found. Returns the match's handle, which
   * is what a bound link binds.
   */
  private checkLink(link: LinkExpression, scope: Scope, binding?: string): PositionTypeRef | undefined {
    const fromSymbol = this.resolveName(link.from, link.span, scope);
    const fromType = fromSymbol !== undefined ? this.symbolPositionType(fromSymbol) : undefined;
    if (fromType?.kind === 'local') {
      if (link.to.kind === 'match') {
        this.report(
          DiagnosticCodes.NODE_LINK_BODY,
          `'${link.from}' is ${fromType.label} this run built, so a body here would find among what '${link.edge}' already holds — anything it found is linked already. To pick one of them out, 'match ${link.from}-[:${link.edge}]-> { … }'; to link a record you hold, 'link ${link.from} -[:${link.edge}]-> <name>'`,
          link.to.match.span,
        );
        return undefined;
      }
      this.checkLocalLink({ ...link, to: link.to }, fromType, scope);
      return undefined;
    }
    const found =
      link.to.kind === 'match'
        ? this.checkMatch(link.to.match, scope, {
            ...(binding !== undefined ? { binding } : {}),
            impliedIdentity: link.to.impliedIdentity,
          })
        : undefined;
    // A link writes an EDGE, so it writes the graph the edge's source is in.
    this.noteNamedEffect('write', link.from, scope);
    if (link.to.kind === 'handle') this.resolveName(link.to.name, link.span, scope);
    this.checkBareLinkEdge(
      { from: link.from, edge: link.edge, span: link.span, verb: 'link' },
      scope,
    );
    this.recordNode({
      kind: 'link',
      span: link.span,
      scope,
      from: link.from,
      edge: link.edge,
      to:
        link.to.kind === 'handle'
          ? { kind: 'handle', name: link.to.name }
          : { kind: 'match', span: link.to.match.span },
    });
    return found;
  }

  /**
   * `link sent -[:messages]-> one` where `sent` is a node this run built — the
   * landing is APPENDED to an edge the literal declared.
   *
   * The literal is the whole of what the node has, so an edge it never declared
   * is a typo, and a `lazy` entry has no array to append to. The landing itself
   * is checked STRUCTURALLY against what the edge says it lands on, exactly as
   * an argument is checked against a parameter: a local node belongs to no
   * graph, so there is no instance to compare and nothing nominal to compare it
   * by.
   *
   * NO EFFECT ROW ENTRY. The row carries the graphs a run touches, and this one
   * touches none: run-local mutation is not an effect on the world.
   *
   */
  private checkLocalLink(
    link: LinkExpression & { to: Extract<LinkTarget, { kind: 'handle' }> },
    from: Extract<PositionTypeRef, { kind: 'local' }>,
    scope: Scope,
  ): void {
    const toSymbol = this.resolveName(link.to.name, link.span, scope);
    const edge = from.edges?.[link.edge];
    if (edge === undefined) {
      this.reportUndeclaredLocalEdge({
        from,
        edgeName: link.edge,
        span: link.span,
        subject: link.from,
      });
      return;
    }
    if (edge.deferred === true) {
      this.report(
        DiagnosticCodes.NODE_EDGE_DEFERRED,
        `'${link.edge}' is a lazy entry — its landings come from a walk that runs again at every read, so an appended one would be gone by the next. Declare a separate edge for what this run writes ('${link.edge}Written: <source-[:Edge]->>')`,
        link.span,
      );
      return;
    }
    this.recordNode({
      kind: 'link',
      span: link.span,
      scope,
      from: link.from,
      edge: link.edge,
      to: { kind: 'handle', name: link.to.name },
    });
    const toType = toSymbol !== undefined ? this.symbolPositionType(toSymbol) : undefined;
    const target = edge.target;
    if (toType === undefined || target === undefined) return;
    // Two comparisons, and which one applies is a fact about the EDGE's type.
    // An edge typed by a declared node names a structure no system owns, so
    // every landing is judged by what it offers; a synthesised node takes that
    // road whatever the edge says, because it belongs to no graph and the
    // nominal test could only ever say no.
    const misfit =
      edge.structural === true || toType.kind === 'local'
        ? structuralMisfit(toType, target)
        : undefined;
    if (misfit !== undefined) {
      this.report(
        DiagnosticCodes.NODE_LINK_SHAPE,
        `'${link.edge}' lands on ${describePosition(target)}, and ${misfit}`,
        link.span,
      );
      return;
    }
    if (
      edge.structural !== true
      && toType.kind !== 'local'
      && positionsMatch(toType, target) === false
    ) {
      this.report(
        DiagnosticCodes.NODE_LINK_SHAPE,
        `'${link.edge}' lands on ${describePosition(target)}, but '${link.to.name}' is ${describePosition(toType)}`,
        link.span,
      );
    }
  }

  // ── Traversal heads & blocks ──

  /** Validates the head path, resolves its references, returns its hop aliases and probe steps. */
  private checkPathHead(head: PathHead, scope: Scope): HeadInfo {
    const aliases = extractHopAliases(head.hopsRaw);
    const root = head.root;
    const rootName = pathRootName(head);
    let rootSymbol: ScopeSymbol | undefined;
    if (rootName !== undefined) {
      rootSymbol = this.resolveName(rootName, head.span, scope);
    }
    // An EXPRESSION root is checked as the expression it is — name-resolved,
    // parsed, and read for its value type — before a single hop is walked. A
    // record IS a value type, so ONE rule decides both roots: the head starts
    // at whatever record the root holds, whether a name holds it or an
    // expression does.
    const rootValueType =
      root?.kind === 'expression'
        ? this.checkExprSlot(root.expr, scope).valueType
        : rootSymbol?.bindingPlane === 'scalar'
          // Walking a held tuple reads it as the list of records it widens to.
          ? this.readHeldValue(rootSymbol.fieldType, head.span)
          : undefined;
    // The hops are the same hops whatever the root is, so the probe roots them
    // at a NAME the formula grammar accepts — the author's, or the stand-in an
    // expression root probes as.
    const probeText = `${probePathHead(head)}.\`__movement_head_probe__\``;
    let parsed: Expression | undefined;
    try {
      parsed = parseMovementExpression(probeText);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      if (e.code !== undefined) {
        this.report(e.code, e.message, head.span);
      } else {
        this.report(DiagnosticCodes.EXPR_PARSE, `Invalid traversal path: ${e.message}`, head.span);
      }
    }
    let steps: TraversalStep[] | undefined;
    if (parsed) {
      const names = collectExpressionNames(parsed);
      const local = new Set([...aliases, ...names.aliases]);
      // Already resolved above — the name by `resolveName`, the expression by
      // `checkExprSlot`, which resolved every name inside it.
      if (rootName !== undefined) local.add(rootName);
      if (root?.kind === 'expression') local.add(EXPRESSION_ROOT_PROBE);
      for (const ref of new Set(names.refs)) {
        if (!local.has(ref)) this.resolveName(ref, head.span, scope);
      }
      // The arrow half of the retired block read-back (`orgs-[o:co]->`).
      this.reportBlockReadBack(names, scope, head.span);
      // The calls in the hops' WHERE, ORDER BY and settings resolve by scope as
      // a slot's do (version 3); they are read once per landing.
      if (since(this.languageVersion, 3)) {
        let tree: MExpr | undefined;
        try {
          tree = parseExpression(probeText);
        } catch (e) {
          if (!(e instanceof ExpressionSyntaxError)) throw e;
        }
        if (tree !== undefined) {
          // The probe reads a field off the head's walk; that walk is the head.
          const walk = tree.kind === 'member' ? tree.object : undefined;
          this.checkExpressionTree(tree, {
            spanOf: () => head.span,
            extentOf: (at) => headHopsExtent(head, at),
            scope,
            writeField: false,
            ...(walk !== undefined ? { head: walk } : {}),
          });
        }
      }
      // A `_resources`-headed path parses to resource_traverse (no steps) —
      // it stays untyped; a plain hop chain yields the steps to type-walk.
      if (parsed.type === 'traverse') steps = parsed.steps;
    }
    // A BARE ADAPTER as a path root — `write kg-[:Company]-> { … }` against an
    // import nobody constructed. It used to degrade to silence: the root has no
    // position type, so the walk and every field check below simply skipped,
    // and a movement written against the ambient graph passed the checker while
    // meaning nothing. Silent degradation is the absence of a guarantee, so it
    // is reported at the root the author wrote — the same diagnosis a parameter
    // type and a `listen to` already give, now at the third place an instance
    // name can appear.
    if (rootSymbol?.kind === 'adapter' && rootName !== undefined) {
      const adapterName = rootSymbol.importedName ?? rootSymbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${rootName}' is an adapter, not an instance — construct and name an instance first, then walk or write from the name: 'go = ${this.constructionCall(adapterName)}' … 'go${head.hopsRaw ?? ''}'`,
        head.span,
      );
    }
    // Where the walk starts. A name bound on the arrow plane says so directly;
    // a name bound on the VALUE plane says so through its type, because a
    // record IS a value type — `both = [one, two]`, `first = AT(rows, 0)`,
    // `found = MAP(pieces, (p) => { return extract … })` all walk, and they all
    // sit on the dot plane. One record or a list of them is the same walk: a
    // hop is many-valued either way, so plurality lives in the traversal.
    const rootType =
      (rootSymbol ? this.symbolPositionType(rootSymbol) : undefined)
      ?? recordHeadPosition(rootValueType);
    // A root that is a VALUE and NOT a record — a name bound to one, or an
    // expression that computes one. There are no positions on the value plane —
    // a value type is text, a number, a list or a dict of them — so a hop off a
    // root whose value type is KNOWN can never land anywhere, and it is said
    // here rather than at run time, after everything that produced the value
    // has already been paid for.
    //
    // A value whose type is NOT known stays silent and runs (the honesty rule):
    // a plugin whose output nobody declared, an untyped import.
    if (
      steps !== undefined &&
      root !== undefined &&
      rootValueType !== undefined &&
      !holdsRecords(rootValueType)
    ) {
      this.report(
        DiagnosticCodes.HEAD_NOT_A_POSITION,
        `'${spellPathRoot(root)}' is ${describeFieldType(rootValueType)}, and a hop walks from a POSITION — there is nothing here to hop from. A head starts at a record, an extraction's result, or a list of them ('found = MAP(pieces, (p) => { return extract … })'); read a value with the value functions instead.`,
        head.span,
      );
    }
    // The head, recorded HERE — the one place the compiler reads a path — so a
    // renderer never has to read the syntax back. Landings are attached by the
    // caller that walks the chain; it is the only one that knows them.
    const recorded = this.recordNode<RecordedTraversal>({
      kind: 'traversal',
      span: head.span,
      scope,
      ...(rootName !== undefined ? { root: rootName } : {}),
      ...(traversalFrom(rootType) !== undefined ? { from: traversalFrom(rootType) } : {}),
      steps: steps ?? [],
      landings: [],
    });
    return {
      aliases,
      steps,
      rootType,
      ...(recorded !== undefined ? { recorded } : {}),
    };
  }

  /**
   * Finishes a recorded head with where its hops landed. An ALIASED hop's
   * landing is the one the walk bound the alias to; the last hop's is the walk's
   * own destination. Anything else stays absent — the walk never named it, and
   * inventing a landing would be the story claiming a fact the checker has not
   * got.
   */
  private attachLandings(
    head: HeadInfo,
    typing: ExpressionTyping,
    landed: PositionTypeRef | undefined,
  ): void {
    const { recorded, steps } = head;
    if (recorded === undefined || steps === undefined) return;
    recorded.landings = steps.map((step, index) => {
      const alias = step.type === 'edge' || step.type === 'meta_edge' ? step.alias : undefined;
      if (alias !== undefined) return recordedLanding(typing.locals.get(alias));
      return index === steps.length - 1 ? recordedLanding(landed) : undefined;
    });
  }

  /**
   * Checks the block and returns what ONE iteration of it hands back. A bound
   * block's value is those returns collected (`checkRValue`'s `block` case);
   * an unbound one runs for its effects and its returns go nowhere.
   */
  private checkTraversalBlock(
    block: TraversalBlock,
    scope: Scope,
    assignedName: string | undefined,
  ): ReturnShape & { headOrdering: CollectionOrder } {
    const head = this.checkPathHead(block.head, scope);
    // Type the hop chain (check 4) and harvest per-alias position types.
    // Rootless heads are relative to the enclosing position, which M2b does
    // not track — they walk untyped.
    const typing = this.slotTyping(scope, block.head.span);
    const landed =
      head.steps && head.rootType !== undefined
        ? typing.walkSteps(head.rootType, head.steps)
        : undefined;
    // The head decides what the block's collected returns are: iterations run
    // in the order the head yields positions, so the collection is ordered iff
    // the head is.
    const headOrdering = typing.lastOrdering;
    this.attachLandings(head, typing, landed);
    const blockScope = new Scope('traversal', scope);
    this.recordFrame('traversal', block.span, blockScope);
    for (const alias of head.aliases) {
      const aliasType = typing.locals.get(alias);
      this.declareAuthored(
        blockScope,
        {
          name: alias,
          kind: 'alias',
          span: block.head.span,
          ...(aliasType ? { posType: aliasType } : {}),
        },
        block.head.span,
      );
    }
    const returned = this.checkBody(block.body, blockScope, {
      what: assignedName !== undefined ? `the block bound to '${assignedName}'` : 'this block',
      returns: [],
    });
    // Bindings made inside the block are NOT visible outside it; remember them
    // so a later read of one is diagnosed as out-of-scope rather than unknown.
    // Nothing else escapes: the ONE way a value leaves a block is `return`.
    for (const [name, symbol] of blockScope.symbols) {
      if (symbol.kind === 'alias') continue;
      scope.escaped.set(name, assignedName);
    }
    for (const [name, blockName] of blockScope.escaped) {
      if (!scope.escaped.has(name)) scope.escaped.set(name, blockName);
    }
    return { ...returned, headOrdering };
  }

  // ── Calls ──

  /**
   * A call — and its value, which is what the callee RETURNS. A callee with no
   * `return` hands nothing back: its call is a statement, and the sites that
   * USE a call's value (`boundCallShape`) refuse it there rather than binding a
   * name to nothing.
   */
  private checkCall(
    statement: CallStatement,
    scope: Scope,
    binding?: string,
  ): ReturnShape {
    const resolution = this.calleeResolution(statement.callee, scope);
    const recorded = this.recordNode<RecordedCall>({
      kind: 'call',
      span: statement.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      callee: statement.callee,
      isMovement: resolution.kind === 'found' && resolution.symbol.kind === 'movement',
    });
    let params: DeclaredParams | undefined;
    let value: ReturnShape = UNKNOWN_RETURN;
    if (resolution.kind !== 'found') {
      this.reportCalleeUnresolved(statement.callee, statement.span, resolution, scope);
      // Something runs here and nobody can say what: the row is a lower bound.
      this.effects?.markPartial();
    } else {
      const callee = resolution.symbol;
      const closure = this.calledClosure(callee);
      if (callee.kind === 'movement') {
        value = this.movementReturnType(callee);
        // Bottom-up over the call graph: a call adds what the callee does.
        this.effects?.absorb(this.movementEffects(callee));
        if (callee.arity !== undefined && statement.args.length !== callee.arity) {
          this.report(
            DiagnosticCodes.CALL_ARITY,
            `'${statement.callee}' takes ${callee.arity} argument${callee.arity === 1 ? '' : 's'}, got ${statement.args.length}`,
            statement.span,
          );
        }
        params = this.movementParams(callee);
        // What its body needs of each record argument is learned on the
        // inference walk, which a declared return type otherwise skips.
        if (callee.movement !== undefined && callee.movement.returnType === undefined) this.inferMovement(callee);
      } else if (callee.kind === 'plugin') {
        // One function sort: a plugin is a function whose body isn't visible.
        value = this.checkPluginApplication(statement, callee, scope);
      } else if (closure !== undefined) {
        // A closure bound to a name is a function: its signature is its
        // parameters, its value what its body returns, and calling it does
        // what its body does.
        value = closure.returns;
        this.effects?.absorb(closure.effects);
        this.noteUndeclaredSelfCall(callee, statement.span);
        if (statement.args.length !== closure.params.length) {
          this.report(
            DiagnosticCodes.CALL_ARITY,
            `'${statement.callee}' takes ${closure.params.length} argument${closure.params.length === 1 ? '' : 's'}, got ${statement.args.length}`,
            statement.span,
          );
        }
        params = closure.params.map(({ name, ...type }) => ({ name, type }));
      } else {
        // Either an unlinked file import (a body nobody parsed) or a name that
        // is not callable at all. Both leave the row a lower bound.
        this.effects?.markPartial();
        if (callee.kind !== 'fileImport') {
          // A file import may be a movement — M3 resolves it; give it the benefit of the doubt.
          this.report(
            DiagnosticCodes.CALL_NOT_MOVEMENT,
            `'${statement.callee}' is ${describeKind[callee.kind]}, not a movement — only movements are called`,
            statement.span,
          );
        }
      }
    }
    const bound = this.checkArgumentBindings({
      callee: statement.callee,
      args: statement.args,
      params,
      span: statement.span,
    });
    if (recorded !== undefined && params !== undefined) {
      recorded.argParams = bound.map(b => b.param?.name);
    }
    for (const { arg, param, index } of bound) {
      this.checkCallArg(statement.callee, arg, param, index, scope);
    }
    return value;
  }

  /** One argument: check it in its own right, then check that it FITS the
   *  parameter it binds. The forms differ only in how the argument's type is
   *  arrived at. `index` is the argument's place, for a positional one's
   *  diagnostics — an argument the author did not name is named for them. */
  private checkCallArg(
    callee: string,
    arg: CallArg,
    param: BoundParam | undefined,
    index: number,
    scope: Scope,
  ): void {
    const fit: ArgFit = { callee, param, index, positional: arg.name === undefined };
    switch (arg.kind) {
      case 'expr': {
        const { valueType, parsed } = this.checkExprSlot(arg.expr, scope);
        const argType = this.bareSlotPositionType(arg.expr, scope);
        if (param?.type.fieldType !== undefined) {
          this.checkValueArgFit(fit, param.type.fieldType, argType !== undefined ? recordOf(argType) : valueType, {
            span: arg.expr.span,
            literal: isRecordLiteralSlot(arg.expr),
            ...(parsed !== undefined ? { parsed } : {}),
            slot: arg.expr,
          });
          return;
        }
        this.refuseValueForPosition(fit, argType === undefined ? valueType : undefined, arg.expr.span);
        this.checkCallArgFit(fit, argType, param?.type.posType, arg.expr.span);
        this.checkArgFieldsInHand(fit, argType ?? recordIn(valueType)?.position, arg.expr.span);
        return;
      }
      case 'write': {
        const handle = this.checkWrite(arg.write, scope, { isBound: true });
        if (param?.type.fieldType !== undefined) {
          this.checkValueArgFit(fit, param.type.fieldType, recordOf(handle), { span: arg.write.span });
          return;
        }
        this.checkCallArgFit(fit, handle, param?.type.posType, arg.write.span);
        this.checkArgFieldsInHand(fit, handle, arg.write.span);
        return;
      }
      case 'node': {
        const synthesised = this.checkNodeLiteral(arg.node, scope);
        if (param?.type.fieldType !== undefined) {
          this.checkValueArgFit(fit, param.type.fieldType, recordOf(synthesised), { span: arg.node.span });
          return;
        }
        this.checkCallArgFit(fit, synthesised, param?.type.posType, arg.node.span);
        this.checkArgFieldsInHand(fit, synthesised, arg.node.span);
        return;
      }
      case 'closure':
      case 'type':
        // What `MAP` and `MEMBERS` take. A movement's parameter holds a value
        // or a record, and a function or a type is not yet a value.
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `The argument${describeArgPlace(fit)} to '${callee}' is ${arg.kind === 'closure' ? 'a function written in place' : 'a type'}, which is not a value an argument can carry — only a built-in that takes one (MAP, FILTER, REDUCE, GROUPBY, KEYBY, MEMBERS) is handed one`,
          arg.span,
        );
        return;
      case 'call': {
        // A built-in called here (`log(UPPER(x))`) is the value it computes —
        // an ordinary expression argument.
        const reading = this.readCallAt(arg.call, scope, 'argument');
        if (reading.kind === 'value') {
          this.checkCallArg(
            callee,
            { kind: 'expr', ...(arg.name !== undefined ? { name: arg.name } : {}), expr: reading.expr },
            param,
            index,
            scope,
          );
          return;
        }
        if (reading.kind === 'refused') {
          this.reportCallRefusal(reading.refusal);
          return;
        }
        // The utility idiom: one movement's value is another's argument. Its
        // value is a synthesised node like any other, so it fits the parameter
        // by the same STRUCTURAL road — a node belongs to no graph, and there
        // is no third rule for one that came out of a call.
        const value = this.checkCall(arg.call, scope);
        if (param?.type.fieldType !== undefined) {
          this.checkValueArgFit(fit, param.type.fieldType, valueOfReturn(value), { span: arg.call.span });
          return;
        }
        this.refuseValueForPosition(fit, value.posType === undefined ? value.fieldType : undefined, arg.call.span);
        this.checkCallArgFit(fit, value.posType, param?.type.posType, arg.call.span);
        this.checkArgFieldsInHand(fit, value.posType, arg.call.span);
        return;
      }
    }
  }

  /**
   * A record argument against what the callee's body needs of it
   * (`FieldsNeed`): TypeScript's parameter-versus-argument check, on whether
   * the record's fields are in hand. A record read from its system one field
   * at a time does not satisfy a parameter whose body serialises or spreads
   * it, nor does a record whose children are the system's (a system write's
   * result) satisfy one whose body walks to a child and serialises that. The
   * calling function's own parameter, passed on, takes on the callee's need
   * instead — its callers answer for it.
   */
  private checkArgFieldsInHand(fit: ArgFit, arg: PositionTypeRef | undefined, span: Span): void {
    const need = parameterNeedOf(fit.param?.type.posType);
    if (need === undefined || arg === undefined) return;
    const shortfall = this.fieldsInHandShortfall(need, arg, `passes it to '${fit.callee}' as '${need.param}' (line ${span.start.line})`);
    if (shortfall === undefined) return;
    this.report(
      DiagnosticCodes.CALL_ARG_OPAQUE_RECORD,
      `'${fit.callee}' needs every field of ${shortfall.what} in hand — its body ${shortfall.why} — and this argument is ${describePosition(arg)}, ${shortfall.whose}${describeArgPlace(fit)}. Copy the fields it needs into a record the program holds and pass that ('node { name: r.name, … }'), or have '${fit.callee}' read the fields it uses one by one`,
      span,
    );
  }

  /**
   * What `record` falls short of `need` by, if anything: the fields of the
   * record itself, or of the records reached through its edges. A record
   * that is itself a parameter of the function being checked, with its
   * fields in hand there, files `need` as its own (`passedTo`, said `at`).
   */
  private fieldsInHandShortfall(
    need: FieldsNeed,
    record: PositionTypeRef,
    at: string,
  ): { what: string; why: string; whose: string } | undefined {
    const isDeclared = (token: object) => this.declaredShapeTokens.has(token);
    const inHand = holdsFieldsInHand(record, isDeclared);
    const own = parameterNeedOf(record);
    if (inHand && own !== undefined) {
      if (own !== need && !own.passedTo.some(onward => onward.need === need)) own.passedTo.push({ need, at });
      return undefined;
    }
    const why = inHand ? undefined : fieldsNeededBy(need, 'record');
    if (why !== undefined) {
      return { what: `'${need.param}'`, why, whose: 'whose fields are read from its system one at a time' };
    }
    if (holdsReachedFieldsInHand(record, isDeclared)) return undefined;
    const whyReached = fieldsNeededBy(need, 'reached');
    if (whyReached === undefined) return undefined;
    return {
      what: `the records '${need.param}' leads to`,
      why: whyReached,
      whose: "whose linked records are the system's, read one field at a time",
    };
  }

  /**
   * A VALUE handed to a parameter that takes a record POSITION. The engine has
   * always refused it at run time ("arguments are positions"); said here, where
   * it is written, once the value's type is known and holds no records.
   */
  private refuseValueForPosition(fit: ArgFit, valueType: FieldType | undefined, span: Span): void {
    const posType = fit.param?.type.posType;
    if (posType === undefined || valueType === undefined || holdsRecords(valueType)) return;
    // Said at save from version 3, where a parameter may take a value instead;
    // an older pin keeps the run-time refusal it always had.
    if (!since(this.languageVersion, 3)) return;
    this.report(
      DiagnosticCodes.CALL_ARG_TYPE,
      `'${fit.callee}' expects ${describePosition(posType)}${describeArgPlace(fit)}, but this argument is ${describeFieldType(valueType)} — a record parameter takes a record (a bound record, a node, or a write); declare the parameter as a value type ('<text>', '<{ … }>') to pass a value`,
      span,
    );
  }

  /**
   * A value argument against a VALUE parameter — TypeScript's assignability,
   * with its excess-property check: a record LITERAL passed to a record
   * parameter may not carry a key the parameter does not declare, and every
   * argument must carry the keys the parameter requires. A value that may be
   * absent does not fill a parameter that requires one (`string | undefined`
   * is not `string`); an optional key takes one.
   */
  private checkValueArgFit(
    fit: ArgFit,
    paramType: FieldType,
    argType: FieldType | undefined,
    options: ArgValueOptions,
  ): void {
    if (argType === undefined) return;
    const { span } = options;
    const expected = `'${fit.callee}' expects ${describeFieldType(paramType)}${describeArgPlace(fit)}`;
    // A string LITERAL is its own type — `"warm"` is `"warm"`, which TypeScript
    // assigns to `"brisk" | "warm"` — so against a closed set it is a
    // membership check, with the enum's own did-you-mean.
    const literal = stringLiteralOf(options.parsed);
    if (literal !== undefined && this.reportEnumLiteral(literal, stripAbsent(paramType), span)) return;
    if (isMaybeAbsent(argType) && !isMaybeAbsent(paramType)) {
      this.report(
        DiagnosticCodes.CALL_ARG_TYPE,
        `${expected}, but this argument may be absent — fill it first ('COALESCE(x, …)') or declare the parameter as a record key that may be left out ('{ key?: … }')`,
        span,
      );
      return;
    }
    const param = stripAbsent(paramType);
    const arg = stripAbsent(argType);
    if (isDictType(param) && param.shape !== undefined) {
      this.checkRecordArgFit(expected, param.shape, arg, options);
      return;
    }
    if (!fieldAssignable(arg, param)) {
      const { slot } = options;
      const asList =
        slot !== undefined && isListType(param) && fieldAssignable(arg, param.of)
          ? { span: slot.span, text: listArgumentRewrite(slot) }
          : undefined;
      this.reportWithFix({
        code: DiagnosticCodes.CALL_ARG_TYPE,
        message: `${expected}, but this argument is ${describeFieldType(arg)}${asList !== undefined ? ` — pass it as a list: '${asList.text}'` : ''}`,
        span,
        ...(asList !== undefined ? { fix: { edits: [asList] } } : {}),
      });
    }
  }

  /** A value against a record parameter's declared keys. */
  private checkRecordArgFit(
    expected: string,
    keys: Record<string, FieldType | null>,
    arg: FieldType,
    options: ArgValueOptions,
  ): void {
    const { span } = options;
    if (!isDictType(arg)) {
      this.report(DiagnosticCodes.CALL_ARG_TYPE, `${expected}, but this argument is ${describeFieldType(arg)}`, span);
      return;
    }
    const required = Object.entries(keys)
      .filter(([, type]) => type !== null && !isMaybeAbsent(type))
      .map(([key]) => key);
    const supplied = arg.shape;
    // Keys that are data, not program text: nothing says which are there.
    if (supplied === undefined) {
      if (required.length > 0) {
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `${expected}, but this argument is ${describeFieldType(arg)}, whose keys are data — nothing says it has ${required.map(k => `'${k}'`).join(', ')}`,
          span,
        );
      }
      return;
    }
    const missing = required.filter(key => !Object.hasOwn(supplied, key));
    if (missing.length > 0) {
      this.report(
        DiagnosticCodes.CALL_ARG_TYPE,
        `${expected}, but this argument is missing ${missing.length === 1 ? 'the key' : 'the keys'} ${missing.map(k => `'${k}'`).join(', ')}`,
        span,
      );
    }
    if (options.literal === true) {
      const excess = Object.keys(supplied).filter(key => !Object.hasOwn(keys, key));
      if (excess.length > 0) {
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `${expected}, which has no ${excess.length === 1 ? 'key' : 'keys'} ${excess.map(k => `'${k}'`).join(', ')}${didYouMean(excess[0], Object.keys(keys))}`,
          span,
        );
      }
    }
    const written = options.parsed?.type === 'object' ? options.parsed.entries : [];
    for (const [key, keyType] of Object.entries(keys)) {
      const given = supplied[key];
      if (keyType === null || given === undefined || given === null) continue;
      const literal = stringLiteralOf(
        written.find((entry): entry is ObjectEntry => !isObjectSpread(entry) && entry.key === key)?.value,
      );
      if (literal !== undefined && this.reportEnumLiteral(literal, stripAbsent(keyType), span)) continue;
      if (isMaybeAbsent(given) && !isMaybeAbsent(keyType)) {
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `${expected}, and its key '${key}' is required, but the value given for it may be absent`,
          span,
        );
        continue;
      }
      if (!fieldAssignable(given, keyType)) {
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `${expected}, and its key '${key}' takes ${describeFieldType(stripAbsent(keyType))}, but the value given for it is ${describeFieldType(stripAbsent(given))}`,
          span,
        );
      }
    }
  }

  /**
   * A string literal against a CLOSED option set — the enum check every
   * literal-against-enum site shares. True when the target is such a set (the
   * literal has then been judged); false leaves the ordinary fit to the caller.
   */
  private reportEnumLiteral(literal: string, target: FieldType, span: Span): boolean {
    if (!isEnumType(target)) return false;
    const diagnostic = checkEnumLiteral(literal, target);
    if (diagnostic?.severity === 'warning') this.reportWarning(diagnostic.code, diagnostic.message, span);
    else if (diagnostic) this.report(diagnostic.code, diagnostic.message, span);
    return true;
  }

  /**
   * Binds a call's arguments to its callee's parameters — by name, or by
   * declared order — and checks the binding: every named argument names a
   * parameter, every parameter is supplied, no parameter is supplied twice.
   * Unknown signatures (unresolved callees, file imports the linker didn't
   * resolve) skip the name checks entirely.
   */
  private checkArgumentBindings(input: {
    callee: string;
    args: CallArg[];
    params: DeclaredParams | undefined;
    span: Span;
    /** PARTIAL application (a callback's fixed arguments): an unsupplied
     *  parameter is not missing — it is what the caller supplies later. */
    partial?: boolean;
  }): Array<{ arg: CallArg; param: BoundParam | undefined; index: number }> {
    const { callee, args, params, span } = input;
    const seen = new Set<string>();
    for (const arg of args) {
      if (arg.name === undefined) continue;
      if (seen.has(arg.name)) {
        this.report(
          DiagnosticCodes.CALL_ARG_DUPLICATE,
          `Duplicate argument '${arg.name}' — each of '${callee}'s parameters is supplied once`,
          callArgSpan(arg),
        );
      }
      seen.add(arg.name);
    }
    if (!params) return args.map((arg, index) => ({ arg, param: undefined, index }));
    const paramNames = params.map(p => p.name);
    const byName = new Map(params.map(p => [p.name, p]));
    const bound = argumentBindings(args, paramNames).map(({ arg, param }, index) => ({
      arg,
      param: param !== undefined ? byName.get(param) : undefined,
      index,
    }));
    for (const arg of args) {
      if (arg.name !== undefined && !byName.has(arg.name)) {
        this.report(
          DiagnosticCodes.CALL_ARG_UNKNOWN,
          `'${arg.name}' is not a parameter of '${callee}' — its parameters are: ${paramNames.join(', ') || '(none)'}`,
          callArgSpan(arg),
        );
      }
    }
    // A positional argument past the last parameter is the arity error the
    // call site already reported; a parameter past the last argument is missing.
    const supplied = new Set(bound.flatMap(b => (b.param !== undefined ? [b.param.name] : [])));
    const missing = input.partial === true ? [] : paramNames.filter(name => !supplied.has(name));
    if (missing.length > 0) {
      this.report(
        DiagnosticCodes.CALL_ARG_MISSING,
        `'${callee}' is missing ${missing.length === 1 ? 'the argument' : 'arguments'} ${missing.map(n => `'${n}'`).join(', ')} — ${isPositionalCall(args) ? `pass one argument per parameter, in order: ${callee}(${paramNames.join(', ')})` : 'supply every parameter by name'}`,
        span,
      );
    }
    return bound;
  }

  /**
   * `node { … }` — in-memory node synthesis. The type IS the literal: a
   * checker-local node (no graph, no schema to re-resolve) whose dot plane is
   * the value entries and whose arrow plane is the entries that wrote
   * literals.
   *
   * Ruling 1: nothing marks which is which — the entry's KIND decides. That is
   * why there are two entry shapes in the AST and no modifier in the grammar.
   *
   */
  private checkNodeLiteral(literal: NodeLiteral, scope: Scope): PositionTypeRef {
    if (literal.graph !== undefined) return this.checkGraphLiteral(literal, scope);
    const reads: Record<string, FieldType | undefined> = {};
    const edges: Record<string, LocalEdge> = {};
    const seen = new Set<string>();
    for (const entry of literal.entries) {
      this.noteEntryName(entry, seen);
      switch (entry.kind) {
        case 'value': {
          // The name lands on the read plane whether or not we could type it:
          // "I haven't typed this" and "there is no such entry" are different
          // facts, and only the second is an error at the read.
          reads[entry.name] = this.checkNodeValueEntry(entry, scope);
          break;
        }
        case 'nodes': {
          const landings = entry.nodes.map(node => this.checkNodeLiteral(node, scope));
          edges[entry.name] = {
            // A synthesised edge promises exactly what it is: readable, and
            // nothing else. It is not writable (there is no system behind it),
            // not awaitable (nothing will ever land later).
            schema: { target: entry.name, readable: true },
            target: this.mergeLandings(landings, entry),
          };
          break;
        }
        case 'declared': {
          // The DECLARED edge: no landings yet, and a type that says what the
          // ones `link` appends have to be. Same promises as any other
          // synthesised edge — readable, and nothing else.
          //
          // `order by <sequencing>` is the author's own sequencing claim, and
          // it reaches the set/list split by the one road every other claim
          // takes (`EdgeSchema.sequenced`, which `hopOrdering` reads). All
          // three words read back the SAME way here — a run-local edge has
          // only the order `link` appended in — so `document` and
          // `chronological` say what the author is collecting, not a second
          // sort the runtime performs.
          edges[entry.name] = {
            schema: {
              target: entry.name,
              readable: true,
              ...(entry.sequenced !== undefined ? { sequenced: entry.sequenced } : {}),
            },
            ...this.declaredEdgeLanding(entry, scope),
          };
          break;
        }
        case 'traversal': {
          // The PASS-THROUGH edge: its landings are the walked source's own
          // positions, so the edge's type IS the traversal's landing type —
          // the source's field names, unrenamed. A per-item MAPPING replaces
          // that landing with the tail literal's structure instead. `lazy`
          // changes neither; it is the same walk at a different moment.
          const landed = this.checkLazyTraversal(
            {
              head: entry.head,
              ...(entry.mapping ? { mapping: entry.mapping } : {}),
              span: entry.span,
            },
            scope,
          );
          const target =
            landed?.kind === 'local' && entry.mapping !== undefined
              ? { ...landed, label: `a '${entry.name}' landing` }
              : landed;
          edges[entry.name] = {
            schema: { target: entry.name, readable: true },
            // A head we couldn't type leaves the landing UNKNOWN — the entry is
            // still declared, so traversing it is a guess, not a bad name.
            ...(target !== undefined ? { target } : {}),
            ...(entry.lazy ? { deferred: true } : {}),
          };
          break;
        }
      }
    }
    return { kind: 'local', label: 'a node', reads, edges };
  }

  /** One entry name, once per literal — one name, one meaning. */
  private noteEntryName(entry: { name: string; span: Span }, seen: Set<string>): void {
    if (seen.has(entry.name)) {
      this.report(
        DiagnosticCodes.NODE_ENTRY_DUPLICATE,
        `'${entry.name}' is written twice in this node — each entry names one thing`,
        entry.span,
      );
    }
    seen.add(entry.name);
  }

  /** A field entry's value — its type, or undefined where it can't be typed. */
  private checkNodeValueEntry(
    entry: Extract<NodeEntry, { kind: 'value' }>,
    scope: Scope,
  ): FieldType | undefined {
    return this.nodeValueEntryType(entry, this.checkExprSlot(entry.value, scope), scope);
  }

  /** The type of a field entry whose slot `checkExprSlot` has typed. */
  private nodeValueEntryType(
    entry: Extract<NodeEntry, { kind: 'value' }>,
    { valueType, parsed }: { valueType?: FieldType; parsed?: Expression },
    scope: Scope,
  ): FieldType | undefined {
    // A NODE in a field slot is an error, not a silent untyped read — the
    // value plane is scalar, and the author meant an edge. Two discernible
    // shapes: a bare name bound on the node plane, and ONLY/FIRST/LAST over a
    // bare walk (which pick a position).
    const nodeRef = this.bareNodeSymbol(entry.value.raw, parsed, scope);
    if (nodeRef !== undefined) {
      this.report(
        DiagnosticCodes.NODE_ENTRY_NODE_VALUE,
        `'${entry.name}: ${nodeRef.name}' puts a node in a field — an entry value is a scalar. A node becomes a child by synthesis ('${entry.name}: node { … }') or by a walk ('${entry.name}: ${nodeRef.name}-[:Edge]->')`,
        entry.span,
      );
    } else if (parsed !== undefined && aggregatedBarePath(parsed) !== undefined) {
      this.report(
        DiagnosticCodes.NODE_ENTRY_NODE_VALUE,
        `'${entry.name}' is given a record — ONLY/FIRST/LAST over a bare walk pick a NODE, and an entry value is a scalar. Walk the edge instead ('${entry.name}: <source>-[:Edge]->') or aggregate a field ('ONLY(….\`Field\`)')`,
        entry.span,
      );
    }
    return valueType ?? scalarLiteralType(entry.value.raw);
  }

  // ── Graph literals ──

  /**
   * `graph<Shape> { … }` / `graph { … }` — a local graph built as a value.
   *
   * With a shape it is TypeScript's `satisfies` applied to an object literal:
   * every entry must be something the shape declares, of the type it declares,
   * and every field the shape requires must be written — only a `<T | null>`
   * field may be left out (it is then absent, which is what a write that never
   * mentions a field leaves too). The value is then OF the shape, the way
   * `const m: Message = { … }` is, so whatever reads it reads the declaration,
   * and an omitted nullable field reads as `T | absent`. Without a shape the
   * literal's own structure is its type, exactly as a node literal's is.
   *
   * Either way the type is a run-local node — a local graph — so a write, a
   * link or a delete into it is the local graph's own, never a system's.
   */
  private checkGraphLiteral(literal: NodeLiteral, scope: Scope): PositionTypeRef {
    const shape = literal.graph?.shape;
    if (shape === undefined) return this.checkGraphBody(literal, scope, undefined);
    const symbol = this.resolveName(shape.name, shape.span, scope);
    if (symbol !== undefined && symbol.kind !== 'shape') {
      this.report(
        DiagnosticCodes.GRAPH_SHAPE,
        `'graph<${shape.name}>' takes a node declaration, and '${shape.name}' is ${describeKind[symbol.kind]} — declare the structure ('node ${shape.name} { … }'), or drop '<${shape.name}>' to infer it from the literal`,
        shape.span,
      );
    }
    const root = symbol?.kind === 'shape' ? declaredRootPosition(symbol) : undefined;
    if (root?.kind !== 'position') return this.checkGraphBody(literal, scope, undefined);
    const required = { schema: root.instance.schema, position: root.position };
    const body = this.checkGraphBody(literal, scope, required);
    return shapedWithReferences(declaredLocalGraph(root.instance, root.position), body);
  }

  /**
   * One graph body, checked against the shape node it has to satisfy (none
   * without a shape) — returns the body's own inferred structure.
   */
  private checkGraphBody(
    literal: NodeLiteral,
    scope: Scope,
    required: RequiredPosition | undefined,
  ): Extract<PositionTypeRef, { kind: 'local' }> {
    const reads: Record<string, FieldType | undefined> = {};
    const edges: Record<string, LocalEdge> = {};
    // A spread whose keys nobody can name: what it supplies is checked when
    // the graph is built, so no field can be called missing here.
    let opaqueSpread = false;
    // A graph body is TypeScript's object literal: members take effect in the
    // order written, so a later one wins and a key written before a spread
    // that always supplies it is overwritten (error 2783).
    const spreads = (literal.spreads ?? []).map(source => ({ source, at: source.after }));
    const writtenFrom = (index: number): Set<string> =>
      new Set(literal.entries.slice(index).map(entry => entry.name));
    const writtenBefore = (index: number): Set<string> =>
      new Set(literal.entries.slice(0, index).map(entry => entry.name));
    const applySpreads = (index: number): void => {
      for (const { source } of spreads.filter(s => s.at === index)) {
        const earlier = writtenBefore(index);
        const keys = this.checkGraphSpread(source, { scope, required, written: writtenFrom(index), earlier });
        if (keys === undefined) {
          opaqueSpread = true;
          continue;
        }
        const mayBeAbsent = keys.mayBeAbsent === true;
        for (const name of [...Object.keys(keys.reads), ...Object.keys(keys.edges)]) {
          if (!mayBeAbsent && earlier.has(name)) {
            this.report(
              DiagnosticCodes.MAP_KEY_OVERWRITTEN,
              `'${name}' is written before '...${source.source}', which always has '${name}', so the spread overwrites it — move '${name}: …' after the spread to override it, or drop it`,
              source.span,
            );
          }
          const held = Object.hasOwn(reads, name) || Object.hasOwn(edges, name);
          if (mayBeAbsent && held) {
            // Absent, the spread copies nothing and the earlier member stays.
            const before = reads[name];
            const type = keys.reads[name];
            if (before !== undefined && type !== undefined) {
              reads[name] = valueUnion([before, stripAbsent(type)]) ?? undefined;
            }
            continue;
          }
          delete reads[name];
          delete edges[name];
          if (Object.hasOwn(keys.reads, name)) reads[name] = keys.reads[name];
          else edges[name] = keys.edges[name];
        }
      }
    };
    const seen = new Set<string>();
    for (const [index, entry] of literal.entries.entries()) {
      applySpreads(index);
      this.noteEntryName(entry, seen);
      switch (entry.kind) {
        case 'value': {
          const typed = this.checkExprSlot(entry.value, scope);
          const reference = this.graphReference(entry, typed, scope);
          if (reference !== undefined) {
            entry.reference = true;
            const child = this.graphChild(entry.name, required, entry.span);
            if (child !== undefined) {
              this.checkGraphReferenceFits(entry.name, reference.position, { required: child, span: entry.span });
            }
            delete reads[entry.name];
            edges[entry.name] = referenceEdge(entry.name, reference.position, reference.sequenced);
            break;
          }
          delete entry.reference;
          const valueType = this.nodeValueEntryType(entry, typed, scope);
          delete edges[entry.name];
          reads[entry.name] = valueType;
          if (required !== undefined) this.checkGraphField(entry.name, valueType, { required, span: entry.span });
          break;
        }
        case 'nodes': {
          const child = this.graphChild(entry.name, required, entry.span);
          const landings = entry.nodes.map(node => this.checkGraphBody(node, scope, child));
          delete reads[entry.name];
          edges[entry.name] = {
            schema: { target: entry.name, readable: true },
            target: this.mergeLandings(landings, entry),
          };
          break;
        }
        case 'traversal': {
          const child = this.graphChild(entry.name, required, entry.span);
          delete reads[entry.name];
          edges[entry.name] = this.checkGraphWalk(entry, scope, child);
          break;
        }
        case 'declared':
          // The parser refuses a declared edge in a graph body.
          break;
        default:
          neverAsAny(entry);
      }
    }
    applySpreads(literal.entries.length);
    if (required !== undefined && !opaqueSpread) {
      this.reportMissingGraphFields(required, reads, literal.span);
    }
    return { kind: 'local', label: 'a graph', reads, edges };
  }

  /** Every field `required` declares that nothing supplied — refused unless it
   *  is declared `<T | null>`, which may be left out and is then absent. */
  private reportMissingGraphFields(
    required: RequiredPosition,
    supplied: Record<string, unknown>,
    span: Span,
  ): void {
    const declared = required.schema.positions[required.position];
    for (const [name, want] of Object.entries(declared?.properties ?? {})) {
      if (Object.hasOwn(supplied, name) || isMaybeAbsentType(want)) continue;
      this.report(
        DiagnosticCodes.GRAPH_FIELD_MISSING,
        `${describeShapeNode(required.position)} needs \`${name}\` (${describeFieldType(want)}) and this graph doesn't write it — only a field declared '<T | null>' may be left out`,
        span,
      );
    }
  }

  /** A field written in a body that has to satisfy `required` — or supplied
   *  by a spread, named by `via`. */
  private checkGraphField(
    name: string,
    have: FieldType | undefined,
    { required, span, via }: { required: RequiredPosition; span: Span; via?: string },
  ): void {
    const declared = required.schema.positions[required.position];
    if (declared === undefined) return;
    const want = declared.properties[name];
    if (want === undefined) {
      this.reportGraphUnknown(name, required, span, 'field');
      return;
    }
    if (have !== undefined && !fieldAssignable(have, want)) {
      this.report(
        DiagnosticCodes.GRAPH_FIELD_TYPE,
        `${describeShapeNode(required.position)} declares \`${name}\` as ${describeFieldType(want)}, and this is ${describeFieldType(have)}${textRepair(have, want)}`,
        span,
      );
      return;
    }
    // TypeScript's strict null rule, as for a write field or a required
    // parameter: a value that may not be there can't fill a field that must
    // be. Before version 3 the field was silently left empty at run time.
    if (
      have !== undefined &&
      isMaybeAbsentType(have) &&
      !isMaybeAbsentType(want) &&
      since(this.languageVersion, 3)
    ) {
      this.report(
        DiagnosticCodes.ABSENT_REQUIRED,
        `${describeShapeNode(required.position)} needs \`${name}\` (${describeFieldType(want)}), and ${via !== undefined ? `'...${via}' supplies one that` : 'this value'} may be absent (${describeFieldType(have)}) — fall back to a value that is always there ('${name}: COALESCE(…, "…")'), or declare the field '<${describeFieldType(stripAbsent(want))} | null>' if it may be left empty`,
        span,
      );
    }
  }

  /**
   * The shape node a child entry has to satisfy — the parent shape's nested
   * node of the same name — or undefined, reported, when the parent declares
   * no such child.
   */
  private graphChild(
    name: string,
    required: RequiredPosition | undefined,
    span: Span,
  ): RequiredPosition | undefined {
    if (required === undefined) return undefined;
    const declared = required.schema.positions[required.position];
    if (declared === undefined) return undefined;
    const edge = declared.edges[name];
    if (edge === undefined) {
      this.reportGraphUnknown(name, required, span, 'child');
      return undefined;
    }
    return { schema: required.schema, position: edge.target };
  }

  /** An entry the shape doesn't declare as what it was written as — a field
   *  where the shape has a child node, the reverse, or neither. */
  private reportGraphUnknown(
    name: string,
    required: RequiredPosition,
    span: Span,
    writtenAs: 'field' | 'child',
  ): void {
    const declared = required.schema.positions[required.position];
    const shape = describeShapeNode(required.position);
    if (writtenAs === 'field' && declared?.edges[name] !== undefined) {
      this.report(
        DiagnosticCodes.GRAPH_ENTRY_KIND,
        `\`${name}\` is a child node of ${shape}, not a field — build it with a body ('${name}: { … }') or from a walk ('${name}: m-[x:Edge]-> { … }')`,
        span,
      );
      return;
    }
    if (writtenAs === 'child' && declared?.properties[name] !== undefined) {
      this.report(
        DiagnosticCodes.GRAPH_ENTRY_KIND,
        `\`${name}\` is a field of ${shape}, not a child node — give it a value ('${name}: …')`,
        span,
      );
      return;
    }
    const known = [...Object.keys(declared?.properties ?? {}), ...Object.keys(declared?.edges ?? {})];
    this.report(
      DiagnosticCodes.GRAPH_FIELD_UNKNOWN,
      `${shape} has no \`${name}\`${didYouMean(name, known)} — it declares: ${known.join(', ') || '(nothing)'}`,
      span,
    );
  }

  /**
   * A walk in a graph body. Followed by a field body, each record builds one
   * child from that body — a copy, written in the landing's scope (the hop's
   * alias names the record there and nowhere else). Bare, the edge holds
   * REFERENCES to the records, as `{ items: obj }` holds `obj` in TypeScript:
   * the edge is typed as the records it walks to, and a shape's child node
   * checks them structurally, as it would an argument.
   */
  private checkGraphWalk(
    entry: Extract<NodeEntry, { kind: 'traversal' }>,
    scope: Scope,
    required: RequiredPosition | undefined,
  ): LocalEdge {
    const head = this.checkPathHead(entry.head, scope);
    const typing = this.slotTyping(scope, entry.head.span);
    const landed =
      head.steps && head.rootType !== undefined
        ? typing.walkSteps(head.rootType, head.steps)
        : undefined;
    if (entry.mapping !== undefined) {
      const landing = this.landingScope(
        { head: entry.head, mapping: entry.mapping, span: entry.span },
        head,
        typing,
        scope,
      );
      return {
        schema: { target: entry.name, readable: true },
        target: { ...this.checkGraphBody(entry.mapping, landing, required), label: `a '${entry.name}' landing` },
      };
    }
    if (required !== undefined) this.checkGraphReferenceFits(entry.name, landed, { required, span: entry.span });
    // The edge keeps the walk's order, where the walk has one.
    const last = head.steps?.at(-1);
    const sequenced =
      typing.lastEdgeSchema?.sequenced
      ?? (last?.type === 'edge' && last.cardinality?.orderBy !== undefined ? 'arrival' : undefined);
    return referenceEdge(entry.name, landed, sequenced);
  }

  /**
   * A graph entry whose value is a RECORD — a name bound on the node plane,
   * ONLY/FIRST/LAST over a bare walk, or any value holding records (one, or a
   * list of them, such as what a `MAP` of writes hands back) — and so an edge
   * holding references to them, as `{ owner: r }` holds `r` in TypeScript.
   * Undefined for a value (and for a node-plane name that is no record, which
   * the field rule then refuses as it does in a node literal).
   */
  private graphReference(
    entry: Extract<NodeEntry, { kind: 'value' }>,
    { valueType, parsed }: { valueType?: FieldType; parsed?: Expression },
    scope: Scope,
  ): { position: PositionTypeRef | undefined; sequenced: EdgeSchema['sequenced'] } | undefined {
    // One record, or a list that keeps its order, is held in the order it
    // was handed over — the order the edge's landings were appended in.
    const named = this.bareNodeSymbol(entry.value.raw, parsed, scope);
    if (named !== undefined) {
      if (named.kind === 'shape' || named.kind === 'instance' || named.kind === 'movement') return undefined;
      const position = this.symbolPositionType(named);
      if (position?.kind === 'closure' || position?.kind === 'meta') return undefined;
      return { position, sequenced: named.plural === true ? undefined : 'arrival' };
    }
    if (parsed !== undefined && aggregatedBarePath(parsed) !== undefined) {
      const selected = this.landedAggregatePosition(parsed, scope, entry.value.span);
      return { position: selected?.kind === 'maybeEmpty' ? selected.of : selected, sequenced: 'arrival' };
    }
    const held = recordIn(valueType);
    if (held === undefined) return undefined;
    const list = valueType !== undefined ? variantOf(stripAbsent(valueType)) : undefined;
    const unordered = list?.kind === 'list' && list.unordered === true;
    return { position: held.position, sequenced: unordered ? undefined : 'arrival' };
  }

  /** Do the records a reference entry holds carry what the shape's child node
   *  needs? Checked structurally, as an argument reaching a `<Shape>`
   *  parameter is. */
  private checkGraphReferenceFits(
    name: string,
    records: PositionTypeRef | undefined,
    { required, span }: { required: RequiredPosition; span: Span },
  ): void {
    const misfit = surfaceMisfit(records !== undefined ? recordSurface(records) : undefined, required, {
      absentMayBeMissing: true,
    });
    if (misfit === undefined) return;
    this.report(
      DiagnosticCodes.GRAPH_REFERENCE_SHAPE,
      `'${name}' holds the records themselves, and ${describeShapeNode(required.position)} doesn't fit them: ${misfit} — copy the fields it needs with a body ('${name}: … -> { field: x.Field }')`,
      span,
    );
  }

  /**
   * `...v` in a graph body: what the map supplies, key by key — or undefined
   * when its keys can't be named here, in which case a SHAPE is what the
   * graph is checked against when it is built. Without a shape nothing could
   * say what such a graph holds, so that is refused.
   *
   * No excess check for a spread's keys, as TypeScript makes none: a key the
   * shape doesn't declare rides along unseen by the type.
   */
  private checkGraphSpread(
    entry: MapSpread,
    {
      scope,
      required,
      written,
      earlier,
    }: {
      scope: Scope;
      required: RequiredPosition | undefined;
      /** Keys a later entry writes: it wins, so the spread's value for one is never what the field holds. */
      written: ReadonlySet<string>;
      /** Keys an earlier entry wrote: a spread that may be absent leaves them as they are. */
      earlier: ReadonlySet<string>;
    },
  ): SpreadKeys | undefined {
    const symbol = this.spreadSourceSymbol(entry, scope);
    if (symbol === undefined) return undefined;
    const record = spreadRecordOf(symbol);
    if (record !== undefined) {
      const keys = this.checkGraphRecordSpread(entry, { record, required, written, earlier });
      return keys !== undefined ? { ...keys, mayBeAbsent: record.mayBeAbsent } : undefined;
    }
    const valueType = symbol.posType === undefined ? symbol.fieldType : undefined;
    const map = valueType !== undefined ? stripAbsent(valueType) : undefined;
    if (map === undefined || (map !== 'json' && (typeof map !== 'object' || map.kind !== 'dict'))) {
      this.report(
        DiagnosticCodes.GRAPH_SPREAD_NOT_MAP,
        `'...${entry.source}' copies a map's keys or a record's fields into the graph, and '${entry.source}' is ${map !== undefined ? describeFieldType(map) : 'not a value'} — spread a map (plugin output, JSON, '{ … }') or one record, or write the fields one by one`,
        entry.span,
      );
      return undefined;
    }
    const mayBeAbsent = valueType !== undefined && isMaybeAbsentType(valueType);
    const keys = map === 'json' ? undefined : mayBeAbsent && map.shape !== undefined ? absentKeys(map.shape) : map.shape;
    if (keys === undefined) {
      if (required === undefined) {
        this.report(
          DiagnosticCodes.GRAPH_SPREAD_UNTYPED,
          `nothing says which keys '${entry.source}' holds, so nothing could say what this graph holds — give the graph a shape ('graph<Shape> { ...${entry.source} }'), and it is checked against the shape when it is built`,
          entry.span,
        );
      }
      return undefined;
    }
    return { ...this.checkSpreadKeys(keys, { required, entry, written, earlier }), mayBeAbsent };
  }

  /**
   * `...r` in a graph body where `r` is ONE record: its fields copied as a
   * snapshot, by the rule a bare walk copies by — the shape decides which
   * fields and how deep (a child node in the shape is followed through the
   * record's edge of the same name), files stay lazy handles, and nothing in
   * the graph refers back into the record's system. Without a shape the
   * record's own fields are copied and no edge is followed. A record that may
   * not be there copies nothing when it isn't, so every key it supplies is
   * `T | absent` — TypeScript's `...undefined`.
   *
   * The copy plan is recorded on the spread for the engine, as a walk's is.
   */
  private checkGraphRecordSpread(
    entry: MapSpread,
    {
      record,
      required,
      written,
      earlier,
    }: {
      record: { position: PositionTypeRef | undefined; mayBeAbsent: boolean };
      required: RequiredPosition | undefined;
      written: ReadonlySet<string>;
      earlier: ReadonlySet<string>;
    },
  ): SpreadKeys | undefined {
    const supplied = record.position !== undefined ? recordSurface(record.position) : undefined;
    const absent = (type: FieldType | undefined): FieldType | undefined =>
      record.mayBeAbsent && type !== undefined ? maybeAbsent(type) : type;
    if (supplied === undefined) {
      if (required === undefined) {
        this.report(
          DiagnosticCodes.GRAPH_SPREAD_UNTYPED,
          `nothing says which fields '${entry.source}' has, so nothing could say what this graph holds — give the graph a shape ('graph<Shape> { ...${entry.source} }'), and it is checked against the shape when it is built`,
          entry.span,
        );
        return undefined;
      }
      entry.copy = copyPlanOf(required);
      return undefined;
    }
    if (required === undefined) {
      entry.copy = { fields: Object.keys(supplied.properties), edges: {} };
      return {
        reads: Object.fromEntries(Object.entries(supplied.properties).map(([name, type]) => [name, absent(type)])),
        edges: {},
      };
    }
    const declared = required.schema.positions[required.position];
    const reads: Record<string, FieldType | undefined> = {};
    const edges: Record<string, LocalEdge> = {};
    const plan: { fields: string[]; edges: Record<string, CopyPlan> } = { fields: [], edges: {} };
    for (const name of Object.keys(declared?.properties ?? {})) {
      if (!Object.hasOwn(supplied.properties, name)) continue;
      const type = absent(supplied.properties[name]);
      if (!written.has(name)) {
        const held = earlier.has(name) && type !== undefined ? stripAbsent(type) : type;
        this.checkGraphField(name, held, { required, span: entry.span, via: entry.source });
      }
      reads[name] = type;
      plan.fields.push(name);
    }
    // A record this program wrote into a system is read as what the write
    // handed back — its fields. Its edges are the system's, read live, and a
    // snapshot never hops past the landing to fetch them.
    const followsEdges = record.position?.kind !== 'handle';
    for (const [name, edge] of Object.entries(declared?.edges ?? {})) {
      if (!followsEdges || !Object.hasOwn(supplied.edges, name) || written.has(name)) continue;
      const child: RequiredPosition = { schema: required.schema, position: edge.target };
      const misfit = surfaceMisfit(supplied.edges[name]?.(), child, { absentMayBeMissing: true });
      if (misfit !== undefined) {
        this.report(
          DiagnosticCodes.GRAPH_COPY_SHAPE,
          `'...${entry.source}' copies its '${name}' records, and ${describeShapeNode(child.position)} doesn't fit them: ${misfit} — write '${name}' after the spread with a body ('${name}: ${entry.source}-[x:${name}]-> { field: x.Field }')`,
          entry.span,
        );
      }
      plan.edges[name] = copyPlanOf(child);
      edges[name] = { schema: { target: name, readable: true } };
    }
    entry.copy = plan;
    return { reads, edges };
  }

  /** A known map's keys, read as a graph body: a nested map (or a list of
   *  them) is a child where the shape says so — everywhere, without one. */
  private checkSpreadKeys(
    keys: Record<string, FieldType | null>,
    {
      required,
      entry,
      written = new Set(),
      earlier = new Set(),
    }: {
      required: RequiredPosition | undefined;
      entry: MapSpread;
      written?: ReadonlySet<string>;
      earlier?: ReadonlySet<string>;
    },
  ): SpreadKeys {
    const declared = required !== undefined ? required.schema.positions[required.position] : undefined;
    const reads: Record<string, FieldType | undefined> = {};
    const edges: Record<string, LocalEdge> = {};
    for (const [key, valueType] of Object.entries(keys)) {
      const nested = valueType !== null ? nestedMapKeys(valueType) : undefined;
      const asChild =
        declared !== undefined ? declared.edges[key] !== undefined : nested !== undefined;
      if (!asChild) {
        if (declared === undefined && valueType !== null && mayHoldMap(valueType)) {
          this.report(
            DiagnosticCodes.GRAPH_SPREAD_UNTYPED,
            `'${entry.source}.${key}' may hold a nested map, and without a shape nothing says whether that is a child node or a value — give the graph a shape ('graph<Shape> { ...${entry.source} }')`,
            entry.span,
          );
        }
        if (required !== undefined && declared?.properties[key] !== undefined && valueType !== null && !written.has(key)) {
          const held = earlier.has(key) ? stripAbsent(valueType) : valueType;
          this.checkGraphField(key, held, { required, span: entry.span, via: entry.source });
        }
        reads[key] = valueType ?? undefined;
        continue;
      }
      const child =
        required !== undefined && declared !== undefined
          ? { schema: required.schema, position: declared.edges[key].target }
          : undefined;
      if (nested === undefined) {
        // A child the shape declares, from a value nobody can see into: the
        // build checks it. Anything that can't be a map is wrong now.
        if (valueType !== null && !mayHoldMap(valueType)) {
          this.report(
            DiagnosticCodes.GRAPH_ENTRY_KIND,
            `'${entry.source}.${key}' is ${describeFieldType(valueType)}, and \`${key}\` is a child node of ${describeShapeNode(required?.position ?? '')} — it needs a map, or a list of maps`,
            entry.span,
          );
        }
        edges[key] = { schema: { target: key, readable: true } };
        continue;
      }
      const landing = this.checkSpreadKeys(nested, { required: child, entry });
      if (child !== undefined) this.reportMissingGraphFields(child, landing.reads, entry.span);
      edges[key] = {
        schema: { target: key, readable: true },
        target: { kind: 'local', label: `a '${key}' landing`, ...landing },
      };
    }
    return { reads, edges };
  }

  /**
   * Where a declared edge's landings live — and by which comparison they are
   * judged. A declared entry's type is the one a movement parameter takes, and
   * it has the parameter's two spellings:
   *
   *   - an ADDRESS, WALKED — the same hop chain a traversal head walks, so
   *     `<slack-[:Channels]->-[:Messages]->>` means in a declaration exactly
   *     what it means in a movement. Landings are that system's records, so a
   *     record from elsewhere is not one and the comparison stays nominal.
   *   - a DECLARED NODE (`<Company>`) — a structure no system owns. Nothing
   *     nominal exists to compare, so landings are judged by what they OFFER,
   *     exactly as an argument reaching a `<Company>` parameter is.
   *
   * Nothing is read here and nothing is recorded: a declaration is a type, and
   * the run never walks it. The type is still reported on, because a declared
   * edge nobody could type would accept every `link` in silence.
   */
  private declaredEdgeLanding(
    entry: Extract<NodeEntry, { kind: 'declared' }>,
    scope: Scope,
  ): Pick<LocalEdge, 'target' | 'structural'> {
    const { type } = entry;
    if (type.hopsRaw === undefined) {
      const resolution = scope.resolve(type.graph);
      if (resolution.kind === 'found' && resolution.symbol.kind === 'shape') {
        const target = declaredRootPosition(resolution.symbol);
        return target !== undefined ? { target: runBuiltLanding(target), structural: true } : {};
      }
      this.report(
        DiagnosticCodes.NODE_ENTRY_TYPE,
        `'${entry.name}: <${type.graph}>' has to say what LANDS on the edge, and '${type.graph}' is neither a node this file declares nor an address — declare the structure its landings have ('node ${type.graph} { … }'), or give it the address they come from ('${entry.name}: <${type.graph}-[:Edge]->>')`,
        type.span,
      );
      return {};
    }
    const target = this.declaredEdgeAddress(type, scope);
    return target !== undefined ? { target } : {};
  }

  /** The address half of `declaredEdgeLanding`: the hop chain, walked. */
  private declaredEdgeAddress(type: TypeRef, scope: Scope): PositionTypeRef | undefined {
    const symbol = this.resolveName(type.graph, type.span, scope);
    if (symbol === undefined) return undefined;
    if (symbol.kind === 'adapter') {
      const adapterName = symbol.importedName ?? symbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${type.graph}' is an adapter, not an instance — construct and name an instance first, then declare the edge off the name: 'go = ${this.constructionCall(adapterName)}' … '<go${type.hopsRaw ?? ''}>'`,
        type.span,
      );
      return undefined;
    }
    const start = this.symbolPositionType(symbol);
    const steps = type.hopsRaw !== undefined ? parseTraversalPath(type.hopsRaw) : undefined;
    if (start === undefined || steps === undefined) return undefined;
    return this.reportingTyping(scope, type.span).walkSteps(start, steps);
  }

  /**
   * The ONE landing type a plural synthesised edge exposes. A traversal yields
   * one type however many landings it has, so the edge carries what EVERY
   * landing carries — the rest is unreadable through the edge, exactly as it
   * would be through a union.
   *
   * Landings that disagree about an entry's TYPE are an error rather than a
   * first-one-wins silence: nothing would tell the author which literal typed
   * the read.
   */
  private mergeLandings(
    landings: PositionTypeRef[],
    entry: Extract<NodeEntry, { kind: 'nodes' }>,
  ): PositionTypeRef {
    const [first, ...rest] = landings;
    if (first === undefined || first.kind !== 'local') {
      return { kind: 'local', label: `a '${entry.name}' landing`, reads: {} };
    }
    if (rest.length === 0) return { ...first, label: `a '${entry.name}' landing` };

    const reads: Record<string, FieldType | undefined> = {};
    for (const name of Object.keys(first.reads)) {
      // PRESENCE first: an entry only some landings wrote isn't on the edge's
      // type at all (reading it through the traversal is the ordinary
      // unknown-name error, which is the true statement).
      if (!rest.every(l => l.kind === 'local' && Object.hasOwn(l.reads, name))) continue;
      const types = [first.reads[name], ...rest.map(l => (l.kind === 'local' ? l.reads[name] : undefined))];
      const known = types.filter((t): t is FieldType => t !== undefined);
      const clash = known.find(t => !fieldTypeEquals(t, known[0]));
      if (clash !== undefined) {
        this.report(
          DiagnosticCodes.NODE_LANDING_MISMATCH,
          `the landings of '${entry.name}' disagree about \`${name}\` (${describeFieldType(known[0])} and ${describeFieldType(clash)}) — a traversal lands on one type, so they must agree`,
          entry.span,
        );
      }
      // One landing we couldn't type leaves the read untyped: the edge can't
      // promise a type no landing agreed to.
      reads[name] = known.length === types.length ? known[0] : undefined;
    }
    const edges: Record<string, LocalEdge> = {};
    for (const [name, edge] of Object.entries(first.edges ?? {})) {
      if (rest.every(l => l.kind === 'local' && l.edges?.[name] !== undefined)) {
        edges[name] = edge;
      }
    }
    return { kind: 'local', label: `a '${entry.name}' landing`, reads, edges };
  }

  /** The position type of an argument slot that is a single bare name. */
  private bareSlotPositionType(slot: ExprSlot, scope: Scope): PositionTypeRef | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const resolution = scope.resolve(trimmed);
    return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
  }

  /**
   * Check 7: the argument's (graph, position) must match the parameter's.
   *
   * A SYNTHESISED node takes the structural road instead — it belongs to no
   * graph, so there is no instance token to compare and the nominal test would
   * only ever say no. Every other argument kind goes through `positionsMatch`
   * exactly as before: a real instance's position still matches nominally.
   */
  private checkCallArgFit(
    fit: ArgFit,
    argType: PositionTypeRef | undefined,
    paramType: PositionTypeRef | undefined,
    span: Span,
  ): void {
    if (argType === undefined || paramType === undefined) return;
    const { callee } = fit;
    const place = describeArgPlace(fit);
    if (argType.kind === 'local') {
      const misfit = structuralMisfit(argType, paramType);
      if (misfit !== undefined) {
        this.report(
          DiagnosticCodes.NODE_ARG_SHAPE,
          `'${callee}' expects ${describePosition(paramType)}${place}, and ${misfit}`,
          span,
        );
      }
      return;
    }
    if (paramType.kind === 'position' && isDeclaredNode(paramType.instance)) {
      // A declared node belongs to no system, so there is no identity to
      // match: the argument fits when it CARRIES the structure — whatever
      // made it — judged by the comparison `x IS <Doc>` makes.
      const misfit = declaredParamMisfit(argType, paramType);
      if (misfit !== undefined) {
        this.report(
          DiagnosticCodes.CALL_ARG_TYPE,
          `'${callee}' expects a <${paramType.position}> record${place}, and ${misfit}`,
          span,
        );
      }
      return;
    }
    if (positionsMatch(argType, paramType) === false) {
      this.report(
        DiagnosticCodes.CALL_ARG_TYPE,
        `'${callee}' expects ${describePosition(paramType)}${place}, but this argument is ${describePosition(argType)}`,
        span,
      );
    }
  }

  // ── Branching & concurrency ──

  private checkIf(statement: IfStatement, scope: Scope): void {
    // Reaching the statement AFTER the `if` means the arm that ran (if any)
    // fell through. So an arm that always LEAVES (fails, or from version 3
    // returns) proves its condition false
    // below — but only while every EARLIER arm fails too: otherwise the run
    // could have arrived here through one of those, with this arm's condition
    // never evaluated. That ordering is the whole subtlety, and it is why this
    // accumulates rather than testing each arm alone.
    let allPriorTerminate = true;
    const exits = bodyExits(this.languageVersion);
    const armTerminates: boolean[] = [];
    // Arriving at arm k — or at the `else` — already proves every EARLIER arm's
    // condition false, because one `if`'s arms are tried in order. So a bare
    // `IS` that failed rules its variant out of the subject's union, and the
    // eliminations accumulate down the chain: the `else` sees the union minus
    // everything tested above, exactly as TypeScript's else-arm narrowing does.
    // (The guard-clause negation below is the OTHER direction — out into the
    // enclosing scope — which is why that one needs termination and this
    // doesn't.)
    const ruledOut = new Map<string, Set<string>>();
    const recorded = this.recordNode<RecordedBranch>({
      kind: 'branch',
      span: statement.span,
      scope,
      arms: [],
    });
    for (const arm of statement.arms) {
      // Positive IS conjuncts narrow into the arm's scope (check 6) — for
      // the arm body AND for the condition's later conjuncts
      // (`rec IS crm.person AND EXISTS(rec-[:Company]->)`).
      const armScope = new Scope('branch', scope);
      this.recordFrame('branch', arm.span, armScope);
      recorded?.arms.push({ span: arm.span, scope: armScope, conditionSpan: arm.condition.span });
      // Before the condition, so a later arm's own test narrows what the
      // earlier arms already left rather than the original union.
      this.declareEliminated(ruledOut, scope, armScope);
      this.checkConditionSlot(arm.condition, armScope, armScope);
      this.checkStatementList(arm.body, armScope);
      this.collectIsElimination(arm.condition, scope, ruledOut);
      const terminating = terminates(arm.body, exits);
      armTerminates.push(terminating);
      if (allPriorTerminate && terminating) {
        this.narrowConditionNegation(arm.condition, scope, statement.span.end);
      }
      allPriorTerminate = allPriorTerminate && terminating;
    }
    if (statement.elseArm) {
      const elseScope = new Scope('branch', scope);
      this.recordFrame('branch', statement.elseArm.span, elseScope);
      if (recorded) recorded.otherwise = { span: statement.elseArm.span, scope: elseScope };
      this.declareEliminated(ruledOut, scope, elseScope);
      this.checkStatementList(statement.elseArm.body, elseScope);
      // The other direction of the guard clause, TypeScript's
      // `if (x != null) { … } else { return }`: when the `else` and every arm
      // but one leave, reaching the statement after the `if` means THAT arm
      // ran, so its condition holds below. (The arms above it are already
      // negated by the loop: each of them leaves.) From version 3.
      const fallsThrough = armTerminates.flatMap((leaves, index) => (leaves ? [] : [index]));
      if (
        since(this.languageVersion, 3)
        && fallsThrough.length === 1
        && terminates(statement.elseArm.body, exits)
      ) {
        this.narrowConditionHolds(statement.arms[fallsThrough[0]].condition, scope, statement.span.end);
      }
    }
  }

  /** The union type a name carries, or undefined if it carries anything else.
   *  Elimination is a fact about unions only — narrowing a single-typed
   *  position by a failed test leaves it exactly where it was, same as TS. */
  private unionSymbolType(
    name: string,
    scope: Scope,
  ): Extract<PositionTypeRef, { kind: 'union' }> | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    const posType = this.symbolPositionType(resolution.symbol);
    return posType?.kind === 'union' ? posType : undefined;
  }

  /** What a FAILED `IS` rules out of its subject's union. Only a BARE `IS`
   *  contributes: a conjunction proves nothing when false (only that one of its
   *  conjuncts was), the same rule the guard-clause negation follows.
   *
   *  Both planes contribute, and by the same move — the variant a PASSING test
   *  would have narrowed to is the one a failing test rules out. Only the way
   *  that variant is named differs: a record union names it directly, an event
   *  union names it by ADDRESS, and the address's key is the variant. (The
   *  address plane sat out until the engine stopped answering `false` to a test
   *  it cannot decide; a silent false routed an undiscriminated event into an
   *  arm typed "none of the above", which is elimination reading a silence as a
   *  fact. It now fails the run — see `evaluateIsTest` — so the else is sound
   *  here for exactly the reason it is sound there.) */
  private collectIsElimination(
    slot: ExprSlot,
    scope: Scope,
    ruledOut: Map<string, Set<string>>,
  ): void {
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch {
      return; // the parse failure is reported by the arm's own check
    }
    if (condition.kind !== 'isTest') return;
    const subject = condition.subjectRaw.trim();
    if (!BARE_IDENT.test(subject)) return;
    const union = this.unionSymbolType(subject, scope);
    if (union === undefined) return;
    const graph = scope.resolve(condition.type.graph);
    if (graph.kind !== 'found') return;
    const eliminated = ruledOut.get(subject) ?? new Set<string>();
    // A STRUCTURAL test names no graph at all — a declared node belongs to
    // none. What a passing test would have narrowed to is every member that
    // CONFORMS, so failing it rules out exactly those, and the third plane
    // joins the other two on the same move.
    if (graph.symbol.kind === 'shape') {
      if (condition.type.position !== undefined || condition.type.hopsRaw !== undefined) return;
      for (const variant of union.variants) {
        // Only a member we PROVED conforms is ruled out by the failure.
        if (conformsToDeclaredNode(union.instance, variant, graph.symbol) === true) {
          eliminated.add(variant);
        }
      }
      ruledOut.set(subject, eliminated);
      return;
    }
    // Every other test has to name THIS union's graph before it rules anything
    // out — two instances can spell the same position name, and identity is the
    // token, never the spelling.
    if (union.instance.token !== graph.symbol) return;
    const variant = ruledOutVariant(condition.type, union);
    if (variant === undefined) return;
    eliminated.add(variant);
    ruledOut.set(subject, eliminated);
  }

  /** Shadows each subject with its union MINUS everything the arms above ruled
   *  out — the same scope move the positive `IS` makes, into the arm's own
   *  scope, so the arm's extent already bounds it. */
  private declareEliminated(
    ruledOut: Map<string, Set<string>>,
    scope: Scope,
    into: Scope,
  ): void {
    for (const [name, eliminated] of ruledOut) {
      const resolution = scope.resolve(name);
      if (resolution.kind !== 'found') continue;
      const union = this.unionSymbolType(name, scope);
      if (union === undefined) continue;
      const remaining = union.variants.filter(v => !eliminated.has(v));
      if (remaining.length === union.variants.length) continue;
      into.declare({ ...resolution.symbol, posType: residualUnion(union, remaining) });
    }
  }

  /** The guard-clause narrowing: an arm that always fails declares its
   *  condition's negation into the ENCLOSING scope, for the statements after
   *  the `if`. A conjunction proves nothing when false (only that one of its
   *  conjuncts is), so only a plain expression condition contributes.
   *  `guardEnd` is where that narrowing starts to hold — the end of the `if`
   *  statement, since only its continuation is proved. */
  private narrowConditionNegation(slot: ExprSlot, scope: Scope, guardEnd: Loc): void {
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch {
      return; // the parse failure is reported by the arm's own check
    }
    if (condition.kind !== 'expr') return;
    this.narrowNegatedPresence(condition.expr, scope, scope, slot.span, {
      visibleFrom: guardEnd,
    });
  }

  /** The guard clause's other direction: the condition of the one arm that
   *  falls through, declared TRUE into the enclosing scope from `guardEnd`.
   *  A conjunction proves each of its conjuncts, exactly as it does inside the
   *  arm; an `IS` conjunct narrows the arm only, as before. */
  private narrowConditionHolds(slot: ExprSlot, scope: Scope, guardEnd: Loc): void {
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch {
      return; // the parse failure is reported by the arm's own check
    }
    const conjuncts = condition.kind === 'and' ? condition.conjuncts : [condition];
    for (const conjunct of conjuncts) {
      if (conjunct.kind !== 'expr') continue;
      this.narrowPresence(conjunct.expr, scope, scope, slot.span, { visibleFrom: guardEnd });
    }
  }

  // ── Movements ──

  private checkMovement(statement: MovementDeclaration, scope: Scope): void {
    if (!scope.symbols.has(statement.name)) {
      // Normally hoisted by checkStatementList; reached directly only as a
      // parallel sibling.
      this.checkFunctionName(statement.name, statement.span, scope);
      this.declareAuthored(
        scope,
        {
          name: statement.name,
          kind: 'movement',
          span: statement.span,
          arity: statement.params.length,
          movement: { decl: statement, declScope: scope },
        },
        statement.span,
      );
    }
    const movementScope = new Scope('movement', scope);
    this.recordFrame('movement', statement.span, movementScope);
    for (const param of statement.params) {
      // A movement's parameter type is what it promises its callers, and there
      // is no caller to read it from — a listen, a call and a callback all
      // check against it. So it is written, always.
      if (param.type === undefined) {
        this.reportParamNeedsType(param.name, param.span, `'${statement.name}'`);
        continue;
      }
      // A VALUE parameter — a scalar, a refinement, a list or record of them —
      // is read on the dot plane, and nothing below (a graph, an event
      // position, a listen) has anything to say about it.
      const value = this.movementParamValueType(param.type, scope, true);
      if (value !== undefined) {
        if (this.declareAuthored(movementScope, valueParamSymbol(param, value.type), param.span)) {
          this.report(DiagnosticCodes.DUPLICATE_DECL, `Duplicate parameter '${param.name}'`, param.span);
        }
        continue;
      }
      const paramTypeRef = typeNameOf(param.type);
      if (paramTypeRef === undefined) continue;
      const graphSymbol = this.resolveName(paramTypeRef.graph, paramTypeRef.span, scope);
      // A bare adapter import used as a position source (`<manual-[:invocation]->>`)
      // — instantiation is explicit now, so the parameter's graph must be a
      // CONSTRUCTED instance. Guide the author to construct + name it first.
      if (graphSymbol?.kind === 'adapter') {
        const adapterName = graphSymbol.importedName ?? paramTypeRef.graph;
        const positionExample = paramTypeRef.position ?? (adapterName === 'cron' ? 'tick' : 'invocation');
        this.report(
          DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
          `'${paramTypeRef.graph}' is an adapter, not an instance — construct an instance and name it first: 'go = ${this.constructionCall(adapterName)}', then type the parameter against the name ('<go-[:${positionExample}]->>') and listen to it ('listen to go {}')`,
          paramTypeRef.span,
        );
      }
      if (scope.kind === 'file' && statement.params.length === 1 && graphSymbol?.kind === 'instance') {
        // Dispatchable: a listener could fire it. Zero-width span so the
        // LISTEN_MISSING squiggle lands on the declaration word, not the body.
        this.dispatchables.push({
          movement: statement.name,
          instanceName: paramTypeRef.graph,
          ...(graphSymbol.adapter !== undefined ? { adapter: graphSymbol.adapter } : {}),
          ...(paramTypeRef.position !== undefined ? { position: paramTypeRef.position } : {}),
          ...(graphSymbol.schema?.eventNarrowingKeys !== undefined
            ? { narrowingKeys: [...graphSymbol.schema.eventNarrowingKeys] }
            : {}),
          span: { start: statement.span.start, end: statement.span.start },
        });
      }
      const declared =
        graphSymbol && graphSymbol.kind !== 'adapter'
          ? this.positionFromTypeRefStrict(graphSymbol, paramTypeRef, paramTypeRef.span)
          : undefined;
      const info = scope.symbols.get(statement.name)?.movement;
      const posType =
        declared !== undefined && info?.decl === statement
          ? asParameter(declared, paramNeedsOf(info), { fn: info.decl.name, param: param.name })
          : declared;
      const existing = this.declareAuthored(
        movementScope,
        {
          name: param.name,
          kind: 'param',
          span: param.span,
          ...(posType ? { posType } : {}),
        },
        param.span,
      );
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `Duplicate parameter '${param.name}'`,
          param.span,
        );
      }
    }
    const symbol = scope.symbols.get(statement.name);
    const collector: ReturnCollector = { what: `'${statement.name}'`, returns: [] };
    this.recordMovementRow(symbol, () => this.checkBody(statement.body, movementScope, collector));
    this.checkDeclaredReturn(statement.returnType, collector, scope, statement.span);
    // Every member of a cycle is known by now: this body's own calls were
    // inferred while it was walked, and a cycle through it comes back here. A
    // body that returns no value has nothing to declare (TypeScript's `void`).
    const cycle = symbol?.movement?.cycle;
    if (
      cycle !== undefined
      && statement.returnType === undefined
      && collector.returns.length > 0
      && since(this.languageVersion, 3)
    ) {
      this.report(
        DiagnosticCodes.RECURSIVE_RETURN_TYPE,
        recursiveReturnTypeMessage(statement.name, cycle.chainFrom(statement.name), `function ${statement.name}(…): <number> { … }`),
        { start: statement.span.start, end: statement.span.start },
      );
    }
  }

  /**
   * `): <R>` against what the body hands back — TypeScript's rule: every
   * `return` is assignable to the declared type, and a body that declares one
   * returns something. The declaration's own type is resolved here with
   * reporting, as a parameter's is, so a type that names nothing is said once,
   * where it is written.
   */
  private checkDeclaredReturn(
    written: ParamTypeRef | undefined,
    collector: ReturnCollector,
    scope: Scope,
    span: Span,
  ): PlaneType | undefined {
    if (written === undefined || !since(this.languageVersion, 3)) return undefined;
    const declared = this.closureParamShape({ name: 'return', type: written, span: written.span }, scope);
    const expected = `${collector.what} declares it returns <${spellParamType(written)}>`;
    if (collector.returns.length === 0) {
      this.report(
        DiagnosticCodes.RETURN_TYPE,
        `${expected}, but its body never returns a value — add a 'return', or drop the return type`,
        { start: span.start, end: span.start },
      );
      return declared;
    }
    for (const returned of collector.returns) this.checkReturnFit(expected, declared, returned);
    return declared;
  }

  /** One `return` against a declared return type. */
  private checkReturnFit(expected: string, declared: PlaneType, returned: ReturnShape & { span: Span }): void {
    const { span } = returned;
    if (declared.fieldType !== undefined) {
      const got = returned.fieldType ?? (returned.posType !== undefined ? recordOf(returned.posType) : undefined);
      if (got === undefined) return;
      if (isMaybeAbsent(got) && !isMaybeAbsent(declared.fieldType)) {
        this.report(
          DiagnosticCodes.RETURN_TYPE,
          `${expected}, but this value may be absent — fill it first ('COALESCE(x, …)'), or declare the return type as one that may be absent`,
          span,
        );
        return;
      }
      const target = stripAbsent(declared.fieldType);
      const source = stripAbsent(got);
      const misfit = isDictType(target) && target.shape !== undefined
        ? recordReturnMisfit(target.shape, source)
        : fieldAssignable(source, target)
        ? undefined
        : `this returns ${describeFieldType(source)}`;
      if (misfit !== undefined) this.report(DiagnosticCodes.RETURN_TYPE, `${expected}, but ${misfit}`, span);
      return;
    }
    const target = declared.posType;
    if (target === undefined) return;
    const source = returned.posType;
    if (source === undefined) {
      if (returned.fieldType !== undefined) {
        this.report(
          DiagnosticCodes.RETURN_TYPE,
          `${expected}, a record, but this returns ${describeFieldType(returned.fieldType)}`,
          span,
        );
      }
      return;
    }
    // The structural judgements are the ones an argument meets at a call: a
    // returned value is handed to the caller exactly as an argument is handed
    // to a parameter.
    const structural =
      source.kind === 'local'
        ? structuralMisfit(source, target)
        : target.kind === 'position' && isDeclaredNode(target.instance)
        ? declaredParamMisfit(source, target)
        : undefined;
    if (structural !== undefined) {
      this.report(DiagnosticCodes.RETURN_TYPE, `${expected}, and ${structural}`, span);
    } else if (source.kind !== 'local' && !(target.kind === 'position' && isDeclaredNode(target.instance))
      && positionsMatch(source, target) === false) {
      this.report(DiagnosticCodes.RETURN_TYPE, `${expected}, but this returns ${describePosition(source)}`, span);
    }
  }

  // ── Listeners ──

  /**
   * `listen to <instance> { <config> } fire <movement>` — the file-level
   * statement trigger rows are derived from. Checks:
   *   - file-level only;
   *   - the listened name is a constructed adapter instance, or the
   *     ambient `kg` (whose event channel is record mutations);
   *   - config keys match the adapter's trigger-config vocabulary (when the
   *     catalog declares one; absent vocabulary stays silent), and config
   *     VALUES match the adapter's declared value vocabulary where one
   *     exists (`triggerConfigOptions` — the subscribable-event surface);
   *   - kg listens carry the mutation vocabulary: a required `type`
   *     (angle-bracketed — it names a kg node type), optional `changes`
   *     (⊆ create/update/delete) and `fields` (properties of the type);
   *   - the fired name is a movement with exactly one parameter, typed
   *     against the listened instance (the event position) — for kg, the
   *     kg position the `type` config names;
   *   - no duplicate identical (instance, config) listens.
   */
  private checkListen(statement: ListenDeclaration, scope: Scope): void {
    // A TYPE-ONLY walk (`movementValueType`) must leave no trace on the
    // checker: it is the same body seen twice, and counting its listeners
    // twice would answer a file-level question with a callee's re-reading.
    if (this.typeOnly) return;
    this.listenCount++; // any listen — even a broken one — suppresses LISTEN_MISSING
    if (scope.kind !== 'file') {
      this.report(
        DiagnosticCodes.LISTEN_FILE_LEVEL,
        "'listen' is a file-level statement — it declares the file's listeners, so move it out of this block",
        statement.span,
      );
      return;
    }

    const instanceSymbol = this.resolveName(statement.instance, statement.span, scope);

    // Recorded here, where the listened name has resolved and before any of the
    // config checks can return early: a listen that fires nothing is still a
    // listen the author wrote, and the story renders the truth. What the config
    // decides — the selection, the address, the derived event types — is filled
    // in below as the same walk learns it.
    // The fired movement is a function's name, so from version 3 it is the
    // same name in any letter case — as at a call.
    const firesResolution = this.calleeResolution(statement.movement, scope);
    const recorded = this.recordNode<RecordedListen>({
      kind: 'listen',
      span: statement.span,
      scope,
      instance: statement.instance,
      ...(instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined
        ? { adapterType: instanceSymbol.adapter }
        : {}),
      fires: statement.movement,
      firesMovement:
        firesResolution.kind === 'found' && firesResolution.symbol.kind === 'movement',
      narrowing: {},
      eventTypes: [],
    });
    // `listen to manual() {} fire …` — the now-rejected inline construction
    // form. Instantiation is explicit: construct + name the instance first,
    // then `listen to <name>`. Reject it with the named-construction fix.
    const isInlineConstruct = statement.construct !== undefined;
    if (isInlineConstruct) {
      const adapterName =
        instanceSymbol?.kind === 'adapter'
          ? (instanceSymbol.importedName ?? instanceSymbol.name)
          : statement.construct?.callee ?? statement.instance;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'listen to ${statement.instance}(…)' constructs an instance inline — construct and name it first, then listen by name: 'go = ${this.constructionCall(adapterName)}' … 'listen to go {} fire ${statement.movement}'`,
        statement.span,
      );
    } else if (instanceSymbol && instanceSymbol.kind === 'adapter') {
      // A bare adapter import — not a constructed instance.
      const adapterName = instanceSymbol.importedName ?? instanceSymbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${statement.instance}' is an adapter, not an instance — construct and name an instance first, then listen to it by name: 'go = ${this.constructionCall(adapterName)}' … 'listen to go {} fire ${statement.movement}'`,
        statement.span,
      );
    } else if (instanceSymbol && instanceSymbol.kind !== 'instance') {
      this.report(
        DiagnosticCodes.LISTEN_NOT_INSTANCE,
        `'${statement.instance}' is ${describeKind[instanceSymbol.kind]} — 'listen to' names a constructed adapter instance (e.g. inbox = email(credentials: …))`,
        statement.span,
      );
    }

    // The universal listen-config key (see SUPPRESS_SELF_KEY). It is NOT
    // adapter vocabulary — it's a platform 2-way-sync semantic, valid on
    // every listener (kg or adapter), so it's validated HERE (boolean
    // literal only) and excluded from both the adapter-vocabulary check and
    // the kg-config check below.
    const suppressSelfArg = statement.config.find(arg => arg.name === SUPPRESS_SELF_KEY);
    if (suppressSelfArg) {
      if (suppressSelfArg.isType || !BOOLEAN_LITERAL.test(suppressSelfArg.value.raw.trim())) {
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${SUPPRESS_SELF_KEY}' takes a boolean literal — write ${SUPPRESS_SELF_KEY}: true to ignore this system's own writes echoing back (the 2-way-sync case), or omit it (the default is off)`,
          suppressSelfArg.value.span,
        );
      }
    }

    // The literal config values that select which events fire — the
    // adapter's `events: [...]`, captured from the option-bearing config
    // below. They drive the derived event type (see derivedEventTypes).
    let selectedConfigValues: string[] | undefined;
    // Every SINGLE-literal config value the listen states, by key — the address
    // it subscribes to (`base: "appDevLoop"`), which is what narrows the type it
    // fires. A non-literal (a list, an expression) is not an address and simply
    // isn't here.
    const listenConfigValues: Record<string, string | undefined> = {};
    // A `'fields'`-format key's bare names, held until the address has landed.
    let fieldsFilter: { names: string[]; span: Span } | undefined;
    const adapterName =
      instanceSymbol?.kind === 'instance' ? instanceSymbol.adapter : undefined;
    const spec = adapterName !== undefined ? this.catalog.adapter(adapterName) : undefined;
    const vocabulary = spec?.triggerConfig;
    // Keys the adapter REQUIRES (the cron `schedule`) — a listen
    // missing one would provision a listener that can never fire.
    //
    // THE POSITION SUPPLIES THE LEADING HOPS: a required key is also
    // satisfied when the instance's construction pins a POSITION arg of the
    // same name (`at = airtable(credentials: c, base: "Dev Base")` supplies
    // `base`, so its listens name only `table`). A listen's address is
    // relative to the instance's position, not absolute from the meta node.
    for (const required of spec?.triggerConfigRequired ?? []) {
      if (statement.config.some(arg => arg.name === required)) continue;
      const positionSupplies =
        spec?.constructionArgs.some(a => a.kind === 'position' && a.name === required) === true
        && instanceSymbol?.kind === 'instance'
        && typeof instanceSymbol.constructionArgs?.[required] === 'string'
        && instanceSymbol.constructionArgs[required].trim() !== '';
      if (positionSupplies) continue;
      const example =
        spec?.triggerConfigFormats?.[required] === 'cron' ? '"0 9 * * 1"'
        : required === 'key' ? `"${suggestedListenKey(statement.movement)}"`
        : '"…"';
      const why = spec?.triggerConfigRequiredWhy?.[required];
      const rewritten = `listen to ${spellName(statement.instance)} { ${required}: ${example} } fire ${spellName(statement.movement)}`;
      // A fix only for the routing key, whose value is derived (a schedule is
      // the author's to choose), and only when nothing else was written in the
      // statement — rewriting it would otherwise drop the author's own config.
      const exact =
        required === 'key' && statement.config.length === 0 && statement.alias === undefined && statement.construct === undefined;
      this.reportWithFix({
        code: DiagnosticCodes.LISTEN_BAD_CONFIG,
        message: `a '${adapterName}' listener requires a '${required}' config${why !== undefined ? ` (${why})` : ''} — e.g. ${rewritten}`,
        span: statement.span,
        ...(exact ? { fix: { edits: [{ span: statement.span, text: rewritten }] } } : {}),
      });
    }
    for (const arg of statement.config) {
      if (arg.name === SUPPRESS_SELF_KEY) continue; // universal key, validated above
      // Reject any config key the adapter doesn't accept. A resolved adapter
      // with NO declared config vocabulary accepts NONE — an unknown key is an
      // error, not silently passed. (An unresolved adapter — no `spec` — stays
      // silent: the unknown-stays-silent contract.)
      if (spec && !(vocabulary ?? []).includes(arg.name)) {
        const accepted = vocabulary ?? [];
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${adapterName}' listeners do not accept a config key '${arg.name}'${accepted.length ? ` — they accept: ${accepted.join(', ')}` : ' — they take no config'}`,
          arg.value.span,
        );
        continue;
      }
      if (arg.isType) {
        // No listen config takes a type. The graph's `type: <company>` was
        // the last one, and it is a quoted value now like every other pin —
        // a listen names things by the address's own currency, not by a
        // type reference (D25).
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${arg.name}' takes a plain value — '<${arg.value.raw.trim()}>' is a type reference, and listen config is quoted values: ${arg.name}: "${arg.value.raw.trim()}"`,
          arg.value.span,
        );
        continue;
      }
      const literal = staticStringValues(arg.value);
      if (literal?.length === 1 && !isListSlot(arg.value)) {
        listenConfigValues[arg.name] = literal[0];
      }
      const options = spec?.triggerConfigOptions?.[arg.name];
      if (options !== undefined) {
        const values = staticStringValues(arg.value);
        if (values === undefined || !isListSlot(arg.value)) {
          // Event selections are always a list of quoted strings — even a
          // single event — so the authored shape is uniform and every reader
          // sees an array.
          const example = options.length > 0 ? `"${options[0]}"` : '"…"';
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' is a list of events${options.length > 0 ? ` — one of: ${options.join(', ')}` : ''} — e.g. ${arg.name}: [${example}]`,
            arg.value.span,
          );
        } else {
          // The selected events — the source of the listener's event type.
          selectedConfigValues = values;
          for (const value of values) {
            if (!options.includes(value)) {
              this.report(
                DiagnosticCodes.LISTEN_BAD_CONFIG,
                `'${value}' is not an event '${adapterName}' can subscribe to — one of: ${options.join(', ')}`,
                arg.value.span,
              );
            }
          }
        }
      }
      // Static value formats — the SAME parser/probe the platform scheduler
      // runs, so check time and fire time can never disagree about what is
      // valid.
      const format = spec?.triggerConfigFormats?.[arg.name];
      if (format === 'cron') {
        // The cron adapter's `schedule`.
        const values = staticStringValues(arg.value);
        if (values === undefined || values.length !== 1) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' takes one quoted cron expression — e.g. ${arg.name}: "0 9 * * 1" (minute hour day-of-month month day-of-week, UTC unless a timezone is set)`,
            arg.value.span,
          );
        } else {
          const scheduleError = cronScheduleError(values[0]);
          if (scheduleError !== null) {
            this.report(
              DiagnosticCodes.LISTEN_BAD_CONFIG,
              `'${values[0]}' is not a valid schedule — ${scheduleError}. Five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1" is 09:00 every Monday`,
              arg.value.span,
            );
          }
        }
      } else if (format === 'timezone') {
        // The cron adapter's optional `timezone` — an IANA id.
        const values = staticStringValues(arg.value);
        if (values === undefined || values.length !== 1) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' takes one quoted IANA time zone — e.g. ${arg.name}: "Europe/London"`,
            arg.value.span,
          );
        } else {
          const tzError = cronTimezoneError(values[0]);
          if (tzError !== null) {
            this.report(
              DiagnosticCodes.LISTEN_BAD_CONFIG,
              `${tzError}. The schedule then fires at that local wall-clock time, with daylight-savings handled for you`,
              arg.value.span,
            );
          }
        }
      } else if (format === 'strings') {
        // A list of the source system's own names (Gmail's `labels`). Only
        // the shape is ours to check; the names are the system's.
        const values = staticStringValues(arg.value);
        if (
          values === undefined ||
          !isListSlot(arg.value) ||
          values.length === 0 ||
          values.some(value => value.trim() === '')
        ) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' is a non-empty list of quoted, non-empty names — e.g. ${arg.name}: ["…"]`,
            arg.value.span,
          );
          continue;
        }
      } else if (format === 'fields') {
        // The changed-attribute filter — bare property names of whatever the
        // listen's address lands on. The SHAPE is checkable here; the NAMES
        // need the landed position, so they are held for the check below.
        const names = bareNameValues(arg.value);
        if (names === undefined) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' is a list of the watched type's properties, bare — e.g. ${arg.name}: [domains]`,
            arg.value.span,
          );
        } else {
          fieldsFilter = { names, span: arg.value.span };
        }
        continue; // bare names are not an expression slot
      }
      this.checkExprSlot(arg.value, scope);
    }

    if (recorded) {
      for (const [key, value] of Object.entries(listenConfigValues)) {
        if (value !== undefined) recorded.narrowing[key] = value;
      }
      if (selectedConfigValues !== undefined) recorded.events = [...selectedConfigValues];
    }

    // The type(s) this listen fires, derived from its config alone. Computed
    // HERE — before `fire` is resolved — because a listen that fires nothing
    // is still a listen the author wrote: the story renders what it watches,
    // and a `fields:` filter is checkable whether or not the movement is.
    const instanceRef =
      instanceSymbol !== undefined ? instanceRefOf(instanceSymbol) : undefined;
    // A listen with no `events:` selection is subscribed to the adapter's own
    // dispatch DEFAULT (whatsapp: messages only), not necessarily everything.
    const listenSpec =
      instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined
        ? this.catalog.adapter(instanceSymbol.adapter)
        : undefined;
    const subscribed = selectedConfigValues ?? listenSpec?.defaultEvents;
    if (recorded && subscribed !== undefined) recorded.events = [...subscribed];
    // A typo'd hop dies HERE, at the pin the author wrote, with a did-you-mean
    // — not downstream as a parameter mismatch against a signature that may
    // carry the same typo, and not silently when the address is wide.
    if (instanceRef !== undefined) {
      this.checkHopPins(
        instanceRef,
        listenConfigValues,
        key =>
          statement.config.find(arg => arg.name === key)?.value.span ?? statement.span,
      );
    }
    const eventTypes =
      instanceRef !== undefined
        ? this.derivedEventTypes(instanceRef, subscribed, listenConfigValues)
        : undefined;
    if (recorded && eventTypes !== undefined) {
      recorded.eventTypes = eventTypes.map(ref =>
        ref.kind === 'union'
          ? { key: ref.union, ...(ref.display !== undefined ? { display: ref.display } : {}) }
          : ref.kind === 'position'
            ? { key: ref.position, ...(ref.display !== undefined ? { display: ref.display } : {}) }
            : { key: describePosition(ref) },
      );
    }

    // `fields: [domains]` — the names, now that the address has landed. One
    // landed type is the checkable case: where a listen fires several, a name
    // valid on any of them is valid (the filter is applied per event).
    //
    // The names belong to whatever the listen is FILTERING, and the two event
    // shapes disagree about what that is. Where the landed position declares a
    // SUBJECT edge — the hop from an event to the record it is about — the
    // record is one hop away and its properties are what `fields:` names; the
    // event node's own `action`/`type` are not filterable fields, they are the
    // address. Where no subject edge is declared the listen fires the record
    // itself and the landed position is already the right surface.
    //
    // The marker is the adapter's, not this checker's: recognising an edge by
    // its name would be parsing a display string an adapter is free to spell
    // differently.
    if (fieldsFilter !== undefined && instanceRef !== undefined && eventTypes !== undefined) {
      const known = new Set<string>();
      let described = false;
      for (const type of eventTypes) {
        const key = type.kind === 'position' ? type.position : undefined;
        const landed = key !== undefined ? instanceRef.schema.positions[key] : undefined;
        if (landed === undefined) continue;
        const position = subjectOf(instanceRef, landed)?.position ?? landed;
        if (position.undescribed === true) continue;
        described = true;
        for (const name of Object.keys(position.properties)) known.add(name);
      }
      if (described) {
        for (const name of fieldsFilter.names) {
          if (known.has(name)) continue;
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${name}' is not a property of what this listener watches`
              + `${known.size > 0 ? ` — one of: ${[...known].sort().join(', ')}` : ''}`,
            fieldsFilter.span,
          );
        }
      }
    }

    const configIdentity = statement.config
      .map(arg => `${arg.name}=${arg.value.raw.trim()}`)
      .sort()
      .join(',');
    const identity = `${statement.instance}::${configIdentity}`;
    if (this.listenIdentities.has(identity)) {
      this.report(
        DiagnosticCodes.LISTEN_DUPLICATE,
        `Duplicate listener — an identical 'listen to ${statement.instance}${statement.config.length > 0 ? ' { … }' : ''}' already exists; two listens on the same instance must differ in config`,
        statement.span,
      );
    }
    this.listenIdentities.add(identity);

    if (statement.alias !== undefined) {
      const aliasKey = `${statement.movement}::${statement.alias}`;
      if (this.listenAliases.has(aliasKey)) {
        this.report(
          DiagnosticCodes.LISTEN_ALIAS_DUPLICATE,
          `Two lanes of '${statement.movement}' are both named "${statement.alias}" — give each listen a distinct alias`,
          statement.span,
        );
      } else {
        this.listenAliases.add(aliasKey);
      }
    }

    const movementSymbol = this.resolveName(this.calleeName(statement.movement, scope), statement.span, scope);
    if (!movementSymbol) return;
    if (movementSymbol.kind === 'fileImport') return; // may be a movement — M3 resolves it
    if (movementSymbol.kind !== 'movement') {
      this.report(
        DiagnosticCodes.CALL_NOT_MOVEMENT,
        `'${statement.movement}' is ${describeKind[movementSymbol.kind]}, not a movement — 'fire' names a movement declared in this file`,
        statement.span,
      );
      return;
    }
    const info = movementSymbol.movement;
    if (!info) return;
    if (info.decl.params.length !== 1) {
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes ${info.decl.params.length} parameters — a movement fired by a listener takes exactly one, the event position`,
        statement.span,
      );
      return;
    }
    if (instanceSymbol?.kind !== 'instance') return;

    // Can this system notify us AT ALL? A manifest naming zero trigger types
    // (Sheets, Drive, Dropbox — write targets) has no inbound surface, so a
    // listener on it provisions cleanly and then stays silent forever, which
    // reads to the author as "it works, nothing has happened yet".
    //
    // This is deliberately gated on a spec we HAVE: an unknown adapter stays
    // leniently unchecked, a known one without the flag is a definite no. The
    // downstream event-type check can't make that call — it sees an empty
    // event surface and can't tell "this system has none" from "we haven't
    // introspected one yet", so it correctly stays lenient and the listener
    // sails through.
    if (instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined) {
      const spec = this.catalog.adapter(instanceSymbol.adapter);
      if (spec !== undefined && spec.canFire !== true) {
        this.report(
          DiagnosticCodes.LISTEN_CANNOT_FIRE,
          `'${statement.instance}' can't start an automation — it has no way to tell us when `
            + `something changes there. Use it as somewhere to write to, and start this from `
            + `something that can notify us (a schedule, an inbox, a chat message, or a record `
            + `change in a system that reports one)`,
          statement.span,
        );
        return;
      }
    }

    const param = info.decl.params[0];
    if (param.type === undefined) return; // already reported at the declaration
    // A listener hands its movement an event — a record position — so a
    // movement whose parameter takes a VALUE is one no listen can fire.
    if (this.movementParamValueType(param.type, info.declScope, false) !== undefined) {
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes '${param.name}: <${spellParamType(param.type)}>', a value, but a listener fires its movement with an event position of '${statement.instance}' — type the parameter as one ('<${statement.instance}-[:…]->>')`,
        statement.span,
      );
      return;
    }
    const declared = typeNameOf(param.type);
    if (declared === undefined) return;
    const paramGraph = info.declScope.resolve(declared.graph);
    if (paramGraph.kind !== 'found') return; // already reported at the declaration

    // Shape-typed params keep the structural conformance path (unchanged).
    if (paramGraph.symbol.kind === 'shape' && instanceSymbol?.kind === 'instance') {
      this.checkListenShapeConformance(paramGraph.symbol, instanceSymbol, param, statement);
      return;
    }

    // The fired movement's parameter must be typed against the SAME
    // constructed instance this listener names — `go = manual()` /
    // `movement m(run: <go-[:invocation]->>)` / `listen to go {} fire m`.
    if (paramGraph.symbol !== instanceSymbol) {
      const paramType = `${declared.graph}${declared.hopsRaw ?? ''}`;
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes '${param.name}: <${paramType}>', but this listener fires with an event position of '${statement.instance}' — the parameter's type must equal the listened instance's event position type (a '<${statement.instance}-[:…]->>' position, not '<${paramType}>')`,
        statement.span,
      );
      return;
    }

    // Derived above, before the fired movement resolved: the type(s) this
    // listen fires — the event node each selected kind is delivered on, at
    // the address the config states, with the `events:` selection as `action`
    // pins where the node declares that axis. The parameter must satisfy
    // EVERY one (a listen calls the movement on every matching event, so each
    // delivered type is an argument). Same assignability primitive as any
    // call. An adapter that declares no event edges stays leniently
    // unchecked.
    if (instanceRef === undefined || eventTypes === undefined) return;
    const paramType = this.positionFromTypeRef(paramGraph.symbol, declared);
    if (paramType === undefined) return; // unknown position already reported at the decl
    const mismatch = eventTypes.find((t) => positionsMatch(t, paramType) === false);
    if (mismatch !== undefined) {
      // The parameter as the AUTHOR WROTE IT — never the key it resolved to.
      // A signature and a listen disagreeing is a disagreement about an
      // address, so both sides must read as addresses.
      const wrote = `<${declared.graph}${declared.hopsRaw ?? ''}>`;
      // The signature names the RECORD this event is about — the shape every
      // movement written against an ambient graph has, and the one case where
      // "what to change" is fully determined. Say it, exactly.
      const rewrite = this.recordSignatureRewrite({
        instance: instanceRef,
        instanceName: statement.instance,
        fires: mismatch,
        paramName: param.name,
        paramType,
      });
      if (rewrite !== undefined) {
        this.report(
          DiagnosticCodes.LISTEN_PARAM_MISMATCH,
          `'${statement.movement}' takes '${param.name}: ${wrote}', but this listener fires `
            + `${describeEventType(mismatch)} — the EVENT, not the record it is about. `
            + `Type the parameter against the event and reach the record in one hop: `
            + `'${statement.movement}(${rewrite.eventParam}: ${rewrite.signature})', `
            + `then wrap the body in '${rewrite.binding}'.`,
          statement.span,
        );
        return;
      }
      const example = this.eventTraversalExample(instanceRef, param.name, statement.instance);
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes '${param.name}: ${wrote}' (${describePosition(paramType)}), but `
          + `this listener fires ${describeEventType(mismatch)}. Every listen firing a movement must `
          + `satisfy its signature — either narrow this listen to what '${statement.movement}' accepts, `
          + `or widen the signature`
          + (example === undefined ? '.' : ` — e.g. \`${example}\` `)
          + (example === undefined ? '' : `(a delete event has no record to read).`),
        statement.span,
      );
    }
  }

  /**
   * The construction an adapter actually takes, as an author writes it —
   * `kg()`, `attio(credentials: …)`, `airtable(credentials: …, base: …)`.
   *
   * DERIVED from the declared signature, because "here is how to construct it"
   * is only worth saying if it is true for THIS adapter: telling the author of
   * a credential-free system to pass credentials sends them looking for a
   * connection that does not exist, and showing `()` for one that needs a
   * credential fails on paste. An adapter the catalog does not know gets the
   * bare call — the honest answer when nothing was declared.
   */
  private constructionCall(adapterName: string): string {
    const args = this.catalog.adapter(adapterName)?.constructionArgs ?? [];
    const required = args.filter((a) => a.required).map((a) => `${a.name}: …`);
    return `${adapterName}(${required.join(', ')})`;
  }

  /**
   * The one connection that can construct `adapter`, when the workspace has
   * exactly one — the only case where naming it is certain to be right.
   */
  private soleCredentialFor(adapter: string): string | undefined {
    const serving = (this.catalog.credentialNames?.() ?? []).filter(
      (name) => this.catalog.credential(name)?.adapters.includes(adapter) === true,
    );
    return serving.length === 1 ? serving[0] : undefined;
  }

  /** `import { attio } from adapters, then '<name> = attio(credentials: …)'` —
   *  then, when the workspace has just one connection for it, the same two
   *  lines naming that connection. Appended rather than substituted: the
   *  general form is what earlier versions' corpora read. */
  private importAndConstructLines(adapter: string): string {
    const adapterImport = importLine(adapter, 'adapters');
    const general = `${adapterImport}, then '<name> = ${this.constructionCall(adapter)}'`;
    const args = this.catalog.adapter(adapter)?.constructionArgs ?? [];
    const credentialArg = credentialArgOf({ constructionArgs: args });
    const credential = credentialArg?.required === true ? this.soleCredentialFor(adapter) : undefined;
    if (credentialArg === undefined || credential === undefined) return general;
    const call = args
      .filter((a) => a.required)
      .map((a) => `${a.name}: ${a.name === credentialArg.name ? spellName(credential) : '…'}`)
      .join(', ');
    return `${general} — with the one ${adapter} connection here: '${importLine(credential, 'credentials')}' and '<name> = ${adapter}(${call})'`;
  }

  /**
   * `crm = attio(credentials: …)` written whole, but `attio` never imported —
   * one line short of working, so that line is the fix. The construction's
   * credential is repaired in the same breath (the check that would find it
   * wrong never runs while the callee is unresolved), so one round suffices.
   */
  private reportUnimportedAdapterConstruction(construct: ConstructionCall, scope: Scope): void {
    const adapterImport = importLine(construct.callee, 'adapters');
    const credentialArg = credentialArgOf(this.catalog.adapter(construct.callee) ?? { constructionArgs: [] });
    const credentialSlot = construct.args.find((a) => a.name === credentialArg?.name)?.value;
    const repair = credentialSlot !== undefined ? this.credentialArgRepair(credentialSlot, scope) : undefined;
    this.reportWithFix({
      code: DiagnosticCodes.NAME_UNRESOLVED,
      message: `'${construct.callee}' is not in scope — import it: add '${adapterImport}' at the top of the file${repair !== undefined ? `, and ${repair.instruction}` : ''}`,
      span: construct.span,
      fix: { edits: [insertLineAtTop(adapterImport), ...(repair?.edits ?? [])] },
    });
  }

  /**
   * A credential argument naming a connection the workspace HAS, but written
   * as a string (`"Acme CRM"`) or never imported: the exact repair. Undefined
   * when the argument names no known connection, or is already right.
   */
  private credentialArgRepair(
    slot: ExprSlot,
    scope: Scope,
  ): { instruction: string; edits: SourceEdit[] } | undefined {
    const raw = slot.raw.trim();
    const quoted = /^"([^"\\]*)"$/.exec(raw);
    const name = quoted !== null ? quoted[1] : unwrapCredentialArg(raw);
    if (name === null || this.catalog.credential(name) === undefined) return undefined;
    const imported = scope.resolve(name).kind === 'found';
    if (quoted === null && imported) return undefined;
    const line = importLine(name, 'credentials');
    const steps = [
      ...(quoted !== null ? [`write the credential as a name, not a string: 'credentials: ${spellName(name)}'`] : []),
      ...(imported ? [] : [`add '${line}' at the top of the file`]),
    ];
    return {
      instruction: steps.join(', and '),
      edits: [
        ...(imported ? [] : [insertLineAtTop(line)]),
        ...(quoted !== null ? [{ span: slot.span, text: spellName(name) }] : []),
      ],
    };
  }

  /**
   * The EXACT rewrite for a signature typed against the record when the listen
   * fires the event — the shape every movement written against an ambient
   * graph has, once the graph publishes an event entry like every other
   * adapter (D40(a)).
   *
   * It fires only when the diagnosis is certain: the fired event declares a
   * SUBJECT edge, and that edge lands on the very position the signature
   * named. Then the new signature is the address this listen actually fires
   * and the body regains the author's own name one hop along. Anything less
   * certain falls through to the general advice — a rewrite that doesn't
   * compile is worse than none, which is the same rule `eventTraversalExample`
   * follows.
   *
   * Every identifier comes from the schema: the event's name and pins from the
   * address, the hop from the edge the adapter marked. Nothing is spelled here,
   * so a fixture shaped like one adapter cannot make a hardcoded string look
   * derived.
   *
   */
  private recordSignatureRewrite(input: {
    instance: InstanceRef;
    instanceName: string;
    fires: PositionTypeRef;
    paramName: string;
    paramType: PositionTypeRef;
  }): { signature: string; binding: string; eventParam: string } | undefined {
    const { fires, paramType } = input;
    if (fires.kind !== 'position' && fires.kind !== 'union') return undefined;
    if (fires.address === undefined) return undefined;
    if (paramType.kind !== 'position') return undefined;
    const landed = fires.kind === 'union' ? fires.variants : [fires.position];
    for (const key of landed) {
      const position = input.instance.schema.positions[key];
      if (position === undefined) continue;
      const subject = subjectOf(input.instance, position);
      if (subject === undefined || subject.target !== paramType.position) continue;
      // The author's name still means the record, so it keeps it; the event
      // needs one of its own, and only has to differ from the name in hand.
      const eventParam = input.paramName === 'event' ? 'change' : 'event';
      return {
        signature: eventAddressSource(input.instanceName, fires.address),
        // The BLOCK traversal, because that is the form the language has: a
        // bare `x = a-[:E]->` binding does not parse, and a suggestion that
        // does not compile sends the author somewhere that isn't there.
        binding: `${eventParam}-[${input.paramName}:${subject.edge}]-> { … }`,
        eventParam,
      };
    }
    return undefined;
  }

  /**
   * A worked example of reaching the record, built from THIS instance's own
   * event surface.
   *
   * It used to be hardcoded to Attio's shape (`e-[r:Companies]-> { … r.Name }`),
   * which is a real edge there and a fiction anywhere else — an Airtable author
   * reads it and goes looking for a `Companies` edge on an event whose only edge
   * is `record`. A suggestion that doesn't execute in the instance it's aimed at
   * is worse than no suggestion: it sends the author somewhere that isn't there,
   * which is the same failure `AdapterNameDriftError` makes in
   * `7_readable_means_readable.md`.
   *
   * So take a live action's variant, an edge it really has, and a field really
   * on that edge's target. Anything we can't name, we don't claim: no example
   * beats a wrong one.
   */
  private eventTraversalExample(
    instance: InstanceRef,
    paramName: string,
    instanceName: string,
  ): string | undefined {
    const schema = instance.schema;
    for (const { position: eventName } of schema.eventPositions ?? []) {
      const position = schema.positions[eventName];
      if (position === undefined) continue;
      const actionType = position.properties[EVENT_ACTION_FIELD];
      const actions = isEnumType(actionType) ? actionType.options : [];
      const action = actions.find((a) => a !== RECORD_DELETED_ACTION);
      if (action === undefined) continue; // no change-kind axis — nothing to narrow by
      const edge = Object.keys(position.edges).find(
        (e) => position.edges[e].requiresLiveRecord !== true || action !== RECORD_DELETED_ACTION,
      );
      if (edge === undefined) continue;
      const target = position.edges[edge].target;
      const field = Object.keys(schema.positions[target]?.properties ?? {})[0];
      const read = field === undefined ? '…' : `… r.\`${field}\``;
      return (
        `if ${paramName} IS <${instanceName}-[:\`${eventName}\` WHERE \`${EVENT_ACTION_FIELD}\` == "${action}"]->> `
        + `{ ${paramName}-[r:${edge}]-> { ${read} } }`
      );
    }
    return undefined;
  }

  /**
   * The type(s) a listen produces, as a function of its config. Returns the
   * PositionTypeRefs the param is matched against (one per delivered event
   * node), or undefined when the instance declares no event edges (lenient:
   * caller skips the check).
   *
   * THE EVENT IS JUST A NODE. Each `events:` value is delivered along one of
   * the instance's declared event edges (`eventPositions[].on`); the type it
   * fires is that node at the address the config states — the hop pins from
   * `eventNarrowingKeys`, plus the value itself as an `action` pin where the
   * node declares that axis (an ordinary enum field — ONE namespace, the
   * retired `configValueToAction` translation table has nothing to translate).
   * A selection covering the node's whole action enum — or no selection at
   * all — is the unnarrowed node: not a mechanism, a wider type.
   *
   * Position-per-listen falls out: two listens, two addresses, two keys, two
   * types — no per-listen mechanism anywhere.
   *
   */
  private derivedEventTypes(
    instance: InstanceRef,
    selectedConfigValues: string[] | undefined,
    listenConfigValues: Record<string, string | undefined>,
  ): PositionTypeRef[] | undefined {
    const eventPositions = instance.schema.eventPositions;
    if (eventPositions === undefined || eventPositions.length === 0) return undefined;

    // The address this listen's config states. A listen that doesn't name the
    // whole address narrows nothing — the wide event type stands, so an
    // adapter with no addressable events is untouched.
    const narrowing =
      listenNarrowing({ keys: instance.schema.eventNarrowingKeys, config: listenConfigValues })
      ?? {};

    const refFor = (event: string, pins: Record<string, string>): PositionTypeRef => {
      const narrowed = Object.keys(pins).length > 0;
      const address: EventAddress = { event, narrowing: pins };
      const key = eventAddressKey(address);
      // Resolve through the schema where the position/union is grafted (so the
      // ref's KIND mirrors what the param resolves to); construct the ref
      // directly where it isn't — a listen's address is a real type even where
      // no signature named it, so the ref carries its own display.
      const resolved = positionRefIn(instance, key);
      const base: PositionTypeRef =
        resolved !== undefined && (resolved.kind === 'position' || resolved.kind === 'union')
          ? resolved
          : { kind: 'position', instance, position: key };
      if (base.kind !== 'position' && base.kind !== 'union') return base;
      return {
        ...base,
        address,
        ...(narrowed ? { narrowsEvent: event, display: eventAddressDisplay(address) } : {}),
      };
    };

    const derived: PositionTypeRef[] = [];
    for (const { position: event, on } of eventPositions) {
      // The `events:` values this edge delivers, of those the listen selected.
      // No selection ⇒ the edge fires on all its kinds.
      const deliveredHere =
        selectedConfigValues === undefined
          ? undefined
          : selectedConfigValues.filter((v) => (on === undefined ? true : on.includes(v)));
      if (deliveredHere !== undefined && deliveredHere.length === 0) continue;

      const actionType = instance.schema.positions[event]?.properties[EVENT_ACTION_FIELD];
      const actionEnum = isEnumType(actionType) ? actionType.options : undefined;

      if (actionEnum === undefined || deliveredHere === undefined) {
        derived.push(refFor(event, narrowing));
        continue;
      }
      const pinnable = [...new Set(deliveredHere.filter((v) => actionEnum.includes(v)))];
      if (pinnable.length === 0 || actionEnum.every((v) => pinnable.includes(v))) {
        // Nothing this node's axis recognises (checked as listen config
        // separately), or the whole axis — the unnarrowed node either way.
        derived.push(refFor(event, narrowing));
        continue;
      }
      if (pinnable.length === 1) {
        derived.push(refFor(event, { ...narrowing, [EVENT_ACTION_FIELD]: pinnable[0] }));
        continue;
      }
      // A config-scoped union over the selected action pins (NOT the full
      // static union), keyed by the node's own address so a param naming the
      // node matches while a too-narrow single-action param does not.
      const unionAddress: EventAddress = { event, narrowing };
      derived.push({
        kind: 'union',
        instance,
        union: eventAddressKey(unionAddress),
        variants: pinnable.map((v) =>
          eventAddressKey({ event, narrowing: { ...narrowing, [EVENT_ACTION_FIELD]: v } }),
        ),
        address: unionAddress,
        narrowsEvent: event,
        ...(Object.keys(narrowing).length > 0
          ? { display: eventAddressDisplay(unionAddress) }
          : {}),
      });
    }
    return derived.length > 0 ? derived : undefined;
  }

  private checkListenShapeConformance(
    shapeSymbol: ScopeSymbol,
    instanceSymbol: ScopeSymbol,
    param: MovementDeclaration['params'][number],
    statement: ListenDeclaration,
  ): void {
    const shapeSchema = shapeSymbol.schema;
    const instanceSchema = instanceSymbol.schema;
    // The declaration IS its root node, so that is what the lane must conform to.
    const shapeNodeName = shapeSymbol.name;
    if (!shapeSchema) return;
    const shapeNode = shapeSchema.positions[shapeNodeName];
    if (!shapeNode) return; // unknown root — reported at the param decl

    // The instance's event position; unknown ⇒ unverifiable ⇒ info, not error.
    const eventPos = instanceSchema?.eventPosition;
    const instancePos = eventPos ? instanceSchema!.positions[eventPos] : undefined;
    if (!instancePos) {
      this.reportInfo(
        DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
        `'${statement.instance}' isn't connected (or its event schema is unknown) — conformance to the declaration '${typeNameOf(param.type)?.graph ?? param.name}' is unchecked for this lane`,
        statement.span,
      );
      return;
    }

    if (surfaceNotEnumerated(instancePos)) {
      this.reportInfo(
        DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
        `'${statement.instance}'s event schema can't be introspected — conformance to the declaration '${typeNameOf(param.type)?.graph ?? param.name}' is unchecked for this lane`,
        statement.span,
      );
      return;
    }

    this.conformShapeNode({
      shapeSchema,
      shapeNodeName,
      instanceSchema: instanceSchema!,
      instancePosName: eventPos!,
      statement,
      param,
      visited: new Set(),
      path: '',
    });
  }

  private conformShapeNode(input: {
    shapeSchema: InstanceSchema;
    shapeNodeName: string;
    instanceSchema: InstanceSchema;
    instancePosName: string;
    statement: ListenDeclaration;
    param: MovementDeclaration['params'][number];
    visited: Set<string>;
    path: string;
  }): void {
    const visitKey = `${input.shapeNodeName}::${input.instancePosName}`;
    if (input.visited.has(visitKey)) return;
    input.visited.add(visitKey);

    const shapeNode = input.shapeSchema.positions[input.shapeNodeName];
    const instancePos = input.instanceSchema.positions[input.instancePosName];
    if (!shapeNode || !instancePos) return;
    if (surfaceNotEnumerated(instancePos)) return;

    for (const [fieldName, shapeType] of Object.entries(shapeNode.properties)) {
      const sourceType = instancePos.properties[fieldName];
      if (sourceType === undefined) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}' has no field \`${fieldName}\` that the declaration '${input.shapeNodeName}' requires — this lane can't fire '${input.statement.movement}'`
            : `'${input.statement.instance}' ${input.path}has no field \`${fieldName}\` that the declaration '${input.shapeNodeName}' requires`,
          input.statement.span,
        );
        continue;
      }
      if (!fieldAssignable(sourceType, shapeType)) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}'.\`${fieldName}\` (${describeFieldType(sourceType)}) doesn't fit declared field \`${fieldName}\` (${describeFieldType(shapeType)})`
            : `'${input.statement.instance}' ${input.path}\`${fieldName}\` (${describeFieldType(sourceType)}) doesn't fit declared field \`${fieldName}\` (${describeFieldType(shapeType)})`,
          input.statement.span,
        );
      }
    }

    for (const [edgeName, shapeEdge] of Object.entries(shapeNode.edges)) {
      const instanceEdge = instancePos.edges[edgeName];
      if (!instanceEdge) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}' has no relationship '${edgeName}' that the declaration '${input.shapeNodeName}' requires`
            : `'${input.statement.instance}' ${input.path}has no relationship '${edgeName}' that the declaration '${input.shapeNodeName}' requires`,
          input.statement.span,
        );
        continue;
      }
      this.conformShapeNode({
        ...input,
        shapeNodeName: shapeEdge.target,
        instancePosName: instanceEdge.target,
        path: `${input.path}${edgeName} → `,
      });
    }
  }

  // ── Extraction ──

  /** Checks the tree and returns the inferred result graph's root type (check 9). */
  private checkExtract(
    extract: ExtractExpression,
    scope: Scope,
    binding?: string,
  ): PositionTypeRef {
    // Extraction IS the typed model read — the row's `ai`. Its sources are
    // ordinary expressions and raise their own reads.
    this.effects?.flag('ai');
    // The tier reads by the same rule as `AI(prompt, "…")`'s — one vocabulary,
    // one judgement, reported here at the statement that carries it.
    for (const d of aiTierDiagnostics(extract.tier)) {
      if (d.severity === 'info') this.reportInfo(d.code, d.message, extract.span);
      else this.report(d.code, d.message, extract.span);
    }
    for (const slot of extract.from) {
      this.checkExprSlot(slot, scope);
    }
    this.checkExtractStages(extract.stages, scope, new Set());
    const node = buildExtractGraph(EXTRACT_ROOT_NAME, extract.stages, {
      resolveType: field => this.resolveExtractFieldType(field, scope),
      resolveDeclared: type => declaredExtractShape(scope.resolve(type)),
    });
    this.recordNode({
      kind: 'extract',
      span: extract.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      node,
    });
    return { kind: 'extract', node };
  }

  /**
   * `extract(content, Shape, { … })` — content in, a list of `Shape` records
   * out. The records read the way an extracted record of the same declaration
   * reads under the keyword (`readsAsPresentText`): plain text is always
   * there, anything typed may be absent. They are run-local records, so a
   * walk, a WHERE, a write or a link into one stays in the run, as it does for
   * a graph literal.
   */
  private checkExtractCall(
    call: ExtractCallExpression,
    scope: Scope,
    binding: string | undefined,
  ): FieldType | undefined {
    this.effects?.flag('ai');
    this.checkExtractCallContent(call.content, scope);
    if (call.config !== undefined) this.checkExtractCallConfig(call.config);
    const shape = this.resolveExtractCallShape(call.shape, scope);
    if (shape === undefined) return undefined;
    const { declaration, schema } = shape;
    const node = shapeExtractGraph(declaration.name, declaration.root, declaration.name, schema);
    this.recordNode({
      kind: 'extract',
      span: call.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      node,
    });
    const record = recordOf(extractedRecordType(node));
    switch (call.finds) {
      case 'each':
        return listOf(record, 'ordered');
      // The content may describe none — absence the reader has to handle, as
      // `ONLY(extract(…))`'s is.
      case 'one':
        return maybeAbsent(record);
      default:
        return neverAsAny(call.finds);
    }
  }

  /** The declaration the shape argument names or writes in place — refused,
   *  with the fix, when it is anything else. */
  private resolveExtractCallShape(
    shape: ExtractCallShape,
    scope: Scope,
  ): DeclaredExtractShape | undefined {
    switch (shape.kind) {
      case 'inline': {
        // The declaration's own path, in a scope of its own: written in the
        // argument, it names the shape for this call and nothing after it.
        const own = new Scope('branch', scope);
        this.checkStatement(shape.declaration, own);
        return declaredExtractShape(own.resolve(shape.declaration.name));
      }
      case 'named': {
        const resolution = scope.resolve(shape.name);
        if (resolution.kind !== 'found') {
          this.reportResolutionFailure(shape.name, shape.span, resolution);
          return undefined;
        }
        const declared = declaredExtractShape(resolution);
        if (declared !== undefined) return declared;
        if (resolution.symbol.kind !== 'shape') {
          this.report(
            DiagnosticCodes.EXTRACT_SHAPE_COMPUTED,
            `'${shape.name}' is ${describeKind[resolution.symbol.kind]}, and 'extract' takes a node declaration — the records it hands back are of that shape, so the shape has to be known when the program is checked. Declare it (\`node ${shape.name}: "…" { … }\`) and pass its name, or write it in place.`,
            shape.span,
          );
        }
        return undefined;
      }
      case 'computed':
        this.checkExprSlot(shape.expr, scope);
        this.report(
          DiagnosticCodes.EXTRACT_SHAPE_COMPUTED,
          `'extract' takes a node declaration by its name (\`extract(content, Company)\`) or written in place (\`extract(content, node Company: "…" { … })\`) — the records it hands back are of that shape, so a shape worked out at run time types nothing`,
          shape.span,
        );
        return undefined;
      default:
        return neverAsAny(shape);
    }
  }

  /** The content is a list of text and files. A record goes in as TEXT, which
   *  the author renders — the rendering is part of the prompt, and only the
   *  author knows which one they want. */
  private checkExtractCallContent(content: ExprSlot, scope: Scope): void {
    // HELD, not read: each item is its own block of the prompt, so a list
    // literal keeps its tuple type and every item is judged on its own — a
    // record among the text is named as one, not folded into a mixed list.
    const { valueType, parsed } = this.checkExprSlot(content, scope, { holdsValue: true });
    if (this.bareNodeSymbol(content.raw, parsed, scope) !== undefined) {
      this.report(
        DiagnosticCodes.EXTRACT_CONTENT,
        `'${content.raw.trim()}' is a record, and 'extract' reads text and files — render it as text and put it in the content list: \`extract([TEXT.SERIALISE(${content.raw.trim()}, 'JSON')], …)\``,
        content.span,
      );
      return;
    }
    if (valueType === undefined) return; // unknown stays silent
    const problem = extractContentProblem(valueType, content.raw.trim());
    if (problem !== undefined) this.report(DiagnosticCodes.EXTRACT_CONTENT, problem, content.span);
  }

  /** A settings record is read, not typed — the engine's own reader settles
   *  it here, against the models this deployment reaches when that is known. */
  private checkExtractCallConfig(config: ExprSlot): void {
    let parsed: Expression;
    try {
      parsed = expressionOfSlot(config);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(e.code ?? DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(config, e.pos));
      return;
    }
    const models = this.catalog.models?.();
    const reading = readExtractCallConfig(parsed, models !== undefined ? { models } : {});
    if (reading.ok) return;
    for (const problem of reading.problems) {
      this.report(DiagnosticCodes.EXTRACT_CONFIG, problem, config.span);
    }
  }

  /**
   * An extract field's explicit annotation: a primitive type name, or a
   * BORROWED `<instance>.<root>.<field>` path resolved against the named
   * graph's schema (union of its writable-root fields and position
   * properties; writable wins — enums live on the write surface). Borrowing
   * is THE mechanism for typing extraction against another system's field:
   * the checker resolves it from the catalog here, and the engine
   * re-resolves the same path live at every firing — option lists are
   * never copied out. Unknown segments are MOV_BORROW_*; a graph in scope
   * without a schema stays silent (unknown never false-positives).
   */
  private resolveExtractFieldType(
    field: Pick<ExtractField, 'type' | 'span'>,
    scope: Scope,
  ): SchemaFieldType | undefined {
    if (field.type === undefined) return undefined;
    return this.resolveNamedType(field.type, field.span, scope);
  }

  /**
   * An annotation, resolved: a primitive type name, a refinement the program
   * declares, or a BORROWED `<instance>.<root>.<field>` path into another
   * graph's field. One resolver, because they are one surface — an extract
   * field's annotation and `MEMBERS(<…>)`'s argument are the same written
   * thing, and nothing downstream can tell a written option set from a
   * fetched one.
   */
  private resolveNamedType(written: string, span: Span, scope: Scope): SchemaFieldType | undefined {
    const segments = borrowedTypeSegments(written);
    if (segments === undefined) {
      const primitive = parseFieldTypeName(written);
      if (primitive !== undefined) return primitive;
      const declared = this.declaredTypeIn(written, scope);
      if (declared !== undefined) return declared;
      // A bare annotation that names neither a primitive nor a declared type
      // constrains nothing, and used to say so to nobody — the typo that
      // silently un-types a field.
      this.report(
        DiagnosticCodes.UNKNOWN_TYPE_NAME,
        `'${written}' is not a type — annotate with a primitive (${PRIMITIVE_TYPE_NAMES.join(', ')}), a type you declare (\`type ${written} = <"A" | "B">\`), or another field's type by path (<crm-[:companies]->.\`funding_stage\`>)${didYouMean(written, typeNamesInScope(scope))}`,
        span,
      );
      return undefined;
    }
    if (segments.length !== 3) {
      this.report(
        DiagnosticCodes.BORROW_MALFORMED,
        `'${written}' is not a borrowable path — a borrowed type names another graph's field: an edge, then the field (e.g. <crm-[:companies]->.\`funding_stage\`>)`,
        span,
      );
      return undefined;
    }
    const [graphName, rootName, fieldName] = segments;
    const resolution = scope.resolve(graphName);
    if (resolution.kind !== 'found') {
      if (resolution.kind === 'unknown') {
        this.report(
          DiagnosticCodes.BORROW_UNKNOWN_GRAPH,
          `Unknown name '${graphName}' in the borrowed type '${written}' — a borrowed type starts at a constructed instance, a declared node, or kg`,
          span,
        );
      } else {
        this.reportResolutionFailure(graphName, span, resolution);
      }
      return undefined;
    }
    const symbol = resolution.symbol;
    if (!isGraphSymbol(symbol)) {
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_GRAPH,
        `'${graphName}' is ${describeKind[symbol.kind]} — a borrowed type starts at a constructed instance, a declared node, or kg`,
        span,
      );
      return undefined;
    }
    const schema = symbol.schema;
    if (!schema) return undefined; // no schema → every typed check stays silent
    const fields = borrowableFieldsOf(schema, rootName);
    if (!fields) {
      const available = [
        ...new Set([...Object.keys(schema.writableRoots), ...Object.keys(schema.positions)]),
      ];
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_ROOT,
        `'${graphName}' has no '${rootName}' to borrow from${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
        span,
      );
      return undefined;
    }
    const type = fields[fieldName];
    if (type === undefined) {
      const available = Object.keys(fields);
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_FIELD,
        `'${graphName}.${rootName}' has no field '${fieldName}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
        span,
      );
      return undefined;
    }
    return type;
  }

  /**
   * A declaration's words are string expressions, checked HERE — against the
   * file scope at the declaration — so a name bound further down is refused as
   * read before it is bound, and an extraction that reuses the declaration from
   * anywhere gets the words the declaration's own scope gives them.
   */
  private checkShapeDescriptions(node: ShapeNode, scope: Scope): void {
    this.checkFieldChildNamesApart(node.fields, node.children);
    if (node.description !== undefined) this.checkExprSlot(node.description, scope);
    for (const field of node.fields) {
      if (field.description !== undefined) this.checkExprSlot(field.description, scope);
    }
    for (const child of node.children) this.checkShapeDescriptions(child, scope);
  }

  /**
   * A declared node's fields take the same explicit types extract annotations
   * do: primitive names, refinements declared in THIS file, or BORROWED dotted
   * paths into another graph's field (`crm_stage: crm.companies.funding_stage`).
   * `shapeToSchema` degraded anything it could not name to text at hoist time
   * (the borrow's graph may not be bound yet); here — at the declaration's
   * source position — each annotation resolves through the same resolver an
   * extract field's does, reports the same diagnostics (an unknown name,
   * including a refinement only an IMPORTING file declares, is
   * MOV_UNKNOWN_TYPE_NAME), and patches the schema in place.
   */
  private resolveShapeFieldTypes(
    node: ShapeNode,
    key: string,
    schema: InstanceSchema,
    scope: Scope,
  ): void {
    for (const field of node.fields) {
      // Version 1 resolved only borrowed paths here; any other name kept the
      // type `shapeToSchema` gave it at hoist, an unknown one reading as text.
      if (before(this.languageVersion, 2) && borrowedTypeSegments(field.type) === undefined) continue;
      const resolved = this.resolveExtractFieldType(
        { type: field.type, span: field.span },
        scope,
      );
      if (resolved !== undefined) {
        const properties = schema.positions[key]?.properties;
        if (properties) properties[field.name] = field.nullable === true ? (maybeAbsent(resolved) ?? resolved) : resolved;
      }
    }
    for (const child of node.children) {
      this.resolveShapeFieldTypes(child, `${key}.${child.name}`, schema, scope);
    }
  }

  /**
   * `through` arguments may reference inherited context (ancestor nodes'
   * fields along the path) plus the node's PRIOR stages' fields; a stage's
   * own or later fields are a forward reference — the pipeline runs before
   * they are extracted. Children declared in a stage inherit fields up to
   * and including that stage.
   *
   * A description is checked here on the SAME terms as any other string slot,
   * against the ordinary statement scope: the whole tree's descriptions are
   * evaluated when the spec is built, before a single field is extracted, so
   * an extracted field is not in scope for one. A name a description
   * interpolates that nothing in scope provides is reported here rather than
   * reaching the extractor as literal `${…}` text.
   */
  private checkExtractStages(
    stages: ExtractStage[],
    scope: Scope,
    inherited: Set<string>,
    declared?: ShapeNode,
  ): void {
    // The declaration's own names were checked where it was declared; only the
    // clashes the stages add are reported here.
    const stageFieldList = stages.flatMap(stage => stage.fields);
    this.checkFieldChildNamesApart(
      [...(declared?.fields ?? []), ...stageFieldList],
      stages.flatMap(stage => stage.children),
    );
    this.checkFieldChildNamesApart(stageFieldList, declared?.children ?? []);
    const stageFields = stages.map(stage => stage.fields.map(f => f.name));
    const prior = new Set(inherited);
    for (let k = 0; k < stages.length; k++) {
      const stage = stages[k];
      const ownOrLater = new Set(stageFields.slice(k).flat());
      for (const plugin of stage.through ?? []) {
        this.checkPluginCall(plugin, scope, { prior: new Set(prior), ownOrLater });
      }
      const seen = new Set<string>();
      for (const field of stage.fields) {
        if (seen.has(field.name)) {
          this.report(
            DiagnosticCodes.EXTRACT_FIELD_DUPLICATE,
            `'${field.name}' is declared twice in this node — each field names one thing`,
            field.span,
          );
        }
        seen.add(field.name);
        this.checkExprSlot(field.description, scope);
      }
      for (const name of stageFields[k]) prior.add(name);
      for (const child of stage.children) {
        if (child.description !== undefined) this.checkExprSlot(child.description, scope);
        if (child.declared === undefined) {
          this.checkExtractStages(child.stages, scope, new Set(prior));
          continue;
        }
        // The declaration is the node's first stage; the `through` stages that
        // follow may read its fields. Its own words were checked where it was
        // declared, against the scope it was declared in.
        const shape = this.resolveExtractShape(child, scope);
        const declaredFields = shape?.declaration.root.fields.map(f => f.name) ?? [];
        this.checkExtractStages(
          child.stages,
          scope,
          new Set([...prior, ...declaredFields]),
          shape?.declaration.root,
        );
      }
    }
  }

  /**
   * A record's fields and the edges to its child nodes are one namespace — the
   * record is written out, and read, by name — so a field and a child node
   * called the same thing leave `x.name` meaning two things. Refused where the
   * shape is written, the way a node literal's twin entries are.
   */
  private checkFieldChildNamesApart(
    fields: ReadonlyArray<{ name: string }>,
    children: ReadonlyArray<{ name: string; span: Span }>,
  ): void {
    const fieldNames = new Set(fields.map(field => field.name));
    for (const child of children) {
      if (!fieldNames.has(child.name)) continue;
      this.report(
        DiagnosticCodes.EXTRACT_FIELD_DUPLICATE,
        `'${child.name}' is both a field and a child node here — a record's fields and its child nodes share one namespace, so give one of them another name`,
        child.span,
      );
    }
  }

  /** The declaration `node entry: <Entry>` takes as its shape — refused, with
   *  the fix, when the name is not a node declaration. */
  private resolveExtractShape(
    node: DeclaredExtractNode,
    scope: Scope,
  ): DeclaredExtractShape | undefined {
    const { type, span } = node.declared;
    const resolution = scope.resolve(type);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(type, span, resolution);
      return undefined;
    }
    const shape = declaredExtractShape(resolution);
    if (shape === undefined) {
      this.report(
        DiagnosticCodes.EXTRACT_SHAPE_NOT_DECLARED,
        `'${type}' is ${describeKind[resolution.symbol.kind]}, not a node declaration — an extraction node takes its shape from a declared node ('node ${type}: "…" { … }' at the top of the file), or spells its fields inline ('node ${node.name}: "…" { … }')`,
        span,
      );
    }
    return shape;
  }

  private checkPluginCall(plugin: PluginCall, scope: Scope, fields: ThroughFieldsContext): void {
    const resolution = scope.resolve(plugin.plugin);
    let spec;
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(plugin.plugin, plugin.span, resolution);
    } else if (resolution.symbol.kind !== 'plugin') {
      this.report(
        DiagnosticCodes.THROUGH_NOT_PLUGIN,
        `'${plugin.plugin}' is ${describeKind[resolution.symbol.kind]}, not a plugin — 'through […]' takes imported plugins`,
        plugin.span,
      );
    } else {
      spec = this.catalog.plugin(resolution.symbol.importedName ?? plugin.plugin);
    }
    // A stage is plain function application — the same call, in the position
    // that feeds the extraction. So it folds the same row.
    this.absorbPluginRow(spec);
    const supplied = new Set(plugin.args.map(arg => arg.name));
    this.reportPluginMissingArgs(plugin.plugin, spec, supplied, plugin.span);
    for (const arg of plugin.args) {
      this.reportPluginBadArg(plugin.plugin, spec, arg.name, arg.value.span);
      this.checkExprSlot(arg.value, scope, { fields });
    }
  }

  /**
   * Calling a plugin adds what the plugin does — the declared row folded in
   * exactly as an inferred one is. Nobody having declared leaves the row a
   * LOWER BOUND: a stage runs, and what it reached is not a claim this checker
   * can make.
   */
  private absorbPluginRow(spec: PluginSpec | undefined): void {
    if (spec?.effects === undefined) this.effects?.markPartial();
    else this.effects?.absorb(rowFromDeclaration(spec.effects));
  }

  /** An argument the plugin's registry entry doesn't list. One fact, one code,
   *  whether it was written in a stage or at an ordinary call. */
  private reportPluginBadArg(
    name: string,
    spec: PluginSpec | undefined,
    arg: string,
    span: Span,
    /** A PLAIN call also accepts the arguments a stage gets fed for free —
     *  there is no extraction here to fill them, so the author does. */
    options?: { plain?: true },
  ): void {
    if (spec === undefined || spec.args.includes(arg)) return;
    if (options?.plain === true && spec.fedArgs?.some(fed => fed.name === arg)) return;
    const accepted =
      options?.plain === true
        ? [...spec.args, ...(spec.fedArgs ?? []).map(fed => fed.name)]
        : spec.args;
    this.report(
      DiagnosticCodes.THROUGH_BAD_ARG,
      `'${name}' does not accept an argument '${arg}'${accepted.length ? ` — it accepts: ${accepted.join(', ')}` : ''}`,
      span,
    );
  }

  /**
   * A `spec.requiredArgs` entry the call never supplies. One fact, one code,
   * whether it was written in a stage or at an ordinary call — the missing-arg
   * sibling of `reportPluginBadArg`.
   *
   * Only OMISSION is checked here. A supplied argument whose value resolves
   * absent at run time is a different, legal case — the engine's
   * skip-on-absent sentinel is the honest cover for that (a source field that
   * came back empty), and this diagnostic must never re-litigate it.
   */
  private reportPluginMissingArgs(
    name: string,
    spec: PluginSpec | undefined,
    supplied: Set<string>,
    span: Span,
  ): void {
    const missing = (spec?.requiredArgs ?? []).filter(arg => !supplied.has(arg));
    if (missing.length === 0) return;
    this.report(
      DiagnosticCodes.THROUGH_ARG_MISSING,
      `'${name}' is missing ${missing.length === 1 ? 'the required argument' : 'required arguments'} ${missing.map(a => `'${a}'`).join(', ')}`,
      span,
    );
  }

  /**
   * `vc_url_retrieval(email: @user_email)` written as an ordinary call — the
   * one-function-sort ruling, where a plugin is a function whose body isn't
   * visible and whose DECLARED row says what calling it does.
   *
   * Where it may be called is decided by that row, not by a syntactic slot: a
   * declared row folds into the caller and the call is legal anywhere a call
   * is. An UNDECLARED row keeps today's legality exactly — a `through [ … ]`
   * stage and nowhere else — because a call nobody can describe would silently
   * widen what the movement does.
   */
  private checkPluginApplication(statement: CallStatement, symbol: ScopeSymbol, scope: Scope): ReturnShape {
    const spec = this.catalog.plugin(symbol.importedName ?? statement.callee);
    this.absorbPluginRow(spec);
    // A plugin's parameters are a registry's flat config, in no order anyone
    // designed — so there is no position for an argument to take. Named only.
    if (isPositionalCall(statement.args)) {
      this.report(
        DiagnosticCodes.PLUGIN_ARGS_NAMED,
        `'${statement.callee}' is a plugin, and a plugin's arguments are named — write each as '<parameter>: <value>'${spec !== undefined && spec.args.length > 0 ? ` (it takes: ${spec.args.join(', ')})` : ''}`,
        statement.span,
      );
      return UNKNOWN_RETURN;
    }
    const supplied = new Set(statement.args.flatMap(arg => (arg.name !== undefined ? [arg.name] : [])));
    // Three ways a plugin is a stage and nothing else, in the order they
    // answer "why can't I call this": nobody said what it DOES, nobody said
    // what it HANDS BACK, or the extraction is its only way in. One refusal
    // per call — the first true one is the one to fix.
    const stageOnly = this.refusePlainPluginCall(statement, spec, supplied);
    this.reportPluginMissingArgs(statement.callee, spec, supplied, statement.span);
    for (const arg of statement.args) {
      if (arg.name === undefined) continue; // refused above: a plugin's arguments are named
      this.reportPluginBadArg(statement.callee, spec, arg.name, callArgSpan(arg), {
        plain: true,
      });
      this.reportPluginArgType(statement.callee, spec?.argTypes?.[arg.name], arg, scope);
    }
    // The call's value is what the plugin DECLARED it hands back, on the plane
    // that declaration lives on. Undeclared (or refused above) leaves it
    // unknown — true, and it refuses nothing: binding one stays silent rather
    // than MOV_CALL_RETURNS_NOTHING, which would be a claim.
    if (stageOnly || spec?.output === undefined) return UNKNOWN_RETURN;
    this.reportPluginOutputChanged(statement, spec);
    const output = pluginOutputUnder(spec, this.languageVersion) ?? spec.output;
    const found = (fields: Record<string, SchemaFieldType>): PositionTypeRef => ({
      kind: 'local',
      label: `what '${statement.callee}' found`,
      reads: { ...fields },
    });
    switch (output.kind) {
      case 'value':
        return { returns: true, fieldType: output.type };
      case 'record':
        return { returns: true, posType: found(output.fields) };
      case 'records':
        // One record per thing found, in the order the plugin found them — a
        // sequence, like a hop's landings, so FIRST and AT mean something.
        return { returns: true, fieldType: listOf(recordOf(found(output.fields)), 'ordered') };
      default:
        return neverAsAny(output);
    }
  }

  /**
   * A plugin argument against what the plugin declares it takes. A plugin is
   * handed values: an expression, or a call (a built-in's or a function's),
   * read as the value `v = <argument>` would bind. A RECORD handed to an
   * argument whose declared type holds none (text, a url, a number) is
   * refused, as a movement's value parameter refuses one; an argument
   * declared to take structured data (`json`) takes a record, and is handed
   * its fields — a `node { … }` literal included, as an argument with no
   * declared type does. A write, or a node literal handed to an argument that
   * takes a plain value, is a record written in place, not a value.
   */
  private reportPluginArgType(
    callee: string,
    declared: SchemaFieldType | undefined,
    arg: CallArg,
    scope: Scope,
  ): void {
    const name = arg.name ?? '';
    switch (arg.kind) {
      case 'expr': {
        const valueType = this.slotValueTypeSilently(arg.expr, scope);
        const record = this.bareSlotPositionType(arg.expr, scope) ?? recordIn(valueType)?.position;
        this.checkPluginArgValue({ callee, declared, name, record, valueType, span: arg.expr.span });
        return;
      }
      case 'call': {
        const reading = this.readCallAt(arg.call, scope, 'argument');
        if (reading.kind === 'value') {
          // A built-in called here (`relay(data: UPPER(x))`) is the value it
          // computes — an ordinary expression argument.
          const { valueType } = this.checkExprSlot(reading.expr, scope);
          const record = this.bareSlotPositionType(reading.expr, scope) ?? recordIn(valueType)?.position;
          this.checkPluginArgValue({ callee, declared, name, record, valueType, span: arg.call.span });
          return;
        }
        if (reading.kind === 'refused') {
          this.reportCallRefusal(reading.refusal);
          return;
        }
        // A function's call: it runs, and its value is the argument.
        const shape = this.boundCallShape(arg.call, scope, undefined, arg.call.span);
        const record = shape.posType ?? recordIn(shape.fieldType)?.position;
        const valueType = shape.fieldType ?? (shape.posType !== undefined ? recordOf(shape.posType) : undefined);
        this.checkPluginArgValue({ callee, declared, name, record, valueType, span: arg.call.span });
        return;
      }
      case 'node':
        // Structured data, or no declared type: the literal is what binding
        // it to a name and passing the name would hand over — its fields.
        if (declared === 'json' || declared === undefined) {
          const synthesised = this.checkNodeLiteral(arg.node, scope);
          this.checkPluginArgValue({ callee, declared, name, record: synthesised, valueType: recordOf(synthesised), span: arg.node.span });
          return;
        }
        this.refusePluginRecordInPlace(callee, declared, arg);
        return;
      case 'write':
        this.refusePluginRecordInPlace(callee, declared, arg);
        return;
      // Refused for every callee where arguments are bound: no argument
      // carries one.
      case 'closure':
      case 'type':
        return;
      default:
        return neverAsAny(arg);
    }
  }

  /** A plugin argument's value against the type the plugin declares for it. */
  private checkPluginArgValue(at: {
    callee: string;
    declared: SchemaFieldType | undefined;
    name: string;
    record: PositionTypeRef | undefined;
    valueType: FieldType | undefined;
    span: Span;
  }): void {
    const { callee, declared, name, record, valueType, span } = at;
    if (declared === 'json') {
      // Handed its fields, all at once: a record whose fields are read from
      // its system one at a time has none to hand, and a function's parameter
      // passed here needs them in hand, whatever the plugin then reads of them.
      if (record === undefined) return;
      if (holdsFieldsInHand(record, token => this.declaredShapeTokens.has(token))) {
        noteFieldsNeeded(record, `hands it to '${callee}' as '${name}', which takes every field (line ${span.start.line})`);
        return;
      }
      this.report(
        DiagnosticCodes.CALL_ARG_TYPE,
        `'${callee}' takes every field of the record it is given as '${name}', and this is ${describePosition(record)}, whose fields are read from its system one at a time. Pass a dict of the fields it needs ('${name}: { name: r.name, … }')`,
        span,
      );
      return;
    }
    if (declared === undefined) return;
    if (record === undefined && (valueType === undefined || !holdsRecords(stripAbsent(valueType)))) return;
    this.report(
      DiagnosticCodes.CALL_ARG_TYPE,
      `'${callee}' takes ${describeFieldType(declared)} for '${name}', and this is a record — pass one of its fields ('${name}: r.website')`,
      span,
    );
  }

  /**
   * A write written in place as a plugin argument, or a `node { … }` handed
   * to one that takes a plain value: a record, where a value is taken. The
   * engine has always refused a write at run time ("a plugin takes values");
   * said here, where it is written.
   */
  private refusePluginRecordInPlace(
    callee: string,
    declared: SchemaFieldType | undefined,
    arg: Extract<CallArg, { kind: 'write' | 'node' }>,
  ): void {
    const takes =
      declared === undefined ? 'a value' : declared === 'json' ? 'structured data' : describeFieldType(declared);
    const what = arg.kind === 'write' ? 'a write' : "a 'node { … }' literal";
    const repair =
      arg.kind === 'write'
        ? `Run the write first ('r = write …') and pass ${declared === undefined || declared === 'json' ? `'${arg.name}: r' or ` : ''}one of its fields ('${arg.name}: r.name')`
        : `Pass one of the values it would hold ('${arg.name}: …')`;
    this.report(
      DiagnosticCodes.CALL_ARG_TYPE,
      `'${callee}' takes ${takes} for '${arg.name}', and this is ${what} written in place — a record, and a plugin's arguments are values. ${repair}`,
      callArgSpan(arg),
    );
  }

  /**
   * A plugin whose output changed shape between the pin and the version
   * being checked, on a check for a move up: the call validates against the
   * new shape, but a program written against the
   * old one may validate too and read something else (all page text as one
   * string, say, where there is now a list of records). Said once per call.
   */
  private reportPluginOutputChanged(statement: CallStatement, spec: PluginSpec): void {
    const changed = spec.earlierOutputs?.find(entry => this.upgradeCrosses(entry.before));
    const now = pluginOutputUnder(spec, this.languageVersion);
    if (changed === undefined || now === undefined) return;
    this.reportUpgradeWarning(
      DiagnosticCodes.PLUGIN_OUTPUT_CHANGED,
      `'${statement.callee}' called on its own hands back ${describePluginOutput(now)} since language version ${describeLanguageVersion(changed.before)}; before it, ${describePluginOutput(changed.output)}. Check that this call reads its result as the new shape.`,
      statement.span,
    );
  }

  /**
   * Whether this plugin can be called at all outside a `through [ … ]` stage,
   * reporting the reason when it cannot. A plugin is a function whose body
   * isn't visible, so everything a call needs to know has to have been
   * declared: what running it does, what it hands back, and what it runs ON.
   */
  private refusePlainPluginCall(
    statement: CallStatement,
    spec: PluginSpec | undefined,
    supplied: Set<string>,
  ): boolean {
    if (spec === undefined) return false;
    const stage = `write it in a 'through [ … ]' (\`extract from [ … ] through [${statement.callee}] { … }\`)`;
    if (spec.effects === undefined) {
      this.report(
        DiagnosticCodes.PLUGIN_ROW_UNDECLARED,
        `'${statement.callee}' is a plugin that hasn't declared what it does, so it can only run as an extraction stage — ${stage}.`,
        statement.span,
      );
      return true;
    }
    if (spec.fedByExtraction === true) {
      this.report(
        DiagnosticCodes.PLUGIN_FED_BY_EXTRACTION,
        `'${statement.callee}' runs on what an extraction gives it and takes nothing of its own, so it only makes sense as a stage of one — ${stage}.`,
        statement.span,
      );
      return true;
    }
    if (spec.output === undefined) {
      this.report(
        DiagnosticCodes.PLUGIN_OUTPUT_UNDECLARED,
        `'${statement.callee}' is a plugin that hasn't declared what it hands back, so there is nothing to bind — it can only run as an extraction stage, where its output goes to the extractor: ${stage}.`,
        statement.span,
      );
      return true;
    }
    // A stage gets this argument fed to it; a plain call has no stage behind
    // it, so the author writes what the extraction would have written.
    const unfed = (spec.fedArgs ?? []).filter(
      fed => fed.required === true && !supplied.has(fed.name),
    );
    if (unfed.length > 0) {
      this.report(
        DiagnosticCodes.PLUGIN_FED_BY_EXTRACTION,
        `'${statement.callee}' is missing ${unfed.length === 1 ? 'the argument' : 'the arguments'} ${unfed.map(fed => `'${fed.name}'`).join(', ')} — inside a 'through [ … ]' the extraction supplies ${unfed.length === 1 ? 'it' : 'them'}, so a call on its own has to say ${unfed.length === 1 ? 'it' : 'them'} (\`${statement.callee}(${unfed.map(fed => `${fed.name}: …`).join(', ')})\`).`,
        statement.span,
      );
      return true;
    }
    return false;
  }

  // ── Expression slots ──

  /**
   * Name-resolves and (where rootable) type-checks an expression slot.
   * Returns the slot's shallow value type when inferable — write-field
   * compatibility (check 2) consumes it.
   */
  private checkExprSlot(
    slot: ExprSlot,
    scope: Scope,
    options?: SlotOptions,
  ): { valueType?: FieldType; parsed?: Expression } {
    const trimmed = slot.raw.trim();
    if (BARE_IDENT.test(trimmed)) {
      if (EXPR_LITERALS.has(trimmed.toUpperCase())) {
        // `TRUE` is a boolean on this road as on every other: a slot that
        // compares types (a declared text field) must see it as one.
        const literal = scalarLiteralType(trimmed);
        return literal !== undefined ? { valueType: literal } : {};
      }
      this.resolveNameWithFields(trimmed, slot.span, scope, options?.fields);
      // A bare name short-circuits the parse, but it still HAS a value type —
      // the binding's own. Without this its absence would die here, at the very
      // sites (a plain write field) that require presence.
      const held = this.bareNameValueType(scope, trimmed);
      const valueType = options?.holdsValue === true ? held : this.readHeldValue(held, slot.span);
      return valueType !== undefined ? { valueType } : {};
    }
    const hoisted = this.hoistNestedCalls(slot, scope);
    if (hoisted !== undefined) return this.checkExprSlot(hoisted, scope, options);
    let parsed: Expression;
    try {
      parsed = expressionOfSlot(slot);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(e.code ?? DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(slot, e.pos));
      return {};
    }
    const names = collectExpressionNames(parsed);
    for (const ref of new Set(names.refs)) {
      if (names.aliases.has(ref)) continue; // bound by a step within this expression
      this.resolveNameWithFields(ref, slot.span, scope, options?.fields);
    }
    this.checkSlotExpression(slot, scope, options?.writeField === true ? { writeField: true } : undefined);
    this.reportBlockReadBack(names, scope, slot.span);
    const typing = this.slotTyping(scope, slot.span);
    const valueType = options?.holdsValue === true
      ? typing.inferExact(parsed, options.writeTarget)
      : typing.infer(parsed, options?.writeTarget);
    return { parsed, ...(valueType !== undefined ? { valueType } : {}) };
  }

  /** A held value READ — a tuple as the list it widens to, refused where it
   *  holds records and values both. The walker's `widen`, for a bare name the
   *  statement layer typed without walking. */
  private readHeldValue(type: FieldType | undefined, span: Span): FieldType | undefined {
    const mixed = mixedTupleMessage(type);
    if (mixed !== undefined) this.report(TypedDiagnosticCodes.LIST_MIXED, mixed, span);
    return widenTuples(type, this.languageVersion);
  }

  /**
   * The RETIRED block read-back: `orgs.name`, `orgs-[o:co]->` — reaching into
   * the block that `orgs` was bound to for a name bound INSIDE it. Naming is
   * not exporting any more, so the name never left; the block hands one value
   * back with `return`.
   *
   * Diagnosed off the fact the checker already records: closing a block writes
   * each of its bindings into the enclosing scope's `escaped` map, against the
   * name the block was bound to. Nothing is marked for this — the read is
   * matched against what actually escaped.
   */
  private reportBlockReadBack(names: CollectedNames, scope: Scope, span: Span): void {
    for (const { root, members } of names.rooted) {
      for (const member of members) {
        if (!escapedFromBlock(scope, member, root)) continue;
        this.report(
          DiagnosticCodes.BLOCK_READ_BACK_RETIRED,
          `'${member}' is bound INSIDE the block '${root}' came from, and a block's bindings do not escape it — return the value from the block instead: '${root} = … { … return ${member} }'`,
          span,
        );
        return;
      }
    }
  }

  /** `narrowInto`: the scope IS-test narrowings are declared into (the if-arm's scope). */
  private checkConditionSlot(slot: ExprSlot, scope: Scope, narrowInto?: Scope): void {
    const hoisted = this.hoistNestedCalls(slot, scope);
    if (hoisted !== undefined) return this.checkConditionSlot(hoisted, scope, narrowInto);
    let condition: MovementCondition;
    try {
      condition = conditionOfSlot(slot);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(e.code ?? DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(slot, e.pos));
      return;
    }
    this.checkSlotExpression(slot, scope);
    this.checkCondition(condition, slot, scope, narrowInto);
  }

  private checkCondition(
    condition: MovementCondition,
    slot: ExprSlot,
    scope: Scope,
    narrowInto: Scope | undefined,
  ): void {
    switch (condition.kind) {
      case 'and':
        // In order, so an IS conjunct narrows the conjuncts after it.
        condition.conjuncts.forEach(c => this.checkCondition(c, slot, scope, narrowInto));
        return;
      case 'isTest': {
        const subject = condition.subjectRaw.trim();
        let subjectSymbol: ScopeSymbol | undefined;
        if (BARE_IDENT.test(subject)) {
          subjectSymbol = this.resolveName(subject, slot.span, scope);
        } else {
          this.checkExprSlot({ raw: condition.subjectRaw, span: slot.span }, scope);
        }
        const graphSymbol = this.resolveName(condition.type.graph, slot.span, scope);
        // A DECLARED NODE is a structure, not a graph, so the test it names is
        // a different question — asked and answered on its own.
        if (graphSymbol?.kind === 'shape') {
          this.checkDeclaredNodeTest(condition, graphSymbol, subjectSymbol, slot.span, narrowInto);
          return;
        }
        // An IS test naming a position the graph's known schema lacks can
        // never be true — same strictness as a parameter's TypeRef.
        if (graphSymbol && condition.type.position !== undefined) {
          const instance = isGraphSymbol(graphSymbol) ? instanceRefOf(graphSymbol) : undefined;
          if (instance && positionRefIn(instance, condition.type.position) === undefined) {
            this.reportUnknownPosition(
              graphSymbol,
              condition.type.graph,
              condition.type.position,
              slot.span,
            );
          }
        }
        // Narrowing (check 6): a positive IS test on a union-typed position
        // narrows it to the named variant inside the arm.
        if (
          narrowInto
          && subjectSymbol?.posType?.kind === 'union'
          && graphSymbol
          && condition.type.position !== undefined
        ) {
          const union = subjectSymbol.posType;
          if (
            union.instance.token === graphSymbol
            && union.variants.includes(condition.type.position)
          ) {
            narrowInto.declare({
              ...subjectSymbol,
              posType: {
                kind: 'position',
                instance: union.instance,
                position: condition.type.position,
              },
            });
          }
        }
        // An ADDRESS test — `e IS <at-[:`Record Change` WHERE `action` ==
        // "record.deleted"]->>`. A type guard is an INTERSECTION: the narrowed
        // type is the subject's own address extended by the test's pins (TS's
        // `A & B`), so the test never has to restate what the signature
        // already pinned. Its typos die at the pins (`checkAddressPins`); an
        // address that resolves to no grafted position narrows nothing —
        // `never` errors at the USE, not at the narrow.
        if (condition.type.hopsRaw !== undefined && graphSymbol) {
          const instance = isGraphSymbol(graphSymbol) ? instanceRefOf(graphSymbol) : undefined;
          const testAddress = addressOfTypeRef(condition.type.hopsRaw);
          if (instance !== undefined && testAddress !== undefined) {
            this.checkAddressPins(instance, testAddress, slot.span);
            const subject = subjectSymbol !== undefined ? subjectSymbol.posType : undefined;
            if (
              narrowInto
              && subjectSymbol !== undefined
              && subject !== undefined
              && (subject.kind === 'position' || subject.kind === 'union')
              && subject.instance.token === instance.token
            ) {
              const subjectAddress: EventAddress = subject.address ?? {
                event: subject.kind === 'position' ? subject.position : subject.union,
                narrowing: {},
              };
              if (subjectAddress.event === testAddress.event) {
                const merged: Record<string, string> = { ...subjectAddress.narrowing };
                let consistent = true;
                for (const [key, value] of Object.entries(testAddress.narrowing)) {
                  if (merged[key] !== undefined && merged[key] !== value) {
                    consistent = false; // pins two values — `never`; runtime is falsy
                    break;
                  }
                  merged[key] = value;
                }
                if (consistent) {
                  const mergedAddress: EventAddress = {
                    event: testAddress.event,
                    narrowing: merged,
                  };
                  const resolved = positionRefIn(
                    subject.instance,
                    eventAddressKey(mergedAddress),
                  );
                  if (resolved?.kind === 'position' || resolved?.kind === 'union') {
                    narrowInto.declare({
                      ...subjectSymbol,
                      posType: {
                        ...resolved,
                        address: mergedAddress,
                        ...(Object.keys(merged).length > 0
                          ? { narrowsEvent: mergedAddress.event }
                          : {}),
                      },
                    });
                  }
                }
              }
            }
          }
        }
        return;
      }
      case 'expr': {
        const names = collectExpressionNames(condition.expr);
        for (const ref of new Set(names.refs)) {
          if (names.aliases.has(ref)) continue;
          this.resolveName(ref, slot.span, scope);
        }
        const type = this.slotTyping(scope, slot.span).infer(condition.expr);
        // Gating on a STRUCTURED value is always-true, never a decision — the
        // one shape whose truthiness carries no information. Every other type
        // is left to its own truthiness, as before.
        const opaque = checkJsonOpaque(type, 'used as a condition');
        if (opaque !== null) this.report(opaque.code, opaque.message, slot.span);
        // Narrowing (layer 6): an `==` against a present value proves its
        // subject present inside the arm — the comparison joins `?:` fill and
        // traversal-as-gate as a guard form. Runs AFTER the walk above so the
        // condition itself is typed unnarrowed.
        if (narrowInto) this.narrowPresence(condition.expr, scope, narrowInto, slot.span);
        return;
      }
    }
  }

  /**
   * `rec IS <Doc>` — a STRUCTURAL test. The other `IS` forms ask "is this
   * position THAT one", by name or by address; a declared node names no
   * position at all, so the question is the one the language already answers
   * when a node literal reaches a `<Doc>` parameter: does what this position
   * OFFERS carry everything `Doc` declares? Same comparator, asked as a
   * predicate — which is why the test is decidable from the schema and needs no
   * data read.
   *
   * It follows that a single-typed subject is decided at CHECK time (its
   * structure is fully known, so the answer cannot vary per record) and there
   * is nothing to narrow: the arm's type is the type it already had. A UNION
   * subject is where the test does work — some members conform and some do not,
   * so the arm keeps the conforming ones and the `else` (via
   * `collectIsElimination`) keeps the rest, which is the record plane's
   * machinery verbatim with the comparator standing in for the name match.
   *
   */
  private checkDeclaredNodeTest(
    condition: Extract<MovementCondition, { kind: 'isTest' }>,
    declaration: ScopeSymbol,
    subjectSymbol: ScopeSymbol | undefined,
    span: Span,
    narrowInto: Scope | undefined,
  ): void {
    // The retired meta-node hop, said in the predicate's own vocabulary.
    if (condition.type.position !== undefined || condition.type.hopsRaw !== undefined) {
      const subject = condition.subjectRaw.trim();
      this.report(
        DiagnosticCodes.SHAPE_HOP_RETIRED,
        `'${condition.type.graph}' is a declared node — it IS the record it describes, so there is nothing to hop through: write '${subject} IS <${quoteName(condition.type.graph)}>'. Its nested nodes are edges you traverse off the value instead ('${subject}-[x:${quoteName(condition.type.position ?? 'name')}]->')`,
        span,
      );
      return;
    }
    if (narrowInto === undefined || subjectSymbol === undefined) return;
    const subject = this.symbolPositionType(subjectSymbol);
    if (subject?.kind !== 'union') return;
    const conforming = subject.variants.filter(
      variant => conformsToDeclaredNode(subject.instance, variant, declaration) !== false,
    );
    if (conforming.length === subject.variants.length) return; // proves nothing new
    narrowInto.declare({ ...subjectSymbol, posType: residualUnion(subject, conforming) });
  }

  /**
   * Declares the presence narrowings a true condition earns into the arm's
   * scope. `presenceProofs` owns which comparisons prove what; this side owns
   * only the scope mechanics — resolve the proven root, discharge that field's
   * absence on its position type, shadow the symbol with the narrowed one (the
   * same move an IS test makes).
   */
  private narrowPresence(
    expr: Expression,
    scope: Scope,
    narrowInto: Scope,
    span: Span,
    options: { visibleFrom?: Loc } = {},
  ): void {
    const typing = this.silentTyping(scope, span);
    this.declarePresence(presenceProofs(expr, operand => typing.infer(operand)), scope, narrowInto, options);
  }

  /**
   * The narrowings a condition's FALSITY earns, declared into `narrowInto` —
   * the guard clause `if x == null { ERROR(…) }`, whose continuation knows `x`
   * is present. Same mechanics as the positive side; only the proof set differs.
   */
  private narrowNegatedPresence(
    expr: Expression,
    scope: Scope,
    narrowInto: Scope,
    span: Span,
    options: { visibleFrom: Loc },
  ): void {
    const typing = this.silentTyping(scope, span);
    this.declarePresence(
      negativePresenceProofs(expr, operand => typing.infer(operand)),
      scope,
      narrowInto,
      options,
    );
  }

  /** Shadow each proven name with its narrowed self — the same scope move an
   *  `IS` test makes. The two planes discharge differently because they carry
   *  the absence differently, and a proof that discharges nothing declares
   *  nothing (so "unnarrowed" never collapses into "narrowed to nothing").
   *  `visibleFrom` bounds a narrowing declared into a scope the shadowed
   *  binding OUTLIVES (the guard clause's continuation); narrowing into an
   *  arm's own scope needs none — the arm's extent already bounds it. */
  private declarePresence(
    proofs: PresenceProof[],
    scope: Scope,
    narrowInto: Scope,
    options: { visibleFrom?: Loc } = {},
  ): void {
    for (const proof of proofs) {
      const resolution = scope.resolve(proof.root);
      if (resolution.kind !== 'found') continue;
      const symbol = resolution.symbol;
      if (proof.kind === 'nonBlank') {
        // Only a value binding narrows: an instance or a declaration is an
        // identity (a graph token), never a value read.
        if (symbol.kind !== 'param' && symbol.kind !== 'alias' && symbol.kind !== 'binding') continue;
        const nonBlank = proof.propertyId === undefined
          ? { ...symbol.nonBlank, value: true as const }
          : { ...symbol.nonBlank, fields: new Set([...(symbol.nonBlank?.fields ?? []), proof.propertyId]) };
        narrowInto.declare({ ...symbol, nonBlank }, options);
        continue;
      }
      if (proof.kind === 'field') {
        const posType = this.symbolPositionType(symbol);
        if (posType === undefined) continue;
        const narrowed = narrowPresent(posType, proof.propertyId);
        if (narrowed !== undefined) narrowInto.declare({ ...symbol, posType: narrowed }, options);
        continue;
      }
      if (symbol.bindingPlane === 'scalar') {
        if (symbol.fieldType === undefined || !isMaybeAbsent(symbol.fieldType)) continue;
        narrowInto.declare({ ...symbol, fieldType: stripAbsent(symbol.fieldType) }, options);
        continue;
      }
      const posType = this.symbolPositionType(symbol);
      if (posType === undefined) continue;
      const narrowed = narrowPresentNode(posType);
      if (narrowed !== undefined) narrowInto.declare({ ...symbol, posType: narrowed }, options);
    }
  }

  // ── Name resolution & failure reporting ──

  private resolveNameWithFields(
    name: string,
    span: Span,
    scope: Scope,
    fields: ThroughFieldsContext | undefined,
  ): void {
    if (fields) {
      if (fields.prior.has(name)) return;
      if (fields.ownOrLater.has(name)) {
        this.report(
          DiagnosticCodes.THROUGH_FORWARD_REF,
          `'${name}' is extracted by this stage (or a later one) — a 'through' pipeline runs before its stage, so it can only read fields from the node's earlier stages`,
          span,
        );
        return;
      }
    }
    this.resolveName(name, span, scope);
  }

  private resolveName(name: string, span: Span, scope: Scope): ScopeSymbol | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind === 'found') return resolution.symbol;
    this.reportResolutionFailure(name, span, resolution);
    return undefined;
  }

  private reportResolutionFailure(
    name: string,
    span: Span,
    resolution: Exclude<ReturnType<Scope['resolve']>, { kind: 'found' }>,
  ): void {
    switch (resolution.kind) {
      case 'pending':
        this.report(
          DiagnosticCodes.USE_BEFORE_BIND,
          `'${name}' is read before its binding statement — statements run in source order, so move this after the statement that binds '${name}'`,
          span,
        );
        return;
      case 'escaped': {
        // The ONE way a value leaves a block is `return`, so the hint is that
        // rewrite — not a reach back into the block, which no longer exists.
        const hint =
          resolution.blockName !== undefined
            ? ` — return it from the block instead ('${resolution.blockName} = … { … return ${name} }')`
            : " — return it from the block and bind the block ('names = … { … return " + name + " }')";
        this.report(
          DiagnosticCodes.NAME_UNRESOLVED,
          `'${name}' is not in scope — it was bound inside a traversal block, and a block's bindings do not escape it${hint}`,
          span,
        );
        return;
      }
      case 'unknown': {
        // The name IS a system we know — it was just never brought into
        // scope. Two lines short of working, so the message is both of them.
        // (This is the whole migration story for the graph, which stopped
        // being ambient: `kg` resolves here like any other adapter now.)
        if (this.catalog.adapter(name) !== undefined) {
          this.report(
            DiagnosticCodes.NAME_UNRESOLVED,
            `'${name}' is not in scope — import it and construct an instance first: `
              + this.importAndConstructLines(name)
              + seeHandbook(HANDBOOK_POINTERS.systems),
            span,
          );
          return;
        }
        // A connection the workspace has, named but never imported — the
        // credentials namespace is no more ambient than the adapters one.
        if (this.catalog.credential(name) !== undefined) {
          const line = importLine(name, 'credentials');
          this.reportWithFix({
            code: DiagnosticCodes.NAME_UNRESOLVED,
            message: `'${name}' is a credential — import it: add '${line}' at the top of the file`,
            span,
            fix: { edits: [insertLineAtTop(line)] },
          });
          return;
        }
        // Same story one namespace over: the plugin exists, the import line
        // doesn't. A plugin needs no construction, so that is the whole fix.
        if (this.catalog.plugin(name) !== undefined) {
          this.report(
            DiagnosticCodes.NAME_UNRESOLVED,
            `'${name}' is a plugin — import it: import { ${name} } from plugins`,
            span,
          );
          return;
        }
        this.report(
          DiagnosticCodes.NAME_UNRESOLVED,
          `Unknown name '${name}' — every name must be imported, bound by '=', a movement parameter, or a traversal alias in scope`,
          span,
        );
        return;
      }
    }
  }
}
