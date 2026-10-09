// Typed positions for the movement checker (M2b).
//
// Layers schema types onto M2a's binding layer: every bound name MAY carry a
// `PositionTypeRef` (where one is derivable), and the typed checks — writes
// (check 2), traversal validity (check 4), linked writes (check 5),
// narrowing (check 6), call fit (check 7), effect typing (check 8),
// extraction-tree validity (check 9) — fire only where a type is KNOWN.
// Unknown stays silent: a missing catalog schema, an untyped alias, a
// `_resources` hop all degrade to "no diagnostics", never to false
// positives.
//
// `ExpressionTyping` is the one expression walker: it validates every
// traversal it can root (reporting unknown edges / extract-field misuse)
// while inferring a shallow value type for write-field compatibility. The
// statement-level integration (which symbols carry which types) lives in
// check.ts; this module knows schemas and expressions, not scopes.

import {
  AI_TIER_ALIASES,
  AI_TIERS,
  FOLD_ALGEBRA,
  isObjectSpread,
  listElementExpression,
  objectMemberExpression,
  type AggregationFunction,
  type ObjectMember,
  type EdgeCapability,
  type Expression,
  type FilterOperator,
  type ListElement,
  type TraversalStep,
} from '@listen-fire/shared/expression/types';
import { isNullLiteral, isPurePredicate } from '@listen-fire/shared/expression/filter';
import { isNaturalOrder, orderKeyProperty } from '@listen-fire/shared/expression/order_limit';
import { quoteName } from '@listen-fire/shared/expression/formula';
import { POSITION_SENTINEL } from '../expression/bridge';
import {
  builtinOptionsFor,
  CHUNKS_FUNCTION_ID,
  CHUNKS_SIGNATURE,
  FILE_FUNCTION_ID,
  READ_FUNCTION_ID,
  READ_SIGNATURE,
  stdlibFunctionById,
  type BuiltinOptionsSpec,
  type BuiltinParamType,
  type StdlibFunctionSpec,
} from '../expression/stdlib';
import { builtinParamAt, describeBuiltin, lookupBuiltin, type Builtin } from './standard_library';
import { extractCallNestedMessage } from './calls';
import { neverAsAny } from '../never';
import { before, since, type LanguageVersion } from '../language_version';
import { Span } from '../parser/ast';
import {
  describeFieldType,
  EdgeSchema,
  edgeIsReadable,
  edgeIsWritable,
  EVENT_ACTION_FIELD,
  FieldType,
  InstanceSchema,
  PositionSchema,
  refinementKey,
  type SchemaFieldType,
  surfaceNotEnumerated,
  type TupleRest,
  variantOf,
} from './catalog';
import type { DeclaredEffectRow, EffectRow } from './effects';
import { eventAddressKey, type EventAddress } from './event_address';
import {
  closestByEditDistance,
  closestMovementMetaKey,
  didYouMean,
  isClockMetaKey,
  isMovementMetaKey,
  movementMetaKeyType,
} from './meta';

export const TypedDiagnosticCodes = {
  /** `ONLY(extract(content, Shape))` — the extraction call inside another
   *  expression. Its shape is a TYPE, which an expression cannot hold, so the
   *  call is read where a binding's value is; bind it, then use the name. */
  EXTRACT_CALL_NESTED: 'MOV_EXTRACT_CALL_NESTED',
  WRITE_UNKNOWN_ROOT: 'MOV_WRITE_UNKNOWN_ROOT',
  WRITE_UNKNOWN_FIELD: 'MOV_WRITE_UNKNOWN_FIELD',
  WRITE_FIELD_TYPE: 'MOV_WRITE_FIELD_TYPE',
  /** A DISCRIMINATED write shape's discriminant field is present but its value
   *  is NOT a compile-time literal (a property read, an AI() call, an
   *  interpolation). A create must know its shape at author time — without the
   *  literal the checker cannot select the variant and validate the body, so
   *  this is an ERROR (not a silent degrade). The message tells the author to
   *  name the target with a literal. The write-side dual of read narrowing,
   *  where a WHERE's literal selects a variant. */
  WRITE_DISCRIMINANT_NOT_LITERAL: 'MOV_WRITE_DISCRIMINANT_NOT_LITERAL',
  /** A write body field that PARAMETERIZES an edge's landing type
   *  (`EdgeSchema.genericOver` with `onNonLiteral: 'error'`) is present but is not a
   *  compile-time literal — an ask's `Answer Type` read out of a variable. The
   *  adapter already refuses this at run time (the answer's type has to be
   *  fixed when the ask is raised), so the checker says so up front instead of
   *  letting a create fail live. The WRITE_DISCRIMINANT_NOT_LITERAL shape, one
   *  door over: there the literal selects a write SHAPE, here it fixes a
   *  LANDING type. What a computed value costs is the edge's own declaration
   *  (`genericOver.onNonLiteral`); absent, it degrades silently — computed
   *  options are legitimate and were promised nothing. */
  WRITE_GENERIC_NOT_LITERAL: 'MOV_WRITE_GENERIC_NOT_LITERAL',
  /** WARNING severity: the same body field, on an edge that declares
   *  `onNonLiteral: 'warn'` — the write RUNS (an ask's `Fields` built from a
   *  query is a real thing to do), but the landing cannot be typed, so the
   *  answer arrives as one opaque value instead of a property per name. Not an
   *  error: nothing is wrong, something was LOST, and a guarantee lost in
   *  silence is lost twice. The message names the trade and how to take it
   *  back. */
  WRITE_GENERIC_UNTYPED: 'MOV_WRITE_GENERIC_UNTYPED',
  /** A write body's field set is assignable to NO variant of an UNTAGGED write
   *  union (`WritableRootSchema.writeUnion`) — a Slack message setting both
   *  `File` and `Blocks`. Nothing discriminates the variants, so this is plain
   *  assignability: the fields a body maps must be a subset of one shape. The
   *  message names the shapes and the fields that fit none of them together. */
  WRITE_UNION_UNSATISFIED: 'MOV_WRITE_UNION_UNSATISFIED',
  UNIQUE_UNKNOWN_FIELD: 'MOV_UNIQUE_UNKNOWN_FIELD',
  LINKED_UNKNOWN_EDGE: 'MOV_LINKED_UNKNOWN_EDGE',
  LINKED_NEEDS_TYPE: 'MOV_LINKED_NEEDS_TYPE',
  LINKED_TYPE_MISMATCH: 'MOV_LINKED_TYPE_MISMATCH',
  LINKED_TARGET_NOT_WRITABLE: 'MOV_LINKED_TARGET_NOT_WRITABLE',
  TRAVERSE_UNKNOWN_EDGE: 'MOV_TRAVERSE_UNKNOWN_EDGE',
  /** A read traversal walks a WRITE-ONLY edge (`EdgeSchema.readable: false`)
   *  — a pure create path with no read API behind it (WhatsApp's `replies`).
   *  Traversing it would silently yield nothing, so the read is an error;
   *  writes along the edge are untouched. */
  WRITE_ONLY_EDGE: 'MOV_WRITE_ONLY_EDGE',
  /** A BARE traversal walks an AWAITABLE edge (`EdgeSchema.awaitable: true`) —
   *  a promise in type-space (an ask's `Response`). Reading it live would
   *  yield nothing until it resolves; the author meant to `await` it. The TS
   *  analogue: property access on an un-awaited Promise. Carries a did-you-mean
   *  pointing at `await <head>-[:edge]->`. */
  AWAIT_REQUIRED: 'MOV_AWAIT_REQUIRED',
  /** An `await`'s WHERE narrows the awaited edge with an IMPURE predicate
   *  (AI() / EXISTS / a nested live traversal). The engine evaluates an await's
   *  WHERE against a candidate + the park's serialized scope WITHOUT rehydrating
   *  the run (F10), so it must be PURE. */
  AWAIT_IMPURE_WHERE: 'MOV_AWAIT_IMPURE_WHERE',
  /** A value that MAY be absent (a combinator slot no arm filled, a maybe-empty
   *  node's field — F19, an out-of-range index read) flows where a
   *  NON-ABSENT value is REQUIRED: a plain write field, an ORDERED comparison.
   *  (Equality is NOT such a site — absent is simply never equal.) The TS
   *  analogue is "possibly undefined" at a use site — the read itself is fine;
   *  the error is at the USE. Discharge it: a `?:` (fill) write field, a
   *  traversal-as-gate, an `==` guard, or a `COALESCE` whose fallback always
   *  answers. (asks-as-adapter P20/F13; layer 6.) */
  ABSENT_REQUIRED: 'MOV_ABSENT_REQUIRED',
  /** A property read names a field a CLOSED typed position does not declare
   *  (positions are closed unless the schema marks them `openProperties`). */
  UNKNOWN_PROPERTY: 'MOV_UNKNOWN_PROPERTY',
  /** A read or traversal through a handle NOTHING HAS DESCRIBED
   *  (`PositionSchema.undescribed`) — an unnarrowed event's `record` edge
   *  landing on the meta type, a type no describe answered for.
   *
   *  Distinct from an OPEN position, which is a positive claim that the surface
   *  is wider than enumerated and therefore stays silent. This is the ABSENCE of
   *  a claim: nothing has said what the handle carries, so the read cannot be
   *  checked and returns null at run time. The rule for a `never` — don't
   *  error at the narrow, error where the handle is USED. */
  UNDESCRIBED_POSITION: 'MOV_UNDESCRIBED_POSITION',
  /** A property read names a WRITE-ONLY field — declared on the type's write
   *  shape only (`readable: false`): a value a write SETS (WhatsApp Message's
   *  send-side `File`), never one with a value to read. Distinct from
   *  UNKNOWN_PROPERTY so the message can carry the adapter's own guidance
   *  for the field's real read path. */
  WRITE_ONLY_PROPERTY: 'MOV_WRITE_ONLY_PROPERTY',
  /** WARNING severity: the property name is carried by more than one of the
   *  source's fields, so the read resolves to the first. Legal — it never
   *  gates a compile — but the author should know their source has two fields
   *  wearing one name, because only they can rename one. */
  AMBIGUOUS_PROPERTY: 'MOV_AMBIGUOUS_PROPERTY',
  EXTRACT_UNKNOWN_FIELD: 'MOV_EXTRACT_UNKNOWN_FIELD',
  EXTRACT_TYPE_CONFLICT: 'MOV_EXTRACT_TYPE_CONFLICT',
  /** Info severity: an unannotated extract field flows into an option-set write
   *  target — suggest the explicit (borrowed) annotation. The message names
   *  the discharge in the same breath, because annotating is exactly what
   *  makes the read `T | absent` (R14) and a plain write field then refuses
   *  it: a nudge that led an author into a refusal it never mentioned would
   *  be pointing two ways at once. */
  EXTRACT_ANNOTATE: 'MOV_EXTRACT_ANNOTATE',
  /** An UNANNOTATED extract field — text, because the shortcut asks the model
   *  for words — written into a field text cannot fill (a number, a date, a
   *  yes/no, a file). TypeScript's string-where-number-is-required. The
   *  message names the annotation that makes the model answer the right type. */
  EXTRACT_NEEDS_ANNOTATION: 'MOV_EXTRACT_NEEDS_ANNOTATION',
  NARROWING: 'MOV_NARROWING',
  CALL_ARG_TYPE: 'MOV_CALL_ARG_TYPE',
  /** A comparison (relational `< <= > >=` or equality `== !=`) whose two
   *  operands are in different value categories (temporal / numeric / textual
   *  / boolean) — e.g. `date <= number`. Only raised when BOTH operand types
   *  are KNOWN; an underspecified side stays silent. The message names the two
   *  types and suggests a coercer (DATE / DATETIME / NUMBER). */
  COMPARE_TYPE_MISMATCH: 'MOV_COMPARE_TYPE_MISMATCH',
  /** A `json` value is OPERATED ON — compared, used in arithmetic, folded into
   *  text, aggregated. A structured value has no known shape (the DATA top
   *  type, TypeScript's `unknown`), so every such operation is meaningless
   *  rather than merely risky: the old `text` projection let them all through
   *  and produced `[object Object]` at run time. The message says what the
   *  author CAN do — pass the value through unchanged to a json field — and
   *  never suggests a narrowing syntax, because there isn't one. */
  JSON_OPAQUE: 'MOV_JSON_OPAQUE',
  /** A RECORD where a value is required — interpolated into text, added up,
   *  compared to a scalar. A record is a place in a graph, not data; it has no
   *  one spelling as text, and there is no implicit one. Read a field off it,
   *  or walk it. */
  RECORD_NOT_A_VALUE: 'MOV_RECORD_NOT_A_VALUE',
  /** A tuple holding both records and values — `[one, "label"]` — READ as a
   *  list: handed to `MAP`, written into a list field, folded. A list holds
   *  one kind of thing: a list of records is walked, a list of values is read,
   *  and nothing reads both. The literal itself is a tuple and may hold both
   *  (`AT(t, 0)` reads a slot); the refusal is where it is read as a list.
   *  Reported only where both halves are known; a member nobody can type keeps
   *  the honesty rule and stays silent. */
  LIST_MIXED: 'MOV_LIST_MIXED',
  /** `...x` inside a list literal where `x` is not a collection — a text, a
   *  number, a record, a dict. A spread splices a list's (or tuple's) members
   *  in; one thing has no members to splice. */
  LIST_SPREAD_NOT_A_LIST: 'MOV_LIST_SPREAD_NOT_A_LIST',
  /** `...x` inside a map literal where `x` has no keys to copy — a text, a
   *  list, a number — or is a record whose fields the program does not hold
   *  (a system's record, read one field at a time). */
  MAP_SPREAD_NOT_KEYED: 'MOV_MAP_SPREAD_NOT_KEYED',
  /** `{ k: v, ...m }` where `m` always has `k`: the written value is
   *  overwritten before anything reads it — TypeScript's error 2783. */
  MAP_KEY_OVERWRITTEN: 'MOV_MAP_KEY_OVERWRITTEN',
  /** An arithmetic operand (`+ - * /`) whose KNOWN type is not numeric — the
   *  classic being `"a" + b`, since `+` is addition and the language has no
   *  concat overload. The engine coerces through `Number()`, so such an
   *  operation evaluated to NaN and was stored as null without a word: the
   *  recurring "the type system said nothing" bug class. TypeScript's analogue
   *  ("the left-hand side of an arithmetic operation must be of type number")
   *  is an error, and so is this. A string operand carries a did-you-mean for
   *  `${…}` interpolation — the one real string-building path. Unknown operands
   *  stay silent, and a `json` one is JSON_OPAQUE's to report. */
  ARITH_NON_NUMERIC: 'MOV_ARITH_NON_NUMERIC',
  /** A string LITERAL compared to, written into, or narrowed against an enum
   *  field that is not one of that enum's options. Only literals are checked —
   *  a text field vs an enum stays silent (the value isn't known at author
   *  time). A typo'd value would silently never match at runtime, so this is an
   *  error, with a did-you-mean for the closest option. */
  ENUM_UNKNOWN_VALUE: 'MOV_ENUM_UNKNOWN_VALUE',
  /** A CLOSED enum whose option set is EMPTY — the empty union, TypeScript's
   *  `never`. No value satisfies it, so any use of the field is impossible
   *  rather than mistaken. Distinct from ENUM_UNKNOWN_VALUE so the message can
   *  say the domain is empty instead of sending the author hunting for a typo
   *  in a value that could never have been right. Unlike every other
   *  membership rule this does NOT depend on the value, so it also fires for a
   *  non-literal expression: "the value isn't known at author time" stops
   *  being a reason for silence when NO value would do. */
  ENUM_EMPTY_DOMAIN: 'MOV_ENUM_EMPTY_DOMAIN',
  /** Warning: a string LITERAL against an OPEN known-values field that is
   *  neither a known value nor id-shaped (`open.allowPattern`). The listing
   *  may be incomplete (private channels, later-created values), so this
   *  never gates a compile — it catches the typo'd-name case with a
   *  did-you-mean. */
  VALUE_UNLISTED: 'MOV_VALUE_UNLISTED',
  /** An `@`-prefixed meta field whose key is not one of the canonical eight
   *  (`@current_date`, `@user_email`, …). An unknown key resolves to null at
   *  runtime SILENTLY, so this is an error — almost always a legacy name
   *  (`@current_user_email`) or a typo; the message suggests the closest key. */
  META_UNKNOWN_KEY: 'MOV_META_UNKNOWN_KEY',
  /** A hop WHERE / ORDER BY / LIMIT asks for something the source can't do
   *  across that relationship — filter a non-filterable field/operator, order
   *  by a non-orderable field, or limit an edge that doesn't support it
   *  (adapter-capability-contract chunk 6). Only raised when the adapter has
   *  DECLARED its capability; an undeclared surface stays silent. */
  HOP_FILTER_UNSUPPORTED: 'MOV_HOP_FILTER_UNSUPPORTED',
  /**
   * WARNING — part of a hop's WHERE pushes to the source and part of it cannot,
   * so the rest runs app-side over what came back. The bracket states the
   * condition and the boundedness; WHERE it runs is delivery, and the engine is
   * free to deliver the same condition worse. So this is a note about the cost,
   * never a refusal — an adapter that loses a filter capability must not turn
   * saved movements into save errors.
   *
   * It is not a one-time save message either: it is derived from the capability
   * surface every time the program is checked, so validate and the picture both
   * carry it for as long as it is true, and it disappears on its own when the
   * source grows the filter.
   *
   */
  HOP_FILTER_RESIDUAL: 'MOV_HOP_FILTER_RESIDUAL',
  /**
   * WARNING — the filter sibling of `HOP_ORDER_ENGINE`, for the other half of
   * the bracket. A root collection whose source cannot narrow AT ALL
   * (`filter: 'bounded'`) is fetched in full and the WHERE runs here, over
   * everything the source handed back. The records you get are the WHERE's
   * answer either way; what differs is the size of the fetch, so this is the
   * cost said out loud, never a refusal.
   *
   * Like `HOP_ORDER_ENGINE` it is re-derived from the capability surface on
   * every check, so it appears for as long as it is true and disappears on
   * its own the day the source grows a native filter. A record edge's
   * `bounded` filter stays silent — the set is already in hand, bounded by
   * the record it left, so there is no bigger fetch to warn about.
   *
   */
  HOP_FILTER_ENGINE: 'MOV_HOP_FILTER_ENGINE',
  HOP_ORDER_UNSUPPORTED: 'MOV_HOP_ORDER_UNSUPPORTED',
  /**
   * WARNING — the sibling of `HOP_FILTER_RESIDUAL`, for the other half of the
   * bracket. A root collection whose source can NARROW but cannot SORT
   * (`filter: 'native'`, `order: 'bounded'`) is fetched in full — everything
   * the WHERE let through — and sorted here. The rows and their order are the
   * ones the author asked for; what differs is the size of the fetch, so this
   * is the cost said out loud, never a refusal.
   *
   * Like the residual-filter warning it is re-derived from the capability
   * surface on every check, so it appears for as long as it is true and
   * disappears on its own the day the source grows the sort.
   *
   */
  HOP_ORDER_ENGINE: 'MOV_HOP_ORDER_ENGINE',
  HOP_LIMIT_UNSUPPORTED: 'MOV_HOP_LIMIT_UNSUPPORTED',
  /** An ORDER-SENSITIVE fold (`JOIN`, `FIRST`, `LAST`, `AT`) reads a collection
   *  whose order MEANS NOTHING — a traversal with no `ORDER BY` over an edge no
   *  adapter declares sequenced, or a list collected from one. The fold would
   *  answer whatever the source happened to hand over that minute, and answer
   *  differently the next: a guarantee nobody has, spelled as if they did.
   *
   *  The message names the fixes that exist, in the order they usually apply:
   *  `ONLY` when the author means "the one that matched" (which is what most
   *  `FIRST`s mean), an `ORDER BY` on the hop when they mean a ranking, or a
   *  relationship the source keeps in order. Commutative folds (`COUNT`, `SUM`,
   *  `MIN`, `ONLY`, …) are unaffected — they answer the same over any
   *  permutation, so they take a set or a list. */
  FOLD_NEEDS_ORDER: 'MOV_FOLD_NEEDS_ORDER',
  /** A hop takes a `LIMIT` with no `ORDER BY`, over a relationship the source
   *  keeps in no particular order — "some n of them", which is the same bug as
   *  `FIRST` over an unordered set and gets the same treatment. */
  LIMIT_NEEDS_ORDER: 'MOV_LIMIT_NEEDS_ORDER',
  /** An ordering key — a hop's `ORDER BY`, or `SORT`'s key — that answers with
   *  SEVERAL values for one element (a many-valued field, a path ending in
   *  one). There is no single value to rank the element by, and comparing the
   *  collection would rank by whatever its text happens to be. Fold the key
   *  down to one value (`MIN`, `MAX`, `FIRST`) or name a single-valued one. */
  ORDER_KEY_MULTI: 'MOV_ORDER_KEY_MULTI',
  /** An ordering key that asks a model (`AI(…)`) or extracts a value. A key is
   *  read once per element and its answers are compared with each other, which
   *  needs a function of the element and nothing else. */
  ORDER_KEY_IMPURE: 'MOV_ORDER_KEY_IMPURE',
  /** `SORT` given something that is not a collection — one value has no order
   *  to put it in. */
  SORT_NOT_COLLECTION: 'MOV_SORT_NOT_COLLECTION',
  /** `SORT` given a key over a collection of plain values (text, numbers).
   *  A member has no fields to key on; such a list sorts by the members
   *  themselves — `SORT(xs)` / `SORT(xs, DESC)`. */
  SORT_KEY_ON_SCALAR: 'MOV_SORT_KEY_ON_SCALAR',
  /** `SORT` over a walk written INSIDE the call. A walk in an expression hands
   *  over its landings as plain records with no graph behind them, so there is
   *  nothing to read a key from. Bind the walk first —
   *  `entries = list-[e:Entries]-> { return e }` — and sort the name. */
  SORT_KEY_ON_WALK: 'MOV_SORT_KEY_ON_WALK',
  /** `SORT` over records with no key. A record has no order of its own, so
   *  there is nothing to rank it by until the key says. */
  SORT_NEEDS_KEY: 'MOV_SORT_NEEDS_KEY',
  /** A stdlib argument the function PARSES rather than passes on (a date format
   *  pattern) is given a computed value. Nothing at author time can see what
   *  the string will say, so the pattern would go unchecked and a typo in it
   *  would print silently wrong — the WRITE_DISCRIMINANT_NOT_LITERAL shape, one
   *  door over. Write the pattern down. */
  STDLIB_ARG_NOT_LITERAL: 'MOV_STDLIB_ARG_NOT_LITERAL',
  /** The same argument, written down and wrong — an unknown format token. The
   *  message carries the vocabulary and a did-you-mean, the way a typo'd enum
   *  value does. */
  STDLIB_ARG_INVALID: 'MOV_STDLIB_ARG_INVALID',
  /** A stdlib argument declared `recordArg` (`TEXT.PAIRS`'s first) that is
   *  neither a dict nor a typed record — `<json>` from a system included: it
   *  looks keyed at the write layer, but the checker cannot see its keys, so
   *  folding over it would fold over nothing the author wrote down. A record
   *  that may itself be ABSENT is not this error: absence propagates through
   *  the call the way it does everywhere else. */
  STDLIB_ARG_NOT_RECORD: 'MOV_STDLIB_ARG_NOT_RECORD',
  /** `TEXT.SERIALISE` of a value holding a `lazy` edge: the walk has not run,
   *  so there is nothing to write out until it is read. */
  STDLIB_ARG_LAZY_EDGE: 'MOV_STDLIB_ARG_LAZY_EDGE',
  /** A built-in's argument of a type its signature does not take —
   *  `UPPER(record)`, `ROUND("ten")` (language version 3; the signatures are
   *  the standard-library scope's, checker/standard_library.ts). */
  BUILTIN_ARG_TYPE: 'MOV_BUILTIN_ARG_TYPE',
  /** `READ(x)` where `x` is not a file. READ turns a FILE into its text, and
   *  nothing else has bytes to read — a text argument is either a value the
   *  author already has (so the call does nothing) or the wrong name. The
   *  message says which type it got. A file that may itself be ABSENT is not
   *  this error: reading nothing answers nothing. An argument the checker
   *  cannot type stays silent, as everywhere else. */
  READ_NOT_FILE: 'MOV_READ_NOT_FILE',
  /** `CHUNKS(x, { … })` where `x` is not a text. Cutting a text into pieces is
   *  the only thing this does, and everything else has to be made into text
   *  first. A text that may itself be ABSENT is not this error: there is
   *  nothing to cut, so the answer is no pieces. */
  CHUNKS_NOT_TEXT: 'MOV_CHUNKS_NOT_TEXT',
  /** An option in a built-in's options map (`CHUNKS(t, { size: … })`) whose
   *  value is the wrong type, or may not answer at all. The map's KEYS are
   *  the bridge's — they are written down, so a typo is a parse-time fact;
   *  the values are ordinary expressions, so only the checker sees them. */
  OPTION_INVALID: 'MOV_OPTION_INVALID',
  /** Info severity: a tier written in a spelling that predates the tiers
   *  (`AI(…, "smart")`). It still means what it always meant, so nothing is
   *  broken and this never gates a save — but the word the language now uses
   *  is the one the handbook teaches and the one the next reader will look
   *  for, so the nudge names it. */
  AI_TIER_LEGACY: 'MOV_AI_TIER_LEGACY',
  /** Info severity: a presence test — `x == null`, `x != null`, `EXISTS(x)` —
   *  whose subject can NEVER be absent, so the answer is fixed at author time.
   *  Not an error (the guard is harmless and may be defensive habit), but the
   *  author is testing for something the type says cannot happen; TypeScript
   *  reports the same shape as an always-truthy condition. Silent whenever the
   *  subject's type is unknown — an underspecified surface is not a claim. */
  PRESENCE_TEST_CONSTANT: 'MOV_PRESENCE_TEST_CONSTANT',
  /** A presence test (`== null`, `!= null`, `EXISTS`, `ISNULL`) on an
   *  extracted TEXT field, which is never absent — a text not found is `""`.
   *  An ERROR, unlike the constant-test note: the guard's author meant
   *  "was it found", and the test they wrote can no longer answer that. The
   *  message names the emptiness test that does. */
  PRESENCE_TEST_ON_TEXT: 'MOV_PRESENCE_TEST_ON_TEXT',
  /** A read or traversal off a position whose union has had EVERY member ruled
   *  out by the `IS` tests above it — the empty union, TypeScript's `never`.
   *  Nothing can reach the branch, so there is no surface to read. Reaching the
   *  branch is not itself the error (an exhaustive chain is good code, and
   *  erroring at the narrow would be erroring at a true statement), which is
   *  why this fires at the USE. Distinct from NARROWING so the message can say
   *  the cases are already covered rather than send the author to add another
   *  `IS` that could never match. */
  UNREACHABLE_BRANCH: 'MOV_UNREACHABLE_BRANCH',
  /** A dict is looked up by TEXT and by nothing else — the key world is JSON's,
   *  which has one key type. A key of some other shape reaches this rather than
   *  being stringified on the way in: the coercion is a decision (which format?
   *  which timezone?) and the author makes it, in writing. Fires at the two
   *  boundaries a key crosses: `GROUPBY`/`KEYBY`'s key function, and `AT(dict,
   *  key)`. */
  DICT_KEY_NOT_TEXT: 'MOV_DICT_KEY_NOT_TEXT',
  /** `AT(d, "key")` with a LITERAL key the dict literal never wrote down. The
   *  dict's keys are known (it was written as a literal), so a key it lacks is
   *  a typo rather than an everyday miss — the enum did-you-mean
   *  (`ENUM_UNKNOWN_VALUE`), one door over, and TypeScript's "property does
   *  not exist on type". A dict whose keys are data (`GROUPBY`, a system's
   *  json) has no such list and stays a lookup that may miss. */
  DICT_UNKNOWN_KEY: 'MOV_DICT_UNKNOWN_KEY',
} as const;

// ── Tiers ──

/** What the checker has to say about a written tier, if anything. Returned
 *  rather than reported, because the SAME vocabulary is written in two places
 *  — `AI(prompt, "…")`, an expression, and `extract "…" from […]`, a
 *  statement — and each reports at its own span. One rule, two callers. */
export interface TierDiagnostic {
  code: string;
  message: string;
  severity?: 'error' | 'info' | 'warning';
}

/**
 * A written tier, judged. Unknown is an ERROR with a did-you-mean, exactly as
 * a typo'd enum value is: it would otherwise mean "whatever the platform
 * defaults to", which is the same word doing double duty for "I didn't say"
 * and "I said something you ignored. A legacy spelling still runs — it means
 * what it always meant — so it is an INFO nudge toward the word we teach.
 */
export function aiTierDiagnostics(written: string | undefined): TierDiagnostic[] {
  if (written === undefined) return [];
  if ((AI_TIERS as readonly string[]).includes(written)) return [];
  const legacy = AI_TIER_ALIASES.get(written);
  if (legacy !== undefined) {
    return [
      {
        code: TypedDiagnosticCodes.AI_TIER_LEGACY,
        message:
          `"${written}" is the old spelling of the "${legacy}" tier and still means it — `
          + `write \`"${legacy}"\` instead, which is the word the tiers are named in `
          + `(${AI_TIERS.map(t => `"${t}"`).join(' | ')}).`,
        severity: 'info',
      },
    ];
  }
  const closest = closestByEditDistance(written, [...AI_TIERS]);
  return [
    {
      code: TypedDiagnosticCodes.ENUM_UNKNOWN_VALUE,
      message:
        `"${written}" isn't a tier — expected one of: ${AI_TIERS.map(t => `"${t}"`).join(' | ')}.`
        + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
    },
  ];
}

// ── Position type references ──

/**
 * Identity of the graph a position belongs to. `token` is the ScopeSymbol
 * that introduced the graph (the constructed instance, the shape
 * declaration, the ambient kg) compared by reference — two positions are in
 * the same graph iff their tokens are the same object.
 */
export interface InstanceRef {
  token: object;
  name: string;
  schema: InstanceSchema;
}

/**
 * What a body hands back. `returns` is whether it hands anything back AT ALL —
 * a fact callers act on (a call that returns nothing cannot be bound) — kept
 * apart from the TYPE, which may be unknown for a body that plainly does
 * return. Conflating the two would turn "we couldn't type this" into "there is
 * nothing here", which is the accusation the checker must never make.
 *
 * The type, when known, sits on the plane every bound value already has: a
 * record POSITION (the arrow plane) or a VALUE (the dot plane).
 */
export interface ReturnShape extends PlaneType {
  returns: boolean;
}

/** A type on whichever PLANE it lives: a record POSITION (the arrow plane) or
 *  a VALUE (the dot plane). Both absent = untyped. */
export interface PlaneType {
  posType?: PositionTypeRef;
  fieldType?: FieldType;
}

/**
 * What a function's record PARAMETER needs of the record it is handed — the
 * half of its type its body decides. A system's record is opaque: its fields
 * are read one at a time, so a consumer that needs every field in hand (a
 * serialisation, a spread) refuses one. Inside the body the parameter is typed
 * by its declared shape, which holds its fields, so the body is accepted and
 * the requirement is filed here instead; every call site checks its argument
 * against it, as TypeScript checks an argument against a parameter.
 *
 * One cell per parameter, shared by every walk of the body and carried on the
 * parameter's position type (`PositionTypeRef.parameter`), so a name bound to
 * the parameter, a list holding it or a closure over it records here too.
 * A parameter passed on to another function's parameter takes on that one's
 * requirement (`passedTo`), read when a call site asks — so a cycle of calls
 * needs no fixpoint.
 */
export interface FieldsNeed {
  fn: string;
  param: string;
  /** The first consumer in the body that needs the fields in hand. */
  consumer?: string;
  passedTo: Array<{ need: FieldsNeed; at: string }>;
  /** The cell for the records reached THROUGH the parameter's edges, at any
   *  depth: a body that walks to a child and serialises it needs the child's
   *  fields in hand, which a record whose own fields are in hand may still not
   *  offer (a system write's result: its children are the system's). */
  reached?: FieldsNeed;
  /** This cell is a parameter's `reached` cell. */
  throughEdges?: true;
}

/** What a requirement is asked of: the record handed over itself, or the
 *  records reached through its edges. */
export type FieldsReach = 'record' | 'reached';

/** Why `need`'s parameter needs the fields of its record (`record`) or of
 *  what is reached through it (`reached`) in hand, if it does — directly, or
 *  through the parameters it is passed on to. */
export function fieldsNeededBy(
  need: FieldsNeed,
  reach: FieldsReach = 'record',
  seen: Array<{ need: FieldsNeed; reach: FieldsReach }> = [],
): string | undefined {
  // A reached cell stands for every depth below the parameter, so what is
  // reached from one of its records is reached from the parameter too.
  const asked: FieldsReach = need.throughEdges === true ? 'record' : reach;
  if (seen.some(s => s.need === need && s.reach === asked)) return undefined;
  seen.push({ need, reach: asked });
  if (asked === 'record' && need.consumer !== undefined) {
    return need.throughEdges === true
      ? `reaches a record through '${need.param}' and ${need.consumer}`
      : need.consumer;
  }
  if (asked === 'reached' && need.reached !== undefined) {
    const why = fieldsNeededBy(need.reached, 'record', seen);
    if (why !== undefined) return why;
  }
  const onwardReaches: FieldsReach[] = need.throughEdges === true ? ['record', 'reached'] : [asked];
  for (const onward of need.passedTo) {
    for (const onwardReach of onwardReaches) {
      const why = fieldsNeededBy(onward.need, onwardReach, seen);
      if (why !== undefined) return `${onward.at}, and '${onward.need.fn}' ${why}`;
    }
  }
  return undefined;
}

/** Files that `position`'s record — when it is a function's parameter — has
 *  its fields read by `consumer`. A position that is no parameter is nobody's
 *  business here. */
export function noteFieldsNeeded(position: PositionTypeRef | undefined, consumer: string): void {
  const need = parameterNeedOf(position);
  if (need !== undefined) need.consumer ??= consumer;
}

/** The parameter cell a position carries, through a gate. */
export function parameterNeedOf(position: PositionTypeRef | undefined): FieldsNeed | undefined {
  if (position === undefined) return undefined;
  if (position.kind === 'maybeEmpty') return parameterNeedOf(position.of);
  return position.kind === 'position' || position.kind === 'union' ? position.parameter : undefined;
}

/** The cell for what is reached through `need`'s parameter — made on first
 *  ask; a reached cell is its own (every depth shares it). */
function reachedThrough(need: FieldsNeed): FieldsNeed {
  if (need.throughEdges === true) return need;
  need.reached ??= { fn: need.fn, param: need.param, passedTo: [], throughEdges: true };
  return need.reached;
}

/** `landing`, walked from `from`, carrying the cell for what is reached
 *  through `from`'s parameter: a body's need of the child is a need of what
 *  the caller's record leads to, which is in hand exactly when the caller's
 *  record's children are (`holdsReachedFieldsInHand`). */
export function withParameterOf(
  from: PositionTypeRef | undefined,
  landing: PositionTypeRef | undefined,
): PositionTypeRef | undefined {
  const need = parameterNeedOf(from);
  if (need === undefined || landing === undefined) return landing;
  switch (landing.kind) {
    case 'maybeEmpty': {
      const of = withParameterOf(from, landing.of);
      return of !== undefined ? { ...landing, of } : landing;
    }
    case 'position':
    case 'union':
      return { ...landing, parameter: reachedThrough(need) };
    default:
      return landing;
  }
}

/** One parameter of a closure: its name, and what it accepts. */
export interface ClosureParam extends PlaneType {
  name: string;
}

export type PositionTypeRef =
  /** A bare instance name — the meta position whose edges are the collections. */
  | { kind: 'meta'; instance: InstanceRef }
  /** A position of a known type in a graph. */
  | {
      kind: 'position';
      instance: InstanceRef;
      position: string;
      narrowsEvent?: string;
      display?: string;
      address?: EventAddress;
      /** Fields a guard in scope has proven present — as on `extract`. */
      present?: ReadonlySet<string>;
      /**
       * The record is a landing on an appendable edge of a node THIS RUN
       * BUILT (`deduped-[e:entries]->`). The run's own graph holds it and it
       * has identity there, so `write e { … }` updates it in place exactly as
       * it would a record in a system that updates by id.
       */
      runBuilt?: true;
      /** The record is a function's parameter: what its body needs of it is
       *  filed here (`FieldsNeed`). */
      parameter?: FieldsNeed;
    }
  /** A union-typed position (`crm.record`); narrowed by `IS` tests. */
  | {
      kind: 'union';
      instance: InstanceRef;
      union: string;
      variants: string[];
      narrowsEvent?: string;
      display?: string;
      address?: EventAddress;
      parameter?: FieldsNeed;
    }
  // `narrowsEvent` above: the UNNARROWED event type this one narrows (the
  // event edge whose address pins base/table/action). Set only on an
  // address-narrowed event type — a listen's derived type, or a signature that
  // pins one. It is what makes an unaddressed signature the WIDER type rather
  // than a different one: "no address on the param accepts any listen".
  //
  // `address` above: the parsed event address itself (edge + pins), carried so
  // an IS test can narrow BY EXTENDING it (subject pins ∪ test pins — an
  // intersection type, exactly TS's `A & B`). The KEY stays the identity;
  // the address is the two sides' shared pre-key struct, never re-parsed
  // from the key.
  //
  // `display`: author-facing text for a ref whose KEY is opaque, when the ref
  // knows it and the schema does not — a LISTEN's derived address is a real type
  // even where no signature named it, so nothing grafted a position to hang a
  // `displayName` on. Diagnostics only.
  /** A write-result handle: position in the target graph + the write's result
   *  shape. `edges` is the write shape's relationship table, carried so a handle
   *  to a writable-only type (no minted position — an ask's `Check`) can still
   *  TRAVERSE its edges (`await a-[:Response]->`); access through the record you
   *  wrote, never a root read. Absent when the write shape declares no edges.
   *
   *  `genericLandings` is where THIS write's own literals landed: edge name →
   *  the position the host synthesized for the values this body authored
   *  (`EdgeSchema.genericOver`). It rides the HANDLE rather than being baked
   *  into `edges` because it is a fact about one construction site, not about
   *  the type — two `Choose` asks in one movement have the same edges and
   *  different landings. Empty/absent ⇒ every edge lands on its declared
   *  target. */
  | {
      kind: 'handle';
      instance: InstanceRef;
      position?: string;
      resultShape: Record<string, FieldType>;
      edges?: Record<string, EdgeSchema>;
      genericLandings?: Record<string, string>;
    }
  /** A position in an extract result graph (the root binding or a traversed
   *  node). `present` holds the fields a guard in scope has proven present —
   *  TypeScript's narrowed property reference, carried on the reference rather
   *  than the node, since the node is the one graph every reader shares. */
  | { kind: 'extract'; node: ExtractNodeType; present?: ReadonlySet<string> }
  /**
   * A CLOSURE — `(d: <date>) => { … }`, and everything sugared onto it (a
   * callback's body, an `until` condition). It is a value that can be bound,
   * passed and parked; what it carries is its signature: the parameters it
   * accepts and what calling it hands back (`returns` empty ⇒ it returns
   * nothing). It has no dot plane and no arrow plane — reading a field off a
   * closure or traversing one is an error, not an unknown.
   *
   * `effects` is the closure's own inferred effect row, riding in the type
   * because that is where a value's facts live: passing the closure around
   * carries the row with it, and CALLING it is what adds the row to the
   * caller's. Capturing one adds nothing.
   */
  | {
      kind: 'closure';
      label: string;
      params: ClosureParam[];
      returns: ReturnShape;
      effects: EffectRow;
    }
  /**
   * `T | absent` at the NODE level (asks-as-adapter F19/F20): an awaited landing
   * off a `resolvesEmpty` edge (an ask `Response` a cancel may resolve empty). A
   * DOT read of its field yields `T | absent` (the field may not be there); an
   * ARROW traversal INTO a block is gate-discharged (the block runs zero times
   * when empty), so it unwraps to the inner node. One unified absent with the
   * scalar case. */
  | { kind: 'maybeEmpty'; of: PositionTypeRef }
  /**
   * A CHECKER-LOCAL node — a position a CONSTRUCT mints rather than a system.
   * It belongs to no graph, so there is no schema to consult and nothing to
   * re-resolve at run time: it carries exactly what the construct declared, a
   * closed set of READS (dot plane) and optionally EDGES (arrow plane) whose
   * landings are themselves local. That is a write handle's shape minus the
   * instance — `handle.resultShape` + `handle.edges` for a node no adapter owns
   * — which is why the awaitable-edge story comes for free.
   *
   * `label` is author-facing text for diagnostics ('a callback', "a callback's
   * call"), never an identity: a local node IS its structure.
   *
   * Today's locals are the `callback(…)` binding and its `Called` landing.
   *
   */
  | {
      kind: 'local';
      label: string;
      /** The dot plane. A name PRESENT with an `undefined` type is a read the
       *  construct declared and could not type — different from a name that
       *  isn't there at all, and the difference is load-bearing: one reads
       *  as unknown, the other is an error. */
      reads: Record<string, FieldType | undefined>;
      edges?: Record<string, LocalEdge>;
      /** The landing `write deduped-[:entries]-> { … }` handed back: a record
       *  on an edge of a node this run built, updatable in place as the
       *  `position` kind's `runBuilt` is, with the edge's landing type — what
       *  `write h { … }` may set. A value the run merely synthesised (a
       *  `node { … }` or `graph<Shape> { … }` literal) is on no such edge, and
       *  does not carry it. */
      runBuilt?: { landing: PositionTypeRef };
      /** A record `extract(…)` / `extractOne(…)` handed back: one the run
       *  built, updatable in place like a landing — `fields` is what
       *  `write r { … }` may set, the fields the extraction declared. */
      extracted?: { fields: Record<string, SchemaFieldType> };
    };

/** One edge of a checker-local node: the same `EdgeSchema` promises every other
 *  edge carries (awaitable, resolvesEmpty, …), plus the landing itself — a
 *  local node has no instance to resolve a target NAME against. */
export interface LocalEdge {
  schema: EdgeSchema;
  /** The landing. ABSENT means the construct declared this edge and could not
   *  type where it lands — the arrow-plane twin of `reads[name] === undefined`,
   *  and the same load-bearing distinction: traversing it is unknown, not an
   *  unknown NAME. */
  target?: PositionTypeRef;
  /** The landing type is a DECLARED NODE — a structure, belonging to no system
   *  — so landings are compared by what they OFFER, the way an argument
   *  reaching a `<Company>` parameter is. An edge typed by an ADDRESS keeps the
   *  nominal test: its landings are records of that system, and one from
   *  elsewhere is not one of them. */
  structural?: true;
  /** The edge's landings are RECOMPUTED at every read (a `lazy` entry's walk),
   *  so there is no array for a `link` to append to — appending to one would be
   *  a landing that vanishes at the next read. */
  deferred?: true;
  /** A graph literal's edge holding REFERENCES to records (a bare walk, or a
   *  record written as an entry's value) — the real records, read live, as
   *  `{ items: obj }` holds `obj` in TypeScript. */
  references?: true;
}

/** Does the checker hold this record's fields IN HAND — see
 *  `ExpressionTyping.holdsSpelledFields`, which is this plus the note a
 *  parameter's body files. */
export function holdsFieldsInHand(
  position: PositionTypeRef | undefined,
  isDeclaredGraphToken: ((token: object) => boolean) | undefined,
): boolean {
  if (position === undefined) return false;
  switch (position.kind) {
    case 'extract':
    case 'handle':
    case 'local':
      return true;
    case 'maybeEmpty':
      return holdsFieldsInHand(position.of, isDeclaredGraphToken);
    case 'position':
    case 'union':
      return isDeclaredGraphToken?.(position.instance.token) === true;
    case 'meta':
    case 'closure':
      return false;
    default:
      return neverAsAny(position);
  }
}

/** Does the checker hold IN HAND the fields of the records reached through
 *  this record's edges? A walked child of a system's record — one traversed,
 *  or a system write's own result — is the system's record, read one field at
 *  a time; a record the run built (or extracted, or a declared shape's) holds
 *  its children, unless it holds a system's records by reference. */
export function holdsReachedFieldsInHand(
  position: PositionTypeRef | undefined,
  isDeclaredGraphToken: ((token: object) => boolean) | undefined,
): boolean {
  if (position === undefined) return false;
  switch (position.kind) {
    case 'extract':
      return true;
    case 'local':
      return liveReferenceWithin(position, isDeclaredGraphToken) === undefined;
    case 'maybeEmpty':
      return holdsReachedFieldsInHand(position.of, isDeclaredGraphToken);
    case 'handle':
    case 'position':
    case 'union':
      return isDeclaredGraphToken?.(position.instance.token) === true;
    case 'meta':
    case 'closure':
      return false;
    default:
      return neverAsAny(position);
  }
}

/**
 * The first reference edge, at any depth inside a checker-local node, that
 * holds records read live from a system — a record whose fields the program
 * does not hold, so a value holding one cannot be written out.
 */
function liveReferenceWithin(
  position: PositionTypeRef,
  isDeclaredGraphToken: ((token: object) => boolean) | undefined,
  /** Told of every record held by reference whose fields ARE in hand — a
   *  function's parameter among them files its need through it. */
  onParameter?: (held: PositionTypeRef | undefined) => void,
  seen = new Set<PositionTypeRef>(),
): string | undefined {
  if (seen.has(position)) return undefined;
  seen.add(position);
  if (position.kind === 'maybeEmpty') return liveReferenceWithin(position.of, isDeclaredGraphToken, onParameter, seen);
  if (position.kind !== 'local') return undefined;
  for (const [name, edge] of Object.entries(position.edges ?? {})) {
    const target = edge.target?.kind === 'maybeEmpty' ? edge.target.of : edge.target;
    if (
      edge.references === true
      && (target?.kind === 'position' || target?.kind === 'union' || target?.kind === 'meta')
      && isDeclaredGraphToken?.(target.instance.token) !== true
    ) {
      return name;
    }
    if (edge.references === true) onParameter?.(target);
    const nested = edge.target === undefined ? undefined : liveReferenceWithin(edge.target, isDeclaredGraphToken, onParameter, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The name of a `lazy` edge anywhere inside a checker-local node (its own
 *  edges, or the local nodes those land on): a value holding one cannot be
 *  written out, because the walk has not run. */
function deferredEdgeWithin(position: PositionTypeRef, seen = new Set<PositionTypeRef>()): string | undefined {
  if (seen.has(position)) return undefined;
  seen.add(position);
  if (position.kind === 'maybeEmpty') return deferredEdgeWithin(position.of, seen);
  if (position.kind !== 'local') return undefined;
  for (const [name, edge] of Object.entries(position.edges ?? {})) {
    if (edge.deferred === true) return name;
    const nested = edge.target === undefined ? undefined : deferredEdgeWithin(edge.target, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// ── The callback surface (one declaration; checker and editor both read it) ──

/** What a callback binding reads: the opaque `id` a platform payload carries
 *  (constant-size — the action's value is baked into the stored body at mint
 *  time) and the `url` a human follows. */
export const CALLBACK_READS: Record<string, FieldType> = { id: 'text', url: 'text' };

/** The callback's one edge: each FIRE, as it happens. */
export const CALLBACK_CALLED_EDGE = 'Called';

/** Every call carries WHEN it happened, whatever the signature. */
export const CALLBACK_CALL_AT = 'At';

/** The settings a `callback(…, { … })` config object accepts. This list is what
 *  diagnostics OFFER; `checkCallbackConfig`'s switch is what ENFORCES — adding
 *  a setting means adding both, in the same change. */
export const CALLBACK_CONFIG_KEYS: readonly string[] = ['once', 'ttl'];

/** A callback's FIRE-TIME signature: the values a platform supplies when it
 *  fires (an untyped entry is one whose declared type didn't resolve). */
export type CallbackParams = ReadonlyArray<{ name: string; type: FieldType | undefined }>;

/**
 * The type of `callback(<subject>, …)`: a local node with the `.id` / `.url`
 * reads and an awaitable `Called` edge landing on the CALL — `At` plus one
 * field per fire-time parameter, named and typed from the subject's own
 * signature. Fully static: the landing is derived here, at the construction
 * site, exactly as a write handle's result shape is.
 *
 * `Called` is `awaitable` (so `await cb-[:Called]->` waits for a fire and
 * `resolvesEmpty` types the landing `T | absent`) AND readable, since a bare
 * traversal reads the calls so far — zero of them before anything fires, which
 * is an empty traversal, not a special state. A repeatable callback simply
 * accumulates landings; traversals are many-valued already, so nothing in the
 * type says otherwise.
 *
 */
export function callbackType(params: CallbackParams): PositionTypeRef {
  const fields: Record<string, FieldType> = { [CALLBACK_CALL_AT]: 'datetime' };
  for (const param of params) {
    if (param.type !== undefined) fields[param.name] = param.type;
  }
  return {
    kind: 'local',
    label: 'a callback',
    reads: CALLBACK_READS,
    edges: {
      [CALLBACK_CALLED_EDGE]: {
        schema: {
          target: CALLBACK_CALLED_EDGE,
          awaitable: true,
          // A tap ARRIVES: the platform posts the callback and the run is woken
          // where it parked (`callback_fire`), so nothing has to look on a timer.
          watchable: true,
          resolvesEmpty: true,
          // The call ledger is APPENDED to as each fire lands
          // (`callback_store.ts`: `calls || [call]`), and the read hands back
          // that array — so the calls are in the order they arrived (R2).
          sequenced: 'arrival',
        },
        target: { kind: 'local', label: "a callback's call", reads: fields },
      },
    },
  };
}

/**
 * The type of `(<params>) => { … }` — its signature, and what calling it does.
 * A closure belongs to no graph and carries no data, so there is no plane to
 * read or traverse: the only thing that can be done with one is call it, so
 * `returns` says what that yields and `effects` says what it does.
 */
export function closureType(
  params: ClosureParam[],
  returns: ReturnShape,
  effects: EffectRow,
): PositionTypeRef {
  return { kind: 'closure', label: 'a closure', params, returns, effects };
}

/**
 * The graph a position belongs to, where it belongs to one — the effect row's
 * `read`/`write` entry. A maybe-empty landing is its own landing's graph; a
 * closure, an extract node and a checker-local node belong to no
 * graph, and saying nothing is the honest answer.
 */
export function instanceOfType(type: PositionTypeRef): InstanceRef | undefined {
  switch (type.kind) {
    case 'meta':
    case 'position':
    case 'union':
    case 'handle':
      return type.instance;
    case 'maybeEmpty':
      return instanceOfType(type.of);
    case 'local':
    case 'extract':
    case 'closure':
      return undefined;
  }
}

// ── Extract result graphs (inferred from the tree) ──

export interface ExtractFieldInfo {
  span: Span;
  /** What the author said this field is, in their own words — the same text the
   *  extraction itself is given. An inline field always declares one (the
   *  parser requires it); a field of a node declaration may not, and is then
   *  extracted by its name alone — absent, never invented. */
  description?: string;
  /** Explicit annotation — a primitive (`amount: number "…"`) or a
   *  borrowed path (`stage: crm.companies.funding_stage "…"`). The ONLY
   *  thing that types an extract field: backward adoption from write
   *  targets is demoted to a suggestion (explicit over implicit). A written
   *  annotation names a SURFACE type — a primitive, a declared option set, or
   *  another field's — so it is never a record. */
  explicit?: SchemaFieldType;
  /** The raw annotation token (`<…>` text) IF the author wrote one — kept
   *  even when it didn't resolve to a type here (missing schema / bad borrow),
   *  so we never suggest annotating a field that's already annotated. */
  annotationRaw?: string;
  /** `<text | null>` — the author asked for a missing field to arrive null,
   *  so even a text field reads `text | absent`. */
  nullable?: true;
  /** Annotation suggestions already emitted for this field (dedupe key:
   *  the suggested annotation text). */
  suggested?: Set<string>;
}

/**
 * Does this extracted field read as PRESENT text? Plain text is — the inline
 * `name: "…"` shortcut or `<text>`, inline or from a node declaration alike —
 * because the engine hands a text nobody found over as `""` (its
 * `presentTextFields`, the runtime half of this rule). A typed field, one
 * whose annotation did not resolve here, or one annotated `<text | null>`, is
 * not.
 */
export function readsAsPresentText(field: ExtractFieldInfo): boolean {
  if (field.nullable === true) return false;
  return field.explicit === 'text' || (field.explicit === undefined && field.annotationRaw === undefined);
}

export interface ExtractNodeType {
  /** Node name in the tree; the synthetic root reads as 'the extract result'. */
  name: string;
  /** The author's own words for this node. Absent on the synthetic root — it
   *  was never declared, so nobody described it. */
  description?: string;
  /** Every field the node declares, across all its stages — its outward shape.
   *  A later stage inherits the earlier ones and overrides what it re-declares. */
  properties: Map<string, ExtractFieldInfo>;
  /** Child nodes (from any stage) — the result graph's edges. */
  children: Map<string, ExtractNodeType>;
}

// ── Describing types in diagnostics ──

/**
 * A position's author-facing text. An ordinary position is named by its key;
 * a grafted event address is keyed by an OPAQUE token and carries its display
 * separately, so every diagnostic must come through here rather than render the
 * key it happens to hold.
 *
 */
export function displayNameOf(instance: InstanceRef, position: string): string {
  return instance.schema.positions[position]?.displayName ?? position;
}

export function describePosition(type: PositionTypeRef): string {
  switch (type.kind) {
    case 'meta':
      return `'${type.instance.name}' (the instance itself)`;
    case 'position':
      return `${type.instance.name}.${displayNameOf(type.instance, type.position)}`;
    case 'union':
      // Every member ruled out by an `IS` chain — the empty union, TypeScript's
      // `never`. No member is left to name, and naming the graph would imply
      // one was.
      if (type.variants.length === 0) return 'a record kind the branches above already cover';
      // `display` is the ref's own text for a residual the schema never
      // registered; the schema's own name still wins where it has one.
      return `${type.instance.name}.${type.instance.schema.unionDisplayNames?.[type.union] ?? type.display ?? type.union}`;
    case 'handle':
      return type.position !== undefined
        ? `a ${type.instance.name}.${displayNameOf(type.instance, type.position)} handle`
        : `a ${type.instance.name} write handle`;
    case 'extract':
      return type.node.name === EXTRACT_ROOT_NAME
        ? 'the extract result'
        : `the extracted node '${type.node.name}'`;
    case 'closure':
      return type.label;
    case 'local':
      return type.label;
    case 'maybeEmpty':
      return `${describePosition(type.of)} (which may be empty)`;
  }
}

/** A return shape (or a closure parameter's) in author-facing words. Both
 *  planes absent means the body hands nothing back — a fact, not a gap. */
export function describeReturnShape(shape: PlaneType): string {
  if (shape.posType !== undefined) return describePosition(shape.posType);
  if (shape.fieldType !== undefined) return describeFieldType(shape.fieldType);
  return 'nothing';
}

export const EXTRACT_ROOT_NAME = 'extract result';

// ── Field type compatibility ──

/**
 * The three bare built-in coercers and the category they retype to. They are
 * flat functions in the grammar (`{ fn: 'date' | 'datetime' | 'number' }`), so
 * the checker has no per-function spec to read a `returns` off — this map is
 * the single declaration that lets a cross-category comparison clear by
 * wrapping a side (`` `Snoozed Until` <= DATE(x) ``) and still flags a genuine
 * mismatch (`` `Snoozed Until` <= NUMBER(x) `` retypes to number, so a date
 * field on the other side is still caught).
 */
const BARE_COERCER_RETURNS: Readonly<Record<string, FieldType>> = {
  date: 'date',
  datetime: 'datetime',
  number: 'number',
};

/** Whether a parameter READS its argument as a value of some kind — what
 *  `checkBuiltinArgs` checks. The others take anything (`any`), or have a
 *  contract of their own checked where they are read (a record argument, an
 *  options map, a function, a type). */
function readsAsValue(param: BuiltinParamType): boolean {
  switch (param) {
    case 'scalar':
    case 'text':
    case 'number':
    case 'temporal':
    case 'file':
    case 'textOrList':
    case 'list':
      return true;
    case 'any':
    case 'record':
    case 'options':
    case 'function':
    case 'type':
    case 'shape':
      return false;
    default:
      return neverAsAny(param);
  }
}

/** Whether a value of `type` is one `param` takes. Absence passes through —
 *  every built-in answers absent for an absent argument — and a union must
 *  fit member by member. */
function paramAccepts(param: BuiltinParamType, type: FieldType): boolean {
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'maybeAbsent':
      return paramAccepts(param, variant.of);
    case 'absent':
      return true;
    case 'union':
      return variant.of.every(member => paramAccepts(param, member));
    case 'text':
    case 'enum':
      return param === 'scalar' || param === 'text' || param === 'temporal' || param === 'textOrList';
    case 'number':
      return param === 'scalar' || param === 'number';
    case 'boolean':
      return param === 'scalar';
    case 'date':
    case 'datetime':
      return param === 'scalar' || param === 'temporal';
    case 'file':
      return param === 'file';
    case 'list':
    case 'tuple':
      return param === 'list' || param === 'textOrList';
    // A record and a json value are reported before this is asked
    // (`requireTransparent`); a dict is keyed structure, which no value
    // parameter reads.
    case 'json':
    case 'record':
    case 'dict':
      return false;
    default:
      return neverAsAny(variant);
  }
}

function describeParamType(param: BuiltinParamType): string {
  switch (param) {
    case 'scalar':
      return 'one plain value (text, a number, a boolean or a date)';
    case 'text':
      return 'text';
    case 'number':
      return 'a number';
    case 'temporal':
      return 'a date, a datetime, or text that reads as one';
    case 'file':
      return 'a file';
    case 'textOrList':
      return 'text or a list';
    case 'list':
      return 'a list';
    case 'any':
      return 'any value';
    case 'record':
      return 'a record or a dict';
    case 'options':
      return 'a map of settings';
    case 'function':
      return 'a function';
    case 'type':
      return 'a type';
    case 'shape':
      return 'a node declaration';
    default:
      return neverAsAny(param);
  }
}

/** The flat built-in `COALESCE(a, b, …)`. The grammar lowercases every function
 *  name, so this is the id that reaches the checker. */
const COALESCE_FUNCTION_ID = 'coalesce';

/** `extractOne(…)`, as the grammar's lowercasing hands it over. */
const EXTRACT_ONE_FUNCTION_ID = 'extractone';

/** Wrap `T` as `T | absent`, flattening (`maybeAbsent(maybeAbsent(T))` is one
 *  level) so callers never nest. `undefined` (untyped) stays untyped — an
 *  unknown type can't be made partial. (asks-as-adapter P20/F13.)
 *
 *  A `T | absent` is still a T on whichever union T came from — the absence
 *  layer nests inside it — so a SURFACE type in is a surface type out.
 *  Overloads rather than a type parameter, which would infer the one literal
 *  argument's own type instead. */
export function maybeAbsent(type: SchemaFieldType | undefined): SchemaFieldType | undefined;
export function maybeAbsent(type: FieldType | undefined): FieldType | undefined;
export function maybeAbsent(type: FieldType | undefined): FieldType | undefined {
  if (type === undefined) return undefined;
  const variant = variantOf(type);
  switch (variant.kind) {
    // Already partial — flatten rather than nest a second layer.
    case 'maybeAbsent':
      return type;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'enum':
    case 'record':
    case 'union':
      return { kind: 'maybeAbsent', of: type };
    default:
      return neverAsAny(variant);
  }
}

/** The present component of a possibly-absent type — `T | absent → T`, `T → T`.
 *  A surface type in is a surface type out, as with `maybeAbsent`. */
export function stripAbsent(type: SchemaFieldType): SchemaFieldType;
export function stripAbsent(type: FieldType): FieldType;
export function stripAbsent(type: FieldType): FieldType {
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'maybeAbsent':
      return variant.of;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'enum':
    case 'record':
    case 'union':
      return type;
    default:
      return neverAsAny(variant);
  }
}

/** Whether reading this type may yield NO value — the checker's require-present
 *  sites (a plain write field, a comparison) fire on it unless discharged. */
export function isMaybeAbsent(type: FieldType | undefined): boolean {
  if (type === undefined) return false;
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'maybeAbsent':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'enum':
    case 'record':
    // A union's absence is hoisted outside it (`valueUnion`).
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/**
 * COALESCE, typed as TypeScript types `a ?? b`.
 *
 * ABSENCE: it answers the first argument that HAS a value, so it discharges
 * absence exactly when one argument definitely has one: a literal, or any
 * present-typed expression. `null` is not such an argument — it IS the
 * absence — so `COALESCE(x, null)` may still be absent. When EVERY argument may
 * be absent, so may the result: `COALESCE(FIRST(x))` is `FIRST(x)` with a
 * longer name, and it is refused wherever the bare form is. Answering
 * "untyped" there was laundering — information destruction reading as a
 * guarantee.
 *
 * KIND: the kind the arguments share (`null` aside), so
 * `COALESCE(e.diverse, FALSE)` is a boolean wherever it goes — a text field
 * declared on a node refuses it, as it refuses `FALSE`. Arguments of different
 * kinds have no one kind (the model has no unions), and the result is then
 * untyped, as it always was.
 *
 * An UNTYPED argument leaves the result unknown: nothing here knows whether it
 * answers, or what, so this manufactures neither a presence nor a kind
 * (unknown stays unknown, as in TS).
 */
function coalesceType(args: Array<FieldType | undefined>): FieldType | undefined {
  if (args.some(type => type === undefined)) return undefined;
  const typed = args as FieldType[];
  const valued = typed.filter(type => type !== 'absent');
  // Every argument is the `null` literal — the value that is never there.
  if (valued.length === 0) return 'absent';
  const kinds = valued.map(stripAbsent);
  const shared = kinds.every(kind => fieldTypeEquals(kind, kinds[0]!)) ? kinds[0] : undefined;
  if (valued.some(type => !isMaybeAbsent(type))) return shared;
  return shared !== undefined ? maybeAbsent(shared) : valued.find(isMaybeAbsent);
}

function unwrapList(type: FieldType): FieldType {
  const t = stripAbsent(type);
  const variant = variantOf(t);
  switch (variant.kind) {
    case 'list':
      return unwrapList(variant.of);
    // A tuple behaves as the list it widens to wherever its members unify —
    // one element type, so every list rule applies unchanged. Members that
    // share nothing have no element type, and the tuple stays itself
    // (`baseKind` calls that `json`: structured data whose shape nothing here
    // describes). The expression walker widens a tuple before any of this sees
    // it (`widenTuples`), so this answers only a tuple handed in directly —
    // which widens only to what its members share, as every version agrees.
    case 'tuple': {
      const list = widenTuple(variant, 'shared');
      return list !== undefined ? unwrapList(list) : t;
    }
    // A union is the element itself — one of several kinds, each rule
    // distributing over its members.
    case 'union':
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'dict':
    case 'enum':
    case 'record':
    // `stripAbsent` already peeled this, so it cannot arrive — but the case is
    // what keeps the switch total.
    case 'maybeAbsent':
      return t;
    default:
      return neverAsAny(variant);
  }
}

// ── Tuples read as lists ────────────────────────────────────────────────────
//
// A list literal is a TUPLE (language version 3) — its slots were written
// down, so `AT(t, 0)` reads exactly the first one — and everywhere else it is
// read as the list it widens to, TypeScript's tuple-to-array assignability:
// `[T, U]` read as a list is `(T | U)[]`. Members that share a type widen to a
// list of it; members that do not widen to a list of their UNION. A
// combinator's receipt is a tuple under every version and widens the same way.
//
// Versions 1 and 2 had no value unions: there a tuple whose members share
// nothing reads as a list nobody can type — silent wherever it goes — and a
// list literal is no tuple at all (the `list` case of the walker reads it where
// it is written). The widening half of that difference is decided here
// (`wideningUnder`) and nowhere else: a union exists only where this produced
// one, so no rule downstream asks the version again.
//
// The union is the READER's to build, because only a reader knows the
// program's version — the expression walker and the statement layer read
// through `widenTuples`. A tuple handed unread to a free predicate
// (`fieldAssignable`, `fieldTypeCompatible`, `unwrapList`) widens only to what
// its members share, which is what every version agrees on.

type TupleType = Extract<FieldType, { kind: 'tuple' }>;
type ListType = Extract<FieldType, { kind: 'list' }>;

/** How a tuple's disagreeing members widen: to no element anyone can type
 *  (`shared` — the members' one shared type, or nothing), or to their union. */
type Widening = 'shared' | 'union';

function wideningUnder(languageVersion: LanguageVersion): Widening {
  return before(languageVersion, 3) ? 'shared' : 'union';
}

/** Every type a tuple's members can have — its variadic run's included. */
function tupleMembers(tuple: TupleType): Array<FieldType | null> {
  return tuple.rest === undefined ? tuple.of : [...tuple.of, tuple.rest.of];
}

/**
 * The list a tuple widens to under `languageVersion` — `[T, U]` read as
 * `(T | U)[]`. A member nobody could type leaves no element to name (TS's
 * `unknown` swallows a union), and the widened list is UNKNOWN. So does a
 * mixture of records and values, which no list holds (refused where it is
 * read: `mixedTupleMessage`).
 */
export function tupleAsList(tuple: TupleType, languageVersion: LanguageVersion): ListType | undefined {
  return widenTuple(tuple, wideningUnder(languageVersion));
}

function widenTuple(tuple: TupleType, widening: Widening): ListType | undefined {
  const members = tupleMembers(tuple).map(member => widenTuplesBy(member ?? undefined, widening));
  // What the members share comes first, so a tuple that widened before still
  // widens to exactly that (a dict's written keys forgotten, records of
  // different positions one record type).
  const shared = unifyValueTypes(members);
  if (shared !== undefined) return { kind: 'list', of: shared };
  if (widening === 'shared') return undefined;
  const typed = members.filter((member): member is FieldType => member !== undefined);
  if (typed.length !== members.length) return undefined;
  const union = valueUnion(typed);
  return union !== undefined ? { kind: 'list', of: union } : undefined;
}

/** `type` with a tuple at its top read as the list it widens to under
 *  `languageVersion`, absence kept; any other type unchanged. */
export function widenTuples(type: FieldType | undefined, languageVersion: LanguageVersion): FieldType | undefined {
  return widenTuplesBy(type, wideningUnder(languageVersion));
}

function widenTuplesBy(type: FieldType | undefined, widening: Widening): FieldType | undefined {
  if (type === undefined) return undefined;
  const present = stripAbsent(type);
  if (!isTupleType(present)) return type;
  const list = widenTuple(present, widening);
  return isMaybeAbsent(type) ? maybeAbsent(list) : list;
}

// ── Value unions ────────────────────────────────────────────────────────────

/**
 * `A | B | …` in its one canonical form — the only constructor of a union, so
 * the set semantics hold everywhere one is compared or shown:
 *
 * - nested unions flatten, and a member twice is there once;
 * - absence is hoisted: `text | absent | number` is `(text | number) | absent`,
 *   which is how every require-present site already reads absence;
 * - a member another member accepts is absorbed — `json` takes every data
 *   shape, `text` every enum — as TS reduces `"a" | string` to `string`;
 * - one member left is that member; none is the `null` literal's type;
 * - members are sorted by display, so equal sets are one value.
 *
 * Records and values have no union — a list holds one or the other — so a
 * mixture answers undefined, and so does an empty set. Records of different
 * positions are one record type already (`unifyValueTypes`).
 */
export function valueUnion(types: readonly FieldType[]): FieldType | undefined {
  if (types.length === 0) return undefined;
  let absent = false;
  const flat: FieldType[] = [];
  const add = (type: FieldType): void => {
    if (isMaybeAbsent(type)) absent = true;
    const present = stripAbsent(type);
    if (present === 'absent') {
      absent = true;
      return;
    }
    if (isUnionType(present)) present.of.forEach(add);
    else flat.push(present);
  };
  types.forEach(add);
  const withAbsence = (one: FieldType): FieldType => (absent ? maybeAbsent(one)! : one);
  if (flat.length === 0) return 'absent';
  const records = flat.filter(member => isRecordType(member));
  if (records.length > 0) {
    if (records.length !== flat.length) return undefined;
    return withAbsence(unifyValueTypes(flat)!);
  }
  const kept = flat.filter((member, i) =>
    !flat.some((other, j) => j !== i && memberAbsorbs(other, member) && (j < i || !memberAbsorbs(member, other))),
  );
  if (kept.length === 1) return withAbsence(kept[0]!);
  const sorted = kept
    .map(member => ({ member, key: describeFieldType(member) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ member }) => member);
  return withAbsence({ kind: 'union', of: sorted });
}

/** Does a union holding `wide` already hold every `narrow`? */
function memberAbsorbs(wide: FieldType, narrow: FieldType): boolean {
  if (fieldTypeEquals(wide, narrow)) return true;
  if (wide === 'json') return isDataShaped(narrow);
  if (wide === 'text') return isEnumType(narrow);
  return false;
}

/** The members of a union, or the one type that is not one — absence peeled,
 *  as every rule that distributes over members reads them. */
export function unionMembers(type: FieldType): FieldType[] {
  const present = stripAbsent(type);
  return isUnionType(present) ? present.of : [present];
}

function isUnionType(type: FieldType): type is Extract<FieldType, { kind: 'union' }> {
  return typeof type !== 'string' && type.kind === 'union';
}

/**
 * Reading a tuple of records AND values as a list — `[one, "label"]` handed to
 * `MAP`, written into a list field. A tuple may hold both (each slot is its
 * own type); a LIST holds one kind of thing, because a list of records is
 * walked, a list of values is read, and nothing reads both. The message, or
 * undefined when the tuple (at any depth) holds one kind. A member nobody
 * could type says nothing, as everywhere.
 */
export function mixedTupleMessage(type: FieldType | undefined): string | undefined {
  if (type === undefined) return undefined;
  const present = stripAbsent(type);
  if (!isTupleType(present)) return undefined;
  const members = tupleMembers(present).filter((member): member is FieldType => member !== null);
  const record = members.find(member => isRecordType(member));
  const value = members.find(member => !isRecordType(member) && stripAbsent(member) !== 'absent');
  if (record !== undefined && value !== undefined) {
    return `a list holds one kind of thing, and this one holds both: ${describeFieldType(stripAbsent(record))} is a record, and another member is ${describeFieldType(widenTuplesBy(value, 'shared') ?? value)}. A tuple may hold both — read one slot with 'AT(t, 0)' — but read as a list it may not. Build a list of records and walk it ('both = [one, two]' … 'both-[c:company]-> { … }'), or read the records' fields first and build a list of the values.`;
  }
  return members.map(mixedTupleMessage).find(message => message !== undefined);
}

// ── The order discipline (set vs list) ──────────────────────────────────────
//
// A collection either carries a MEANINGFUL order or it does not, and the
// difference decides which folds may read it. The fact lives on two planes,
// the same split absence already lives on:
//
//   • the POSITION plane — a walk is ordered when its LAST hop is: the author
//     wrote an `ORDER BY` on it, or the adapter declares the edge inherently
//     sequenced (`EdgeSchema.sequenced`). The last hop is what produced the
//     members the fold reads; earlier hops chose where to start from. A chain
//     whose earlier hops fan out can still hand back a concatenation nobody
//     ordered — the honest limit of a checker that cannot see hop cardinality,
//     and the reason the rule is stated rather than implied.
//   • the VALUE plane — `FieldType`'s `{ kind: 'list', unordered? }`. A list is
//     a sequence by construction, so the flag marks the exception.
//
// `unknown` is the third answer and it is never a diagnostic: an untyped
// binding, an edge no schema described, a hop off a position nobody looked at.
// Saying nothing about a surface nobody described is the same rule the rest of
// this file follows.

export type CollectionOrder = 'ordered' | 'unordered' | 'unknown';

/** A walk written as a VALUE and read for its landings (`l-[e:Entries]->`) —
 *  the shape whose records arrive without the graph behind them. */
function isBareWalk(expr: Expression): boolean {
  return (
    expr.type === 'traverse'
    && expr.steps.length > 0
    && expr.expression.type === 'property'
    && expr.expression.propertyTypeId === POSITION_SENTINEL
  );
}

/** Does each value of this type stand alone — not a collection of several?
 *  `json` may hold a list at run time, so it is not known to. */
function holdsOneValue(type: FieldType): boolean {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'list':
    case 'tuple':
    case 'json':
      return false;
    case 'union':
      return variant.of.every(holdsOneValue);
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'absent':
    case 'dict':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
      return true;
    default:
      return neverAsAny(variant);
  }
}

/** Is this the end of a path the bridge marked "the positions themselves"? The
 *  one test that tells a walk read for its LANDINGS from one read for a field,
 *  and it is the shape the bridge already produces — nothing re-parsed. */
export function isPositionTerminal(expr: Expression): boolean {
  return expr.type === 'property' && expr.propertyTypeId === POSITION_SENTINEL;
}

/**
 * A walk read for a FIELD — `m-[a:Attachments]->.\`File\`` — which is
 * many-valued: one value per landing. Its type is the field's own (the walk
 * chooses the values, the field says what each one is, and plurality lives in
 * the traversal, never in a second type), and read as ONE value it collapses —
 * nothing landed is absent, one landing is its value, several are their
 * values. A reader that takes a COLLECTION (a fold, a spread) reads it as the
 * values themselves. The engine asks the same question of the same shape.
 */
export function isWalkProjection(expr: Expression): boolean {
  if (expr.type !== 'traverse' || expr.steps.length === 0) return false;
  const terminal = expr.expression;
  return (terminal.type === 'property' && terminal.propertyTypeId !== POSITION_SENTINEL)
    || terminal.type === 'edge_property';
}

/** A value read BY NAME — a dict. It has parts, so a key can name one, and no
 *  order of its own, so a key must. */
function isKeyedValue(type: FieldType): boolean {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    // A record is read by name too — its fields are the keys — so ordering a
    // list of records asks for the key the same way ordering a list of dicts
    // does, rather than falling to "sorts by its members".
    case 'dict':
    case 'record':
      return true;
    case 'union':
      return variant.of.every(isKeyedValue);
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'enum':
    case 'maybeAbsent':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/** A PLAIN value — text, a number, a date: something with no fields to key on
 *  and a natural order of its own. `json` and `file` are neither. */
function isPlainValue(type: FieldType): boolean {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    // An enum's values ARE text, so it orders as text does.
    case 'enum':
      return true;
    case 'union':
      return variant.of.every(isPlainValue);
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'record':
    case 'maybeAbsent':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/**
 * The call inside an ordering key that makes it something other than a
 * function of the element — a model call, an extraction. Named for the
 * message; undefined when the key is a read (a field, a path, arithmetic on
 * them), however deep.
 *
 */
function impureKeyCall(expr: Expression): string | undefined {
  switch (expr.type) {
    case 'llm':
      return 'AI(…)';
    case 'extract_value':
      return 'EXTRACT_VALUE(…)';
    case 'kg_exists':
    case 'kg_value':
      return expr.type === 'kg_exists' ? 'KG_EXISTS(…)' : 'KG_VALUE(…)';
    default:
      return subExpressions(expr).map(impureKeyCall).find(found => found !== undefined);
  }
}

/** Every expression written INSIDE one — the sub-terms a rule about the whole
 *  has to look through. */
function subExpressions(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'traverse':
      return [expr.expression, ...expr.steps.flatMap(step =>
        step.type === 'edge' && step.expressionFilter !== undefined ? [step.expressionFilter] : [],
      )];
    case 'resource_traverse':
      return expr.expressionFilter !== undefined ? [expr.expressionFilter, expr.expression] : [expr.expression];
    case 'aggregate':
      return expr.orderBy !== undefined ? [expr.expression, expr.orderBy] : [expr.expression];
    case 'not':
    case 'negate':
      return [expr.expression];
    case 'at':
      return [expr.expression, expr.index];
    case 'arithmetic':
    case 'compare':
      return [expr.left, expr.right];
    case 'logical':
      return expr.operands;
    case 'concat':
      return expr.parts;
    case 'conditional':
      return [expr.condition, expr.then, expr.else];
    case 'list':
      return expr.elements.map(listElementExpression);
    case 'object':
      return expr.entries.map(objectMemberExpression);
    case 'function':
      return expr.args;
    case 'exists':
      return expr.where !== undefined ? [expr.where] : [];
    default:
      return [];
  }
}

/**
 * One member of a VALUE collection — a list's element type, a tuple's shared
 * one. Undefined where the type is not a collection of values at all, which is
 * what the collection ops refuse on.
 */
export function collectionElementOf(type: FieldType): FieldType | undefined {
  const t = stripAbsent(type);
  const variant = variantOf(t);
  switch (variant.kind) {
    case 'list':
      return variant.of;
    // Members that share nothing leave a tuple with no element type — the
    // collection is real, but nothing here can say what one member is. (A
    // tuple handed in unread widens as every version agrees; a reader widened
    // it first — see "Tuples read as lists".)
    case 'tuple':
      return widenTuple(variant, 'shared')?.of;
    // A union of collections is a collection of what any of them holds.
    case 'union': {
      const elements = variant.of.map(collectionElementOf);
      return elements.every((element): element is FieldType => element !== undefined)
        ? valueUnion(elements)
        : undefined;
    }
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'dict':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
      return undefined;
    default:
      return neverAsAny(variant);
  }
}

/** The ordering a value collection carries — the public half of the order
 *  discipline, for rules outside this file (the collection ops). */
export function collectionOrderOf(type: FieldType | undefined): CollectionOrder {
  return valueOrdering(type);
}

/** The ordering a VALUE collection carries. Undefined / non-collection types
 *  say nothing — a fold over one is not this rule's business. */
function valueOrdering(type: FieldType | undefined): CollectionOrder {
  if (type === undefined) return 'unknown';
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    // A tuple is a fixed sequence of slots — order is what it IS.
    case 'tuple':
      return 'ordered';
    case 'list':
      return variant.unordered === true ? 'unordered' : 'ordered';
    case 'union':
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'dict':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
      return 'unknown';
    default:
      return neverAsAny(variant);
  }
}

/** The list type `of` collected under `ordering` — the one place the value
 *  plane's flag is set, so "unordered" cannot be spelled two ways. */
export function listOf(of: FieldType, ordering: CollectionOrder): FieldType {
  return ordering === 'unordered' ? { kind: 'list', of, unordered: true } : { kind: 'list', of };
}

/** The author-facing name of an order-sensitive fold. */
const FOLD_SPELLING: Partial<Record<AggregationFunction | 'at', string>> = {
  first: 'FIRST',
  last: 'LAST',
  join: 'JOIN',
  at: 'AT',
};

/** The type a LITERAL index reads off a tuple. Out of range is knowably null —
 *  a fixed length is a fact, so the read is `absent` rather than an unknown.
 *  A non-literal index cannot pick a slot, so it reads any member — what the
 *  tuple widens to a list of, under the program's version — possibly absent as
 *  any index read is.
 *
 *  A VARIADIC tuple's length is not a fact, so only the slots on the near side
 *  of its run are fixed: `[text, ...file[]]` reads `text` at 0, and at 1 a
 *  member that may be any of what follows — or nothing at all. */
function tupleSlotType(
  tuple: TupleType,
  { index, languageVersion }: { index: number | undefined; languageVersion: LanguageVersion },
): FieldType | undefined {
  const anyOf = (members: Array<FieldType | null>): FieldType | undefined =>
    maybeAbsent(tupleAsList({ kind: 'tuple', of: members }, languageVersion)?.of);
  if (index === undefined) return anyOf(tupleMembers(tuple));
  const rest: TupleRest | undefined = tuple.rest;
  if (rest === undefined) {
    const resolved = index < 0 ? tuple.of.length + index : index;
    if (resolved < 0 || resolved >= tuple.of.length) return 'absent';
    return tuple.of[resolved] ?? undefined;
  }
  if (index >= 0) {
    return index < rest.at ? tuple.of[index] ?? undefined : anyOf([rest.of, ...tuple.of.slice(rest.at)]);
  }
  const fromEnd = tuple.of.length + index;
  return fromEnd >= rest.at ? tuple.of[fromEnd] ?? undefined : anyOf([...tuple.of.slice(0, rest.at), rest.of]);
}

/** The integer an index expression is FIXED at, when it is written down. */
function literalIndex(expr: Expression): number | undefined {
  if (expr.type !== 'static' || typeof expr.value !== 'number') return undefined;
  return Number.isInteger(expr.value) ? expr.value : undefined;
}

/** The text a dict key expression is FIXED at, when it is written down. */
function literalKey(expr: Expression): string | undefined {
  return expr.type === 'static' && typeof expr.value === 'string' ? expr.value : undefined;
}

type BaseKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'file' | 'json' | 'absent' | 'record';

/** The base kind of a value, or `mixed` for a union whose members have more
 *  than one — the rules that can say more read each member (`baseKinds`). */
function baseKind(type: FieldType): BaseKind | 'mixed' {
  const kinds = baseKinds(type);
  return kinds.every(kind => kind === kinds[0]) ? kinds[0]! : 'mixed';
}

/** The base kind of each member a value may be — one, unless it is a union. */
function baseKinds(type: FieldType): BaseKind[] {
  return unionMembers(unwrapList(type)).map(memberBaseKind);
}

function memberBaseKind(type: FieldType): BaseKind {
  const variant = variantOf(unwrapList(type));
  switch (variant.kind) {
    // A RECORD is its own base kind and reaches no other. It is not data (so a
    // `json` field cannot hold one), and it is emphatically not text — the
    // catch-all this switch replaced would have made it one, and "everything
    // renders into text" is the conflation every rule downstream of this
    // function exists to end.
    case 'record':
      return 'record';
    // A tuple whose slots disagree survives `unwrapList` — structured data with
    // no element type, which is exactly what `json` means here. A DICT is the
    // same answer for the same reason: it is a keyed structure, and adding one
    // up or joining it into text reads nothing meaningful.
    case 'tuple':
    case 'dict':
      return 'json';
    // Enum values are text.
    case 'enum':
      return 'text';
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
      return variant.kind;
    // `unwrapList` strips absence, so this cannot arrive; text is the answer
    // the catch-all gave it.
    case 'maybeAbsent':
      return 'text';
    // A list survives `unwrapList` only as the empty/disagreeing tuple case
    // above; a plain list is already unwrapped to its element.
    case 'list':
      return 'text';
    // `baseKinds` reads a union's members one by one, so none arrives here —
    // a union never holds one (`valueUnion` flattens).
    case 'union':
      return 'json';
    default:
      return neverAsAny(variant);
  }
}

/** Is this a DATA shape — something a `json` field can hold? Everything but a
 *  `file`, which is a HANDLE (a byte channel the adapter pulls), not a value
 *  that serializes into a JSON document. */
function isDataShaped(type: FieldType): boolean {
  // A record is the second handle: it is a place in a graph, not a document,
  // and nothing serialises one into a json field.
  return baseKinds(type).every(base => base !== 'file' && base !== 'record');
}

/**
 * The comparison CATEGORY of a value type — two values compare only within a
 * category. `date`/`datetime` are both temporal (a date is midnight, so they
 * order against each other); `text`/`enum` are both textual (a string literal
 * compared to an enum is additionally membership-checked by
 * `checkEnumLiteralOperand`); `list`/`file` are structural (comparable only to
 * an identical type). `json` is `opaque` — comparable to NOTHING, itself
 * included: a structured value has no known shape, so no comparison of one is
 * meaningful (`checkComparable` reports it before the category rule, with the
 * pass-it-through guidance rather than a coercer hint).
 */
type ComparisonCategory =
  | 'temporal'
  | 'numeric'
  | 'textual'
  | 'boolean'
  | 'structural'
  /** A RECORD — comparable to another record and to nothing else. Two
   *  references to the same record are equal (identity: the same landing, the
   *  same external id); a record against a scalar is the mismatch this
   *  category exists to name. */
  | 'record'
  | 'opaque'
  /** The `null` literal's own category — in no other, so it matches nothing by
   *  the category rule. `== null` never reaches here (it is intercepted as the
   *  one loose comparison); everything else against `null` IS a mismatch. */
  | 'absent';

export function comparisonCategory(type: FieldType): ComparisonCategory {
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'record':
      return 'record';
    case 'enum':
      return 'textual';
    // A collection compares only to an identical type, which is what
    // `structural` means — and what every non-enum object spelling answered
    // before this switch enumerated them.
    case 'list':
    case 'tuple':
    case 'dict':
    case 'maybeAbsent':
      return 'structural';
    case 'date':
    case 'datetime':
      return 'temporal';
    case 'number':
      return 'numeric';
    case 'text':
      return 'textual';
    case 'boolean':
      return 'boolean';
    case 'file':
      return 'structural';
    case 'json':
      return 'opaque';
    case 'absent':
      return 'absent';
    // A union's members in one category are that category; members in more
    // than one compare only to an identical type, as a collection does. The
    // comparison rules read the members themselves (`checkComparable`).
    case 'union': {
      const categories = variant.of.map(comparisonCategory);
      return categories.every(category => category === categories[0]) ? categories[0]! : 'structural';
    }
    default:
      return neverAsAny(variant);
  }
}

/** Could a value of one union member compare to a value of another — the
 *  category rule, read pairwise. A union holds values only, and no `json`
 *  (`valueUnion`), so the record and opaque rules have nothing to say here. */
function membersComparable(left: FieldType, right: FieldType): boolean {
  const category = comparisonCategory(left);
  if (category !== comparisonCategory(right)) return false;
  return category !== 'structural' || fieldTypeEquals(left, right);
}

/** A type-only enum shape — the membership check's subject. */
export type EnumType = Extract<FieldType, { kind: 'enum' }>;

export function isEnumType(type: FieldType | undefined): type is EnumType {
  if (type === undefined) return false;
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'enum':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'record':
    case 'maybeAbsent':
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/** A tuple — and, asked of a type that has already been unwrapped, the shape
 *  that says `unwrapList` found no shared element. */
function isTupleType(type: FieldType): type is Extract<FieldType, { kind: 'tuple' }> {
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'tuple':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'dict':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/** A list — the multi-valued shape an append writes into. */
export function isListType(type: FieldType | undefined): type is Extract<FieldType, { kind: 'list' }> {
  if (type === undefined) return false;
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'list':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'tuple':
    case 'dict':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/** A dict — a value looked up by key rather than indexed. */
export function isDictType(type: FieldType): type is Extract<FieldType, { kind: 'dict' }> {
  const variant = variantOf(type);
  switch (variant.kind) {
    case 'dict':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'enum':
    case 'record':
    case 'maybeAbsent':
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/** What an enum check reports: a code, a message, and (open known-values only)
 *  a warning severity. */
type EnumDiagnostic = { code: string; message: string; severity?: 'warning' };

/**
 * Is this enum's domain EMPTY — a closed option set with nothing in it? That is
 * the empty union, TypeScript's `never`: it accepts NOTHING, not everything. So
 * the diagnostic is about the field, not the value — checked before membership
 * (a "not one of: ()" message is worse than useless) and independent of whether
 * the value is a literal at all.
 *
 * An OPEN known-values field with nothing listed is the OTHER fact: the adapter
 * couldn't enumerate the values, not that there are none. That stays silent —
 * "I haven't looked" and "there is nothing" must not collapse together.
 *
 * `subject` names the field when the call site knows it ("'listName' on the
 * List"); callers that only hold the type get the anonymous phrasing.
 */
export function checkEnumDomain(
  enumType: EnumType,
  subject = 'This field',
): EnumDiagnostic | null {
  if (enumType.open !== undefined || enumType.options.length > 0) return null;
  return {
    code: TypedDiagnosticCodes.ENUM_EMPTY_DOMAIN,
    message:
      `${subject} has no values to choose from — the connected system currently `
      + `offers none, so its option set is empty. No value can satisfy it, which `
      + `makes this impossible rather than mistaken: it is not a typo, and no `
      + `spelling would work. Nothing can use this field until an option exists.`,
  };
}

/**
 * The one place enum-literal membership is decided. A string LITERAL that is
 * contextually an enum value — one operand of a comparison against an enum
 * field, a value written into an enum field, the literal an enum position is
 * narrowed against — must be one of the enum's options. Returns the diagnostic
 * (code + message, with a did-you-mean for the closest option) when it isn't,
 * or null when it's valid. Shared by the compare, write, and IS-narrow sites so
 * the membership rule and the suggestion phrasing can never drift.
 */
export function checkEnumLiteral(
  literal: string,
  enumType: EnumType,
): EnumDiagnostic | null {
  const empty = checkEnumDomain(enumType);
  if (empty !== null) return empty;
  if (enumType.options.includes(literal)) return null;
  if (enumType.open) {
    // Open known-values: id-shaped literals are always legal; anything else
    // unknown is a WARNING (the listing may be incomplete), with the same
    // did-you-mean as the closed check.
    const pattern = enumType.open.allowPattern;
    if (pattern !== undefined) {
      try {
        if (new RegExp(pattern).test(literal)) return null;
      } catch {
        // An unparseable pattern never blocks the author — skip the id gate.
        return null;
      }
    }
    const closest = closestByEditDistance(literal, enumType.options);
    return {
      code: TypedDiagnosticCodes.VALUE_UNLISTED,
      severity: 'warning',
      message:
        `"${literal}" isn't among the known values here (the list may be incomplete) — `
        + `known: ${enumType.options.slice(0, 20).join(' | ')}.`
        + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
    };
  }
  const closest = closestByEditDistance(literal, enumType.options);
  return {
    code: TypedDiagnosticCodes.ENUM_UNKNOWN_VALUE,
    message:
      `"${literal}" isn't a value of ${describeFieldType(enumType)} — `
      + `expected one of: ${enumType.options.join(' | ')}.`
      + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
  };
}

/**
 * The one place "you can't do that to a structured value" is decided — the
 * shape of `checkEnumLiteral`, for the same reason: the rule and its wording
 * are shared by every site that operates on a value (the typing walker's
 * comparisons / arithmetic / folds, and the statement layer's conditions), so
 * they cannot drift apart. `operation` completes "it can't be …".
 *
 * Returns null for anything else, an unknown type included — silence for an
 * unknown type is this layer's contract.
 */
export function checkJsonOpaque(
  type: FieldType | undefined,
  operation: string,
): { code: string; message: string } | null {
  if (type === undefined || !baseKinds(type).includes('json')) return null;
  return {
    code: TypedDiagnosticCodes.JSON_OPAQUE,
    message:
      `${describeFieldType(stripAbsent(type))} is a structured value and nothing describes `
      + `its shape, so it can't be ${operation} — pass it through unchanged into a json `
      + `field instead`,
  };
}

/**
 * A RECORD where a value is required — interpolated into text, added up,
 * compared to a scalar, joined. `checkJsonOpaque`'s shape, for the same reason:
 * one rule, read by every site that needs a value, so the two cannot drift.
 *
 * There is no implicit string form and there never will be: a record has no
 * one spelling, and inventing one is how `[object Object]` reached a CRM. The
 * message names the record and the repair — read a field off it.
 */
export function checkRecordAsValue(
  type: FieldType | undefined,
  operation: string,
): { code: string; message: string } | null {
  if (type === undefined || !baseKinds(type).includes('record')) return null;
  return {
    code: TypedDiagnosticCodes.RECORD_NOT_A_VALUE,
    message:
      `${describeFieldType(stripAbsent(type))} is a record, not a value, so it can't be `
      + `${operation} — read a field off it ('c.\`Name\`'), or walk it in a block `
      + `('c-[x:edge]-> { … }')`,
  };
}

/**
 * The one place "arithmetic is numeric" is decided — `checkJsonOpaque`'s shape,
 * for the same reason. `+ - * /` are the four arithmetic operators, and `+` has
 * no concat overload: the engine coerces both sides through `Number()`, so a
 * non-numeric operand evaluated to NaN and stored as null, SILENTLY. That is
 * the absence of a guarantee, not a weaker one, so a KNOWN non-numeric operand
 * is an error — TypeScript's "the left-hand side of an arithmetic operation
 * must be of type number".
 *
 * Permissive where it cannot see: an undefined (untyped/underspecified) operand
 * stays silent, like every check in this layer. A `json` operand belongs to
 * MOV_JSON_OPAQUE, which the same site already reports — saying it twice, in
 * two vocabularies, helps nobody.
 *
 * Numeric means `number` after `baseKind` — absence and list cardinality are
 * transparent here (their own sites police them), and an enum is text.
 */
export function checkArithmeticOperands(
  expr: Extract<Expression, { type: 'arithmetic' }>,
  left: FieldType | undefined,
  right: FieldType | undefined,
): { code: string; message: string } | null {
  const sides = [
    { label: 'left', expr: expr.left, type: left },
    { label: 'right', expr: expr.right, type: right },
  ];
  if (sides.some(s => s.type !== undefined && baseKinds(s.type).includes('json'))) return null;
  // A union is numeric only when every member is — `text | number` may be text.
  const offenders = sides.filter(s => s.type !== undefined && baseKinds(s.type).some(kind => kind !== 'number'));
  if (offenders.length === 0) return null;

  const described = offenders.map(o => describeFieldType(stripAbsent(o.type!)));
  const subject =
    offenders.length === 1
      ? `the ${offenders[0].label} side of '${expr.op}' is ${described[0]}`
      : described[0] === described[1]
        ? `both sides of '${expr.op}' are ${described[0]}`
        : `the left side of '${expr.op}' is ${described[0]} and the right side is ${described[1]}`;

  return {
    code: TypedDiagnosticCodes.ARITH_NON_NUMERIC,
    message: `An arithmetic operation requires numeric operands — ${subject}.${hintFor(expr, offenders.flatMap(o => baseKinds(o.type!)))}`,
  };
}

/**
 * Unary minus's one operand, refused the same way `+` on a non-number is
 * (same code, same "requires numeric operands" wording) — negating a number
 * is a number; anything else is an error, not a silent `NaN`.
 */
export function checkNegateOperand(
  type: FieldType | undefined,
): { code: string; message: string } | null {
  if (type === undefined) return null;
  const kinds = baseKinds(type);
  if (kinds.includes('json') || kinds.every(kind => kind === 'number')) return null;
  const described = describeFieldType(stripAbsent(type));
  const hint =
    kinds.includes('text') ? ' Wrap it in NUMBER(…) if it holds a number.'
    : kinds.includes('date') || kinds.includes('datetime') ? ' Shift a date with DATE.ADD_DAYS(date, days) instead.'
    : '';
  return {
    code: TypedDiagnosticCodes.ARITH_NON_NUMERIC,
    message: `An arithmetic operation requires numeric operands — the operand of unary '-' is ${described}.${hint}`,
  };
}

/** The remedy clause, chosen by what the offending operand actually is: a
 *  string wants interpolation (`+` is the only operator anyone means as
 *  concatenation; for the others it is a value that needs coercing), a date
 *  wants the shift function. Anything else gets no guess. */
function hintFor(
  expr: Extract<Expression, { type: 'arithmetic' }>,
  offending: BaseKind[],
): string {
  if (offending.includes('text')) {
    if (expr.op !== '+') return ' Wrap it in NUMBER(…) if it holds a number.';
    const rewritten = interpolationRewrite(expr);
    return (
      ' Build the string with "${…}" interpolation instead'
      + (rewritten !== undefined ? `: ${rewritten}.` : '.')
    );
  }
  if (offending.includes('date') || offending.includes('datetime')) {
    return ' Shift a date with DATE.ADD_DAYS(date, days) instead.';
  }
  return '';
}

/**
 * The `+` chain rewritten as one interpolated string — `a.\`Url\` + "?answer=true"`
 * as `"${a.\`Url\`}?answer=true"`. Literals contribute their own text, everything
 * else an interpolation, and the chain is flattened so a three-part concat
 * suggests the whole string rather than a fragment.
 *
 * Undefined unless EVERY leaf is cheaply printable back to source: a suggestion
 * that silently dropped part of the expression, or that re-parsed differently
 * from what the author wrote, would be worse than no suggestion at all.
 */
function interpolationRewrite(expr: Expression): string | undefined {
  const parts: string[] = [];
  const walk = (e: Expression): boolean => {
    if (e.type === 'arithmetic' && e.op === '+') return walk(e.left) && walk(e.right);
    const literal = literalText(e);
    if (literal !== undefined) {
      parts.push(literal);
      return true;
    }
    const source = operandSource(e);
    if (source === undefined) return false;
    parts.push('${' + source + '}');
    return true;
  };
  return walk(expr) ? `"${parts.join('')}"` : undefined;
}

/** A literal's contribution to an interpolated string: its own text, verbatim.
 *  A string carrying quoting-significant characters is not cheaply printable —
 *  re-escaping it here is how a suggestion drifts from what it replaces. */
function literalText(expr: Expression): string | undefined {
  if (expr.type !== 'static' || expr.value === null) return undefined;
  if (typeof expr.value !== 'string') return String(expr.value);
  return /["\\\n]|\$\{/.test(expr.value) ? undefined : expr.value;
}

/** The short source form of an operand — a field read, a dotted read off a
 *  bound name, a meta field, a bare alias. Traversals with hops and every
 *  compound form are deliberately absent: they have no one-line spelling the
 *  author would recognise as their own. */
function operandSource(expr: Expression): string | undefined {
  if (expr.type === 'property') return quoteName(expr.propertyTypeId);
  if (expr.type === 'meta') return `@${expr.key}`;
  if (expr.type === 'alias_ref') return quoteName(expr.name);
  if (
    expr.type === 'traverse'
    && expr.aliasRoot !== undefined
    && expr.steps.length === 0
    && expr.expression.type === 'property'
  ) {
    return `${quoteName(expr.aliasRoot)}.${quoteName(expr.expression.propertyTypeId)}`;
  }
  return undefined;
}

/**
 * May a value of type `value` be written into a field of type `target`?
 * Deliberately lenient (lists coerce both ways, everything renders into
 * text, text parses into dates) — a typed check fires only on clear shape
 * mistakes.
 */
export function fieldTypeCompatible(value: FieldType, target: FieldType): boolean {
  // A tuple is written as the list it widens to; one whose members share
  // nothing is a list nobody can type, and unknown says nothing. (A reader
  // that knows the program's version has already widened it to its union.)
  const written = widenTuplesBy(value, 'shared');
  if (written === undefined) return true;
  // Absence is a require-present concern (checked separately at the write site),
  // not a shape mismatch — compare the present shapes. A union is written when
  // every member it may be is — `text | number` into a number field is not —
  // and a union target takes what any member takes.
  const targets = baseKinds(target);
  return baseKinds(written).every(v => targets.some(t => baseKindWritable(v, t)));
}

function baseKindWritable(v: BaseKind, t: BaseKind): boolean {
  // A literal `null` has no shape to mismatch — it is the ABSENCE of one, which
  // the require-present sites police. Saying it twice, in the shape vocabulary,
  // would send the author hunting for a coercer that could never help.
  if (v === 'absent') return true;
  // A record is a PLACE, not a value — nothing writes one into a field, and
  // nothing fills a record-typed field from a value. The write sites name it
  // themselves (`reportFieldValueType`), with the two things an author can do
  // instead: write one of its fields, or link the two records.
  if (v === 'record' || t === 'record') return false;
  // `json` is the DATA top type: every data shape flows INTO it (an object
  // literal, a list, a scalar — the field mirrors the target API verbatim), and
  // a `file` does not, being a handle rather than data. Nothing flows OUT of it:
  // a json value has no known shape, so writing one into a typed field is the
  // error that tells the author to pass it through instead. Both rules sit ahead
  // of the `text` catch-all — "everything renders into text" is exactly the
  // conflation the json type exists to end.
  if (t === 'json') return v !== 'file';
  if (v === 'json') return false;
  if (t === 'text') return true;
  if (v === t) return true;
  if (v === 'text' && t === 'date') return true;
  return false;
}

/**
 * A record HELD AS A VALUE — the one constructor, so a record type is never
 * spelled two ways. `position` rides along only where the checker can name
 * which record; absent is "a record, and nobody can say which", which is what
 * an extraction result, a synthesised node and a disagreeing list all are.
 */
export function recordOf(position: PositionTypeRef | undefined): FieldType {
  return position !== undefined ? { kind: 'record', position } : { kind: 'record' };
}

/**
 * The RECORD a value type holds, where a walk could start from it — the record
 * itself, or a list of them. Absence is transparent: a walk off a maybe-absent
 * record runs zero times, which is a gate, not a mistake.
 *
 * A DICT is deliberately not one: a dict is looked up, never folded, so the
 * record comes out of it through `AT(m, "k")` and the walk starts there.
 */
export function recordIn(type: FieldType | undefined): Extract<FieldType, { kind: 'record' }> | undefined {
  if (type === undefined) return undefined;
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'record':
      return variant;
    case 'list':
      return recordIn(variant.of);
    // A tuple of records walks as the list of records it widens to — records
    // are one type whatever their position, so no version reads it otherwise.
    case 'tuple':
      return recordIn(widenTuple(variant, 'shared'));
    // A union's members are values (`valueUnion`).
    case 'union':
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    // A DICT is deliberately not one, per the note above, and an enum is a
    // value.
    case 'dict':
    case 'enum':
    case 'maybeAbsent':
      return undefined;
    default:
      return neverAsAny(variant);
  }
}

/** Where a walk off this VALUE starts, when the checker can name it. One record
 *  and a list of them start the same walk — a hop is many-valued either way, so
 *  plurality lives in the traversal and not in a second type. */
export function recordHeadPosition(type: FieldType | undefined): PositionTypeRef | undefined {
  return recordIn(type)?.position;
}

/** Does this value type hold records — so a block head off it walks, rather
 *  than being refused where it is written? */
export function holdsRecords(type: FieldType | undefined): boolean {
  return recordIn(type) !== undefined;
}

/**
 * A record READ AS A VALUE — the one rule for what a name bound on the arrow
 * plane is worth on the dot plane, so the walker and the statement layer cannot
 * answer it differently.
 *
 * A maybe-empty landing MAY not be there, and absence is spelled one way
 * whatever the plane, so the record carries it.
 */
export function recordValueOf(position: PositionTypeRef | undefined): FieldType | undefined {
  if (position === undefined) return undefined;
  return position.kind === 'maybeEmpty' ? maybeAbsent(recordOf(position)) : recordOf(position);
}

/** Is this value type a record? Absence is transparent, as it is everywhere. */
export function isRecordType(type: FieldType | undefined): boolean {
  if (type === undefined) return false;
  const variant = variantOf(stripAbsent(type));
  switch (variant.kind) {
    case 'record':
      return true;
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
    case 'list':
    case 'tuple':
    case 'dict':
    case 'enum':
    case 'maybeAbsent':
    case 'union':
      return false;
    default:
      return neverAsAny(variant);
  }
}

/**
 * What a COLLECTION of these types holds, where they agree on anything.
 *
 * Values agree by sameness. Records agree by being records: a list of them is
 * walked the same way whatever they turn out to be, so members that disagree
 * on WHICH record still make a list of records — with no position, which is
 * the honest answer and the one that leaves the walk off it silent.
 *
 * `undefined` where nothing can be said — an untyped member, or a genuine
 * mixture — which is the caller's cue to stay silent or to refuse.
 */
export function unifyValueTypes(types: Array<FieldType | undefined>): FieldType | undefined {
  const first = types[0];
  if (first === undefined || types.length === 0) return undefined;
  if (types.every(t => t !== undefined && fieldTypeEquals(t, first))) return first;
  if (types.every(t => isRecordType(t))) return { kind: 'record' };
  // Dicts that hold the same thing under different written keys are still a
  // dict of that thing — only the keys stop being knowable, so the shape goes
  // and a lookup falls back to one that may miss.
  const unshaped = types.map(t => (t !== undefined && isDictType(stripAbsent(t)) ? withoutShape(t) : t));
  const head = unshaped[0];
  if (head !== undefined && unshaped.every(t => t !== undefined && fieldTypeEquals(t, head))) {
    return head;
  }
  return undefined;
}

/** A dict with its written keys forgotten — what it holds, looked up by data. */
function withoutShape(type: FieldType): FieldType {
  const present = stripAbsent(type);
  if (!isDictType(present)) return type;
  const unshaped: FieldType = { kind: 'dict', of: present.of };
  return isMaybeAbsent(type) ? maybeAbsent(unshaped)! : unshaped;
}

/** Two runs of tuple slots, slot by slot. */
function slotsAgree(left: Array<FieldType | null>, right: Array<FieldType | null>): boolean {
  return left.length === right.length && left.every((slot, i) => {
    const other = right[i];
    if (slot === null || other === null) return slot === other;
    return fieldTypeEquals(slot, other);
  });
}

/** Strict sameness (number vs text IS different; enum options compared).
 *  Absence is transparent to sameness — `T | absent` equals `T` here (the
 *  require-present sites police absence, not the shape checks). */
export function fieldTypeEquals(a: FieldType, b: FieldType): boolean {
  const left = variantOf(stripAbsent(a));
  const right = variantOf(stripAbsent(b));
  switch (left.kind) {
    // A bare name carries nothing but itself, so the two kinds agreeing IS the
    // two types agreeing.
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'absent':
      return right.kind === left.kind;
    case 'list':
      return right.kind === 'list' && fieldTypeEquals(left.of, right.of);
    // Two tuples are the same type iff they are the same LENGTH and agree slot
    // by slot — an untyped slot matches only another untyped one, because "we
    // could not see" is not a type two tuples can agree on.
    // A variadic run agrees the same way, and only with a run in the same
    // place.
    case 'tuple': {
      if (right.kind !== 'tuple' || !slotsAgree(left.of, right.of)) return false;
      if (left.rest === undefined || right.rest === undefined) return left.rest === right.rest;
      return left.rest.at === right.rest.at && slotsAgree([left.rest.of], [right.rest.of]);
    }
    // Two dicts agree when what they hold agrees. Where the keys were written
    // down they ARE type, so two shaped dicts also agree key by key — an
    // untyped key matching only another untyped one, as a tuple's slot does —
    // and a shaped dict is not the same type as one whose keys are data.
    case 'dict': {
      if (right.kind !== 'dict' || !fieldTypeEquals(left.of, right.of)) return false;
      if (left.shape === undefined || right.shape === undefined) {
        return left.shape === undefined && right.shape === undefined;
      }
      const leftShape = left.shape;
      const rightShape = right.shape;
      const keys = Object.keys(leftShape);
      return (
        keys.length === Object.keys(rightShape).length
        && keys.every(key => {
          if (!Object.hasOwn(rightShape, key)) return false;
          const slot = leftShape[key] ?? null;
          const other = rightShape[key] ?? null;
          if (slot === null || other === null) return slot === other;
          return fieldTypeEquals(slot, other);
        })
      );
    }
    // Two records are the same type when they are the same place to start a
    // walk from — both directions of the fit, so neither stands in for a wider
    // one. Two records nobody can name agree too: "a record, unknown which" is
    // one answer, not two.
    case 'record':
      if (right.kind !== 'record') return false;
      if (left.position === undefined || right.position === undefined) {
        return left.position === undefined && right.position === undefined;
      }
      return sameStartingPoint(left.position, right.position);
    case 'enum':
      return (
        right.kind === 'enum'
        && left.options.length === right.options.length
        && left.options.every((o, i) => o === right.options[i])
      );
    // `stripAbsent` peeled this and `maybeAbsent` never nests, so it cannot
    // arrive; absence is transparent to sameness either way.
    case 'maybeAbsent':
      return right.kind === 'maybeAbsent' && fieldTypeEquals(left.of, right.of);
    // A union IS its member set — the same members in any order.
    case 'union': {
      if (right.kind !== 'union' || left.of.length !== right.of.length) return false;
      const others = right.of;
      return left.of.every(member => others.some(other => fieldTypeEquals(member, other)));
    }
    default:
      return neverAsAny(left);
  }
}

/**
 * Does this write target accept LESS than free text — i.e. would a wrong
 * annotation on the extraction actually produce a value it rejects? A non-text
 * base type (number, date, boolean, file) and a CLOSED option set do; plain
 * text does not (everything renders into it), and neither does an OPEN
 * known-values field, where an unlisted value is only a warning.
 */
function targetConstrainsExtraction(target: FieldType): boolean {
  const variant = variantOf(unwrapList(target));
  switch (variant.kind) {
    case 'enum':
      return variant.open === undefined;
    // `json` constrains nothing, for the same reason `text` doesn't: it accepts
    // every data shape, so no annotation on the extraction can be the wrong one.
    case 'text':
    case 'json':
      return false;
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'absent':
      return true;
    // Every other object spelling answered `false` before this switch
    // enumerated them: only a closed enum constrained.
    case 'list':
    case 'tuple':
    case 'dict':
    case 'record':
    case 'maybeAbsent':
      return false;
    // A wrong annotation could produce a value the target rejects when it could
    // for any member.
    case 'union':
      return variant.of.some(targetConstrainsExtraction);
    default:
      return neverAsAny(variant);
  }
}

/** Can a value of `source` be read where `target` is expected (width-subtype
 *  of a single field)? Identical types pass; an enum (a text base) widens to a
 *  text target; otherwise same comparison-category passes. The reverse of a
 *  widening (text → enum) does NOT pass. */
export function fieldAssignable(source: FieldType, target: FieldType): boolean {
  source = stripAbsent(source);
  target = stripAbsent(target);
  if (fieldTypeEquals(source, target)) return true;
  // TypeScript's union rules: a union reads as X when every member it may be
  // does, and X reads as a union when it reads as some member.
  if (isUnionType(source)) return source.of.every(member => fieldAssignable(member, target));
  if (isUnionType(target)) return target.of.some(member => fieldAssignable(source, member));
  // A tuple reads as the list it widens to — TypeScript's tuple-to-array
  // assignability. Members that share nothing widen to a list nobody can type,
  // which says nothing here, as unknown says nothing everywhere. (A reader that
  // knows the program's version has already widened it to its union.)
  if (isTupleType(source) && !isTupleType(target)) {
    const list = widenTuple(source, 'shared');
    return list === undefined || fieldAssignable(list, target);
  }
  // `json` widens the same way in a read position as in a write: any data shape
  // reads AS json, and a json value reads as nothing else (see
  // `fieldTypeCompatible`). Cardinality stays strict here, unlike the write
  // gate — a `list<json>` target is reached through `fieldTypeEquals` above.
  if (target === 'json') return isDataShaped(source);
  if (source === 'json') return false;
  // A record reaches only an identical record, which `fieldTypeEquals` above
  // already answered. The category rule at the bottom would otherwise let any
  // two records stand in for each other.
  if (baseKind(source) === 'record' || baseKind(target) === 'record') return false;
  if (target === 'text' && (source === 'text' || isEnumType(source))) {
    return true;
  }
  // text → enum is the disallowed reverse of the enum→text widening: a
  // plain-text source can hold any string, so it does NOT satisfy a target
  // constrained to an enum's options.
  if (isEnumType(target)) return false;
  return comparisonCategory(source) === comparisonCategory(target)
    && comparisonCategory(source) !== 'structural';
}

function acceptsAnyNarrowing(
  param: Extract<PositionTypeRef, { kind: 'position' | 'union' }>,
  argNarrowsEvent: string | undefined,
): boolean {
  if (param.narrowsEvent !== undefined) return false; // the signature named an address
  const name = param.kind === 'position' ? param.position : param.union;
  return argNarrowsEvent === name;
}

/**
 * Does an argument's (graph, position) fit a parameter's (check 7)?
 * `undefined` = cannot tell (stay silent).
 */
export function positionsMatch(arg: PositionTypeRef, param: PositionTypeRef): boolean | undefined {
  switch (param.kind) {
    case 'position':
      if (arg.kind === 'position') {
        if (arg.instance.token !== param.instance.token) return false;
        if (arg.position === param.position) return true;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'union') {
        // A multi-action listen's derived union against a plain-position
        // param: only the unnarrowed event node itself is wide enough —
        // "no address on the param accepts any listen".
        if (arg.instance.token !== param.instance.token) return false;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'handle') {
        if (arg.instance.token !== param.instance.token) return false;
        return arg.position === undefined ? undefined : arg.position === param.position;
      }
      return false;
    case 'union':
      if (arg.kind === 'union') {
        if (arg.instance.token !== param.instance.token) return false;
        if (arg.union === param.union) return true;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'position') {
        if (arg.instance.token !== param.instance.token) return false;
        if (param.variants.includes(arg.position)) return true;
        // An unaddressed union accepts any narrowing of the event it names —
        // wider type, not a mechanism.
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'handle') {
        if (arg.instance.token !== param.instance.token) return false;
        return arg.position === undefined ? undefined : param.variants.includes(arg.position);
      }
      return false;
    case 'meta':
      return arg.kind === 'meta' ? arg.instance.token === param.instance.token : false;
    case 'handle':
    case 'extract':
    case 'closure':
    case 'local':
    case 'maybeEmpty':
      // Parameters come from TypeRefs; these kinds cannot be declared.
      return undefined;
  }
}

/**
 * Are these two names the SAME place to start a walk from? Both directions of
 * the fit, so neither stands in for a wider one: a walk off a list of records
 * runs off every member, and one member's type may only speak for the rest
 * where it IS the rest. `undefined` — a handle, an extraction result, a
 * synthesised node, none of which anything can tell apart — is not a yes.
 */
export function sameStartingPoint(a: PositionTypeRef, b: PositionTypeRef): boolean {
  // One type is the same as itself, whatever kind: `[h]` of a write's result
  // is a list of THAT record, not of a record nobody can name.
  if (a === b) return true;
  return positionsMatch(a, b) === true && positionsMatch(b, a) === true;
}

// ── Schema lookups ──

/** Resolves a position-type name within a schema: union first, then position. */
export function positionRefIn(instance: InstanceRef, name: string): PositionTypeRef | undefined {
  const variants = instance.schema.unions?.[name];
  if (variants) return { kind: 'union', instance, union: name, variants };
  if (instance.schema.positions[name]) return { kind: 'position', instance, position: name };
  return undefined;
}

/**
 * Position-aware narrowing: when the instance schema registered a refined
 * position for this hop's WHERE, the hop lands on the REFINEMENT — an anonymous
 * subtype whose surface (notably its edge set) is the selected position's own,
 * not the type's whole-collection union.
 *
 * The checker does not DECIDE anything here, and that is the point. Narrowing
 * consumes a predicate that evaluates to a Boolean, and only the host can
 * evaluate one — it holds the members' published data. So the host resolves
 * every selection it can and registers the result; the checker looks the WHERE
 * up by its canonical key. A predicate the host couldn't decide (an `AI()`, a
 * runtime value) simply has no refinement, so it doesn't narrow — and the
 * runtime guards stay the safety mechanism, exactly as before.
 *
 * This is why there is no `decidableEquality` any more: "which filter shapes
 * can the compiler decide?" was the wrong question. It only ever needed to
 * agree with the host on a key.
 *
 */
export function refineSelected(
  target: PositionTypeRef,
  filter: Expression | undefined,
): PositionTypeRef {
  if (filter === undefined || target.kind !== 'position') return target;
  const refined =
    target.instance.schema.refinements?.[refinementKey({ type: target.position, filter })];
  if (refined === undefined) return target;
  return positionRefIn(target.instance, refined) ?? target;
}

/**
 * How to make a refused field readable on a NARROWABLE type: the type carries
 * only what all its members share, so a field of one member appears once the
 * hop is narrowed to it. The WHERE narrows as a whole, so the test may sit
 * anywhere in it. Empty for a type with nothing to narrow by.
 */
function narrowingHint(position: Extract<PositionTypeRef, { kind: 'position' }>): string {
  const [first, ...rest] = position.instance.schema.narrowBy?.[position.position] ?? [];
  if (first === undefined) return '';
  const others = rest.length > 0 ? ` (or ${rest.map(f => `\`${f}\``).join(', ')})` : '';
  return `. If it is a field of one ${displayNameOf(position.instance, position.position)} only, narrow the hop that lands here to it: test \`${first}\` == "…"${others} in its WHERE`;
}

/** The instance a position ref belongs to — undefined for the refs that belong
 *  to no graph (an extract node, a closure, a construct's local surface). */
export function instanceOfRef(type: PositionTypeRef | undefined): InstanceRef | undefined {
  switch (type?.kind) {
    case 'meta':
    case 'position':
    case 'union':
    case 'handle':
      return type.instance;
    case 'maybeEmpty':
      return instanceOfRef(type.of);
    default:
      return undefined;
  }
}

/** The underlying position schema of a position/handle ref (undefined for the rest). */
export function positionSchemaOfRef(type: PositionTypeRef): PositionSchema | undefined {
  if (type.kind === 'position') return type.instance.schema.positions[type.position];
  if (type.kind === 'handle' && type.position !== undefined) {
    return type.instance.schema.positions[type.position];
  }
  if (type.kind === 'meta') {
    // The instance's meta position, as a real position: its edges ARE its
    // collections, each a create-along edge to that collection's writable root.
    // This is what lets a meta-rooted linked write — `<instance>-[:Companies]->
    // { … }`, the ONLY top-level write form now that flat `X.Type` is gone —
    // resolve and VALIDATE through the same `checkLinkedPath` path as any other
    // linked write. Reads still resolve collections directly (walkSteps' `meta`
    // case), so this doesn't touch the read side. The collection's declared
    // capability rides along because it is the SAME fact an `EdgeSchema` states
    // — one collection, one declaration, whichever view asks for it.
    const schema = type.instance.schema;
    const edges: Record<string, EdgeSchema> = {};
    for (const [collection, { target, capability }] of Object.entries(schema.collections)) {
      edges[collection] = {
        target,
        ...(capability !== undefined ? { capability } : {}),
        ...(schema.writableRoots[target] !== undefined ? { writable: true } : {}),
      };
    }
    return { properties: {}, edges };
  }
  return undefined;
}

/**
 * The declared type of `propertyId` at `position` — a PURE lookup, no
 * diagnostics. Used to type a bracket-WHERE field reference (an
 * `edge_property` against the hop target) for the comparison check; an
 * unknown field, an open or under-described position, or a union where the
 * field's type is ambiguous all degrade to undefined (which keeps the
 * comparison check permissive). `readProperty` is the reporting counterpart.
 */
/**
 * A record's fields and their types, as a read of each would type it — the
 * record's dot plane, which is what spreading it copies. Undefined where
 * nothing says which fields it has.
 */
export function recordFieldTypes(position: PositionTypeRef): Record<string, FieldType | null> | undefined {
  const typed = (names: Iterable<string>): Record<string, FieldType | null> =>
    Object.fromEntries([...names].map(name => [name, lookupPropertyType(position, name) ?? null]));
  switch (position.kind) {
    case 'local':
      return typed(Object.keys(position.reads));
    case 'position':
    case 'handle': {
      const schema = positionSchemaOfRef(position)?.properties ?? {};
      const result = position.kind === 'handle' ? position.resultShape : {};
      if (position.kind === 'position' && positionSchemaOfRef(position) === undefined) return undefined;
      return typed(new Set([...Object.keys(schema), ...Object.keys(result)]));
    }
    case 'extract':
      return Object.fromEntries(
        [...position.node.properties].map(([name, field]) => [
          name,
          readsAsPresentText(field) || position.present?.has(name) === true
            ? field.explicit !== undefined ? stripAbsent(field.explicit) : 'text'
            : field.explicit !== undefined ? maybeAbsent(field.explicit)! : null,
        ]),
      );
    case 'maybeEmpty': {
      const inner = recordFieldTypes(position.of);
      if (inner === undefined) return undefined;
      return Object.fromEntries(
        Object.entries(inner).map(([name, type]) => [name, type !== null ? maybeAbsent(type)! : null]),
      );
    }
    case 'union':
    case 'meta':
    case 'closure':
      return undefined;
    default:
      return neverAsAny(position);
  }
}

export function lookupPropertyType(
  position: PositionTypeRef | undefined,
  propertyId: string,
): FieldType | undefined {
  if (position === undefined) return undefined;
  switch (position.kind) {
    case 'position': {
      const declared = positionSchemaOfRef(position)?.properties[propertyId];
      return declared !== undefined && position.present?.has(propertyId) ? stripAbsent(declared) : declared;
    }
    case 'handle': {
      const fromShape = position.resultShape[propertyId];
      if (fromShape !== undefined) return fromShape;
      return positionSchemaOfRef(position)?.properties[propertyId];
    }
    case 'union': {
      const types = position.variants
        .map(v => position.instance.schema.positions[v]?.properties[propertyId])
        .filter((t): t is SchemaFieldType => t !== undefined);
      if (types.length !== position.variants.length) return undefined;
      return types.every(t => fieldTypeEquals(t, types[0])) ? types[0] : undefined;
    }
    case 'maybeEmpty':
      // A field of a maybe-empty node is itself possibly-absent (F19).
      return maybeAbsent(lookupPropertyType(position.of, propertyId));
    case 'local':
      return position.reads[propertyId];
    case 'closure':
      return undefined;
    case 'meta':
    case 'extract':
      return undefined;
  }
}

// ── Presence narrowing (comparison as a guard form) ──

/**
 * What a condition can prove present. Two shapes, because there are two
 * absences:
 * - `field` — `x.`F`` with no hops (a traversal is already its own gate, so only
 *   the direct read narrows). Discharged by `narrowPresent`.
 * - `binding` — the bound name ITSELF (`channel`, `domain`), whose absence lives
 *   on the binding: `fieldType` for a scalar (`FIRST(co.Domains)`), a
 *   `maybeEmpty` `posType` for a node (`FIRST(chat-[:Channels]->)`, an awaited
 *   `resolvesEmpty` landing). Discharged by `narrowPresentNode` / `stripAbsent`.
 */
export type PresenceProof =
  | { kind: 'field'; root: string; propertyId: string }
  | { kind: 'binding'; root: string }
  /**
   * The read proven not `""` — `x.F` (`propertyId` set) or the binding `x`
   * itself. Text's one blank value ruled out, which TS would spell by
   * narrowing `"" | …` to `…`; here it is carried on the symbol (`nonBlank`)
   * and consulted where a blank changes meaning (an identity key since
   * version 2). Says nothing about presence: an absent read is `!= ""` too.
   */
  | { kind: 'nonBlank'; root: string; propertyId?: string };

/** `x.`F`` as authored — the bridge folds a rooted property read into an
 *  alias-rooted traverse with no steps. */
export function directFieldRead(
  expr: Expression,
): Extract<PresenceProof, { kind: 'field' }> | undefined {
  if (expr.type !== 'traverse') return undefined;
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  if (expr.expression.type !== 'property') return undefined;
  return { kind: 'field', root: expr.aliasRoot, propertyId: expr.expression.propertyTypeId };
}

/** A BARE bound name as authored. The bridge's `resolveProperty` is total, so a
 *  bare identifier arrives as a rootless `property` read (never `alias_ref`);
 *  the statement layer resolves it against the scope, exactly as the engine
 *  does. */
export function bareName(expr: Expression): string | undefined {
  if (expr.type === 'property') return expr.propertyTypeId;
  if (expr.type === 'alias_ref') return expr.name;
  return undefined;
}

/** The subject a condition tests for presence: `x.`F`` or a bare `x`. Inside
 *  a hop's bracket WHERE every name arrives as an `edge_property` — the bare
 *  one names the landed record's field (the walker narrows it there, by the
 *  ambient position), and `e.`F`` off the hop's alias is the same read. */
function presenceSubject(expr: Expression): PresenceProof | undefined {
  const field = directFieldRead(expr) ?? whereFieldRead(expr);
  if (field !== undefined) return field;
  const name = expr.type === 'edge_property' ? expr.propertyTypeId : bareName(expr);
  return name !== undefined ? { kind: 'binding', root: name } : undefined;
}

function whereFieldRead(expr: Expression): Extract<PresenceProof, { kind: 'field' }> | undefined {
  if (expr.type !== 'traverse' || expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  if (expr.expression.type !== 'edge_property') return undefined;
  return { kind: 'field', root: expr.aliasRoot, propertyId: expr.expression.propertyTypeId };
}

/**
 * `FIRST(<bare traversal>)` / `LAST(…)` / `ONLY(…)` — the folds that pick a
 * POSITION rather than a value. Recognised by the bridge's own marker: a bare
 * path's terminal is the position sentinel, a value path's is a real field. So
 * the two planes are told apart by the SHAPE the bridge already produces, with
 * nothing re-parsed from text.
 */
export function aggregatedBarePath(
  expr: Expression,
): { fn: 'first' | 'last' | 'only'; aliasRoot?: string; steps: TraversalStep[] } | undefined {
  if (expr.type !== 'aggregate') return undefined;
  if (expr.fn !== 'first' && expr.fn !== 'last' && expr.fn !== 'only') return undefined;
  const inner = expr.expression;
  if (inner.type !== 'traverse' || inner.steps.length === 0) return undefined;
  const terminal = inner.expression;
  if (terminal.type !== 'property' || terminal.propertyTypeId !== POSITION_SENTINEL) {
    return undefined;
  }
  return {
    fn: expr.fn,
    ...(inner.aliasRoot !== undefined ? { aliasRoot: inner.aliasRoot } : {}),
    steps: inner.steps,
  };
}

/** `EXISTS(<bare name>)`'s subject. The bridge folds it to an alias-rooted
 *  zero-step traverse wrapping a zero-step `exists`; with hops it is a
 *  TRAVERSAL quantifier, which is its own gate and proves nothing about the
 *  root binding. */
export function existsSubject(expr: Expression): string | undefined {
  if (expr.type !== 'traverse') return undefined;
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  const inner = expr.expression;
  if (inner.type !== 'exists' || inner.steps.length > 0 || inner.where !== undefined) {
    return undefined;
  }
  return expr.aliasRoot;
}

/** How a presence test's subject reads back in a diagnostic — the author's own
 *  spelling for the two shapes that have one, undefined for everything else
 *  (a compound expression has no short form worth quoting back). */
function subjectLabel(expr: Expression): string | undefined {
  const name = bareName(expr);
  if (name !== undefined) return name;
  const field = directFieldRead(expr);
  return field !== undefined ? `${field.root}.${quoteName(field.propertyId)}` : undefined;
}

/** What a TRUE comparison says about its subject's blankness — `x.F != ""`,
 *  `LENGTH(x) > 0`, `x == "Acme"` prove it non-blank; `x == ""`,
 *  `LENGTH(x) == 0` prove it blank (so their FALSITY proves it non-blank).
 *  Undefined for any other comparison, and for a subject that is not a
 *  direct read. */
function blankTest(
  expr: Extract<Expression, { type: 'compare' }>,
): { subject: Expression; whenTrue: 'blank' | 'nonBlank' } | undefined {
  for (const [subject, other] of comparisonSides(expr)) {
    if (other.type !== 'static' || typeof other.value !== 'string') continue;
    if (presenceSubject(subject) === undefined) continue;
    if (other.value === '') {
      if (expr.op === 'eq') return { subject, whenTrue: 'blank' };
      if (expr.op === 'neq') return { subject, whenTrue: 'nonBlank' };
      continue;
    }
    if (expr.op === 'eq' && other.value.trim() !== '') return { subject, whenTrue: 'nonBlank' };
  }
  const flipped: Partial<Record<FilterOperator, FilterOperator>> = { lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte', eq: 'eq', neq: 'neq' };
  const sides: Array<[Expression, Expression, FilterOperator | undefined]> = [
    [expr.left, expr.right, expr.op],
    [expr.right, expr.left, flipped[expr.op]],
  ];
  for (const [length, bound, op] of sides) {
    if (length.type !== 'function' || length.fn !== 'length' || length.args.length !== 1) continue;
    if (bound.type !== 'static' || typeof bound.value !== 'number') continue;
    const subject = length.args[0];
    if (presenceSubject(subject) === undefined) continue;
    const n = bound.value;
    if ((op === 'gt' && n >= 0) || (op === 'gte' && n >= 1) || (op === 'neq' && n === 0) || (op === 'eq' && n >= 1)) {
      return { subject, whenTrue: 'nonBlank' };
    }
    if ((op === 'eq' && n === 0) || (op === 'lt' && n === 1) || (op === 'lte' && n === 0)) {
      return { subject, whenTrue: 'blank' };
    }
  }
  return undefined;
}

/** `subject` proven not `""`, in the proof's own shape. */
function nonBlankProof(subject: Expression): PresenceProof[] {
  const read = presenceSubject(subject);
  if (read === undefined) return [];
  return [{ kind: 'nonBlank', root: read.root, ...(read.kind === 'field' ? { propertyId: read.propertyId } : {}) }];
}

/** The two operand orders of a comparison — every rule here is symmetric. */
function comparisonSides(
  expr: Extract<Expression, { type: 'compare' }>,
): Array<[Expression, Expression]> {
  return [
    [expr.left, expr.right],
    [expr.right, expr.left],
  ];
}

/**
 * The field reads a TRUE condition proves PRESENT. `x.F == <a present value>`
 * is the whole proof: the engine compares `left === right`, so an absent read
 * (null/undefined) is never equal to a present value — equality therefore joins
 * `?:` fill and traversal-as-gate as a guard form, exactly as TS narrows
 * `x.f === 'a'`.
 *
 * The rules that fall out of that, rather than being chosen:
 * - positive AND conjuncts only. Under `OR` / `NOT`, a true condition proves
 *   nothing about any one operand.
 * - `==` only. `!=` against a present value proves presence in its FALSE branch,
 *   and `else` arms carry no narrowing (see `checkIf`), so there is nowhere to
 *   put it.
 * - the OTHER side must itself be present. `absent == absent` is TRUE at runtime
 *   (`undefined === undefined`), so comparing two maybe-absent reads proves
 *   nothing; an untyped side proves nothing either.
 *
 * Two forms join it once `null` is a typed literal, both TS's own: `x != null`
 * proves presence directly, and `EXISTS(x)` asks the same question in the
 * language's older spelling. `x == null` proves presence in its FALSE branch —
 * see `negativePresenceProofs`.
 *
 * Blankness rides the same algebra (`blankTest`): `x != ""` and
 * `LENGTH(x) > 0` prove `x` non-blank when true, `x == ""` when false.
 */
export function presenceProofs(
  expr: Expression,
  typeOf: (operand: Expression) => FieldType | undefined,
): PresenceProof[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(o => presenceProofs(o, typeOf));
  }
  // `NOT A` true ⟹ A false, so A's negative proofs hold — the dual of the
  // `not` arm in `negativePresenceProofs`, and what makes `NOT ISNULL(x)` a
  // guard.
  if (expr.type === 'not') return negativePresenceProofs(expr.expression, typeOf);
  const exists = existsSubject(expr);
  if (exists !== undefined) return [{ kind: 'binding', root: exists }];
  if (expr.type !== 'compare') return [];
  const blank = blankTest(expr);
  const proofs: PresenceProof[] = blank?.whenTrue === 'nonBlank' ? nonBlankProof(blank.subject) : [];
  if (expr.op !== 'eq' && expr.op !== 'neq') return proofs;
  for (const [subject, other] of comparisonSides(expr)) {
    // `x != null` — the direct presence test. `x != <a value>` proves nothing
    // (an absent x is unequal to it too), and `x == null` proves the opposite.
    if (isNullLiteral(other)) {
      if (expr.op !== 'neq') continue;
      const proof = presenceSubject(subject);
      if (proof !== undefined) proofs.push(proof);
      continue;
    }
    if (expr.op !== 'eq') continue;
    const proof = presenceSubject(subject);
    if (proof === undefined) continue;
    const otherType = typeOf(other);
    if (otherType === undefined || isMaybeAbsent(otherType)) continue;
    proofs.push(proof);
  }
  return proofs;
}

/**
 * What a FALSE condition proves present — the dual of `presenceProofs`, and the
 * half a guard clause needs: `if channel == null { ERROR(…) }` proves `channel`
 * present for everything AFTER the `if` (see `terminates` and `checkIf`).
 *
 * The boolean algebra dualizes rather than being chosen:
 * - `A OR B` false ⟹ BOTH false, so both operands' negative proofs hold
 *   (`and`'s role in the positive direction);
 * - `A AND B` false ⟹ only that one of them is, which is nothing;
 * - `NOT A` false ⟹ A true, so its POSITIVE proofs hold.
 */
export function negativePresenceProofs(
  expr: Expression,
  typeOf: (operand: Expression) => FieldType | undefined,
): PresenceProof[] {
  if (expr.type === 'logical' && expr.op === 'or') {
    return expr.operands.flatMap(o => negativePresenceProofs(o, typeOf));
  }
  if (expr.type === 'not') return presenceProofs(expr.expression, typeOf);
  // `ISNULL(x)` false ⟹ x is not null ⟹ present. The third null-plane guard
  // spelling, and the one the guard clause reaches for: `if ISNULL(x) { ERROR(…) }`.
  if (expr.type === 'function' && expr.fn === 'isnull' && expr.args.length === 1) {
    const proof = presenceSubject(expr.args[0]);
    return proof !== undefined ? [proof] : [];
  }
  if (expr.type !== 'compare') return [];
  // `x == ""` false ⟹ x is not "" — the guard clause `if x == "" { ERROR(…) }`.
  const blank = blankTest(expr);
  const proofs: PresenceProof[] = blank?.whenTrue === 'blank' ? nonBlankProof(blank.subject) : [];
  if (expr.op !== 'eq') return proofs;
  for (const [subject, other] of comparisonSides(expr)) {
    if (!isNullLiteral(other)) continue;
    const proof = presenceSubject(subject);
    if (proof !== undefined) proofs.push(proof);
  }
  return proofs;
}

/**
 * `position` with `propertyId`'s absence discharged, or undefined when there was
 * none to discharge. The two absences narrow differently because they ARE
 * different facts:
 * - `maybeEmpty` is NODE-level (the ask resolved, or it settled empty), so one
 *   present field proves the whole landing is there — every field discharges.
 */
export function narrowPresent(
  position: PositionTypeRef,
  propertyId: string,
): PositionTypeRef | undefined {
  switch (position.kind) {
    case 'maybeEmpty':
      return isMaybeAbsent(lookupPropertyType(position, propertyId)) ? position.of : undefined;
    // - an extracted TYPED field is `T | absent` on a node that is always
    //   there, so the proof discharges just that field (text is already
    //   present, and testing it is refused elsewhere).
    case 'extract': {
      const field = position.node.properties.get(propertyId);
      if (field === undefined || readsAsPresentText(field) || position.present?.has(propertyId)) {
        return undefined;
      }
      return { ...position, present: new Set([...(position.present ?? []), propertyId]) };
    }
    // - a record the program built carries each field's own type, so a
    //   maybe-absent one is re-declared present.
    case 'local': {
      const read = position.reads[propertyId];
      if (read === undefined || !isMaybeAbsent(read)) return undefined;
      return { ...position, reads: { ...position.reads, [propertyId]: stripAbsent(read) } };
    }
    // - a field its schema types `T | absent` (a declaration's `<T | null>`,
    //   a system's optional field) on a record that is there: the proof
    //   discharges just that field, as on an extracted record.
    case 'position': {
      if (position.present?.has(propertyId)) return undefined;
      if (!isMaybeAbsent(lookupPropertyType(position, propertyId))) return undefined;
      return { ...position, present: new Set([...(position.present ?? []), propertyId]) };
    }
    // Every other position type is unconditionally present — nothing to
    // discharge. Listed rather than defaulted so a new kind that CAN be absent
    // has to say so here.
    case 'meta':
    case 'union':
    case 'handle':
    case 'closure':
      return undefined;
  }
}

/**
 * `position` with the WHOLE landing's absence discharged — the node-plane twin
 * of `narrowPresent`, for a proof about the BINDING rather than one of its
 * fields (`channel != null`, `EXISTS(channel)`). Undefined when there was no
 * node-level absence to discharge, so a caller can tell "narrowed" from
 * "nothing to narrow".
 */
export function narrowPresentNode(position: PositionTypeRef): PositionTypeRef | undefined {
  return position.kind === 'maybeEmpty' ? position.of : undefined;
}

// ── The typed expression walker ──

export interface TypingReporter {
  (code: string, message: string, span: Span, severity?: 'error' | 'info' | 'warning'): void;
}

/**
 * A primitive effect an expression walk passed. A `read` offers every graph the
 * walk touched — its start and each landing — with `undefined` where a hop did
 * not type. The row keeps the ones that resolved and records incompleteness
 * only when NONE did: a walk whose middle hop is an untyped `_resources` step
 * still plainly reads the graph it started in.
 */
export type ExpressionEffect =
  | { kind: 'read'; instances: Array<InstanceRef | undefined> }
  | { kind: 'ai' }
  | { kind: 'now' }
  /** A built-in's DECLARED row (the standard-library scope's), folded in
   *  as a plugin's is. */
  | { kind: 'declared'; row: DeclaredEffectRow };

/**
 * The write target an expression flows into, threaded through `infer` so
 * extract-field reads can suggest annotations. `path` is the borrowable
 * `<instance>.<root>.<field>` spelling of the target, when the write's
 * target graph is known.
 */
export interface WriteTargetRef {
  type: FieldType;
  path?: string;
}

/** Plain-language names for filter operators, for the gate's diagnostics. */
/** What a comparison operator expects of its operands — see
 *  {@link ExpressionTyping.checkCompareOperands}. */
type CompareOperandRule = 'same-category' | 'element-wise' | 'duration' | 'none';

const COMPARE_OPERAND_RULES: Record<FilterOperator, CompareOperandRule> = {
  eq: 'element-wise',
  neq: 'element-wise',
  in: 'element-wise',
  contains: 'element-wise',
  gt: 'same-category',
  gte: 'same-category',
  lt: 'same-category',
  lte: 'same-category',
  within: 'duration',
  exists: 'none',
};

const FILTER_OP_LABELS: Record<FilterOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  exists: 'exists',
  in: 'in',
  within: 'within',
};

function describeFilterOp(op: FilterOperator): string {
  return FILTER_OP_LABELS[op] ?? op;
}

/**
 * The (field, operator) pairs a hop WHERE constrains directly — the LEFT-hand
 * property of each `compare`, walked through boolean structure. Sub-traversals
 * (`EXISTS(...)`, nested hops) are their own hops, gated separately, so we
 * don't descend into them.
 */
function collectFilterPredicates(expr: Expression): Array<{ field: string; op: FilterOperator }> {
  const out: Array<{ field: string; op: FilterOperator }> = [];
  const visit = (e: Expression): void => {
    switch (e.type) {
      case 'compare':
        if (e.left.type === 'property' || e.left.type === 'edge_property') {
          out.push({ field: e.left.propertyTypeId, op: e.op });
        }
        visit(e.left);
        visit(e.right);
        break;
      case 'logical':
        e.operands.forEach(visit);
        break;
      case 'not':
        visit(e.expression);
        break;
      case 'conditional':
        visit(e.condition);
        visit(e.then);
        visit(e.else);
        break;
      default:
        break;
    }
  };
  visit(expr);
  return out;
}

export class ExpressionTyping {
  /** Aliases bound by traversal steps within the expression(s) this walker has seen. */
  readonly locals = new Map<string, PositionTypeRef | undefined>();

  /** True while walking the traversal INSIDE an `await` — an awaitable final
   *  edge then types as its landing (no MOV_AWAIT_REQUIRED). Set per-walk by
   *  `walkSteps`'s `awaited` option. */
  private awaited = false;

  /** The `EdgeSchema` of the LAST edge hop the most recent `walkSteps` resolved
   *  — undefined when the final hop's source/edge was untyped. Read by the
   *  `await` checker to decide MOV_NOT_AWAITABLE and whether the resolution
   *  `resolvesEmpty`. */
  lastEdgeSchema: EdgeSchema | undefined = undefined;

  /** Where each hop of the most recent `walkSteps` landed, POSITIONALLY against
   *  its steps. Recorded for the same reason `lastEdgeSchema` is: the walk is
   *  the one place a path's landings are known, and re-deriving them anywhere
   *  else would be a second implementation of the hop rules. */
  lastLandings: Array<PositionTypeRef | undefined> = [];

  /** The ordering the most recent `walkSteps` RESULT carries — the fact the
   *  fold discipline reads. Set once, at the end of the walk, so a nested walk
   *  inside a hop's WHERE cannot leave its answer behind. */
  lastOrdering: CollectionOrder = 'unknown';

  /** The edge whose sequencing decided `lastOrdering` — what a diagnostic
   *  names when it asks the author to order the hop. */
  lastOrderingEdge: string | undefined = undefined;

  /** Every traversal this walker has typed, with the ordering its walk found.
   *  A fold asks about its ARGUMENT, which was walked while the argument was
   *  typed; keying on the expression itself is how the answer survives the
   *  nested walks that happen in between. */
  private readonly walkOrderings = new WeakMap<
    Expression,
    { order: CollectionOrder; edge: string | undefined }
  >();

  /** Where each walked traversal LANDED. `SORT`'s key is written against the
   *  members, and the members of a walked collection are the walk's landings —
   *  the same reason the ordering above is remembered per expression. */
  private readonly walkDestinations = new WeakMap<Expression, PositionTypeRef>();

  /** Presence narrowings in force for the sub-expression being walked — the
   *  `then` side of `IF EXISTS(x) THEN … END`. Expression-local: TS narrows
   *  inside a conditional too, and without it the language would force a
   *  statement `if` for a value the author is building inline. */
  private readonly narrowedScalars = new Map<string, FieldType>();

  /** The arrow plane's half of the same: a record whose field a guard proved
   *  present (`r.size != null AND r.size > 3`), or a maybe-empty landing
   *  proved there. From version 3. */
  private readonly narrowedRoots = new Map<string, PositionTypeRef>();

  /** What each sub-expression read as, the last time it was walked — so a
   *  guard's proofs can ask an operand's type without walking it again (a
   *  second walk would report its diagnostics and record its effects twice). */
  private readonly readTypes = new WeakMap<Expression, FieldType | undefined>();

  constructor(
    private readonly options: {
      /** The compile context's language version — what this walker's
       *  `since`/`before` conditionals read. */
      languageVersion: LanguageVersion;
      /** Statement-scope resolution: bound name → its position type (undefined = untyped/unknown). */
      resolveRoot: (name: string) => PositionTypeRef | undefined;
      /** Statement-scope resolution of the SCALAR plane: bound name → the value
       *  type it carries (`domain = FIRST(co.Domains)` reads `text | absent`).
       *  Without it a binding's absence dies at the `=`. */
      resolveScalar?: (name: string) => FieldType | undefined;
      /** Is this name BOUND in statement scope at all — whatever plane it sits
       *  on, and whether or not a type came with it? `resolveScalar` and
       *  `resolveRoot` both answer `undefined` for a name that IS declared but
       *  carries no type, so neither can tell a binding from a typo. A bracket
       *  WHERE is the one place that difference decides a diagnostic: every
       *  bare name there is either a field of the hop target or an outer
       *  binding, and anything that is neither is a mistake. */
      nameInScope?: (name: string) => boolean;
      /** Is this name bound on the ARROW plane — a record — whether or not a
       *  position type came with it? `resolveRoot` answers `undefined` both for
       *  a record nobody could type and for a name that is not a record at all,
       *  and a record is a VALUE type now, so the difference decides whether
       *  reading the name yields `record` or nothing. */
      isRecordName?: (name: string) => boolean;
      /** Is this name bound to a whole traversal block's return — a
       *  COLLECTION, even though its position type is the one record a member
       *  of it carries (plurality lives in the traversal, never in a second
       *  type — `ScopeSymbol.plural`)? Answers the order the returns were
       *  collected in, undefined for any other name. Read as a VALUE the name
       *  is the list of those records (`bareNameType`), which is what the
       *  engine hands a map field, a list member or a call argument. */
      pluralOrderOf?: (name: string) => CollectionOrder | undefined;
      /** The value plane's half of the same fact: is this name bound to a
       *  walk read for a field (`pdfs = m-[a:Attachments]->.\`File\``) — one
       *  value per landing, typed as the one value? A spread reads it as the
       *  values. */
      isManyValuedName?: (name: string) => boolean;
      /** Is this graph identity token (`PositionTypeRef.instance.token`, a
       *  `position` / `union` ref) a declared shape (`node X {…}`) rather than
       *  a real adapter instance? The schema itself does not say — a graph is
       *  a graph, described alike either way — so this is the one place that
       *  fact survives to the value layer. `checkStdlibRecordArg` reads it:
       *  a shape's landings are the program's own words; an adapter's are
       *  read one field at a time, with no field list to hand over. */
      isDeclaredGraphToken?: (token: object) => boolean;
      report: TypingReporter;
      /** The span diagnostics point at (the slot / head). */
      span: Span;
      /**
       * Every traversal walked INSIDE an expression, as it is walked.
       *
       * A path head written as a statement (`chat-[ch:Channels]-> { … }`) is
       * recorded by the checker where it reads it. A path written as a VALUE
       * (`n-[:Attendees]->.\`Name\``) is only ever walked here, so it had no
       * record at all — and a renderer with no record has nothing to compose a
       * sentence from but the syntax.
       */
      recordPath?: (path: {
        root?: string;
        steps: TraversalStep[];
        landings: Array<PositionTypeRef | undefined>;
      }) => void;
      /**
       * Every PRIMITIVE EFFECT this walk passes — the expression half of the
       * effect row. The walk is the only place an expression's traversals are
       * resolved to a graph and its `AI(…)` / `@current_date` leaves are seen,
       * so the row is fed from here rather than by a second walker that would
       * have to re-derive both.
       *
       * A walk with NO hops is not a read: `co.\`Name\`` reads a value already
       * in hand, which is exactly the carve-out `isPurePredicate` makes.
       */
      onEffect?: (effect: ExpressionEffect) => void;
      /**
       * A BARE read of an edge the source pushes events for (`watchable`).
       * Not an effect — watchability is a delivery fact, not something running
       * the expression does — so it rides its own hook. The `until` checker is
       * the only listener: polling for something that arrives on its own is
       * what the upgrade nudge is about.
       */
      onWatchableRead?: (edge: string) => void;
    },
  ) {}

  private report(code: string, message: string, severity?: 'error' | 'info' | 'warning'): void {
    this.options.report(code, message, this.options.span, severity);
  }

  /** Hands the walk just finished to the recorder, if anyone asked for one. A
   *  stepless dot-chain (`co.\`Name\``) is not a walk and is left alone — the
   *  reference machinery already reads it. */
  /** Files the walk just finished under the traversal that asked for it, so a
   *  fold reading this traversal can ask about ITS order rather than whichever
   *  walk happened last. */
  private rememberOrdering(expr: Expression, destination?: PositionTypeRef): void {
    this.walkOrderings.set(expr, { order: this.lastOrdering, edge: this.lastOrderingEdge });
    if (destination !== undefined) this.walkDestinations.set(expr, destination);
  }

  private recordWalked(expr: Extract<Expression, { type: 'traverse' }>): void {
    if (expr.steps.length === 0) return;
    this.options.recordPath?.({
      ...(expr.aliasRoot !== undefined ? { root: expr.aliasRoot } : {}),
      steps: expr.steps,
      landings: [...this.lastLandings],
    });
  }

  private rootType(name: string): PositionTypeRef | undefined {
    const narrowed = this.narrowedRoots.get(name);
    if (narrowed !== undefined) return narrowed;
    if (this.locals.has(name)) return this.locals.get(name);
    return this.options.resolveRoot(name);
  }

  /** A bound name's SCALAR type, with any expression-local narrowing applied. */
  /**
   * A bare NAME read as a value. One type universe: a name bound on the arrow
   * plane reads as the record it is, so a record can sit in a list, under a
   * map key, in a call argument or in a `return` with no second spelling —
   * and every rule that requires a VALUE (interpolation, arithmetic, a write
   * field) refuses it by type rather than at run time.
   *
   * The dot plane wins where a name carries a value type, which is the
   * precedence every other read here keeps.
   */
  private bareNameType(name: string): FieldType | undefined {
    const scalar = this.scalarType(name);
    if (scalar !== undefined) return scalar;
    const record =
      recordValueOf(this.rootType(name))
      ?? (this.options.isRecordName?.(name) === true ? recordOf(undefined) : undefined);
    if (record === undefined) return undefined;
    // A block's returned records are a LIST of them — the walk is many-valued,
    // and so is its value.
    const collected = this.options.pluralOrderOf?.(name);
    return collected !== undefined ? listOf(record, collected) : record;
  }

  /**
   * Where a path rooted at this name STARTS. The arrow plane answers directly;
   * a name on the VALUE plane answers through its type, because a record is a
   * value type — `t.\`Text\`` inside a collection op's function, a field off a
   * list literal's member, a hop off `AT(rows, 0)`. A list of records answers
   * with the record: a hop is many-valued, so reading off the list reads off
   * each member, which is what a walk already means.
   */
  private walkStart(name: string): PositionTypeRef | undefined {
    const root = this.rootType(name);
    if (root !== undefined) return root;
    const scalar = this.scalarType(name);
    const position = recordHeadPosition(scalar);
    // A record that may not be there (`ONLY(…)`, `FIRST(…)`, `AT(rows, 0)`) is
    // read as the maybe-empty landing it is, so a field read off it is
    // `T | absent` — TypeScript's `r?.name`. Before version 3 the absence was
    // dropped at the read, and a required slot it reached never heard of it.
    if (
      position !== undefined &&
      position.kind !== 'maybeEmpty' &&
      scalar !== undefined &&
      isMaybeAbsent(scalar) &&
      variantOf(stripAbsent(scalar)).kind === 'record' &&
      since(this.options.languageVersion, 3)
    ) {
      return { kind: 'maybeEmpty', of: position };
    }
    return position;
  }

  private scalarType(name: string): FieldType | undefined {
    const narrowed = this.narrowedScalars.get(name);
    if (narrowed !== undefined) return narrowed;
    return this.options.resolveScalar?.(name);
  }

  /**
   * Can the name be absent? Undefined means NOTHING SAID — an untyped binding,
   * a name that isn't one — and every caller stays silent on it. The two planes
   * carry the fact differently (a scalar's `T | absent`, a node's `maybeEmpty`),
   * which is why this asks both rather than one type answering for both.
   */
  private nameMayBeAbsent(name: string): boolean | undefined {
    const scalar = this.scalarType(name);
    if (scalar !== undefined) return isMaybeAbsent(scalar);
    const node = this.rootType(name);
    if (node !== undefined) return node.kind === 'maybeEmpty';
    return undefined;
  }

  /** A presence test whose subject can never be absent has a fixed answer —
   *  say so (info), the way TS reports an always-truthy condition. */
  private reportConstantPresenceTest(
    name: string,
    test: string,
    verdict: 'always true' | 'always false',
  ): void {
    if (this.nameMayBeAbsent(name) !== false) return;
    this.report(
      TypedDiagnosticCodes.PRESENCE_TEST_CONSTANT,
      `'${name}' always has a value here, so '${test}' is ${verdict} — nothing on this path can make it absent.`,
      'info',
    );
  }

  /**
   * `d.k` where `d` is a DICT — TypeScript's property read of an object, and
   * the same lookup `AT(d, "k")` is: a key the literal was written with reads
   * its own type (absent only if the dict may be), a key it lacks is refused,
   * and a dict whose keys are data reads `T | absent`. Undefined when the read
   * is not one (a record's field, a walk). Before version 3 such a read fell
   * through to the record plane and typed nothing.
   */
  private dictMemberRead(expr: Extract<Expression, { type: 'traverse' }>): { type: FieldType | undefined } | undefined {
    if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
    if (this.rootType(expr.aliasRoot) !== undefined) return undefined;
    const held = this.scalarType(expr.aliasRoot);
    if (held === undefined) return undefined;
    return this.readDictMember(held, expr.expression);
  }

  /**
   * `k`, `k.f`, `k.inner.f` read off a dict of type `held`: `d.k` ends at the
   * key; `d.k.f` reads on from what the key holds — a dict as a dict again
   * (`d.k.inner`), a record as that record. Undefined when `held` is not a dict
   * or `member` reads no key of it — and, `within` a dict read on, a key the
   * inner dict was not written with: that read types as it did before nested
   * dicts were read on, and is not refused.
   */
  private readDictMember(
    held: FieldType,
    member: Expression,
    within = false,
  ): { type: FieldType | undefined } | undefined {
    const dict = stripAbsent(held);
    if (!isDictType(dict)) return undefined;
    const key =
      member.type === 'property'
        ? member.propertyTypeId
        : member.type === 'traverse' && member.aliasRoot !== undefined
          ? member.aliasRoot
          : undefined;
    if (key === undefined) return undefined;
    if (within && dict.shape !== undefined && !Object.hasOwn(dict.shape, key)) return undefined;
    const known = dict.shape === undefined ? dict.of : dict.shape[key] ?? undefined;
    const nested = member.type === 'traverse' && member.steps.length === 0 && known !== undefined && isDictType(stripAbsent(known));
    // Before version 3 a key read fell through to the record plane and typed
    // nothing — except a key holding records (or a dict read on to them),
    // which reads as the records it holds in every version, as a record bound
    // to a name does.
    if (before(this.options.languageVersion, 3) && !nested && !holdsRecords(known)) return undefined;
    let type: FieldType | undefined;
    if (dict.shape === undefined) type = maybeAbsent(dict.of);
    else if (!Object.hasOwn(dict.shape, key)) {
      this.reportUnknownDictKey(key, Object.keys(dict.shape));
      type = undefined;
    } else {
      const slot = dict.shape[key] ?? undefined;
      type = isMaybeAbsent(held) ? maybeAbsent(slot) : slot;
    }
    if (member.type !== 'traverse') return { type };
    if (nested && type !== undefined) {
      const inner = this.readDictMember(type, member.expression, true);
      if (inner !== undefined) return inner;
      if (before(this.options.languageVersion, 3)) return undefined;
    }
    // A record held under the key is read on as that record.
    const record = recordHeadPosition(type);
    return { type: this.inferAt({ type: 'traverse', steps: member.steps, expression: member.expression }, record) };
  }

  /** Walk `body` with `proofs`' subjects read as PRESENT — the narrowing an
   *  `IF <guard> THEN <body>` earns for its own THEN side, and the right side
   *  of `a AND b` from `a`. Restores whatever was in force, so sibling
   *  branches never see it.
   *
   *  Before version 3 only a bare scalar name narrows. From it, every proof
   *  the statement-level guard honours does here too: a field read off a
   *  record (`r.size`), a maybe-empty landing, and — where a bare name is the
   *  ambient record's field, as in a hop's WHERE — that field, by narrowing
   *  the `position` `body` reads rootless names against. */
  private withPresence<T>(
    proofs: PresenceProof[],
    position: PositionTypeRef | undefined,
    body: (position: PositionTypeRef | undefined) => T,
  ): T {
    const restoreScalars = new Map(this.narrowedScalars);
    const restoreRoots = new Map(this.narrowedRoots);
    const everyPlane = since(this.options.languageVersion, 3);
    let narrowedPosition = position;
    for (const proof of proofs) {
      switch (proof.kind) {
        case 'binding': {
          // Before version 3 a bare name read against an ambient record (a
          // WHERE's field) proved nothing here.
          if (!everyPlane && narrowedPosition !== undefined) continue;
          const field = everyPlane && narrowedPosition !== undefined
            ? narrowPresent(narrowedPosition, proof.root)
            : undefined;
          if (field !== undefined) {
            narrowedPosition = field;
            continue;
          }
          const current = this.scalarType(proof.root);
          if (current !== undefined) {
            this.narrowedScalars.set(proof.root, stripAbsent(current));
            continue;
          }
          if (!everyPlane) continue;
          const node = this.rootType(proof.root);
          const present = node !== undefined ? narrowPresentNode(node) : undefined;
          if (present !== undefined) this.narrowedRoots.set(proof.root, present);
          continue;
        }
        case 'field': {
          if (!everyPlane) continue;
          const dict = this.dictWithKeyPresent(proof.root, proof.propertyId);
          if (dict !== undefined) {
            this.narrowedScalars.set(proof.root, dict);
            continue;
          }
          const record = this.walkStart(proof.root);
          const present = record !== undefined ? narrowPresent(record, proof.propertyId) : undefined;
          if (present !== undefined) this.narrowedRoots.set(proof.root, present);
          continue;
        }
        // Blankness decides only where a value becomes an identity key, a
        // statement-level fact; nothing read inside an expression consults it.
        case 'nonBlank':
          continue;
        default:
          return neverAsAny(proof);
      }
    }
    try {
      return body(narrowedPosition);
    } finally {
      this.narrowedScalars.clear();
      for (const [name, type] of restoreScalars) this.narrowedScalars.set(name, type);
      this.narrowedRoots.clear();
      for (const [name, type] of restoreRoots) this.narrowedRoots.set(name, type);
    }
  }

  /** A dict written with `key` as one of its keys, that key's slot proved
   *  present — the dict plane's `narrowPresent`. Undefined for anything else,
   *  including a dict whose keys are data: its reads stay `T | absent`. */
  private dictWithKeyPresent(name: string, key: string): FieldType | undefined {
    if (this.rootType(name) !== undefined) return undefined;
    const held = this.scalarType(name);
    if (held === undefined || isMaybeAbsent(held)) return undefined;
    if (!isDictType(held) || held.shape === undefined || !Object.hasOwn(held.shape, key)) return undefined;
    const slot = held.shape[key] ?? undefined;
    if (slot === undefined || !isMaybeAbsent(slot)) return undefined;
    return { ...held, shape: { ...held.shape, [key]: stripAbsent(slot) } };
  }

  /**
   * `a AND b AND …` / `a OR b OR …`, each operand read where the run reaches
   * it. Both operators short-circuit (the engine stops at the first operand
   * that settles the answer), so from version 3 an operand is typed knowing
   * every operand before it went the way that lets the run get there: TRUE
   * past an `AND`, FALSE past an `OR` — TypeScript's `x != null && x > 3` and
   * `x == null || x > 3`. The proofs are the guard clause's own
   * (`presenceProofs` / `negativePresenceProofs`), so `NOT`, `EXISTS`,
   * `ISNULL` and nesting compose exactly as they do on a statement's `if`.
   */
  private inferLogical(
    expr: Extract<Expression, { type: 'logical' }>,
    position: PositionTypeRef | undefined,
  ): void {
    if (before(this.options.languageVersion, 3)) {
      expr.operands.forEach(o => this.inferAt(o, position));
      return;
    }
    const proofsOf = expr.op === 'and' ? presenceProofs : negativePresenceProofs;
    const walk = (index: number, at: PositionTypeRef | undefined): void => {
      const operand = expr.operands[index];
      if (operand === undefined) return;
      this.inferAt(operand, at);
      if (index === expr.operands.length - 1) return;
      const proofs = proofsOf(operand, o => (this.readTypes.has(o) ? this.readTypes.get(o) : this.inferAt(o, at)));
      this.withPresence(proofs, at, narrowed => walk(index + 1, narrowed));
    };
    walk(0, position);
  }

  /**
   * Infers a shallow value type while validating every traversal the walk
   * can root. `writeTarget` is the typed write target the expression flows
   * into: when the expression is a DIRECT property read (`x.`field``) of an
   * extract field, the target informs the read — an unannotated field gets
   * an info-severity ANNOTATE suggestion naming the target's path, and an
   * annotated field is checked for option-set conflicts. Explicit
   * annotations alone constrain extraction (adoption is demoted).
   */
  infer(expr: Expression, writeTarget?: WriteTargetRef): FieldType | undefined {
    return this.widen(this.inferExact(expr, writeTarget));
  }

  /**
   * `infer`, with a tuple kept AS a tuple rather than read as the list it
   * widens to — for the one place that holds a value without reading it: a
   * name it is bound to, so that `AT(t, 0)` off the name reads the slot.
   */
  inferExact(expr: Expression, writeTarget?: WriteTargetRef): FieldType | undefined {
    if (writeTarget !== undefined && expr.type === 'traverse' && expr.expression.type === 'property' && this.dictMemberRead(expr) === undefined) {
      const start = expr.aliasRoot !== undefined ? this.walkStart(expr.aliasRoot) : undefined;
      const position = this.walkSteps(start, expr.steps);
      this.rememberOrdering(expr, position);
      this.recordWalked(expr);
      return this.readProperty(position, expr.expression.propertyTypeId, writeTarget);
    }
    return this.inferExactAt(expr, undefined);
  }

  /**
   * A tuple READ — as the list it widens to, the way every rule that reads a
   * collection sees one. Reading a tuple of records and values as one list is
   * the mixture a list cannot hold, refused here, where it is read.
   */
  private widen(type: FieldType | undefined): FieldType | undefined {
    const mixed = mixedTupleMessage(type);
    if (mixed !== undefined) this.report(TypedDiagnosticCodes.LIST_MIXED, mixed);
    return widenTuples(type, this.options.languageVersion);
  }

  /** The type of a sub-expression as the expression around it READS it — a
   *  tuple widened to its list. Only the readers that know a tuple's slots
   *  (`AT`, a list literal's own members and spreads, an object literal's
   *  keys) ask `inferExactAt` instead. */
  private inferAt(expr: Expression, position: PositionTypeRef | undefined): FieldType | undefined {
    const type = this.widen(this.inferExactAt(expr, position));
    this.readTypes.set(expr, type);
    return type;
  }

  /** `position` is the ambient position for rootless reads (a traversal's destination). */
  private inferExactAt(expr: Expression, position: PositionTypeRef | undefined): FieldType | undefined {
    switch (expr.type) {
      case 'static':
        if (typeof expr.value === 'string') return 'text';
        if (typeof expr.value === 'number') return 'number';
        if (typeof expr.value === 'boolean') return 'boolean';
        if (expr.value === null) return 'absent';
        return undefined;
      case 'property':
        // Rootless and nothing to stand on ⇒ this is a bare NAME, not a field:
        // the bridge's property resolver is total, so `domain` and `co.Name`
        // arrive in the same shape and only the ambient position tells them
        // apart. The engine resolves it the same way (`scopedBinding`).
        if (position === undefined) return this.bareNameType(expr.propertyTypeId);
        return this.readProperty(position, expr.propertyTypeId);
      case 'traverse': {
        const keyRead = this.dictMemberRead(expr);
        if (keyRead !== undefined) return keyRead.type;
        const exists = existsSubject(expr);
        if (exists !== undefined) {
          this.reportConstantPresenceTest(exists, `EXISTS(${exists})`, 'always true');
          return 'boolean';
        }
        const start = expr.aliasRoot !== undefined ? this.walkStart(expr.aliasRoot) : position;
        const destination = this.walkSteps(start, expr.steps);
        this.rememberOrdering(expr, destination);
        this.recordWalked(expr);
        // `a-[:edge]->` — the LANDINGS themselves, which the bridge marks with
        // the position sentinel. A hop is many-valued, so that is a list of
        // records: `MAP` reads it, `COLLECT` keeps it, and a block head walks
        // it. Read for a FIELD instead (`a-[:edge]->.\`Name\``) it is that
        // field's own type, unchanged — the walk chooses the value, the field
        // says what it is.
        if (expr.steps.length > 0 && isPositionTerminal(expr.expression)) {
          return listOf(recordOf(destination), this.lastOrdering);
        }
        return this.inferAt(expr.expression, destination);
      }
      case 'resource_traverse':
        // `_resources` yields untyped file positions (M2b leaves them silent).
        this.inferAt(expr.expression, undefined);
        return undefined;
      case 'exists':
        this.checkExistsSteps(expr.steps, expr.where, position);
        return 'boolean';
      // A list literal is a TUPLE — a slot per member, as written — and a
      // spread splices in the members of what it spreads (`listLiteralType`).
      //
      // Versions 1 and 2 typed a list literal as the list it reads as, so an
      // index read off one was `T | absent` for whatever its members share,
      // never a slot: a walk off `AT(both, 1)` was not checked against the
      // second record, nor `AT(t, 0) * 2` against the first value. Under them
      // the literal is read where it is written — a record beside a value is
      // refused there, as it always was.
      case 'list': {
        const tuple = this.listLiteralType(expr.elements, position);
        return before(this.options.languageVersion, 3) ? this.widen(tuple) : tuple;
      }
      case 'object':
        return this.objectLiteralType(expr.entries, position);
      case 'concat': {
        const parts = expr.parts.map(p => this.inferAt(p, position));
        parts.forEach(t => this.requireTransparent(t, 'combined into text'));
        return 'text';
      }
      case 'arithmetic': {
        const left = this.inferAt(expr.left, position);
        const right = this.inferAt(expr.right, position);
        this.requireTransparent(left, 'used in arithmetic');
        this.requireTransparent(right, 'used in arithmetic');
        const nonNumeric = checkArithmeticOperands(expr, left, right);
        if (nonNumeric !== null) this.report(nonNumeric.code, nonNumeric.message);
        return 'number';
      }
      case 'compare': {
        const leftType = this.inferAt(expr.left, position);
        const rightType = this.inferAt(expr.right, position);
        this.checkCompareOperands(expr.op, expr, leftType, rightType);
        return 'boolean';
      }
      case 'logical':
        this.inferLogical(expr, position);
        return 'boolean';
      case 'not':
        this.inferAt(expr.expression, position);
        return 'boolean';
      case 'negate': {
        const inner = this.inferAt(expr.expression, position);
        this.requireTransparent(inner, 'negated');
        const nonNumeric = checkNegateOperand(inner);
        if (nonNumeric !== null) this.report(nonNumeric.code, nonNumeric.message);
        return 'number';
      }
      case 'conditional': {
        this.inferAt(expr.condition, position);
        // The condition guards its own THEN — `IF EXISTS(x) THEN "…${x}…"` is
        // the value-level guard clause, and TS narrows inside a ternary too.
        const proofs = presenceProofs(expr.condition, o => this.inferAt(o, position));
        const thenType = this.withPresence(proofs, position, narrowed => this.inferAt(expr.then, narrowed));
        const elseType = this.inferAt(expr.else, position);
        if (thenType !== undefined && elseType !== undefined && fieldTypeEquals(thenType, elseType)) {
          return thenType;
        }
        return undefined;
      }
      case 'at': {
        // AT reads a SLOT, so it is the one reader that sees a tuple as one.
        const inner = this.inferExactAt(expr.expression, position);
        const indexType = this.inferAt(expr.index, position);
        const innerShape = inner === undefined ? undefined : stripAbsent(inner);
        // A DICT is looked up, not indexed: there is no order to demand, and
        // the second argument is a KEY, checked as one. What comes back is
        // `T | absent` under the ordinary absence discipline — a key that is
        // not there is the everyday case, not an error.
        if (innerShape !== undefined && isDictType(innerShape)) {
          this.requireDictKey(indexType, 'looked up in a dict');
          const key = literalKey(expr.index);
          if (innerShape.shape === undefined || key === undefined) return maybeAbsent(innerShape.of);
          // A written key off a literal-shaped dict: the key is there or it is
          // a typo, and both are known now. Present unless the dict itself may
          // not be.
          if (!Object.hasOwn(innerShape.shape, key)) {
            this.reportUnknownDictKey(key, Object.keys(innerShape.shape));
            return undefined;
          }
          const slot = innerShape.shape[key] ?? undefined;
          return isMaybeAbsent(inner) ? maybeAbsent(slot) : slot;
        }
        this.checkFoldOrder('at', expr.expression, position);
        if (inner === undefined) return undefined;
        const element = stripAbsent(inner);
        const variant = variantOf(element);
        switch (variant.kind) {
          // A TUPLE has a slot per position, so a LITERAL index reads that slot
          // and nothing else — present, because a fixed-length list always has
          // it. That exactness is the whole reason the tuple type exists.
          // (Before language version 3 a list literal is no tuple — see
          // `listLiteralType` — so only a combinator's receipt reads here.)
          case 'tuple':
            return tupleSlotType(variant, {
              index: literalIndex(expr.index),
              languageVersion: this.options.languageVersion,
            });
          // Indexing can miss — an out-of-range index reads null at run time,
          // so the element is `T | absent`, exactly as FIRST/LAST are.
          case 'list':
            return maybeAbsent(variant.of);
          // Indexing something that is not a collection reads the thing itself,
          // maybe-absent — including a dict, which the guard above already took.
          case 'text':
          case 'number':
          case 'boolean':
          case 'date':
          case 'datetime':
          case 'file':
          case 'json':
          case 'absent':
          case 'dict':
          case 'enum':
          case 'record':
          case 'maybeAbsent':
          case 'union':
            return maybeAbsent(element);
          default:
            return neverAsAny(variant);
        }
      }
      case 'aggregate': {
        const inner = this.inferAt(expr.expression, position);
        if (expr.fn === 'sort') return this.inferSort(expr, inner, position);
        this.checkFoldOrder(expr.fn, expr.expression, position);
        // The folds that READ the elements (arithmetic, ordering, text) can't
        // read a structured one; the shape-preserving ones (count, first/last,
        // collect) carry json through untouched.
        const element = inner === undefined ? undefined : unwrapList(inner);
        switch (expr.fn) {
          case 'count':
            return 'number';
          case 'sum':
          case 'avg':
            this.requireTransparent(element, 'added up');
            return 'number';
          case 'join':
            this.requireTransparent(element, 'joined into text');
            return 'text';
          // The folds that pick an ELEMENT can come up empty — the engine
          // answers null over an empty set — so they type `T | absent` and the
          // absence fires at whatever site requires a value. (`count` / `sum` /
          // `avg` / `join` / `collect` have a zero, so they always answer.)
          case 'min':
          case 'max':
            this.requireTransparent(element, 'ordered');
            return maybeAbsent(element);
          case 'first':
          case 'last':
            return maybeAbsent(element);
          /**
           * `ONLY` is the commutative singleton — "the one that matched".
           * Nothing matched is ordinary absence, and the absence discipline
           * already carries it (`T | absent`); MORE than one is the author's
           * cardinality claim turning out false, which nothing at author time
           * can see, so it fails the run. Order-free by construction: it never
           * has to say which one, only that there is one.
           */
          case 'only':
            return maybeAbsent(element);
          case 'collect':
            return element !== undefined
              ? listOf(element, this.collectionOrdering(expr.expression, position).order)
              : undefined;
          case 'llm': {
            const llmAgg = lookupBuiltin('LLM_AGG');
            if (llmAgg !== undefined) this.absorbBuiltinEffects(llmAgg);
            return undefined;
          }
        }
        return undefined;
      }
      case 'llm': {
        const ai = lookupBuiltin('AI');
        if (ai !== undefined) this.absorbBuiltinEffects(ai);
        for (const d of aiTierDiagnostics(expr.tier)) this.report(d.code, d.message, d.severity);
        if (expr.promptExpression) {
          const prompt = this.inferAt(expr.promptExpression, position);
          if (ai !== undefined) this.checkBuiltinArgs(ai, [prompt]);
        }
        return undefined;
      }
      case 'function': {
        // A built-in that takes its options as a MAP walks its arguments
        // differently: each option's value is typed on its own against the
        // contract, so the map is never typed as the dict it merely looks
        // like. The keys were settled at the bridge.
        const withOptions = builtinOptionsFor(expr.fn);
        const args = expr.args.map((a, i) =>
          withOptions !== undefined && i === withOptions.index
            ? this.typeOptionsMap(a, withOptions, position)
            : this.inferAt(a, position));
        // FILE(content, "pdf"|"text") yields a file value; the bare
        // coercers DATE/DATETIME/NUMBER retype their argument to the named
        // category (this is what lets a cross-category comparison clear by
        // wrapping a side in one); COALESCE is `a ?? b` — the kind its
        // arguments share, discharging `T | absent` only when something always
        // answers (`coalesceType`); namespaced stdlib calls
        // (bridge-folded dotted ids) declare their returns. Additive only —
        // every other bare function stays untyped (silent).
        if (expr.fn === 'isnull' && expr.args.length === 1) {
          this.refuseTextPresenceTest(expr.args[0], 'absent');
        }
        // Before version 3 there is no extraction call, and the name means
        // what any unknown function does.
        const isExtractCall = expr.fn === 'extract' || expr.fn === EXTRACT_ONE_FUNCTION_ID;
        if (isExtractCall && since(this.options.languageVersion, 3)) {
          this.report(
            TypedDiagnosticCodes.EXTRACT_CALL_NESTED,
            extractCallNestedMessage(expr.fn === 'extract' ? 'extract' : 'extractOne'),
          );
        }
        // The call's entry in the standard-library scope: its effects (the
        // clock `DATE.TODAY` reads, the file `READ` fetches) are its declared
        // row, and from version 3 its arguments are checked against its
        // signature. A name it does not list is resolution's to report (the
        // checker's call walk), or a write field's own function. `extractOne`
        // was a name like any other before version 3, so it has no entry there.
        const builtin =
          expr.fn === EXTRACT_ONE_FUNCTION_ID && before(this.options.languageVersion, 3)
            ? undefined
            : lookupBuiltin(expr.fn);
        if (builtin !== undefined) {
          this.absorbBuiltinEffects(builtin);
          this.checkBuiltinArgs(builtin, args);
        }
        if (expr.fn === FILE_FUNCTION_ID) return 'file';
        if (expr.fn === READ_FUNCTION_ID) return this.typeReadCall(args);
        if (expr.fn === CHUNKS_FUNCTION_ID) return this.typeChunksCall(args);
        if (expr.fn in BARE_COERCER_RETURNS) return BARE_COERCER_RETURNS[expr.fn];
        if (expr.fn === COALESCE_FUNCTION_ID) return coalesceType(args);
        const stdlibSpec = stdlibFunctionById(expr.fn);
        if (stdlibSpec === undefined) {
          // Before version 3 a flat built-in's call is untyped; from 3 it is
          // what its signature says it gives back.
          if (builtin === undefined || before(this.options.languageVersion, 3)) return undefined;
          return builtin.returns === 'derived' ? undefined : builtin.returns;
        }
        this.checkStdlibLiteralArgs(stdlibSpec, expr.args);
        this.checkStdlibRecordArg(stdlibSpec, args, expr.args);
        this.checkStdlibWholeValueArg(stdlibSpec, args);
        // A parse that can fail (`DATE.PARSE`) types its result `T | absent`,
        // so the absence propagates and fires at the required-value site (F13).
        return stdlibSpec.maybeAbsent ? maybeAbsent(stdlibSpec.returns) : stdlibSpec.returns;
      }
      case 'kg_exists':
      case 'kg_value': {
        const kg = lookupBuiltin(expr.type === 'kg_exists' ? 'KG_EXISTS' : 'KG_VALUE');
        if (kg !== undefined) this.absorbBuiltinEffects(kg);
        expr.params.forEach(p => this.inferAt(p, position));
        return expr.type === 'kg_exists' ? 'boolean' : undefined;
      }
      case 'meta':
        this.checkMetaKey(expr.key);
        if (isClockMetaKey(expr.key)) this.options.onEffect?.({ kind: 'now' });
        return movementMetaKeyType(expr.key);
      case 'edge_property': {
        // Inside a bracket WHERE (`-[:companies WHERE `Count` == …]->`) EVERY
        // bare name parses as edge_property, and the engine resolves it against
        // two surfaces: a value binding in the surrounding scope, else a field
        // of the hop TARGET (the ambient `position`). So this types both —
        // otherwise a binding used in a WHERE reads as an undeclared field,
        // types as nothing, and every rule that fires on a type (the
        // ordered-comparison presence rule above all) says nothing about it.
        //
        // Field first, binding second, where the engine's order is the reverse.
        // It only differs when a binding SHADOWS a declared field of the target,
        // which no real movement does, and preferring the binding there would
        // silently retype existing filters.
        //
        // A name that is NEITHER is a mistake, and this is the only place that
        // can say so: the name-resolution pass reads a step filter in `field`
        // position and therefore never resolves it against scope, and the pure
        // lookup below cannot report because a binding would look identical to
        // a typo. Asking scope for mere PRESENCE separates them, so the
        // ordinary unknown-field diagnostic can fire off the position the hop
        // actually landed on — which, for a hop narrowed by a discriminant, is
        // the variant rather than the union.
        //
        // Unless the walked edge can carry INLINE properties, which is the
        // third surface and the one nothing enumerates: where an instance
        // declares them (`edgesCarryProperties`), an unrecognised name may be
        // the relationship's own fact and stays silent.
        const declared = lookupPropertyType(position, expr.propertyTypeId);
        if (declared !== undefined) return declared;
        const bound = this.scalarType(expr.propertyTypeId);
        if (bound !== undefined) return bound;
        if (this.options.nameInScope?.(expr.propertyTypeId) === true) return undefined;
        if (instanceOfRef(position)?.schema.edgesCarryProperties === true) return undefined;
        return this.readProperty(position, expr.propertyTypeId);
      }
      case 'alias_ref':
        // The bridge only emits this where its property resolver is partial;
        // either way a bare name is a scope lookup, same as the `property` case.
        return this.bareNameType(expr.name);
      case 'parent_result':
      case 'action_result':
      case 'extract_value':
        // The scalar sub-prompt inside an extraction tree — a model call like
        // `AI()`, spelled for a field.
        this.options.onEffect?.({ kind: 'ai' });
        return undefined;
      case 'resource':
      case 'linked_object':
        return undefined;
    }
  }

  /** A built-in's declared effect row, into the function around the call. */
  private absorbBuiltinEffects(builtin: Builtin): void {
    const row = builtin.effects;
    const empty = row.ai !== true && row.now !== true && row.suspend !== true
      && (row.reads ?? []).length === 0 && (row.writes ?? []).length === 0;
    if (!empty) this.options.onEffect?.({ kind: 'declared', row });
  }

  /**
   * A built-in's arguments against its signature (language version 3): each
   * is a value of the kind its parameter takes. A record or a json value where
   * a value is read is the rule every such site shares (`requireTransparent`);
   * a value of the wrong kind is `BUILTIN_ARG_TYPE`. An argument nobody can
   * type stays silent, as everywhere in this layer; how many arguments there
   * are is the call walk's (it sees the call before lowering reshapes it).
   */
  private checkBuiltinArgs(builtin: Builtin, args: ReadonlyArray<FieldType | undefined>): void {
    if (before(this.options.languageVersion, 3)) return;
    args.forEach((type, index) => {
      const param = builtinParamAt(builtin, index);
      if (param === undefined || type === undefined || !readsAsValue(param.type)) return;
      if (this.requireTransparent(type, `handed to ${builtin.name}`)) return;
      if (paramAccepts(param.type, type)) return;
      this.report(
        TypedDiagnosticCodes.BUILTIN_ARG_TYPE,
        `${builtin.name}'s '${param.name}' takes ${describeParamType(param.type)}, and this is ${describeFieldType(stripAbsent(type))} — ${describeBuiltin(builtin)}`,
      );
    });
  }

  /**
   * A `json` value is OPAQUE — the DATA top type, TypeScript's `unknown`. Every
   * operation that READS a value (comparison, arithmetic, text folding) needs a
   * shape, and nothing has described this one, so `operation` is an error rather
   * than a risk: the `text` projection this type replaced accepted them all and
   * produced `[object Object]` at run time. The message names what the author
   * CAN do — pass the value through unchanged — and deliberately suggests no
   * narrowing syntax, because none exists to teach.
   *
   * Returns true when it fired, so a caller can stop rather than pile a second
   * diagnostic onto the same expression. Silent for an unknown type, like every
   * other check in this layer.
   */
  /**
   * A dict's keys are TEXT. Anything else is refused here, with the coercion
   * the author has to write themselves — because there is no right default:
   * a date has a dozen spellings and picking one silently is how two parts of
   * one movement come to disagree about what the same day is called.
   *
   * Text and any option set (declared or borrowed) pass — an enum's values ARE
   * strings. Unknown stays silent, like every other rule in this layer.
   */
  /**
   * A list literal's type: a TUPLE, one slot per member as written — `[m.Body,
   * file]` is `[text, file]`. A spread splices in what it spreads: a tuple's
   * own slots, or, for a list, a variadic run of its element (`[m.Body,
   * ...files]` is `[text, ...file[]]`). A second run folds everything from the
   * first run onward into one, as TypeScript does: `[...a, x, ...b]` is
   * `[...T[]]` for whatever the members unify to.
   *
   * A member keeps its own type exactly (a tuple slot holding a tuple stays
   * one); it is the READ of the literal that widens it to a list.
   */
  private listLiteralType(elements: ListElement[], position: PositionTypeRef | undefined): FieldType {
    type Part = { slot: FieldType | null } | { run: FieldType | null };
    const parts: Part[] = elements.flatMap((element): Part[] => {
      if (element.type !== 'spread') return [{ slot: this.inferExactAt(element, position) ?? null }];
      return this.spreadParts(element.expression, position);
    });
    const firstRun = parts.findIndex(part => 'run' in part);
    const slotsOf = (run: Part[]): Array<FieldType | null> =>
      run.map(part => ('slot' in part ? part.slot : part.run));
    if (firstRun === -1) return { kind: 'tuple', of: slotsOf(parts) };
    const prefix = slotsOf(parts.slice(0, firstRun));
    const tail = parts.slice(firstRun + 1);
    if (tail.every(part => 'slot' in part)) {
      const run = parts[firstRun]!;
      return {
        kind: 'tuple',
        of: [...prefix, ...slotsOf(tail)],
        rest: { at: prefix.length, of: 'run' in run ? run.run : null },
      };
    }
    // Two runs: nothing past the first one has a fixed place any more.
    const folded = tupleAsList({ kind: 'tuple', of: slotsOf(parts.slice(firstRun)) }, this.options.languageVersion);
    return { kind: 'tuple', of: prefix, rest: { at: prefix.length, of: folded?.of ?? null } };
  }

  /**
   * `{ k: v, ...m, … }` — typed by its keys, as TypeScript types an object
   * literal: the keys were written down, so each one carries its own value's
   * type (`shape`), and a lookup by a written key reads exactly that. `of`
   * answers a key nobody wrote down — the values' shared type where they
   * agree, and `json` where they do not, since there is no union to name and
   * json is where every value flows. Every value is walked either way, since a
   * traversal inside one must be validated like any other.
   *
   * A key keeps its value's own type (a tuple stays one, so `AT(AT(d, "k"), 0)`
   * reads a slot); whether the values agree is a question about them READ, so
   * it is asked of their widened types.
   *
   * A spread copies another map's keys, or a record's fields, in place —
   * TypeScript's object spread, members taking effect in the order written so
   * a later key wins. A spread that may be absent copies nothing when it is,
   * as TypeScript's `...undefined` does: its keys are then `T | absent`, or
   * whatever an earlier member gave them. A spread whose keys nobody can name
   * (json, a dict built from data) leaves the literal's keys unnamed too.
   */
  private objectLiteralType(members: ObjectMember[], position: PositionTypeRef | undefined): FieldType {
    const shape: Record<string, FieldType | null> = {};
    // Keys a WRITTEN entry gave, until something overwrites them.
    const written = new Set<string>();
    const readTypes: Array<FieldType | undefined> = [];
    let keysNamed = true;
    for (const member of members) {
      if (!isObjectSpread(member)) {
        const exact = this.inferExactAt(member.value, position);
        shape[member.key] = exact ?? null;
        written.add(member.key);
        readTypes.push(widenTuples(exact, this.options.languageVersion));
        continue;
      }
      const spread = this.spreadKeys(member.expression, position);
      if (spread.keys === undefined) {
        keysNamed = false;
        readTypes.push(spread.of);
        continue;
      }
      for (const [key, type] of Object.entries(spread.keys)) {
        const earlier = Object.hasOwn(shape, key) ? shape[key] : undefined;
        if (!spread.mayBeAbsent) {
          if (written.has(key)) {
            this.report(
              TypedDiagnosticCodes.MAP_KEY_OVERWRITTEN,
              `'${key}' is written before a spread that always has '${key}', so the spread overwrites it — move '${key}: …' after the spread to override it, or drop it`,
            );
          }
          shape[key] = type;
        } else if (earlier === undefined) {
          shape[key] = type !== null ? maybeAbsent(type)! : null;
        } else {
          shape[key] = earlier !== null && type !== null ? valueUnion([earlier, type]) ?? null : null;
        }
        written.delete(key);
        readTypes.push(widenTuples(shape[key] ?? undefined, this.options.languageVersion));
      }
    }
    const first = readTypes[0];
    const agree = first !== undefined && readTypes.every(t => t !== undefined && fieldTypeEquals(t, first));
    // Sameness is transparent to absence, so it has to be carried separately:
    // one entry that may not answer makes every read of this dict one that may
    // not answer.
    const of: FieldType = agree ? (readTypes.some(isMaybeAbsent) ? maybeAbsent(first)! : first) : 'json';
    // Version 1 typed a literal as its values alone: a dict when they agree,
    // `json` when they do not (or there are none), and its keys unknown — so
    // every lookup may miss, and no key is a typo.
    if (before(this.options.languageVersion, 2)) return agree ? { kind: 'dict', of } : 'json';
    return keysNamed ? { kind: 'dict', of, shape } : { kind: 'dict', of };
  }

  /**
   * What `...x` copies into a map literal: a map's keys (named when the map
   * was written as a literal), or a record's FIELDS — its dot plane, as the
   * record's own value; an edge is a walk, not a key. `mayBeAbsent` when `x`
   * may not be there. A record is copied from what the binding holds, so it
   * has to be one whose fields the program spells out (`holdsSpelledFields`):
   * a system's record has no field list in hand.
   */
  private spreadKeys(
    expr: Expression,
    position: PositionTypeRef | undefined,
  ): { keys?: Record<string, FieldType | null>; of?: FieldType; mayBeAbsent: boolean } {
    const spread = this.inferExactAt(expr, position);
    if (spread === undefined) return { mayBeAbsent: false };
    const mayBeAbsent = isMaybeAbsent(spread);
    const present = stripAbsent(spread);
    if (present === 'json') return { of: 'json', mayBeAbsent };
    if (isDictType(present)) {
      return present.shape !== undefined
        ? { keys: present.shape, mayBeAbsent }
        : { of: present.of, mayBeAbsent };
    }
    const record = variantOf(present).kind === 'record' ? recordIn(present)?.position : undefined;
    if (record !== undefined && this.holdsSpelledFields(record, "copies its fields into a map with '...'")) {
      const fields = recordFieldTypes(record);
      return fields !== undefined ? { keys: fields, mayBeAbsent } : { of: 'json', mayBeAbsent };
    }
    this.report(
      TypedDiagnosticCodes.MAP_SPREAD_NOT_KEYED,
      variantOf(present).kind === 'record'
        ? `'...' copies a record's fields into this map, and this record's fields are read from its system one at a time — the program doesn't hold them. Write the fields you want ('{ name: r.name, … }')`
        : `'...' copies a map's keys (or a record's fields) into this map, and this is ${describeFieldType(present)} — it has no keys. Write it under a key ('{ k: x }'), or spread a map or a record`,
    );
    return { mayBeAbsent };
  }

  /**
   * What `...x` splices into a list literal, by `x`'s type: a tuple's slots
   * (and its run), or a list's element as a run of any length. A spread of one
   * thing — text, a record, a dict — is refused: it has no members to splice.
   * A spread that may be absent is refused too, as TypeScript refuses spreading
   * `T[] | undefined`: there would be nothing to splice, and the run would
   * fail. A spread nobody could type is a run nobody can type.
   *
   * A walk read for a field (`...m-[a:Attachments]->.\`File\``, or a name
   * bound to one) is a COLLECTION, as a fold reads it: one value per landing,
   * so it splices a run of the field's type — empty when nothing landed, and
   * never absent, so there is nothing to guard. That holds where each landing
   * gives ONE value; a field that itself holds several (a list, json) keeps
   * the reading it always had, since one landing's list and several landings'
   * values are indistinguishable once read.
   */
  private spreadParts(
    expr: Expression,
    position: PositionTypeRef | undefined,
  ): Array<{ slot: FieldType | null } | { run: FieldType | null }> {
    const spread = this.inferExactAt(expr, position);
    if (spread === undefined) return [{ run: null }];
    if (this.isManyValued(expr, position) && holdsOneValue(spread)) return [{ run: spread }];
    if (isMaybeAbsent(spread)) {
      this.report(
        TypedDiagnosticCodes.ABSENT_REQUIRED,
        `'...' splices a list's members into this list, and what it spreads may be absent (${describeFieldType(stripAbsent(spread))}, or nothing) — guard it, or spread a list that is always there ('...COALESCE(xs, [])').`,
      );
    }
    const present = stripAbsent(spread);
    const variant = variantOf(present);
    switch (variant.kind) {
      case 'tuple': {
        const slots = variant.of.map(slot => ({ slot }));
        if (variant.rest === undefined) return slots;
        return [...slots.slice(0, variant.rest.at), { run: variant.rest.of }, ...slots.slice(variant.rest.at)];
      }
      case 'list':
        return [{ run: variant.of }];
      // One of several lists splices whatever any of them holds. A union with
      // a member that is not a collection may be one thing, and is refused as
      // one is.
      case 'union': {
        const run = collectionElementOf(present);
        if (run !== undefined) return [{ run }];
        this.report(
          TypedDiagnosticCodes.LIST_SPREAD_NOT_A_LIST,
          `'...' splices a list's members into this list, and this is ${describeFieldType(present)} — which may be one thing, not several. Spread a list ('[a, ...xs]').`,
        );
        return [{ run: null }];
      }
      // `json` may hold a list at run time, but nothing here says it does —
      // the opaque type is passed through, never taken apart.
      case 'text':
      case 'number':
      case 'boolean':
      case 'date':
      case 'datetime':
      case 'file':
      case 'json':
      case 'absent':
      case 'dict':
      case 'enum':
      case 'record':
      case 'maybeAbsent':
        this.report(
          TypedDiagnosticCodes.LIST_SPREAD_NOT_A_LIST,
          `'...' splices a list's members into this list, and this is ${describeFieldType(present)} — one thing, not several. Write it as a member ('[a, x]') rather than spreading it, or spread a list ('[a, ...xs]').`,
        );
        return [{ run: null }];
      default:
        return neverAsAny(variant);
    }
  }

  /** A walk read for a field, or a bare name bound to one — many values the
   *  type, being one value's, does not count. A bare name under a position is that position's field instead, as
   *  `inferExactAt` reads it. */
  private isManyValued(expr: Expression, position: PositionTypeRef | undefined): boolean {
    if (isWalkProjection(expr)) return true;
    if (position !== undefined) return false;
    const name = bareName(expr);
    return name !== undefined && this.options.isManyValuedName?.(name) === true;
  }

  private reportUnknownDictKey(key: string, keys: string[]): void {
    const closest = closestByEditDistance(key, keys);
    this.report(
      TypedDiagnosticCodes.DICT_UNKNOWN_KEY,
      `this dict has no key "${key}" — it was written with: ${keys.length > 0 ? keys.map(k => `"${k}"`).join(', ') : 'no keys at all'}.`
        + (closest !== undefined ? ` Did you mean "${closest}"?` : ''),
    );
  }

  requireDictKey(type: FieldType | undefined, where: string): void {
    if (type === undefined) return;
    const key = stripAbsent(type);
    const variant = variantOf(key);
    switch (variant.kind) {
      // An enum's values ARE text, so one spells a key with no coercion.
      case 'text':
      case 'enum':
        return;
      case 'union':
        if (variant.of.every(member => member === 'text' || isEnumType(member))) return;
        break;
      case 'number':
      case 'boolean':
      case 'date':
      case 'datetime':
      case 'file':
      case 'json':
      case 'absent':
      case 'list':
      case 'tuple':
      case 'dict':
      case 'record':
      case 'maybeAbsent':
        break;
      default:
        return neverAsAny(variant);
    }
    const repair =
      key === 'date' || key === 'datetime'
        ? "write the spelling down — `DATE.FORMAT(d, \"YYYY-MM-DD\")`"
        : 'write it into text — `"${…}"`';
    this.report(
      TypedDiagnosticCodes.DICT_KEY_NOT_TEXT,
      `a dict is keyed by text, and this key is ${describeFieldType(key)} (${where}). There is no one way to spell ${describeFieldType(key)} as text, so ${repair}.`,
    );
  }

  private requireTransparent(type: FieldType | undefined, operation: string): boolean {
    const diagnostic = checkJsonOpaque(type, operation) ?? checkRecordAsValue(type, operation);
    if (diagnostic === null) return false;
    this.report(diagnostic.code, diagnostic.message);
    return true;
  }

  /**
   * Comparisons (`< <= > >=` and `== !=` alike) must be within a value
   * CATEGORY — temporal (date/datetime, mutually comparable since a date is
   * midnight), numeric (number), textual (text/enum, mutually comparable),
   * boolean. A cross-category compare (`date <= number`, `text == number`)
   * can never be meaningful, so flag it with a coercer hint. Permissive by
   * design: only a DEFINITE mismatch (both sides known, different categories)
   * is flagged — an unknown/undefined side (schema-underspecified) stays
   * silent, never a false positive.
   *
   * text/enum stay same-category here; a string literal compared against an
   * enum is additionally membership-checked by `checkEnumLiteralOperand` (a
   * typo'd option is `MOV_ENUM_UNKNOWN_VALUE`, not a category mismatch).
   */
  private checkComparable(
    left: FieldType | undefined,
    right: FieldType | undefined,
    need: 'overlap' | 'every',
  ): void {
    if (left === undefined || right === undefined) return;
    // A RECORD is compared by IDENTITY: the same landing reached two ways is
    // one record, so `==` is the question it can answer, and reading it — which
    // is what every other rule here does — is not what was asked. A record
    // against anything else is a mismatch: a record is never equal to a scalar.
    if (isRecordType(left) || isRecordType(right)) {
      if (!isRecordType(left) || !isRecordType(right)) this.reportCompareMismatch(left, right);
      return;
    }
    // A structured value is comparable to nothing, itself included — reported
    // ahead of the category rule so the author gets the pass-it-through
    // guidance instead of a coercer hint that couldn't help.
    if (this.requireTransparent(left, 'compared') || this.requireTransparent(right, 'compared')) {
      return;
    }
    // A union compares member by member, as TypeScript's does: equality and
    // membership need one pair that could be equal (`text | number` against
    // "x" asks a real question), ordering needs every pair ordered alike.
    const leftMembers = unionMembers(left);
    const rightMembers = unionMembers(right);
    if (leftMembers.length > 1 || rightMembers.length > 1) {
      const pairs = leftMembers.flatMap(l => rightMembers.map(r => membersComparable(l, r)));
      if (!(need === 'overlap' ? pairs.some(Boolean) : pairs.every(Boolean))) {
        this.reportCompareMismatch(left, right);
      }
      return;
    }
    const leftCategory = comparisonCategory(left);
    const rightCategory = comparisonCategory(right);
    // list / file: comparable only to an identical type; any category mismatch
    // (including list-vs-list of different element types) is flagged below.
    if (leftCategory === 'structural' || rightCategory === 'structural') {
      if (!fieldTypeEquals(left, right)) this.reportCompareMismatch(left, right);
      return;
    }
    if (leftCategory !== rightCategory) this.reportCompareMismatch(left, right);
  }

  /**
   * When `operand` is a bare string LITERAL and the OTHER side of the
   * comparison is enum-typed, the literal is contextually that enum's value —
   * validate its membership through the shared helper. `operandType` is the
   * literal's own (textual) type; `otherType` carries the enum.
   */
  private checkEnumLiteralOperand(
    operand: Expression,
    operandType: FieldType | undefined,
    otherType: FieldType | undefined,
  ): void {
    if (operand.type !== 'static' || typeof operand.value !== 'string') return;
    // Only a textual literal is contextually an enum value — a number/bool
    // literal mistyped against an enum is the category check's concern.
    if (operandType !== 'text') return;
    if (!isEnumType(otherType)) return;
    const diagnostic = checkEnumLiteral(operand.value, otherType);
    if (diagnostic) this.report(diagnostic.code, diagnostic.message, diagnostic.severity);
  }

  /**
   * Dispatch operand typing by the OPERATOR's signature — the rule set is
   * per-operator, not one homogeneous "both sides same category":
   *
   * - `element-wise` (eq / neq / in / contains): membership-shaped. A list
   *   operand participates through its ELEMENT type — `Tags CONTAINS "x"`,
   *   `Domains == "acme.com"` — so lists unwrap before the category rule
   *   (and the enum membership check) applies. Two lists still compare by
   *   their unwrapped element categories.
   * - `same-category` (gt / gte / lt / lte): strict ordering — both sides one
   *   category; lists and files compare only to an identical type.
   * - `duration` (within): the right operand is a duration literal, not a
   *   value the left compares to — validated by shape instead.
   * - `none` (exists): effectively unary; nothing to type.
   *
   * Absence splits along the same seam, mirroring TS. Equality and membership
   * TOLERATE a possibly-absent operand — `undefined === "Ship"` is false, not an
   * error, so the comparison IS the handling and `==` inside an `if` additionally
   * NARROWS (see `presenceProofs`). ORDERING does not: TS errors on
   * `x < 3` for `x: number | undefined`, and here `relationalOrder` would answer
   * false silently, which is the absence of a guarantee rather than a weaker one.
   */
  private checkCompareOperands(
    op: FilterOperator,
    expr: Extract<Expression, { type: 'compare' }>,
    leftType: FieldType | undefined,
    rightType: FieldType | undefined,
  ): void {
    // `== null` is the ONE loose comparison — TypeScript's own carve-out, and
    // the reason it is handled ahead of the category rules: `null` is in no
    // value category, so every other rule would call it a mismatch.
    if (isNullLiteral(expr.left) || isNullLiteral(expr.right)) {
      this.checkNullComparison(op, expr, leftType, rightType);
      return;
    }
    switch (COMPARE_OPERAND_RULES[op]) {
      case 'none':
        return;
      case 'duration':
        // WITHIN orders a timestamp against the wall clock — an ordering, so it
        // demands a present left just like `<`/`>`.
        if (isMaybeAbsent(leftType)) this.reportAbsentInComparison(leftType!);
        this.checkWithinDuration(expr.right);
        return;
      case 'element-wise': {
        const left = leftType === undefined ? undefined : unwrapList(leftType);
        const right = rightType === undefined ? undefined : unwrapList(rightType);
        this.checkComparable(left, right, 'overlap');
        this.checkEnumLiteralOperand(expr.left, left, right);
        this.checkEnumLiteralOperand(expr.right, right, left);
        return;
      }
      case 'same-category':
        // Ordering RECORDS has no meaning — there is nothing about a place in a
        // graph that is before or after another place. Equality is identity and
        // is fine; this is the other half.
        if (
          this.requireTransparent(leftType, 'ordered')
          || this.requireTransparent(rightType, 'ordered')
        ) {
          return;
        }
        // Checked BEFORE `checkComparable`, whose `stripAbsent` erases the very
        // thing this reports.
        if (isMaybeAbsent(leftType)) this.reportAbsentInComparison(leftType!);
        if (isMaybeAbsent(rightType)) this.reportAbsentInComparison(rightType!);
        this.checkComparable(leftType, rightType, 'every');
        this.checkEnumLiteralOperand(expr.left, leftType, rightType);
        this.checkEnumLiteralOperand(expr.right, rightType, leftType);
        return;
    }
  }

  /**
   * A comparison against the `null` LITERAL. `==` / `!=` ask whether the other
   * side has a value at all — legal at any type, and the guard form the rest of
   * this layer narrows on. Every other operator is asking to ORDER or MATCH
   * against nothing, which no value can satisfy: an error rather than a silent
   * false, since silence there is the absence of a guarantee.
   */
  private checkNullComparison(
    op: FilterOperator,
    expr: Extract<Expression, { type: 'compare' }>,
    leftType: FieldType | undefined,
    rightType: FieldType | undefined,
  ): void {
    if (op !== 'eq' && op !== 'neq') {
      this.report(
        TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
        `'${describeFilterOp(op)}' can't be used with null — null is the absence of a value, so only '==' and '!=' say anything about it.`,
      );
      return;
    }
    const sides: Array<[Expression, FieldType | undefined]> = [
      [expr.left, leftType],
      [expr.right, rightType],
    ];
    for (const [subject, subjectType] of sides) {
      if (isNullLiteral(subject)) continue;
      if (this.refuseTextPresenceTest(subject, op === 'eq' ? 'absent' : 'present')) continue;
      const label = subjectLabel(subject);
      if (label === undefined) continue;
      // The subject's own type answers when it HAS one (a field read, a typed
      // scalar binding); a node-plane binding types nothing on this plane, so
      // its absence is read off the binding instead.
      const absent =
        subjectType !== undefined
          ? isMaybeAbsent(subjectType)
          : this.nameMayBeAbsent(bareName(subject) ?? '');
      if (absent !== false) continue;
      this.report(
        TypedDiagnosticCodes.PRESENCE_TEST_CONSTANT,
        `'${label}' always has a value here, so '${label} ${op === 'eq' ? '==' : '!='} null' is ${op === 'eq' ? 'always false' : 'always true'} — nothing on this path can make it absent.`,
        'info',
      );
    }
  }

  /**
   * A presence test on an extracted TEXT field — `x.f == null`, `!= null`,
   * `EXISTS(x.f)`, `ISNULL(x.f)` — can never say anything: a text the model
   * did not find is handed over as `""`, never absent. TypeScript refuses the
   * same shape ("this comparison appears to be unintentional because the
   * types have no overlap"), and so does this, naming the emptiness test that
   * does what the guard meant.
   *
   * Only an extracted field: that "" is a promise the engine keeps. A system's
   * text field is typed the same, but a source may still hand back nothing,
   * so a guard on one stays legal. Returns true when it fired.
   */
  private refuseTextPresenceTest(subject: Expression, asks: 'present' | 'absent'): boolean {
    // Version 1 hands an unfound text over as absent, so there the test is
    // the meaningful one.
    if (before(this.options.languageVersion, 2)) return false;
    const field = directFieldRead(subject);
    if (field === undefined) return false;
    const position = this.rootType(field.root);
    if (position?.kind !== 'extract') return false;
    const declared = position.node.properties.get(field.propertyId);
    if (declared === undefined) return false;
    if (!readsAsPresentText(declared)) return false;
    const label = `${field.root}.${quoteName(field.propertyId)}`;
    const [verdict, fix] =
      asks === 'present'
        ? ['always true', `\`${label} != ""\` (or \`LENGTH(${label}) > 0\`)`]
        : ['always false', `\`${label} == ""\``];
    this.report(
      TypedDiagnosticCodes.PRESENCE_TEST_ON_TEXT,
      `'${label}' is extracted text, and a text the model did not find is "" — never absent — so testing it for null is ${verdict}. Annotate it \`<text | null>\` to keep the null test, or test whether it is empty instead: ${fix}.`,
    );
    return true;
  }

  /** WITHIN's right side, when literal, must be a duration: `<n>d` days,
   *  `<n>h` hours, `<n>w` weeks — the shapes the engine's recency evaluator
   *  understands. Anything else would silently filter everything out. */
  private checkWithinDuration(operand: Expression): void {
    if (operand.type !== 'static') return;
    if (typeof operand.value === 'string' && /^\d+[dhw]$/.test(operand.value)) return;
    this.report(
      TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
      `WITHIN takes a duration literal — a number with a unit, like 30d (days), 12h (hours), or 1w (weeks); got ${JSON.stringify(operand.value)}.`,
    );
  }

  private reportAbsentInComparison(type: FieldType): void {
    this.report(
      TypedDiagnosticCodes.ABSENT_REQUIRED,
      `this side of the ordered comparison may be absent (${describeFieldType(type)}) — it comes from a branch that might not have run, or an answer that might not be there. Ordering needs a value on both sides: fall back to something that always answers ('COALESCE(…, 0)'), gate on it first ('r-[x:…]-> { … }'), or test it with '==' and order inside that branch. (Equality itself is fine on a maybe-absent value — absent is simply never equal.)`,
    );
  }

  private reportCompareMismatch(left: FieldType, right: FieldType): void {
    this.report(
      TypedDiagnosticCodes.COMPARE_TYPE_MISMATCH,
      `Can't compare a ${describeFieldType(left)} to a ${describeFieldType(right)} — `
        + 'wrap one side in DATE(…), DATETIME(…), or NUMBER(…) to coerce it.',
    );
  }

  /** An `@`-prefixed meta field must name one of the canonical keys; an unknown
   *  key would resolve to null silently at runtime, so flag it (with a
   *  did-you-mean for the closest canonical key). */
  private checkMetaKey(key: string): void {
    if (isMovementMetaKey(key)) return;
    const closest = closestMovementMetaKey(key);
    this.report(
      TypedDiagnosticCodes.META_UNKNOWN_KEY,
      `'@${key}' isn't a known meta field.${closest !== undefined ? ` Did you mean '@${closest}'?` : ''}`,
    );
  }

  /**
   * The WHERE on a `match` or `write` target's final hop, typed where it
   * applies: at the record the hop lands on, with the hop's own alias naming
   * that record. The engine evaluates it once per identity candidate, reading
   * the candidate exactly as a traversal WHERE reads a landed record — so the
   * typing is a read hop's, with the alias bound before the filter rather than
   * after it.
   */
  typeTargetFilter(input: {
    filter: Expression;
    landing: PositionTypeRef | undefined;
    alias: string | undefined;
  }): FieldType | undefined {
    if (input.alias !== undefined) this.locals.set(input.alias, input.landing);
    return this.inferAt(input.filter, input.landing);
  }

  private checkExistsSteps(
    steps: TraversalStep[],
    where: Expression | undefined,
    position: PositionTypeRef | undefined,
  ): void {
    const destination = this.walkSteps(position, steps);
    if (where) this.inferAt(where, destination);
  }

  /**
   * Walks traversal hops from `start`, validating each edge against the
   * current position type (check 4) and binding hop aliases' types. An
   * unknown start or a `_resources` hop makes the rest of the walk untyped
   * (silent), never wrong. A polymorphic edge does NOT: it lands on its union,
   * which is a type like any other.
   */
  walkSteps(
    start: PositionTypeRef | undefined,
    steps: TraversalStep[],
    opts?: { awaited?: boolean },
  ): PositionTypeRef | undefined {
    this.awaited = opts?.awaited ?? false;
    this.lastEdgeSchema = undefined;
    const landings: Array<PositionTypeRef | undefined> = [];
    this.lastLandings = landings;
    let current = start;
    // The ordering the walk hands back — the LAST hop's, overwritten per hop.
    let ordering: CollectionOrder = 'unknown';
    let orderingEdge: string | undefined = undefined;
    for (const step of steps) {
      if (step.type === 'edge') {
        const from = current;
        const stepped =
          current !== undefined
            ? this.stepEdge(current, step.edgeTypeId, step.expressionFilter)
            : undefined;
        // Read the hop's sequencing NOW: typing the WHERE below walks its own
        // traversals, and `lastEdgeSchema` belongs to whichever walked last.
        ordering = this.hopOrdering(from, step, this.lastEdgeSchema);
        orderingEdge = step.edgeTypeId;
        this.checkHopLimitOrder(step, ordering);
        // A record reached through a function's parameter is the caller's
        // record's child: its fields are in hand exactly when the caller's
        // are, so what the body needs of it is the parameter's need.
        const next = withParameterOf(
          from,
          stepped !== undefined ? refineSelected(stepped, step.expressionFilter) : stepped,
        );
        // The hop's own alias names the element it lands on, and the bracket's
        // WHERE and ORDER BY are expressions over that element — so the alias
        // is bound before either is typed (`-[e:X WHERE e.`F` == 1]->`, `ORDER
        // BY e-[:Signal]->.`Discovered At``), as the engine binds it per member.
        if (step.alias) this.locals.set(step.alias, next);
        if (step.expressionFilter) this.inferAt(step.expressionFilter, next);
        // The bracket `ORDER BY` key types exactly as the WHERE just did: at
        // the destination, in check 4's vocabulary, silent on an untyped one.
        const orderKey = step.cardinality?.orderBy;
        if (orderKey !== undefined) {
          const keyType = this.inferAt(orderKey, next);
          this.checkOrderingKey(orderKey, keyType, `ORDER BY on '${step.edgeTypeId}'`);
        }
        // Gate the hop's WHERE / ORDER BY / LIMIT against the source's declared
        // filter/order/limit capability (chunk 6). Silent when undeclared.
        if (current !== undefined) this.gateHopCapability(current, step, next);
        current = next;
      } else if (step.type === 'meta_edge') {
        if (step.alias) this.locals.set(step.alias, undefined);
        if (step.expressionFilter) this.inferAt(step.expressionFilter, undefined);
        current = undefined;
        ordering = 'unknown';
        orderingEdge = undefined;
      } else {
        current = undefined; // resource / linkBack steps are untyped
        ordering = 'unknown';
        orderingEdge = undefined;
      }
      landings.push(current);
    }
    this.lastOrdering = steps.length > 0 ? ordering : 'unknown';
    this.lastOrderingEdge = orderingEdge;
    // A hop is a fetch from whatever graph it walks in. A STEPLESS walk is not
    // — `co.`Name`` reads a value the run already holds — so it raises no read,
    // the same line `isPurePredicate` draws.
    if (steps.length > 0) {
      this.options.onEffect?.({
        kind: 'read',
        instances: [start, ...landings].map(type =>
          type !== undefined ? instanceOfType(type) : undefined,
        ),
      });
    }
    return current;
  }

  /**
   * What order ONE hop hands its members back in.
   *
   * An authored `ORDER BY` is the author saying it; `EdgeSchema.sequenced` is
   * the adapter saying it. An extract result's nested nodes come back in the
   * order the document put them in, which is a real and stable order (R3), and
   * is declared here because an extract result graph has no adapter to declare
   * it. A hop off a position nobody described, or over an edge no schema
   * carries, says NOTHING — the third answer, and never a diagnostic.
   */
  private hopOrdering(
    from: PositionTypeRef | undefined,
    step: Extract<TraversalStep, { type: 'edge' }>,
    edgeSchema: EdgeSchema | undefined,
  ): CollectionOrder {
    if (step.cardinality?.orderBy !== undefined) return 'ordered';
    if (from === undefined) return 'unknown';
    // An extract result's entry edges are document-ordered (R3).
    if (from.kind === 'extract') return 'ordered';
    // A root collection (`crm-[c:Companies]->`) is a query with no order asked
    // for — a set, until an ORDER BY says otherwise.
    if (from.kind === 'meta') {
      return from.instance.schema.collections[step.edgeTypeId] !== undefined
        ? 'unordered'
        : 'unknown';
    }
    if (from.kind === 'local') {
      const local = from.edges?.[step.edgeTypeId];
      if (local === undefined) return 'unknown';
      return local.schema.sequenced !== undefined ? 'ordered' : 'unordered';
    }
    if (edgeSchema === undefined) return 'unknown';
    return edgeSchema.sequenced !== undefined ? 'ordered' : 'unordered';
  }

  /** `LIMIT n` with no `ORDER BY` over a hop that comes back in no particular
   *  order is "some n of them" — the same bug as `FIRST` over a set, and it
   *  gets the same refusal. */
  private checkHopLimitOrder(
    step: Extract<TraversalStep, { type: 'edge' }>,
    ordering: CollectionOrder,
  ): void {
    if (step.cardinality?.limit === undefined) return;
    if (step.cardinality.orderBy !== undefined) return;
    if (ordering !== 'unordered') return;
    this.report(
      TypedDiagnosticCodes.LIMIT_NEEDS_ORDER,
      `'${step.edgeTypeId}' comes back in no particular order, so 'LIMIT ${step.cardinality.limit}' takes some ${step.cardinality.limit} of them — a different ${step.cardinality.limit} each run. Say which ones you mean with an ORDER BY (\`-[:${step.edgeTypeId} ORDER BY \`…\` DESC LIMIT ${step.cardinality.limit}]->\`).`,
    );
  }

  /**
   * The ordering of the collection a fold is about to read. The two planes
   * answer separately — a walk from its last hop, a value from its type — and
   * `unknown` means nobody said, which is never an error.
   */
  private collectionOrdering(
    expr: Expression,
    position: PositionTypeRef | undefined,
  ): { order: CollectionOrder; subject: string | undefined } {
    switch (expr.type) {
      case 'traverse': {
        const walked = this.walkOrderings.get(expr);
        if (walked !== undefined) return { order: walked.order, subject: walked.edge };
        return { order: 'unknown', subject: undefined };
      }
      case 'list':
        return { order: 'ordered', subject: undefined };
      case 'aggregate':
        // `SORT` IS the ordering — that is the whole of what it does, so a
        // fold over its answer needs nothing further. `COLLECT` hands the
        // members back as they came, so it is its argument's ordering; nothing
        // else folds to a collection.
        if (expr.fn === 'sort') return { order: 'ordered', subject: undefined };
        return expr.fn === 'collect'
          ? this.collectionOrdering(expr.expression, position)
          : { order: 'unknown', subject: undefined };
      case 'property':
      case 'edge_property':
      case 'alias_ref': {
        // A pure lookup — the read itself was already typed (and diagnosed)
        // when the argument was inferred; asking again must not say it twice.
        const name = expr.type === 'alias_ref' ? expr.name : expr.propertyTypeId;
        const type =
          (position !== undefined ? lookupPropertyType(position, name) : undefined)
          ?? this.scalarType(name);
        return { order: valueOrdering(type), subject: name };
      }
      default:
        return { order: 'unknown', subject: undefined };
    }
  }

  /** A stdlib argument the function READS — a format pattern — must be written
   *  down, and must be right, at save. */
  /**
   * `READ(file)` — a file's TEXT, or absent. The absence carries no reason
   * here, because no absence in this language does: what could not be read,
   * and why, is on the run's trace. So the type is simply `text | absent`,
   * discharged like any other (`COALESCE`, `?:`, an `==` guard).
   *
   * The ARGUMENT is where this can be wrong at author time: only a file has
   * bytes to read. A file that may itself be absent passes — READ of nothing
   * is nothing, and the result was already `text | absent`, so the absence has
   * nowhere new to go. An argument the checker cannot type says nothing, the
   * "unknown stays silent" contract everywhere else in this file.
   */
  private typeReadCall(args: Array<FieldType | undefined>): FieldType | undefined {
    const arg = args[0]; // arity is the bridge's to report
    if (arg !== undefined && stripAbsent(arg) !== 'file') {
      this.report(
        TypedDiagnosticCodes.READ_NOT_FILE,
        `${READ_SIGNATURE} reads a file's text, and this is ${describeFieldType(stripAbsent(arg))} — name the file itself (an attachment's file field), or drop the READ if you already have the text.`,
      );
    }
    return maybeAbsent('text');
  }

  /**
   * `CHUNKS(text, { … })` — the pieces of a text, as a `list of text`.
   *
   * Always a list, never `list of text | absent`: a text that isn't there has
   * no pieces, which is an EMPTY list and not an absence. That keeps the
   * result usable without a guard — `MAP`, `FILTER` and the rest read an empty
   * collection the way they read any other — and it is the honest answer,
   * since "nothing to cut" and "cut into nothing" are the same fact here.
   *
   * The ARGUMENT is the author-time mistake: only a text has pieces.
   */
  private typeChunksCall(args: Array<FieldType | undefined>): FieldType {
    const arg = args[0]; // arity is the bridge's to report
    if (arg !== undefined && stripAbsent(arg) !== 'text') {
      this.report(
        TypedDiagnosticCodes.CHUNKS_NOT_TEXT,
        `${CHUNKS_SIGNATURE} cuts a text into pieces, and this is ${describeFieldType(stripAbsent(arg))} — read the text out of it first (a file's text is READ(file)).`,
      );
    }
    return { kind: 'list', of: 'text' };
  }

  /**
   * The options map of a built-in that declares one. Every value is walked
   * (an expression inside one is validated like any other) and typed against
   * the key's declared type, where the contract names one the checker can
   * check — a `literal` option was settled at the bridge, since its value is a
   * spelling and nothing computes one.
   *
   * The map itself has no value type: it is call shape, not a value the
   * expression hands on.
   */
  private typeOptionsMap(
    arg: Expression,
    spec: BuiltinOptionsSpec,
    position: PositionTypeRef | undefined,
  ): undefined {
    if (arg.type !== 'object') return undefined; // the bridge already refused it
    for (const entry of arg.entries) {
      // The bridge refuses a spread among a built-in's options.
      if (isObjectSpread(entry)) continue;
      const got = this.inferAt(entry.value, position);
      const option = spec.options.find(o => o.key === entry.key);
      if (option === undefined || option.type === 'literal' || got === undefined) continue;
      if (stripAbsent(got) !== option.type) {
        this.report(
          TypedDiagnosticCodes.OPTION_INVALID,
          `${spec.signature}: '${entry.key}' is ${option.summary}, so it is a ${option.type} — and this is ${describeFieldType(stripAbsent(got))}.`,
        );
      } else if (isMaybeAbsent(got)) {
        this.report(
          TypedDiagnosticCodes.OPTION_INVALID,
          `${spec.signature}: '${entry.key}' is ${option.summary}, and this may not answer at all — fill it in ('COALESCE(…, 2000)') so the run always has one.`,
        );
      }
    }
    return undefined;
  }

  private checkStdlibLiteralArgs(
    spec: StdlibFunctionSpec,
    args: ReadonlyArray<Expression>,
  ): void {
    for (const declared of spec.literalArgs ?? []) {
      const arg = args[declared.index];
      if (arg === undefined) continue; // arity is the bridge's to report
      if (arg.type !== 'static' || typeof arg.value !== 'string') {
        this.report(
          TypedDiagnosticCodes.STDLIB_ARG_NOT_LITERAL,
          `${spec.signature} reads ${declared.what}, so it has to be written down — a computed one can't be checked here, and a mistake in it would show up in the output instead. Write the text in place.`,
        );
        continue;
      }
      const problem = declared.check(arg.value);
      if (problem !== undefined) {
        this.report(TypedDiagnosticCodes.STDLIB_ARG_INVALID, problem);
      }
    }
  }

  /**
   * `TEXT.PAIRS`'s first argument (or any future `recordArg`): must be
   * KEYED — a dict, or a typed record — not an ordinary scalar and not
   * `<json>`. `json` gets the same treatment `checkArithmeticOperands` gives
   * it: it LOOKS keyed at the write layer, but the checker cannot see its
   * keys, so folding over one would fold over nothing the author wrote.
   * Unknown stays silent, as everywhere else in this file; an ABSENT record
   * is not this error either — absence propagates through the call.
   *
   * A record clears that bar and can still be refused: `recordFields` (the
   * engine's one dereference for a `recordArg`) reads a record's fields off
   * what the BINDING itself holds — a `node {…}` literal's entries, an
   * extraction's exported fields, a write's result — never off a live system
   * (fields come back one adapter call at a time; there is no "give me all of
   * them" to ask for) and never off a fan-out (it reads ONE landing, not
   * many). `holdsSpelledFields` refuses the first; `pluralOrderOf` the second
   * — both checked here so the engine's `MOVENG_UNSUPPORTED` for either is
   * one a saved movement can never reach.
   */
  private checkStdlibRecordArg(
    spec: StdlibFunctionSpec,
    args: ReadonlyArray<FieldType | undefined>,
    rawArgs: ReadonlyArray<Expression>,
  ): void {
    const declared = spec.recordArg;
    if (declared === undefined) return;
    const type = args[declared.index];
    if (type === undefined) return; // unknown stays silent
    const stripped = stripAbsent(type);
    const notSpelledOut = () =>
      this.report(
        TypedDiagnosticCodes.STDLIB_ARG_NOT_RECORD,
        `\`${spec.namespace}.${spec.name}\` takes a record whose fields the program spells out — a dict literal, a \`node { … }\` literal, an extracted record or a declared one; build a dict of the fields you want from this record`,
      );
    // A block's whole return is a list of records, and the reach for it is
    // reaching for the one record a member carries — answered as that.
    const raw = rawArgs[declared.index];
    const name = raw !== undefined ? bareName(raw) : undefined;
    if (name !== undefined && this.options.pluralOrderOf?.(name) !== undefined) {
      notSpelledOut();
      return;
    }
    // One of several dicts is still a dict whose keys the author wrote.
    if (unionMembers(stripped).length > 1 && unionMembers(stripped).every(isDictType)) return;
    if (!isRecordType(stripped) && !isDictType(stripped)) {
      this.report(
        TypedDiagnosticCodes.STDLIB_ARG_NOT_RECORD,
        `${spec.signature} takes a record or a dict, and this is ${describeFieldType(stripped)}.`,
      );
      return;
    }
    if (isDictType(stripped)) return; // a dict's keys are the ones the author wrote
    if (!this.holdsSpelledFields(recordIn(stripped)?.position, `reads every field of it with \`${spec.namespace}.${spec.name}\``)) notSpelledOut();
  }

  /**
   * `TEXT.SERIALISE`'s first argument (any `wholeValueArg`): takes any value,
   * so the only author-time mistake is the one the engine would otherwise
   * throw for — a record whose fields the program does not hold (read live
   * from a system, one field at a time, or the movement's own trigger).
   * Same test as `checkStdlibRecordArg`, same reason, for one record or a
   * list of them; a record nested inside a dict is beyond what the type says
   * here and fails the run, named.
   */
  private checkStdlibWholeValueArg(
    spec: StdlibFunctionSpec,
    args: ReadonlyArray<FieldType | undefined>,
  ): void {
    const declared = spec.wholeValueArg;
    if (declared === undefined) return;
    const type = args[declared.index];
    if (type === undefined) return;
    const record = recordIn(type);
    if (record === undefined) return;
    const position = record.position;
    if (!this.holdsSpelledFields(position, `writes it out with \`${spec.namespace}.${spec.name}\``)) {
      this.report(
        TypedDiagnosticCodes.STDLIB_ARG_NOT_RECORD,
        `\`${spec.namespace}.${spec.name}\` writes out a record whose fields the program spells out — a \`node { … }\` literal, an extracted record or a declared one; build a dict of the fields you want from this record`,
      );
      return;
    }
    // A graph holding references holds the real records, so one read live
    // from a system is refused through the graph as it is on its own.
    const liveEdge =
      position === undefined
        ? undefined
        : liveReferenceWithin(position, this.options.isDeclaredGraphToken, held =>
            noteFieldsNeeded(held, `writes out a graph holding it with \`${spec.namespace}.${spec.name}\` (line ${this.options.span.start.line})`),
          );
    if (liveEdge !== undefined) {
      this.report(
        TypedDiagnosticCodes.STDLIB_ARG_NOT_RECORD,
        `\`${spec.namespace}.${spec.name}\` writes out a record whose '${liveEdge}' edge holds records read live from a system, one field at a time — copy the fields you want into the graph with a body ('${liveEdge}: … -> { field: x.Field }') and write out that`,
      );
      return;
    }
    const lazyEdge = position === undefined ? undefined : deferredEdgeWithin(position);
    if (lazyEdge !== undefined) {
      this.report(
        TypedDiagnosticCodes.STDLIB_ARG_LAZY_EDGE,
        `\`${spec.namespace}.${spec.name}\` writes out a record whose '${lazyEdge}' edge is a lazy walk that has not run yet — read it first (bind the walk, or await it) and write out what it gave back`,
      );
    }
  }

  /** Does the checker hold this record's fields IN HAND — a `node {…}`
   *  literal or a declared node's landing (`local`), an extraction
   *  (`extract`), a write's own result (`handle`), or a POSITION in a
   *  declared shape's own graph (`isDeclaredGraphToken`) — rather than
   *  resolved from a live system's schema (`position` / `union` in an
   *  ADAPTER's graph: the record a SYSTEM describes, read one field at a
   *  time, not the program's own words) or the bare instance root (`meta`)?
   *  A closure has no fields to spell out. `maybeEmpty` reads through to
   *  what it wraps — a gate changes presence, not which fields exist. */
  private holdsSpelledFields(position: PositionTypeRef | undefined, consumer: string): boolean {
    const held = holdsFieldsInHand(position, this.options.isDeclaredGraphToken);
    // A parameter's declared shape holds its fields here; whether the record
    // a caller hands over does is that caller's to show.
    if (held) noteFieldsNeeded(position, `${consumer} (line ${this.options.span.start.line})`);
    return held;
  }

  /**
   * `SORT(xs)` / `SORT(xs, DESC)` / `SORT(xs, key)` / `SORT(xs, key, DESC)` —
   * the same members, ordered. Its type is the argument's, as an ORDERED list,
   * which is what lets a `JOIN` / `FIRST` / `LAST` / `AT` over the answer stand
   * without further ceremony.
   *
   */
  private inferSort(
    expr: Extract<Expression, { type: 'aggregate' }>,
    inner: FieldType | undefined,
    position: PositionTypeRef | undefined,
  ): FieldType | undefined {
    const members = this.sortElementPosition(expr.expression, position);
    const element = inner === undefined ? undefined : unwrapList(inner);
    if (isBareWalk(expr.expression)) {
      // A walk written as a value hands over its records without the graph
      // behind them, so nothing here can read a key off one — and records have
      // no order of their own to fall back on.
      this.report(
        TypedDiagnosticCodes.SORT_KEY_ON_WALK,
        `SORT reads a key off each record, and a walk written inside the call hands its records over without the graph they came from. Bind the walk first — \`entries = … { return … }\` — then SORT the name.`,
      );
    } else if (
      expr.orderBy === undefined
      && (members !== undefined || (element !== undefined && isKeyedValue(element)))
    ) {
      // A record — or a set of values under names — has no order of its own,
      // and comparing two of them would compare their text.
      this.report(
        TypedDiagnosticCodes.SORT_NEEDS_KEY,
        `SORT is ordering ${members !== undefined ? 'records' : 'values with named parts'}, and one of those has no order of its own — say what to rank them by: SORT(…, \`Added At\`, DESC).`,
      );
    } else if (expr.orderBy !== undefined) {
      if (members === undefined && element !== undefined && isPlainValue(element)) {
        // A list of text or numbers has no fields to key on — a member IS the
        // key, which is the form with no key at all.
        this.report(
          TypedDiagnosticCodes.SORT_KEY_ON_SCALAR,
          `SORT reads this key off each member, and these members are plain values — there is nothing to read it from. Order them by themselves: SORT(…) or SORT(…, DESC).`,
        );
      } else {
        const keyType = this.inferAt(expr.orderBy, members);
        this.checkOrderingKey(expr.orderBy, keyType, 'SORT');
      }
    } else if (
      members === undefined
      && inner !== undefined
      && collectionElementOf(inner) === undefined
      // A WALK fans out invisibly — its members' TYPE is one member's, so a
      // scalar there says nothing about how many came back.
      && !(expr.expression.type === 'traverse' && expr.expression.steps.length > 0)
      && isPlainValue(inner)
    ) {
      this.report(
        TypedDiagnosticCodes.SORT_NOT_COLLECTION,
        `SORT orders a collection, and this is one value — there is nothing to put in order.`,
      );
    }
    if (element === undefined) return undefined;
    return listOf(element, 'ordered');
  }

  /**
   * What an ordering key must be, wherever one is written (a hop's `ORDER BY`,
   * `SORT`'s second argument): ONE value per element, read from the element
   * alone. A key that answers with several has nothing to rank by, and a key
   * that asks a model is not a function of the element.
   *
   */
  private checkOrderingKey(
    key: Expression,
    keyType: FieldType | undefined,
    site: string,
  ): void {
    const call = impureKeyCall(key);
    if (call !== undefined) {
      this.report(
        TypedDiagnosticCodes.ORDER_KEY_IMPURE,
        `${site} reads this key once per record and compares the answers, so it has to be a function of the record — ${call} isn't. Read a field, or a short path to one.`,
      );
      return;
    }
    if (keyType !== undefined && collectionElementOf(keyType) !== undefined) {
      this.report(
        TypedDiagnosticCodes.ORDER_KEY_MULTI,
        `${site} needs one value per record to rank it by, and this key answers with several. Fold it to one (MIN(…), MAX(…), FIRST(…)), or key on a single-valued field.`,
      );
    }
  }

  /**
   * The POSITION a `SORT` key is written against — the members' own type. A
   * walked collection's members are where the walk landed; a bound one's are
   * whatever the name holds. Undefined ⇒ the members are plain values, which
   * is what `SORT_KEY_ON_SCALAR` is about.
   */
  private sortElementPosition(
    argument: Expression,
    position: PositionTypeRef | undefined,
  ): PositionTypeRef | undefined {
    // A WALK's members are where it landed; a stepless dot-chain (`c.\`Name\``)
    // is a value read, and the value has no position.
    if (argument.type === 'traverse') {
      return argument.steps.length > 0 ? this.walkDestinations.get(argument) : undefined;
    }
    if (argument.type === 'property' && position === undefined) {
      return this.rootType(argument.propertyTypeId);
    }
    if (argument.type === 'alias_ref') return this.rootType(argument.name);
    return undefined;
  }

  /** The order discipline at a fold: an order-sensitive fold over a collection
   *  whose order means nothing is refused, naming the fixes that exist. */
  private checkFoldOrder(
    fn: AggregationFunction | 'at',
    argument: Expression,
    position: PositionTypeRef | undefined,
  ): void {
    if (fn !== 'at' && FOLD_ALGEBRA[fn] !== 'order-sensitive') return;
    const { order, subject } = this.collectionOrdering(argument, position);
    if (order !== 'unordered') return;
    const named = subject !== undefined ? `'${subject}'` : 'this collection';
    const orderByFix =
      subject !== undefined && argument.type === 'traverse'
        ? ` Order the hop (\`-[:${subject} ORDER BY \`…\` DESC]->\`), or reach for a relationship the source keeps in order.`
        : ' Order the traversal it came from, or reach for a relationship the source keeps in order.';
    const spelling = FOLD_SPELLING[fn] ?? fn.toUpperCase();
    const meaning =
      fn === 'join'
        ? `${spelling} writes the values out in the order they come in, and ${named} comes back in no particular order — the same line would read differently run to run.`
        : fn === 'at'
          ? `${spelling} reads a position in a sequence, and ${named} comes back in no particular order — every index picks an arbitrary member.`
          : `${spelling} takes the ${fn === 'last' ? 'last' : 'first'} of a sequence, and ${named} comes back in no particular order — so there is no ${fn === 'last' ? 'last' : 'first'}.`;
    const onlyFix =
      fn === 'first' || fn === 'last'
        ? ' If you mean the one that matched, write ONLY(…) — it answers that one and fails the run if there turns out to be more than one.'
        : '';
    this.report(TypedDiagnosticCodes.FOLD_NEEDS_ORDER, `${meaning}${onlyFix}${orderByFix}`);
  }

  /**
   * The filter/order/limit capability of a hop OUT of `from` over `edge`
   * (chunk 6). A top-level collection declares its own, exactly as a
   * record-reference edge does — the root is a node and the meta edge is an
   * edge. Undefined ⇒ undeclared surface ⇒ the gate stays silent.
   *
   */
  private edgeCapabilityFor(from: PositionTypeRef, edge: string): EdgeCapability | undefined {
    if (from.kind === 'meta') {
      return from.instance.schema.collections[edge]?.capability;
    }
    if (from.kind === 'position' || from.kind === 'handle') {
      return positionSchemaOfRef(from)?.edges[edge]?.capability;
    }
    return undefined;
  }

  /**
   * Author-time gate (chunk 6): a hop's WHERE / ORDER BY / LIMIT must be
   * within what the source can do across that relationship. Only fires when
   * the adapter has DECLARED its capability; an undeclared edge or
   * under-described target stays silent (best-effort, like schema today). For
   * a `native` filter/order, the per-field gate consults the TARGET position's
   * `propertyCapabilities`; a `bounded` edge satisfies any field via the shared
   * filter unit, so no per-field gate applies.
   */
  private gateHopCapability(
    from: PositionTypeRef,
    step: Extract<TraversalStep, { type: 'edge' }>,
    target: PositionTypeRef | undefined,
  ): void {
    const cap = this.edgeCapabilityFor(from, step.edgeTypeId);
    if (cap === undefined) return; // undeclared surface ⇒ silent
    const edge = step.edgeTypeId;
    const targetSchema = target !== undefined ? positionSchemaOfRef(target) : undefined;

    if (step.expressionFilter !== undefined) {
      if (cap.filter === undefined) {
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
          `'${edge}' can't be filtered here — this source doesn't support a WHERE across that relationship.`,
        );
      } else if (cap.filter === 'native' && !isPurePredicate(step.expressionFilter)) {
        // An impure filter (AI() / EXISTS) can only run in the app, over a
        // BOUNDED set — never over an unbounded native source, which would mean
        // fetching everything and filtering in memory (the very thing we refuse
        // to do). Bounded edges accept it (the engine evaluates the small set).
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
          `This filter has to run in the app (it uses AI() or EXISTS), which isn't possible over '${edge}' — an unbounded source. Narrow to a bounded relationship first, then filter.`,
        );
      } else if (cap.filter === 'native' && targetSchema?.propertyCapabilities !== undefined) {
        const caps = targetSchema.propertyCapabilities;
        const pushed: string[] = [];
        const residual: string[] = [];
        for (const pred of collectFilterPredicates(step.expressionFilter)) {
          // Unknown fields are MOV_UNKNOWN_PROPERTY's concern, not ours.
          if (targetSchema.properties[pred.field] === undefined) continue;
          const ops = caps[pred.field]?.filterOperators;
          const where = ops !== undefined && ops.includes(pred.op) ? pushed : residual;
          where.push(`\`${pred.field}\` (${describeFilterOp(pred.op)})`);
        }
        if (residual.length > 0 && pushed.length === 0) {
          // NOTHING narrows at the source, so the whole relationship comes back
          // to be filtered here. That is the boundedness rule, and it is still
          // a refusal: an unbounded read is not a slower version of a bounded
          // one.
          this.report(
            TypedDiagnosticCodes.HOP_FILTER_UNSUPPORTED,
            `This source can't filter '${edge}' by ${residual.join(' or ')} — reading it would mean fetching every record and filtering here. Narrow it by something the source can filter first.`,
          );
        } else if (residual.length > 0) {
          // Some of the WHERE narrows at the source and the rest runs here, on
          // what came back. The condition is the one that was written — the
          // engine delivers it either way — so this is the COST, said out loud,
          // and it is said again every time the movement is validated rather
          // than once when it was saved.
          this.report(
            TypedDiagnosticCodes.HOP_FILTER_RESIDUAL,
            `${residual.join(' and ')} on '${edge}' can't be filtered by the source, so those run here on what comes back — the rest of the WHERE narrows it first. The records you get are the same either way; the fetch is bigger.`,
            'warning',
          );
        }
      } else if (cap.filter === 'bounded' && from.kind === 'meta') {
        // A ROOT collection is an unbounded fan-out: `bounded` filtering means
        // the source hands over the whole collection and the WHERE runs here.
        // On a record edge that is free (the set is already in hand, bounded
        // by the record it left), which is why only the root says it — the
        // filter sibling of `HOP_ORDER_ENGINE`.
        this.report(
          TypedDiagnosticCodes.HOP_FILTER_ENGINE,
          `WHERE on '${edge}' runs here, not at the source — the whole collection is fetched first and filtered afterwards. The records you get are the same either way; the fetch is bigger.`,
          'warning',
        );
      }
    }

    const orderBy = step.cardinality?.orderBy;
    if (orderBy !== undefined) {
      // Only a bare property of the landed record can cross the seam; any
      // other key is a walk of this engine's, so the source's ordering
      // capability has nothing to say about it beyond the cost.
      const field = orderKeyProperty(orderBy);
      if (field === undefined) {
        // A key the source cannot be handed. Where it COULD have sorted, say
        // that it now won't: the sort runs here, after the fetch, and each
        // record's key is a read of its own. Where it never could, nothing
        // changed and nothing is said.
        if (cap.order !== undefined) {
          this.report(
            TypedDiagnosticCodes.HOP_ORDER_ENGINE,
            `ORDER BY on '${edge}' runs here, not at the source — this key is read off each record in turn, so the sort happens after the fetch. The order you get is the one you asked for.`,
            'warning',
          );
        }
      } else if (
        isNaturalOrder(cap, { field, direction: step.cardinality?.orderDirection ?? 'asc' })
      ) {
        // The order the source already delivers: satisfied there, so there is
        // no sort to run here and no cost to name — and the LIMIT reaches the
        // fetch. The adapter asks the same question before taking the LIMIT.
      } else if (cap.order === undefined) {
        this.report(
          TypedDiagnosticCodes.HOP_ORDER_UNSUPPORTED,
          `'${edge}' can't be ordered here — this source doesn't support ORDER BY across that relationship.`,
        );
      } else if (cap.order === 'native' && targetSchema?.propertyCapabilities !== undefined) {
        if (
          targetSchema.properties[field] !== undefined &&
          targetSchema.propertyCapabilities[field]?.orderable !== true
        ) {
          this.report(
            TypedDiagnosticCodes.HOP_ORDER_UNSUPPORTED,
            `This source can't order '${edge}' by \`${field}\` — that field isn't orderable server-side.`,
          );
        }
      } else if (cap.order === 'bounded' && from.kind === 'meta') {
        // A ROOT collection is an unbounded fan-out: `bounded` ordering means
        // the source hands over whatever the WHERE let through and the sort
        // happens here. On a record edge that is free (the set is already in
        // hand, bounded by the record it left), which is why only the root
        // says it.
        this.report(
          TypedDiagnosticCodes.HOP_ORDER_ENGINE,
          `ORDER BY on '${edge}' runs here, not at the source — everything the WHERE lets through is fetched first and sorted afterwards. The order you get is the one you asked for; the fetch is bigger.`,
          'warning',
        );
      }
    }

    if (step.cardinality?.limit !== undefined && cap.supportsLimit === false) {
      this.report(
        TypedDiagnosticCodes.HOP_LIMIT_UNSUPPORTED,
        `'${edge}' can't be limited here — this source doesn't support LIMIT across that relationship.`,
      );
    }
  }

  /** One typed hop. Reports TRAVERSE_UNKNOWN_EDGE / NARROWING; undefined = untyped
   *  onward. `filter` is the hop's WHERE (when any) — used only to gate an
   *  awaitable hop's purity. */
  stepEdge(
    from: PositionTypeRef,
    edge: string,
    filter?: Expression,
  ): PositionTypeRef | undefined {
    // Only a position/handle hop carries an `EdgeSchema`; reset per hop so the
    // last-resolved edge's schema survives for the `await` checker.
    this.lastEdgeSchema = undefined;
    switch (from.kind) {
      case 'meta': {
        const target = from.instance.schema.collections[edge]?.target;
        if (target === undefined) {
          const available = Object.keys(from.instance.schema.collections);
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `'${from.instance.name}' has no collection '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        return positionRefIn(from.instance, target);
      }
      case 'position':
      case 'handle': {
        // A write handle to a writable-only type (an ask's `Check`) has no
        // minted position, so `positionSchemaOfRef` is empty — but its WRITE
        // SHAPE declares the relationship table, and traversing a record you
        // just wrote (`await a-[:Response]->`) is real access. Fall back to the
        // handle's own edges so the hop lands on the (minted) target position
        // and every read past it is checked, instead of typing as nothing.
        const schema =
          positionSchemaOfRef(from) ??
          (from.kind === 'handle' && from.edges !== undefined
            ? { properties: {}, edges: from.edges }
            : undefined);
        if (!schema) {
          this.lastEdgeSchema = undefined;
          return undefined;
        }
        const edgeSchema = schema.edges[edge];
        this.lastEdgeSchema = edgeSchema;
        if (!edgeSchema) {
          if (this.reportUndescribed(from, schema, `the edge '${edge}'`)) return undefined;
          // An OPEN position's surface isn't enumerated — that honesty
          // extends to its edges (a raw payload bag). Unknown stays silent.
          // An UNdescribed one is a different fact, handled just above.
          if (schema.openProperties) return undefined;
          const available = Object.keys(schema.edges);
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `${describePosition(from)} has no edge '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        // Where this hop LANDS. Normally the edge's declared target; on a write
        // handle whose construction fixed a generic landing (an ask's `Options`
        // deciding its `Response`'s enum), the position the host synthesized for
        // THIS write's literals. Resolved once, ahead of both returns below, so
        // the awaitable and ordinary paths cannot disagree about the landing.
        const landing =
          (from.kind === 'handle' ? from.genericLandings?.[edge] : undefined) ?? edgeSchema.target;
        // AWAITABLE is a READ MODE, not an edge kind (callback-primitive layer
        // 3): `await` is the read that WAITS, over the very same edge. So an
        // awaitable edge that is also readable may be traversed bare — it reads
        // now and yields nothing until it resolves, which is a legitimate thing
        // to ask. Only an awaitable edge that declares `readable: false` (Slack
        // `Replies`) has no bare read to fall back on, and there the author's
        // real fix is `await`, not "this is write-only" — which is why this
        // precedes the readable check. Still land the target type so downstream
        // reads don't cascade a second error.
        if (edgeSchema.awaitable === true) {
          if (this.awaited) {
            if (filter !== undefined && !isPurePredicate(filter)) {
              // An `await`'s WHERE feeds the engine's rehydration-free evaluation
              // (F10) — it must be PURE (no AI() / EXISTS / nested live traversal).
              this.report(
                TypedDiagnosticCodes.AWAIT_IMPURE_WHERE,
                `The WHERE on '-[:${edge}]->' has to run in the app (it uses AI() or EXISTS), which an 'await' can't do — its condition is evaluated against each candidate without re-running the movement. Narrow it with a pure predicate over the awaited record's own fields.`,
              );
            }
            return positionRefIn(from.instance, landing);
          }
          if (!edgeIsReadable(edgeSchema)) {
            this.report(
              TypedDiagnosticCodes.AWAIT_REQUIRED,
              `'-[:${edge}]->' on ${describePosition(from)} resolves only when it is answered — read it with 'await' (\`await …-[:${edge}]->\`). A bare traversal reads now and would yield nothing until then.`,
            );
            return positionRefIn(from.instance, landing);
          }
          // Read bare, and the source would have TOLD us. Whoever asked (the
          // `until` checker) decides whether that is worth saying.
          if (edgeSchema.watchable === true) this.options.onWatchableRead?.(edge);
        }
        if (!edgeIsReadable(edgeSchema)) {
          this.reportWriteOnlyEdge(from, edge, edgeSchema);
          return undefined;
        }
        // A POLYMORPHIC edge's concrete target varies per record — which is
        // what a UNION is, and `positionRefIn` resolves unions first. This used
        // to answer `undefined`, so the hop typed as nothing and every read
        // past it went unchecked: silent degradation, not a weaker guarantee.
        // Landing on the union instead makes the existing machinery apply for
        // free — shared fields read, variant-only ones say "narrow with IS",
        // and the write side already demands the explicit member.
        return positionRefIn(from.instance, landing);
      }
      case 'union': {
        if (from.variants.length === 0) {
          this.report(
            TypedDiagnosticCodes.UNREACHABLE_BRANCH,
            `the tests above already cover every kind this can be, so nothing reaches here — '${edge}' can't be traversed`,
          );
          return undefined;
        }
        const carrying = from.variants.filter(
          v => from.instance.schema.positions[v]?.edges[edge] !== undefined,
        );
        if (
          carrying.length > 0 &&
          carrying.every(v => !edgeIsReadable(from.instance.schema.positions[v]!.edges[edge]!))
        ) {
          this.reportWriteOnlyEdge(
            from,
            edge,
            from.instance.schema.positions[carrying[0]]!.edges[edge]!,
          );
          return undefined;
        }
        if (carrying.length === from.variants.length && carrying.length > 0) {
          const targets = new Set(
            from.variants.map(v => from.instance.schema.positions[v]?.edges[edge]?.target),
          );
          if (targets.size === 1) {
            const [target] = targets;
            return target !== undefined ? positionRefIn(from.instance, target) : undefined;
          }
          return undefined;
        }
        if (carrying.length > 0) {
          // Variant keys are opaque addresses — render their DISPLAY, and
          // suggest the address-form IS (`.` is for properties; the dotted
          // type marker is retired). The example is DERIVED: the first
          // `action` option whose narrowing actually carries the edge.
          const shown = carrying
            .map(v => `${from.instance.name}'s ${displayNameOf(from.instance, v)}`)
            .join(' / ');
          let example = `x IS <${from.instance.name}-[:\`…\` WHERE …]->>`;
          const address = from.address;
          const actionType =
            address !== undefined
              ? from.instance.schema.positions[address.event]?.properties[EVENT_ACTION_FIELD]
              : undefined;
          if (address !== undefined && actionType !== undefined && isEnumType(actionType)) {
            for (const option of actionType.options) {
              const key = eventAddressKey({
                event: address.event,
                narrowing: { ...address.narrowing, [EVENT_ACTION_FIELD]: option },
              });
              if (carrying.includes(key)) {
                example = `x IS <${from.instance.name}-[:\`${address.event}\` WHERE \`${EVENT_ACTION_FIELD}\` == "${option}"]->>`;
                break;
              }
            }
          }
          this.report(
            TypedDiagnosticCodes.NARROWING,
            `'${edge}' is an edge of ${shown} only — narrow with an IS test (e.g. \`${example}\`) before traversing it`,
          );
          return undefined;
        }
        this.report(
          TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
          `no variant of ${describePosition(from)} has an edge '${edge}'`,
        );
        return undefined;
      }
      case 'extract': {
        const child = from.node.children.get(edge);
        if (!child) {
          const available = [...from.node.children.keys()];
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            `${describePosition(from)} has no nested node '${edge}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        return { kind: 'extract', node: child };
      }
      case 'closure': {
        this.report(
          TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
          `${from.label} is a closure — there is nothing to traverse off one. Call it, and traverse what it returns.`,
        );
        return undefined;
      }
      case 'local': {
        const local = from.edges?.[edge];
        if (local === undefined) {
          const available = Object.keys(from.edges ?? {});
          this.report(
            TypedDiagnosticCodes.TRAVERSE_UNKNOWN_EDGE,
            available.length > 0
              ? `${from.label} has no edge '${edge}' — it has: ${available.join(', ')}`
              : `${from.label} has no edges — read what it carries with a dot: ${Object.keys(from.reads)
                  .map(name => `'.${name}'`)
                  .join(' or ')}`,
          );
          return undefined;
        }
        this.lastEdgeSchema = local.schema;
        // A local AWAITABLE edge is readable BOTH ways: `await` waits for the
        // first landing, a bare traversal reads what has landed so far (zero
        // landings before anything fires — an empty traversal, the language's
        // own way of saying "not yet"). So no MOV_AWAIT_REQUIRED here; only the
        // await's rehydration-free WHERE constraint still applies.
        if (
          local.schema.awaitable === true
          && this.awaited
          && filter !== undefined
          && !isPurePredicate(filter)
        ) {
          this.report(
            TypedDiagnosticCodes.AWAIT_IMPURE_WHERE,
            `The WHERE on '-[:${edge}]->' has to run in the app (it uses AI() or EXISTS), which an 'await' can't do — its condition is evaluated against each candidate without re-running the movement. Narrow it with a pure predicate over the awaited record's own fields.`,
          );
        }
        return local.target;
      }
      case 'maybeEmpty':
        // Traversing INTO a maybe-empty node is gate-discharged (an absent edge
        // matches nothing, so the block runs zero times) — step the inner node.
        return this.stepEdge(from.of, edge, filter);
    }
  }

  /**
   * NOTHING HAS DESCRIBED this position, so anything you do with the handle is
   * a guess — say so instead of waving it through.
   *
   * The counterpart of `openProperties`' silence, and the reason the two are
   * separate fields rather than one. An OPEN position makes a positive claim
   * ("the surface is wider than what's enumerated" — a raw payload bag), which
   * is a real reason to stay quiet. An UNDESCRIBED one makes no claim at all,
   * and the two are not the same fact. Spelling them the same way is what let
   * `` e-[r:record]->.`Name` `` compile against a table nothing had ever
   * fetched: no diagnostics, null at run time.
   *
   * Reports and returns true when `schema` is undescribed. `what` names the
   * thing being reached for (`the field 'Name'`), so the message says what the
   * author was denied rather than only that they were.
   *
   * PENDING short-circuits ahead of that: a position whose fetch is still in
   * flight has no surface to check against either, but the author has done
   * nothing wrong and the answer is coming. It returns true — stop, there is
   * nothing to check — WITHOUT reporting. Reporting here is what would make an
   * editor flash diagnostics on every keystroke until each fetch landed.
   *
   * The two returns look alike and mean opposite things, which is why they read
   * off different flags rather than one: `undescribed` is a verdict, `pending`
   * is a wait.
   */
  private reportUndescribed(
    position: PositionTypeRef,
    schema: PositionSchema,
    what: string,
  ): boolean {
    if (schema.pending === true) return true;
    if (schema.undescribed !== true) return false;
    this.report(
      TypedDiagnosticCodes.UNDESCRIBED_POSITION,
      `nothing describes ${describePosition(position)}, so ${what} can't be checked here — `
        + `it would be null at run time. Narrow the type that reaches it to a concrete one first.`,
    );
    return true;
  }

  /** A read traversal walked a WRITE-ONLY edge — a pure create path with no
   *  read API behind it; traversing it would silently yield nothing. */
  private reportWriteOnlyEdge(from: PositionTypeRef, edge: string, edgeSchema: EdgeSchema): void {
    this.report(
      TypedDiagnosticCodes.WRITE_ONLY_EDGE,
      `'-[:${edge}]->' on ${describePosition(from)} is write-only — ${
        edgeIsWritable(edgeSchema)
          ? `it writes (write …-[:${edge}]-> { … }); the system offers nothing to read back along it`
          : 'the system offers nothing to read along it'
      }`,
    );
  }

  /**
   * The read is LEGAL and typed — but the source carries more than one field
   * under this name, so say which one won. Warning severity: it never gates a
   * compile, because the author's program is fine; the ambiguity is in their
   * workspace, and renaming one of the two fields is the only real fix.
   */
  private reportAmbiguousProperty(
    position: Extract<PositionTypeRef, { kind: 'position' | 'handle' }>,
    schema: PositionSchema,
    propertyId: string,
  ): void {
    if (!schema.ambiguousProperties?.includes(propertyId)) return;
    this.report(
      TypedDiagnosticCodes.AMBIGUOUS_PROPERTY,
      `${describePosition(position)} has more than one field named '${propertyId}' — this reads the first one. Rename one of them in the connected system to be sure which you get.`,
      'warning',
    );
  }

  /** The pointed diagnostic for reading a WRITE-ONLY field — one the type
   *  declares on its write shape only (`readable: false`). Reports and
   *  returns true when `propertyId` is write-only here; the message carries
   *  the adapter's own field doc so the author is steered to the real read
   *  path, not just refused. */
  private reportWriteOnlyProperty(
    position: Extract<PositionTypeRef, { kind: 'position' | 'handle' }>,
    schema: PositionSchema,
    propertyId: string,
  ): boolean {
    if (!schema.writeOnlyProperties?.includes(propertyId)) return false;
    const typeName = position.position;
    const shape =
      typeName !== undefined
        ? (position.instance.schema.writableRoots[typeName] ??
          position.instance.schema.createShapes?.[typeName])
        : undefined;
    const doc = shape?.fieldDocs?.[propertyId];
    this.report(
      TypedDiagnosticCodes.WRITE_ONLY_PROPERTY,
      `'${propertyId}' on ${describePosition(position)} is write-only — a value a write sets, not one to read.${doc ? ` ${doc}` : ''}`,
    );
    return true;
  }

  /**
   * A terminal property read against a position type. Extract positions get
   * full validity checking (check 9: unknown field, working field,
   * annotation suggestions + conflicts); union positions get narrowing
   * checks (check 6); adapter/shape positions and handles contribute a type
   * when the property is declared and ERROR when it isn't — typed positions
   * are CLOSED unless the schema marks them `openProperties` (the honesty
   * valve for raw/under-describable surfaces, which stays silent).
   */
  readProperty(
    position: PositionTypeRef | undefined,
    propertyId: string,
    writeTarget?: WriteTargetRef,
  ): FieldType | undefined {
    if (position === undefined) return undefined;
    if (propertyId === POSITION_SENTINEL) return undefined; // "the positions themselves"
    switch (position.kind) {
      case 'extract': {
        const read = this.readExtractField(position.node, propertyId, writeTarget);
        return read !== undefined && position.present?.has(propertyId) ? stripAbsent(read) : read;
      }
      case 'handle': {
        const declared = position.resultShape[propertyId];
        if (declared !== undefined) return declared;
        const schema = positionSchemaOfRef(position);
        const fromPosition = schema?.properties[propertyId];
        if (fromPosition !== undefined) {
          // Reading the POSITION's surface through the handle, so the
          // position's ambiguity applies here too. (A name resolved off the
          // handle's own `resultShape` above is a different surface — a write
          // result — and carries no such collision.)
          if (schema) this.reportAmbiguousProperty(position, schema, propertyId);
          return fromPosition;
        }
        if (schema && this.reportWriteOnlyProperty(position, schema, propertyId)) return undefined;
        if (schema && this.reportUndescribed(position, schema, `the field '${propertyId}'`)) {
          return undefined;
        }
        if (schema?.openProperties) return undefined;
        const available = [
          ...new Set([...Object.keys(position.resultShape), ...Object.keys(schema?.properties ?? {})]),
        ];
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${describePosition(position)} has no field '${propertyId}'${available.length ? ` — it carries: ${available.join(', ')}` : ''}${didYouMean(propertyId, available)}`,
        );
        return undefined;
      }
      case 'position': {
        const schema = positionSchemaOfRef(position);
        if (!schema) return undefined;
        const declared = schema.properties[propertyId];
        if (declared !== undefined) {
          this.reportAmbiguousProperty(position, schema, propertyId);
          return position.present?.has(propertyId) ? stripAbsent(declared) : declared;
        }
        if (this.reportWriteOnlyProperty(position, schema, propertyId)) return undefined;
        if (this.reportUndescribed(position, schema, `the field '${propertyId}'`)) return undefined;
        if (schema.openProperties) return undefined;
        const available = Object.keys(schema.properties);
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${describePosition(position)} has no field '${propertyId}'${available.length ? ` — it has: ${available.join(', ')}` : ''}${didYouMean(propertyId, available)}${narrowingHint(position)}`,
        );
        return undefined;
      }
      case 'union': {
        if (position.variants.length === 0) {
          this.report(
            TypedDiagnosticCodes.UNREACHABLE_BRANCH,
            `the tests above already cover every kind this can be, so nothing reaches here — '${propertyId}' can't be read`,
          );
          return undefined;
        }
        const carrying = position.variants.filter(
          v => position.instance.schema.positions[v]?.properties[propertyId] !== undefined,
        );
        if (carrying.length === 0) {
          const variantSchemas = position.variants.map(
            v => position.instance.schema.positions[v],
          );
          // Write-only on some variant beats unknown — the pointed
          // diagnostic (a value a write sets, not one to read) fires even
          // when another variant is open.
          const writeOnlyVariant = position.variants.find(v =>
            position.instance.schema.positions[v]?.writeOnlyProperties?.includes(propertyId),
          );
          if (writeOnlyVariant !== undefined) {
            this.reportWriteOnlyProperty(
              { kind: 'position', instance: position.instance, position: writeOnlyVariant },
              position.instance.schema.positions[writeOnlyVariant]!,
              propertyId,
            );
            return undefined;
          }
          // Silent when any variant is unresolvable or open — the read may
          // be legitimate against the under-described variant.
          if (variantSchemas.some(s => s === undefined || surfaceNotEnumerated(s))) return undefined;
          const available = [
            ...new Set(variantSchemas.flatMap(s => Object.keys(s!.properties))),
          ];
          this.report(
            TypedDiagnosticCodes.UNKNOWN_PROPERTY,
            `no variant of ${describePosition(position)} has a field '${propertyId}'${available.length ? ` — its variants have: ${available.join(', ')}` : ''}`,
          );
          return undefined;
        }
        if (carrying.length < position.variants.length) {
          // A type names an EDGE, and an edge is an ADDRESS — the dotted
          // spelling this once suggested has been retired and now parse-errors,
          // so the suggestion was teaching a syntax the author cannot write.
          const shown = carrying
            .map(v => `${position.instance.name}'s ${displayNameOf(position.instance, v)}`)
            .join(' / ');
          this.report(
            TypedDiagnosticCodes.NARROWING,
            `'${propertyId}' is a field of ${shown} only — narrow with an IS test (e.g. \`x IS <${position.instance.name}-[:\`${carrying[0]}\`]->>\`) before reading it`,
          );
          return undefined;
        }
        const types = carrying.map(v => position.instance.schema.positions[v]!.properties[propertyId]!);
        return types.every(t => fieldTypeEquals(t, types[0])) ? types[0] : undefined;
      }
      case 'maybeEmpty':
        // A field of a maybe-empty node is `T | absent` (F19) — one unified
        // absent with the scalar case. Delegate the field lookup (and its
        // reporting) to the inner node, then wrap the result.
        return maybeAbsent(this.readProperty(position.of, propertyId, writeTarget));
      case 'local': {
        // Presence, not truthiness: a declared-but-untyped read is unknown, and
        // an unknown type is not an unknown NAME.
        if (Object.hasOwn(position.reads, propertyId)) return position.reads[propertyId];
        // A name on the ARROW plane is reached by traversal, not by dot.
        if (position.edges?.[propertyId] !== undefined) {
          this.report(
            TypedDiagnosticCodes.UNKNOWN_PROPERTY,
            `'${propertyId}' is an edge of ${position.label} — traverse it ('-[x:${propertyId}]->'), don't read it as a value`,
          );
          return undefined;
        }
        const available = Object.keys(position.reads);
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${position.label} has no '${propertyId}'${available.length ? ` — it carries: ${available.join(', ')}` : ''}`,
        );
        return undefined;
      }
      case 'closure': {
        this.report(
          TypedDiagnosticCodes.UNKNOWN_PROPERTY,
          `${position.label} is a closure — there is nothing to read off one. Call it, and read what it returns.`,
        );
        return undefined;
      }
      case 'meta':
        return undefined;
    }
  }

  private readExtractField(
    node: ExtractNodeType,
    propertyId: string,
    writeTarget?: WriteTargetRef,
  ): FieldType | undefined {
    const nodeLabel =
      node.name === EXTRACT_ROOT_NAME ? 'the extract result' : `the extracted node '${node.name}'`;
    const field = node.properties.get(propertyId);
    if (field === undefined) {
      const available = [...node.properties.keys()];
      this.report(
        TypedDiagnosticCodes.EXTRACT_UNKNOWN_FIELD,
        `'${propertyId}' is not a field of ${nodeLabel}${available.length ? ` — it declares: ${available.join(', ')}` : ''}`,
      );
      return undefined;
    }
    if (field.explicit !== undefined) {
      // Annotation-vs-write compatibility. A redundant annotation is fine and
      // silent; a WRONG one is reported here, at the annotation. The lenient
      // write gate (`fieldTypeCompatible`, at the value site) already reports
      // every shape mistake it can see, so this site covers exactly its blind
      // spot: a target that CONSTRAINS what the text plane may hold — another
      // enum's option set, a date it would have to parse out of free text.
      // Cardinality stays the gate's deliberate leniency (lists coerce both
      // ways), so assignability is asked of the element type.
      const annotated = unwrapList(field.explicit);
      if (
        writeTarget !== undefined &&
        fieldTypeCompatible(field.explicit, writeTarget.type) &&
        targetConstrainsExtraction(writeTarget.type) &&
        !fieldAssignable(annotated, unwrapList(writeTarget.type))
      ) {
        const target = unwrapList(writeTarget.type);
        const enumTarget = isEnumType(target) ? target : undefined;
        const into = writeTarget.path !== undefined ? ` ${writeTarget.path},` : '';
        const mismatch =
          enumTarget !== undefined
            ? `a field whose options are (${enumTarget.options.join(' | ')}) — ${
                isEnumType(annotated)
                  ? 'the option sets differ'
                  : `${describeFieldType(annotated)} isn't constrained to them`
              }`
            : `a ${describeFieldType(writeTarget.type)} field — the annotation doesn't constrain the extraction to that type`;
        this.options.report(
          TypedDiagnosticCodes.EXTRACT_TYPE_CONFLICT,
          `'${propertyId}' on ${nodeLabel} is annotated as ${describeFieldType(field.explicit)}, but it is written into${into} ${mismatch}${writeTarget.path !== undefined ? `; borrow the target's ${enumTarget !== undefined ? 'options' : 'type'} (\`${propertyId}: <${borrowedAnnotationSpelling(writeTarget.path)}> "…"\`) or align the annotation` : ''}`,
          field.span,
        );
      }
      // Version 1: EVERY annotated field is optional, text included — an
      // unfound text is handed over absent there.
      if (before(this.options.languageVersion, 2)) return maybeAbsent(field.explicit);
      // R14: a TYPED extract field is optional — the model was asked for it
      // and may not have found it, and a number, a date, a choice from a set
      // has no value that means "nothing found". So a read is `T | absent`, and
      // the absence discipline fires where the value is REQUIRED (a plain
      // write field, an ordered comparison), not at the read.
      //
      // Text is the exception, because text HAS such a value: the runtime
      // hands a text field nobody found over as `""` (`presentTextFields` in the
      // engine's extraction export), so the read is present, and a text a
      // program only prints or writes needs no discharge.
      return readsAsPresentText(field) ? 'text' : maybeAbsent(field.explicit);
    }
    // An UNANNOTATED field is text — the inline shortcut asks the model for
    // words — and, like `<text>`, present. Only an annotation constrains what
    // the model answers, so a target that needs something text cannot be (a
    // number, a date, a yes/no, a file) is refused here, naming the
    // annotation, exactly as TypeScript refuses a string where a number is
    // required. An option set is text-shaped, so it earns the suggestion
    // instead: the value may still land, and the annotation is what makes it
    // one of the options.
    //
    // A field whose annotation simply didn't resolve here (missing schema /
    // bad borrow) is neither: the author already annotated it and the engine
    // re-resolves live, so it stays untyped and unremarked.
    if (field.annotationRaw !== undefined) return undefined;
    // Version 1: an unannotated field is untyped, and a write into a typed
    // target only earns the suggestion to annotate it (a plain-text or json
    // target has nothing an annotation would add).
    if (before(this.options.languageVersion, 2)) {
      if (writeTarget !== undefined) {
        const target = stripAbsent(writeTarget.type);
        if (target !== 'text' && target !== 'json') {
          this.suggestAnnotation(field, propertyId, nodeLabel, writeTarget);
        }
      }
      return undefined;
    }
    if (writeTarget === undefined) return 'text';
    const targetBase = baseKind(writeTarget.type);
    if (targetBase === 'text' || targetBase === 'json' || targetBase === 'absent') {
      if (isEnumType(unwrapList(writeTarget.type))) this.suggestAnnotation(field, propertyId, nodeLabel, writeTarget);
      return 'text';
    }
    if (targetBase === 'record') return 'text';
    const primitive = describeFieldType(unwrapList(writeTarget.type));
    const borrow =
      writeTarget.path !== undefined
        ? ` (or borrow the field's own type: \`${propertyId}: <${borrowedAnnotationSpelling(writeTarget.path)}> "…"\`)`
        : '';
    this.report(
      TypedDiagnosticCodes.EXTRACT_NEEDS_ANNOTATION,
      `'${propertyId}' on ${nodeLabel} is text — a field with no annotation asks the model for words — and it is written into a ${describeFieldType(writeTarget.type)} field${writeTarget.path !== undefined ? ` (${writeTarget.path})` : ''}. Annotate it so the model answers a ${primitive}: \`${propertyId}: <${primitive}> "…"\`${borrow}. An annotated ${primitive} may not be found, so write it with '?:' (set-if-empty), or fall back with COALESCE.`,
    );
    return undefined;
  }

  /** The info nudge toward an annotation that would ADD a constraint (an
   *  option set; under version 1, any typed target) without the write being
   *  wrong without it. Deduped per
   *  (field, target) so repeated writes say it once. */
  private suggestAnnotation(
    field: ExtractFieldInfo,
    propertyId: string,
    nodeLabel: string,
    writeTarget: WriteTargetRef,
  ): void {
    const annotation =
      writeTarget.path ?? (typeof writeTarget.type === 'string' ? writeTarget.type : undefined);
    if (annotation === undefined) return;
    field.suggested ??= new Set();
    if (field.suggested.has(annotation)) return;
    field.suggested.add(annotation);
    this.options.report(
      TypedDiagnosticCodes.EXTRACT_ANNOTATE,
      `'${propertyId}' on ${nodeLabel} flows into a ${describeFieldType(writeTarget.type)} field${writeTarget.path !== undefined ? ` (${writeTarget.path})` : ''} — annotate it as such (\`${propertyId}: <${borrowedAnnotationSpelling(annotation)}> "…"\`) so the extraction is constrained by the target's type; only explicit annotations constrain extraction. An annotated field reads as its type OR absent, so discharge that in the same edit — write the target field with '?:' (set-if-empty), wrap the read in COALESCE, or guard on it — since a plain field is refused a value that may be absent`,
      field.span,
      'info',
    );
  }
}

/**
 * The paste-able spelling of a borrowed annotation. `WriteTargetRef.path`
 * stores the resolver's `<instance>.<root>.<field>` segments; the SURFACE
 * spelling hops the middle and keeps the dotted property tail — `.` is for
 * properties, `-[:…]->` is for edges. A non-borrowed annotation (a primitive
 * type name) passes through untouched.
 */
function borrowedAnnotationSpelling(path: string): string {
  const segments = path.split('.');
  if (segments.length !== 3) return path;
  return `${segments[0]}-[:${segments[1]}]->.\`${segments[2]}\``;
}
