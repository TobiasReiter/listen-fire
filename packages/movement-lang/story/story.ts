// The STORY IR — a checked program, projected into something a renderer can
// draw without knowing the language.
//
// Two rules shape everything here.
//
//   1. FULLY SERIALIZABLE. The checker's recording is made of LIVE objects:
//      `Scope`s with parent pointers, instance tokens whose identity is object
//      reference. None of that survives a wire. This pass is where identity
//      becomes a stable id — a binding's name plus the source position it was
//      declared at — so `JSON.parse(JSON.stringify(story))` loses nothing.
//
//   2. ADAPTER-BLIND. Adapter types, event names, narrowing keys, record types
//      and edge names travel through as OPAQUE DECLARED STRINGS. Nothing here
//      parses one, and nothing here branches on one. The display vocabulary
//      that turns `attio` + `company` into "a Company in Attio" is an adapter
//      contribution resolved downstream, never a table in the core.
//
// It reads the recording for what the CHECKER resolved and the AST for what the
// AUTHOR wrote — order, nesting, and the verbatim text of every expression.

import type { Expression, FilterOperator, TraversalStep } from '@listen-fire/shared/expression/types';
import { serialize } from '@listen-fire/shared/expression/formula';
import {
  type AwaitSource,
  type CallArg,
  type CallStatement,
  type CollectionOp,
  type ExprSlot,
  type IfStatement,
  type ListenDeclaration,
  type MovementParam,
  type NodeLiteral,
  type PathHead,
  type Program,
  type CombinatorExpression,
  type RValue,
  type ShapeNode,
  type Span,
  type Statement,
  type TypeRef,
  type MatchExpression,
  type LinkExpression,
  type WriteExpression,
} from '../parser/ast';
import {
  constructionAsCall,
  isValueTypeRef,
  pathRootName,
  spreadSourceText,
  spellPathHead,
  spellValueType,
  typeNameOf,
} from '../parser/ast';
import { MovementParseError, parseProgram } from '../parser/parse';
import { expressionOfSlot } from '../expression/bridge';
import { parseFieldTypeName, type Catalog, type SchemaFieldType } from '../checker/catalog';
import { EMPTY_ROW, instanceNames, type EffectRow } from '../checker/effects';
import { bodyExits, terminates, type Exits } from '../checker/flow';
import type { ResolveFile } from '../checker/link';
import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from '../language_version';
import {
  EXTRACT_ROOT_NAME,
  maybeAbsent,
  type ExtractNodeType,
  type PositionTypeRef,
} from '../checker/typing';
import type { Scope, ScopeSymbol } from '../checker/scopes';
import {
  type CheckRecording,
  type Diagnostic,
  type DiagnosticSeverity,
  type RecordedAwait,
  type RecordedBranch,
  type RecordedCall,
  type RecordedCallReading,
  type RecordedExtract,
  type RecordedInstance,
  type RecordedLanding,
  type RecordedLink,
  type RecordedListen,
  type RecordedNode,
  type RecordedCombinator,
  type RecordedTraversal,
  type RecordedWrite,
  type RecordedValuePath,
  checkProgramWithLink,
  collectExpressionNames,
  diagnosticSeverity,
  valuePathKey,
} from '../checker/check';

// ── The IR ──

/**
 * A stable reference to something a name stood for at check time. `declaredAt`
 * is the position the binding was made at — the id a live `ScopeSymbol` becomes
 * once it has to survive serialization. Its ABSENCE means the name did not
 * resolve, which is a different fact from "it resolved to nothing".
 */
export interface StoryRef {
  name: string;
  declaredAt?: Span;
}

/** An endpoint of the record graph. Records and triggers are rows of this IR;
 *  a `binding` is anything else a name stands for (a parameter, an awaited
 *  landing, an extracted node) — real, but not a record we draw. */
export type StoryEndpoint =
  | { kind: 'record'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'binding'; ref: StoryRef };

/** The address a display label is resolved from — an adapter's own slug, its
 *  instance, and the type it declared. Opaque, all three. */
export interface StoryTarget {
  adapterType?: string;
  instance?: string;
  recordType?: string;
}

/**
 * WHAT a name stood for, as the checker typed it — the fact a reader needs in
 * order to be told "the email's Subject" instead of `m.\`Subject\``.
 *
 * Every variant carries only declared strings or ids into this IR; the words
 * ("the", "it just created") are composed at the far end, out of a label the
 * owning system declared. Its ABSENCE is a real answer: nothing resolved, so
 * the reference stays exactly as the author wrote it rather than being given a
 * phrase nobody could check.
 *
 */
export type StoryOrigin =
  /** A movement parameter — what came in. */
  | { kind: 'event'; target: StoryTarget }
  /** A landing in a system: a traversal alias, a selected position. */
  | { kind: 'landing'; target: StoryTarget }
  /** A record this very flow wrote — the reader watched it happen. */
  | { kind: 'record'; record: string }
  /** Something an extraction picked out. `entity` is the name the AUTHOR gave
   *  the node; its absence is the synthetic root, which nobody named — so the
   *  phrase for it is about the extraction, never about a made-up noun. */
  | { kind: 'extracted'; entity?: string }
  /** What a person answered, at an ask's pause. */
  | { kind: 'answer' }
  /** The value another movement came back with. */
  | { kind: 'call'; movement: string }
  /**
   * A deferred action the flow set up — `yes = callback({ … })`. It belongs to
   * no system, so no label can be resolved for it and the only noun there is is
   * the one the AUTHOR chose. That is the same answer an extraction's named
   * entity gives, and it is carried here for the same reason: a phrase composed
   * out of it is the author's own word, not one this pass invented.
   *
   */
  | { kind: 'callback'; name: string };

/**
 * One name READ inside an expression, with what it refers to.
 *
 * `source` is always the author's own text for this reference — it is what the
 * reader sees on hover, and what they see INSTEAD of a phrase when `origin` is
 * absent. `field` is the declared field read off the referent, verbatim.
 *
 * `ambiguous` is the honesty valve: a phrase composed from declared labels
 * ("the Companies it just created") stops identifying anything the moment two
 * names in scope would compose the same one, so the projection says so and the
 * renderer shows the name as well. Guessing which one was meant is the one
 * thing it must not do.
 */
export interface StoryReference {
  source: string;
  root: StoryRef;
  /**
   * The WALK from the root, when the reference is a path rather than a plain
   * read (`n-[:Attendees]->.\`Name\``). Exactly the hops a for-each header
   * carries, so the same declared labels compose the same kind of sentence —
   * "each Attendee's Name" — instead of the path's syntax leaking into a card.
   *
   */
  path?: StoryHop[];
  field?: string;
  origin?: StoryOrigin;
  ambiguous?: boolean;
}

/**
 * A piece of an expression, split AT THE AST.
 *
 * A template (`"Pursue ${m.\`Subject\`}?"`) is a `concat` node whose parts the
 * parser already separated; splitting it here is reading that structure, never
 * scanning the text for `${`. `expression` is the escape hatch with its honesty
 * intact: an interpolated piece that is not a plain reference is shown WHOLE,
 * as the author wrote it, rather than flattened into the sentence.
 */
export type ChipPart =
  | { kind: 'text'; text: string }
  | { kind: 'reference'; reference: StoryReference }
  /** A piece shown WHOLE, as the author wrote it. `refs` are the names visible
   *  inside that text — the raw names a reader is left to make sense of, which
   *  is what tells their introduction sites to show an alias. */
  | { kind: 'expression'; source: string; refs: StoryRef[] }
  /**
   * A test the author wrote (`m.\`Subject\` == "urgent"`). The OPERATOR travels
   * as the language's own token and nothing else: the words for it ("is", "is
   * more than") are the renderer's, exactly as a traversal filter's already
   * are. Without this a condition — the most-read chip on the canvas — stayed
   * pure syntax while everything around it had learned to read.
   */
  | { kind: 'test'; operator: FilterOperator; subject: ChipPart[]; against: ChipPart[] }
  /** `a AND b` / `a OR b`, in the order they were written. */
  | { kind: 'group'; joiner: 'and' | 'or'; of: ChipPart[][] }
  | { kind: 'not'; of: ChipPart[] }
  /**
   * A stdlib call OVER A WALK — `FIRST(team-[c:Channels WHERE \`Name\` == "…"]->)`.
   *
   * The walk is the same STRUCTURE a for-each header carries, so it composes the
   * same sentence out of the same declared labels; what the call adds is the
   * word for what it does to that walk, and that word is the renderer's, exactly
   * as a comparison's "is more than" already is. Without this the whole thing
   * was one raw expression chip: a sentence's worth of declared vocabulary,
   * hidden behind a function name.
   *
   * `fn` is the language's own function id — compared, never parsed. `source` is
   * the author's text, for a call this page has no word for: it is shown whole
   * rather than half-composed.
   *
   */
  | { kind: 'walk'; fn: string; source: string; traversal: StoryTraversal };

/**
 * One authored expression, as the unit of legibility. `source` is the text the
 * author wrote, verbatim; `role` says how to render it; `refs` are the names it
 * reads, resolved; `parts` is the same expression split at the AST, so a
 * renderer can print the literal text and the referents separately.
 *
 * `unparsed` is not in the plan's list and is deliberate: an expression the
 * bridge cannot parse (only reachable in a program that is already invalid) is
 * NOT a literal, and labelling it one would be the story quietly claiming a
 * fact it does not have.
 */
export interface Chip {
  source: string;
  role: 'literal' | 'interpolation' | 'ai' | 'reference' | 'unparsed';
  refs: StoryRef[];
  parts: ChipPart[];
}

/**
 * A traversal, projected as STRUCTURE.
 *
 * A traversal is the one authored form whose text is pure syntax —
 * `chat-[ch:Channels WHERE \`Name\` == "dealflow"]->` says nothing to anyone
 * who does not know the language. So it is the one form that never travels as a
 * chip: the hops, the landings and the filter's comparisons are carried apart,
 * and the sentence is composed at the far end out of declared words.
 *
 * `source` is the path as written. It is here for the case where there IS no
 * structure — a head that did not parse, in a program that is already invalid —
 * so the renderer can show what the author wrote instead of showing nothing.
 *
 */
export interface StoryTraversal {
  /** Stable id, from where the head was written — the key a resolved view hangs
   *  its display vocabulary on, exactly as a record's id does. */
  id: string;
  source: string;
  /** The name the walk starts from, resolved. Absent when the walk starts at
   *  an EXPRESSION — there is no binding to resolve, and `rootExpression`
   *  carries what the author wrote instead. */
  root?: StoryRef;
  /** The EXPRESSION the walk starts from (`AT(rows, 0)-[c:company]->`), as its
   *  own chip: the text the author wrote, plus the bindings it reads. Set
   *  instead of `root`, never alongside it. */
  rootExpression?: Chip;
  /**
   * What it starts FROM, as the checker typed it: `graph` fans out over records
   * that live in a system; `result` continues from what an earlier step produced
   * (a race receipt, an awaited answer). Absent ⇒ the root did not type.
   */
  from?: 'graph' | 'result';
  hops: StoryHop[];
}

export interface StoryHop {
  /** The name each landing is bound to (`ch` in `-[ch:Channels]->`). */
  binding?: string;
  /** The declared edge / collection name. Opaque. */
  edge: string;
  /** Where the hop lands, as the checker resolved it — the address a display
   *  label is resolved from downstream. Absent ⇒ the walk could not type it. */
  landing?: { adapterType?: string; instance?: string; recordType?: string };
  filter?: StoryFilter;
}

/**
 * A hop's WHERE. `comparisons` is the shape a sentence can be composed from —
 * a conjunction of field-against-value tests, each of which reads as a clause.
 * Anything else (an OR, a NOT, a nested EXISTS) is carried WHOLE as one
 * expression chip: it is still the author's filter, shown honestly, rather than
 * a simplification that would quietly claim the wrong thing.
 */
export type StoryFilter =
  | { kind: 'comparisons'; all: StoryComparison[] }
  | { kind: 'expression'; chip: Chip };

export interface StoryComparison {
  /** The declared field name. Opaque. */
  field: string;
  operator: FilterOperator;
  value: Chip;
}

export type StoryValidityStatus = 'valid' | 'invalid' | 'unverified';

export interface StoryProblem {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  span: Span;
}

/** Render the truth: the story always carries its own validity, so a page can
 *  never show an invalid program as though it were live. */
export interface StoryValidity {
  status: StoryValidityStatus;
  problems: StoryProblem[];
}

/** A constructed instance — the binding a listen or a write names, and the
 *  adapter type behind it. Both are declared strings; neither is interpreted. */
export interface StoryInstance {
  name: string;
  adapterType?: string;
  declaredAt: Span;
}

/** What starts the automation. Everything about the system is opaque: the
 *  adapter type, the event kinds, the narrowing keys and their values. */
export interface StoryTrigger {
  id: string;
  instance: StoryRef;
  adapterType?: string;
  /** The event kinds subscribed to. Absent ⇒ nobody published a selection. */
  events?: string[];
  /** The address this listener subscribes to — declared keys, declared values. */
  narrowing: Record<string, string>;
  /** The event position types the listen derives, by their address key. */
  eventTypes: Array<{ key: string; display?: string }>;
  /** The movement this fires, by name; `firesMovement` is whether that name
   *  resolved to one. */
  fires: string;
  firesMovement: boolean;
  /** The lane name from `listen as "…"`. */
  lane?: string;
  at: Span;
}

/**
 * One row of the record graph — deliberately the shape of an inspectRun write
 * row (`{binding, target, action, values}`), with authored expressions where a
 * run has resolved values, so the static page and the run page rhyme.
 */
export interface StoryRecord {
  id: string;
  binding?: string;
  target: { adapterType?: string; instance?: string; recordType?: string };
  /** `find` is a `match`: identified, never written. */
  action: 'create' | 'update' | 'find';
  fields: Record<string, Chip>;
  /** Per-field write precedence, where the author set one (`?:`, `+:`, `+?:`). */
  fieldModes: Record<string, 'fill' | 'append' | 'append-missing'>;
  uniqueBy: Chip[];
  at: Span;
}

export interface StoryEdge {
  from: StoryEndpoint;
  to: StoryEndpoint;
  /** The declared edge name. Opaque. */
  edge: string;
  kind: 'parent' | 'link' | 'response';
}

/**
 * The extraction tree, projected WHOLE: the outward shape per node, the working
 * fields kept separate, children as the tree's edges — so a renderer can show
 * what is actually being looked for rather than a list of names.
 *
 * `description` on both a node and a field is the author's own sentence, the
 * very text the extraction is given. It is the only human-readable thing in the
 * tree; carrying names alone would leave a reader to guess what `stage` means.
 * The root declares none — it is synthetic, so nobody described it.
 */
export interface StoryExtractNode {
  name: string;
  description?: string;
  fields: Array<{ name: string; description?: string; type?: SchemaFieldType; at: Span }>;
  children: StoryExtractNode[];
}

export type StoryWait =
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string; condition?: Chip }
  /**
   * An awaited edge that is not an ask's resolution — waiting on something to
   * turn up, with no record of ours to show.
   *
   * `origin` is WHAT is being waited on, as the checker typed it: the same fact
   * a reference to that name carries, so a wait on a deferred action can be
   * said in the words that action is said in everywhere else. Two race lanes
   * waiting on two different callbacks otherwise read as the same sentence,
   * which names neither.
   *
   */
  | { kind: 'edge'; on?: StoryEndpoint; edge?: string; origin?: StoryOrigin };

/**
 * A node the author ASSEMBLED — `node { Name: c.name, … }`, written inline as a
 * call argument or bound to a name.
 *
 * It belongs to no system, so there is no label to resolve and no action to
 * report; what there IS, is exactly what a written record has and what a reader
 * came to see: the fields and what fills them. Carrying only "a node was bound
 * here" is what made the renderer say "Sets aside lead for later" and show
 * nothing of the lead.
 *
 */
export interface StoryNode {
  fields: Record<string, Chip>;
  /** Nested literals, by the entry that declares them — a synthesised edge. */
  children: Array<{ name: string; nodes: StoryNode[] }>;
}

/**
 * One argument of a call. A call's arguments are not all values: the language
 * lets a POSITION be passed (an assembled node, a written record, another
 * movement's value), and rendering only the value-shaped ones is what made an
 * inline `node { … }` argument disappear from the picture entirely.
 */
/** `name` is the parameter the argument binds — written by the author for a
 *  named argument, and the declaration's for a positional one (its place in
 *  the call, from 1, where the callee's signature is unknown). */
export type StoryArg = { name: string } & (
  | { kind: 'value'; chip: Chip }
  | { kind: 'node'; node: StoryNode }
  | { kind: 'record'; record: string }
  | { kind: 'call'; movement: string }
);

export interface StoryParam {
  name: string;
  /** The type as authored: the graph name plus the hop chain. Declared
   *  strings; the story never resolves an address into a name. ABSENT where
   *  the author wrote none — a collection op's function takes its parameter's
   *  type from the collection, so there is nothing authored to render. */
  type?: { graph: string; position?: string; hops?: string };
  /** A VALUE type the author spelled in full (`text[]`, `{ mode: text }`) —
   *  it names no graph, so it rides here instead of `type`. */
  valueType?: string;
  /**
   * WHAT the annotation resolved to, as the checker typed it — the same address
   * a reference's origin carries, so a parameter's shape is read out of the
   * same vocabulary join everything else is. Absent where nothing resolved,
   * which is the honest answer: the reader is then told the parameter's name
   * and nothing more.
   */
  target?: StoryTarget;
}

/**
 * A node DECLARED IN THE FILE — `node CallSource { text: <text>  node file { … } }`.
 *
 * It is the author's own vocabulary, so it travels in the story rather than
 * being resolved downstream: no adapter declared these words and no manifest
 * can look them up. Two things read them — a parameter typed `<CallSource>`
 * says what it takes, and a landing inside one is NAMED by the node's own name
 * rather than by the address the type system knows it as.
 *
 * `position` is that address, COMPOSED exactly as the schema composes it
 * (`shapeToSchema`: a child's key is its parent's key plus its own name).
 * Downstream it is only ever compared — taking `CallSource.file` apart to find
 * `file` would be parsing a key, which is the one thing this language's naming
 * rule forbids.
 *
 */
export interface StoryShapeNode {
  /** The author's own word for this node: the declaration's name at the root,
   *  the edge's name for a child. */
  name: string;
  position: string;
  /** `type` is absent where the annotation is not one of the language's own
   *  field types — nothing is guessed about what such a field holds. */
  fields: Array<{ name: string; type?: SchemaFieldType }>;
  children: StoryShapeNode[];
}

/**
 * The ordered, nested flow. Pauses (`ask`, `wait`) and branches are STEP KINDS,
 * not separate top-level lists — the mission's `{pauses, branches}` fold in
 * here, because that is where the author put them.
 */
/**
 * A movement's effect row, projected. Identity in the checker's row is the
 * graph TOKEN; a renderer needs something it can print and a reader can find in
 * the source, so `reads`/`writes` are the instances' BINDING names — the same
 * convention every other address in the story follows.
 *
 * `partial` says the row is a lower bound: a callee or a site the checker could
 * not see. A renderer must not turn an empty partial row into "does nothing".
 */
export interface StoryEffects {
  reads: string[];
  writes: string[];
  ai: boolean;
  now: boolean;
  suspend: boolean;
  partial: boolean;
}

export type Step =
  /** A movement declaration, with its body. A file may declare several (one
   *  fired, the rest utilities), so the flow keeps them rather than inventing
   *  an entry point the program never named. Triggers say which is fired.
   *
   *  `terminates` is the checker's own `terminates()` over the body — the same
   *  fact an arm carries, from the same source. A renderer that wants to draw
   *  where a run ENDS asks for it rather than re-deriving it, which is how the
   *  arm caps stayed in step with the language. */
  | {
      kind: 'movement';
      name: string;
      params: StoryParam[];
      steps: Step[];
      terminates: boolean;
      /** What running it may do — the checker's inferred effect row, projected
       *  for display (see `StoryEffects`). */
      effects: StoryEffects;
      at: Span;
    }
  | { kind: 'write'; record: string; at: Span }
  /** `match`: a record FOUND by identity — a row of the graph (action
   *  `find`), never written. On a miss, since language version 4 the run
   *  carries on with the binding absent; before 4 the rest of its scope ran
   *  only when found. */
  | { kind: 'match'; record: string; binding?: string; at: Span }
  | { kind: 'link'; edge: string; from: StoryEndpoint; to: StoryEndpoint; at: Span }
  | { kind: 'unlink'; edge: string; from: StoryEndpoint; to: StoryEndpoint; at: Span }
  | { kind: 'extract'; binding?: string; from: Chip[]; tree?: StoryExtractNode; at: Span }
  /** The pause an ask makes: the record raised, and the edge whose resolution
   *  resumes the run. Which of the record's declared fields is the question is
   *  the ADAPTER's to say — the core never names one. */
  | { kind: 'ask'; record?: string; edge?: string; binding?: string; at: Span }
  | { kind: 'wait'; wait: StoryWait; binding?: string; at: Span }
  | {
      kind: 'branch';
      /** `terminates` is the checker's own `terminates()` over the arm's
       *  authored body — the SAME fact the checker used to narrow below the
       *  `if`, projected rather than re-derived. A renderer that recomputed
       *  this from the Step tree would be a second implementation of the
       *  language's termination rule, and the two would drift the day the
       *  language gains another terminator. */
      arms: Array<{ condition: Chip; steps: Step[]; terminates: boolean; at: Span }>;
      otherwise?: { steps: Step[]; terminates: boolean; at: Span };
      at: Span;
    }
  | {
      kind: 'race';
      /** Which combinator — one lane shape, two settling rules: `race` takes
       *  the first arm to settle, `parallel` waits for all of them. */
      combinator: 'race' | 'parallel';
      /** One lane per ARM, in the order written — the same order the receipt's
       *  slots are in, which is what makes a lane readable against a slot.
       *  A lane written as a closure carries its steps; a lane that is only a
       *  NAME carries the name and no steps (its body is that movement's own
       *  story). `terminates()` is generic over any statement list, so an arm
       *  body qualifies exactly as an `if` arm's does. */
      branches: Array<{
        steps: Step[];
        terminates: boolean;
        arm?: string;
        at: Span;
      }>;
      binding?: string;
      at: Span;
    }
  /** A traversal-headed block — the steps inside run once per landing. */
  | { kind: 'group'; over: StoryTraversal; binding?: string; steps: Step[]; at: Span }
  | {
      kind: 'call';
      movement: string;
      isMovement: boolean;
      args: StoryArg[];
      binding?: string;
      at: Span;
    }
  | { kind: 'delete'; subject: StoryRef; at: Span }
  | { kind: 'refresh'; subject: StoryRef; at: Span }
  | { kind: 'error'; message: Chip; at: Span }
  /** A plain value binding. */
  | { kind: 'value'; binding: string; value: Chip; at: Span }
  /** A node the author assembled and named. */
  | { kind: 'node'; binding: string; node: StoryNode; at: Span }
  /**
   * A DEFERRED ACTION — `yes = callback({ … })`.
   *
   * Not a value being set aside, which is what it used to project as: it is a
   * thing somebody can act on later, and the steps inside it are what happens
   * when they do. So it carries its body the way every other nesting construct
   * does — as `steps`, projected by the same walk — and a renderer draws them
   * without knowing what a callback is.
   *
   * `movement` is the other subject form (`callback(send_reminder)`), where the
   * work deferred is a movement the file declares rather than a body written
   * here; `steps` is then empty, which is the truth about this site rather than
   * a summary of one somewhere else. An INLINE body may also be empty — the
   * minimal confirm pattern — and that is the same shape saying the same thing.
   *
   */
  | {
      kind: 'callback';
      binding: string;
      steps: Step[];
      movement?: string;
      at: Span;
    }
  /** A name bound to something the flow shows no richer form for (an inline
   *  block). Says what it is; claims no more.
   *
   *  A COLLECTION OP says the two things it can say without opening the
   *  function: which op it is (`op`) and what it ran over (`over`). The body
   *  stays where every function's body is — shown where it is called — but the
   *  card stops reading as an anonymous "sets this aside".
   *
   *  `binding` is absent for a collection op run BARE, as a statement — `MAP`
   *  in particular, whose function may run for its own effects and answer
   *  nothing anyone reads. */
  | { kind: 'bind'; binding?: string; of: RValue['kind']; op?: CollectionOp; over?: Chip; at: Span }
  /**
   * `return <value>` — the body handing its value back. `value` is the chip
   * when the returned expression has one; `of` says what kind of thing was
   * returned otherwise. A `return` of an EFFECT (a write, a call, a link, a
   * block) projects as that effect instead, so nothing a movement does can
   * hide behind a return.
   */
  | { kind: 'return'; value?: Chip; of: RValue['kind']; at: Span };

export interface StoryIR {
  movement: { name?: string; validity: StoryValidity };
  instances: StoryInstance[];
  triggers: StoryTrigger[];
  flow: Step[];
  records: StoryRecord[];
  edges: StoryEdge[];
  /** The node declarations the file makes, as trees. */
  shapes: StoryShapeNode[];
}

/** Unparseable source yields no story — never a partial guess. */
export type StoryResult =
  | { ok: true; story: StoryIR }
  | { ok: false; reason: 'unparseable'; problems: StoryProblem[] };

// ── Entry points ──

export interface StoryInput {
  source: string;
  catalog: Catalog;
  /** The automation's name, as the platform knows it. The program does not
   *  carry one. */
  name?: string;
  /**
   * The platform's own validity ruling, when it has one — it knows about
   * things the checker cannot see (an adapter whose schema could not be
   * fetched, so nothing was actually verified). Absent ⇒ derived from the
   * diagnostics: any error ⇒ `invalid`.
   */
  validityStatus?: StoryValidityStatus;
  resolveFile?: ResolveFile;
  /** The saved movement's pin. Absent ⇒ the current version. */
  languageVersion?: LanguageVersion;
}

/**
 * Parse, check with recording on, and project. The whole pass is a pure
 * function of the source and the catalog.
 */
export function storyOf(input: StoryInput): StoryResult {
  let program: Program;
  try {
    program = parseProgram(
      input.source,
      input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : undefined,
    );
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    const span: Span = { start: e.loc, end: e.loc };
    return {
      ok: false,
      reason: 'unparseable',
      problems: [{ code: 'MOV_PARSE', message: e.message, severity: 'error', span }],
    };
  }
  const { diagnostics, recording } = checkProgramWithLink(program, input.catalog, {
    recordAnalysis: true,
    ...(input.resolveFile ? { resolveFile: input.resolveFile } : {}),
    ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
  });
  return {
    ok: true,
    story: projectStory({
      program,
      // `recordAnalysis: true` always returns one; the fallback keeps the
      // projection total rather than asserting.
      recording: recording ?? { frames: [], writes: [], nodes: [] },
      diagnostics,
      languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.validityStatus !== undefined ? { validityStatus: input.validityStatus } : {}),
    }),
  };
}

export interface ProjectStoryInput {
  program: Program;
  recording: CheckRecording;
  diagnostics: Diagnostic[];
  /** The version the program was checked under — termination is version-dependent
   *  (`return` leaves an arm from version 3), so the story asks the same rule. */
  languageVersion: LanguageVersion;
  name?: string;
  validityStatus?: StoryValidityStatus;
}

/** The projection itself, for a caller that has already checked the program. */
export function projectStory(input: ProjectStoryInput): StoryIR {
  return new Projection(input).run();
}

// ── Projection ──

function spanKey(span: Span): string {
  return `${span.start.line}:${span.start.col}-${span.end.line}:${span.end.col}`;
}

/** A record's id — derived from where it is WRITTEN, so it is stable across
 *  projections of the same source and unique by construction. */
function recordId(span: Span): string {
  return `rec:${span.start.line}:${span.start.col}`;
}

function triggerId(span: Span): string {
  return `trg:${span.start.line}:${span.start.col}`;
}

function traversalId(span: Span): string {
  return `trv:${span.start.line}:${span.start.col}`;
}

/**
 * A filter as a CONJUNCTION OF SIMPLE COMPARISONS — a field tested against a
 * value, ANDed — or nothing, when it is any other shape.
 *
 * The judgement has to be exact: a filter that is nearly this shape is not this
 * shape. An OR reads "where A and B" if flattened, which is the opposite of
 * what the author wrote; a NOT reads as its own negation. So anything that is
 * not literally a conjunction of `field <op> value` tests answers `undefined`
 * and is shown whole instead.
 */
function simpleComparisons(
  expr: Expression,
): Array<{ field: string; operator: FilterOperator; value: Expression }> | undefined {
  if (expr.type === 'logical' && expr.op === 'and') {
    const all: Array<{ field: string; operator: FilterOperator; value: Expression }> = [];
    for (const operand of expr.operands) {
      const part = simpleComparisons(operand);
      if (part === undefined) return undefined;
      all.push(...part);
    }
    return all;
  }
  if (expr.type !== 'compare') return undefined;
  if (expr.left.type !== 'property' && expr.left.type !== 'edge_property') return undefined;
  return [{ field: expr.left.propertyTypeId, operator: expr.op, value: expr.right }];
}

/**
 * A deep structural search for an expression node of a given type. Generic on
 * purpose: the expression union grows, and a hand-written visitor would answer
 * `false` for anything added after it was written — a silence indistinguishable
 * from a real answer.
 */
function containsExpressionType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) return value.some((v) => containsExpressionType(v, type));
  if (value !== null && typeof value === 'object') {
    if ((value as { type?: unknown }).type === type) return true;
    return Object.values(value).some((v) => containsExpressionType(v, type));
  }
  return false;
}

function rawPath(head: PathHead): string {
  return spellPathHead(head);
}

/**
 * A NAME READ — the only expression shape that reduces to a referent: a bare
 * name (`answer`), or a name with one declared field off it (`m.\`Subject\``).
 *
 * The bar is deliberately this low. An alias-rooted WALK, an index, a function
 * call all read a name too, but a phrase for them would have to leave out the
 * walking — so they are not reads, and the author's own text stands.
 */
function nameRead(expr: Expression): { name: string; field?: string } | undefined {
  if (expr.type === 'alias_ref') return { name: expr.name };
  // A bare name in VALUE position parses as a property read of the ambient
  // context; the checker resolves it against scope, so the story does too.
  if (expr.type === 'property') return { name: expr.propertyTypeId };
  if (expr.type !== 'traverse') return undefined;
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return undefined;
  if (expr.expression.type !== 'property') return undefined;
  return { name: expr.aliasRoot, field: expr.expression.propertyTypeId };
}

/** The extraction node a type stands on, through the absence wrapper. */
function extractNodeOf(type: PositionTypeRef): ExtractNodeType | undefined {
  if (type.kind === 'extract') return type.node;
  if (type.kind === 'maybeEmpty') return extractNodeOf(type.of);
  return undefined;
}

/**
 * WHERE a type sits, as the pair a display label is looked up by. Only the
 * kinds that HAVE a place answer: a checker-local node belongs to no system, a
 * block meta and a race receipt are structures rather than positions, and
 * saying nothing for them is what keeps their references honest.
 */
function positionAddress(
  type: PositionTypeRef,
): { instance?: string; recordType?: string } | undefined {
  switch (type.kind) {
    case 'position':
      return { instance: type.instance.name, recordType: type.position };
    case 'union':
      return { instance: type.instance.name, recordType: type.union };
    case 'handle':
      return {
        instance: type.instance.name,
        ...(type.position !== undefined ? { recordType: type.position } : {}),
      };
    case 'meta':
      return { instance: type.instance.name };
    case 'maybeEmpty':
      return positionAddress(type.of);
    case 'extract':
    case 'closure':
    case 'local':
      return undefined;
  }
}

function typeRefOf(type: TypeRef | undefined): StoryParam['type'] {
  if (type === undefined) return undefined;
  return {
    graph: type.graph,
    ...(type.position !== undefined ? { position: type.position } : {}),
    ...(type.hopsRaw !== undefined ? { hops: type.hopsRaw } : {}),
  };
}

/**
 * One node declaration, as a tree. `position` is composed on the way down — the
 * same composition `shapeToSchema` makes, so the two agree by construction
 * rather than by a comparison nobody runs.
 */
function shapeNodeOf(node: ShapeNode, position: string): StoryShapeNode {
  return {
    name: node.name,
    position,
    fields: node.fields.map((field) => {
      // Said as written: `<text | null>` shows as text, or nothing.
      const named = parseFieldTypeName(field.type);
      const type = field.nullable ? maybeAbsent(named) : named;
      return { name: field.name, ...(type !== undefined ? { type } : {}) };
    }),
    children: node.children.map((child) => shapeNodeOf(child, `${position}.${child.name}`)),
  };
}

class Projection {
  private readonly writes = new Map<string, RecordedWrite>();
  private readonly nodes = new Map<string, RecordedNode>();
  /** Record id by the BINDING that holds it — how a parent path's root, an
   *  awaited ask handle, or a link endpoint finds the record it names. */
  private readonly recordByBinding = new Map<string, string>();
  /** Names bound by an ask's await — what a person answered. Flow order, like
   *  `recordByBinding`, and for the same reason: the fact is made by the step,
   *  not by the type. */
  private readonly answerBindings = new Set<string>();
  /** Names bound to a deferred action. Flow order, for the same reason the two
   *  above are: `callback` is a thing the FLOW does, not a type a name has. */
  private readonly callbackBindings = new Set<string>();
  /** Traversals walked inside an expression, by the slot they were written in
   *  and the chain they walk — a slot can hold more than one. */
  private readonly valuePaths = new Map<string, RecordedValuePath>();
  /** A stable id per recorded value path, in recording order — the key a
   *  resolved view hangs a walk's display vocabulary on, exactly as a head's
   *  own span-derived id does. A slot can hold two walks, so the span alone
   *  would not tell them apart. */
  private readonly valuePathIds = new Map<string, string>();
  /** Names bound to a call's value, by the movement called. */
  private readonly callBindings = new Map<string, string>();
  private readonly records: StoryRecord[] = [];
  private readonly edges: StoryEdge[] = [];
  private readonly instances: StoryInstance[] = [];
  private readonly triggers: StoryTrigger[] = [];

  constructor(private readonly input: ProjectStoryInput) {
    for (const write of input.recording.writes) {
      this.writes.set(spanKey(write.span), write);
    }
    for (const node of input.recording.nodes) {
      this.nodes.set(`${node.kind}:${spanKey(node.span)}`, node);
      if (node.kind === 'valuePath') {
        const key = `${spanKey(node.span)}|${node.key}`;
        if (!this.valuePaths.has(key)) {
          this.valuePaths.set(key, node);
          this.valuePathIds.set(key, `trv:${this.valuePathIds.size}:${spanKey(node.span)}`);
        }
      }
    }
  }

  /** What leaves an `if` arm — the checker's own rule for this version, so a
   *  lane is capped exactly where the checker narrows below the `if`. */
  private armExits(): Exits {
    return bodyExits(this.input.languageVersion);
  }

  run(): StoryIR {
    for (const node of this.input.recording.nodes) {
      if (node.kind === 'instance') this.addInstance(node);
    }
    const flow = this.steps(this.input.program.statements);
    // After the flow walk: a listen is a file-level statement, so the trigger
    // rows are complete either way, but the record ids they could reference are
    // not until the walk has assigned them.
    for (const node of this.input.recording.nodes) {
      if (node.kind === 'listen') this.addTrigger(node);
    }
    return {
      movement: {
        ...(this.input.name !== undefined ? { name: this.input.name } : {}),
        validity: this.validity(),
      },
      instances: this.instances,
      triggers: this.triggers,
      flow,
      records: this.records,
      edges: this.edges,
      shapes: this.shapes(),
    };
  }

  /** The file's node declarations. File-level statements, so this is a sweep of
   *  the program rather than part of the flow walk. A declaration that extends
   *  another is shown whole — the tree the checker resolved, its base's members
   *  first — since that is what a `<Recap Entry>` carries. */
  private shapes(): StoryShapeNode[] {
    const file = this.input.recording.frames[0]?.scope;
    const shapes: StoryShapeNode[] = [];
    for (const statement of this.input.program.statements) {
      if (statement.kind !== 'shape') continue;
      const symbol = file?.symbols.get(statement.name);
      const resolved =
        symbol?.kind === 'shape' && sameSpan(symbol.span, statement.span) ? symbol.declaration : undefined;
      shapes.push(shapeNodeOf((resolved ?? statement).root, statement.name));
    }
    return shapes;
  }

  private validity(): StoryValidity {
    const problems: StoryProblem[] = this.input.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      severity: diagnosticSeverity(d),
      span: d.span,
    }));
    // An error diagnostic carries NO explicit severity — filtering on
    // `severity === 'error'` would pass vacuously, which is exactly how this
    // check has been got wrong before.
    const status: StoryValidityStatus =
      this.input.validityStatus
      ?? (problems.some((p) => p.severity === 'error') ? 'invalid' : 'valid');
    return { status, problems };
  }

  private addInstance(node: RecordedInstance): void {
    this.instances.push({
      name: node.name,
      ...(node.adapterType !== undefined ? { adapterType: node.adapterType } : {}),
      declaredAt: node.span,
    });
  }

  private adapterTypeOf(instanceName: string | undefined): string | undefined {
    if (instanceName === undefined) return undefined;
    return this.instances.find((i) => i.name === instanceName)?.adapterType;
  }

  private addTrigger(node: RecordedListen): void {
    const listen = this.listenAt(node.span);
    this.triggers.push({
      id: triggerId(node.span),
      instance: this.ref(node.instance, node.scope),
      ...(node.adapterType !== undefined ? { adapterType: node.adapterType } : {}),
      ...(node.events !== undefined ? { events: [...node.events] } : {}),
      narrowing: { ...node.narrowing },
      eventTypes: node.eventTypes.map((t) => ({ ...t })),
      fires: node.fires,
      firesMovement: node.firesMovement,
      ...(listen?.alias !== undefined ? { lane: listen.alias } : {}),
      at: node.span,
    });
  }

  /** The listen declaration at a span — for the surface facts the checker had
   *  no reason to record (the lane alias). */
  private listenAt(span: Span): ListenDeclaration | undefined {
    const key = spanKey(span);
    for (const statement of this.input.program.statements) {
      if (statement.kind === 'listen' && spanKey(statement.span) === key) return statement;
    }
    return undefined;
  }

  // ── Names and expressions ──

  private ref(name: string, scope: Scope): StoryRef {
    const resolution = scope.resolve(name);
    return resolution.kind === 'found'
      ? { name, declaredAt: resolution.symbol.span }
      : { name };
  }

  /** A name as a graph endpoint: the record it holds, when it holds one. */
  private endpoint(name: string, scope: Scope): StoryEndpoint {
    const record = this.recordByBinding.get(name);
    return record !== undefined
      ? { kind: 'record', id: record }
      : { kind: 'binding', ref: this.ref(name, scope) };
  }

  private chip(slot: ExprSlot, scope: Scope): Chip {
    const source = slot.raw.trim();
    let parsed: Expression;
    try {
      parsed = expressionOfSlot(slot);
    } catch {
      return { source, role: 'unparsed', refs: [], parts: [{ kind: 'text', text: source }] };
    }
    return this.chipOf(parsed, source, scope, slot.span);
  }

  /**
   * A traversal head as a chip.
   *
   * A pass-through entry (`company: found-[c:company]->`) takes its values from
   * somewhere else entirely, and where FROM is the whole content of the entry.
   * That is a referent like any other — the checker's own hops and landings,
   * composed by the same rule a walk written inline gets — so a card reads as
   * the things the walk lands on rather than as the path's syntax.
   *
   * A head the checker never typed, or one carrying a WHERE, has nothing a
   * phrase could be composed from without leaving part of it out, and stays
   * exactly as the author wrote it.
   */
  private pathChip(head: PathHead, scope: Scope): Chip {
    const source = rawPath(head);
    const walked = this.traversal(head, scope);
    const composable =
      walked.root !== undefined
      && walked.hops.length > 0
      && !walked.hops.some((hop) => hop.filter !== undefined);
    const rootName = pathRootName(head);
    const origin = rootName !== undefined ? this.origin(rootName, scope) : undefined;
    return {
      source,
      role: 'reference',
      // An expression root reads whatever names ARE inside it — its own chip
      // already resolved them, so the head refers to exactly those.
      refs:
        rootName !== undefined
          ? [this.ref(rootName, scope)]
          : (walked.rootExpression?.refs ?? []),
      parts:
        composable && walked.root !== undefined
          ? [
              {
                kind: 'reference',
                reference: {
                  source,
                  root: walked.root,
                  path: walked.hops,
                  ...(origin !== undefined ? { origin } : {}),
                },
              },
            ]
          : [{ kind: 'text', text: source }],
    };
  }

  /**
   * An expression the AUTHOR wrote inside a bigger one — a filter's comparand.
   * There is no span to slice the source at, so the text comes from the
   * compiler's own printer over the parsed expression: still derived from
   * structure, never re-read off the syntax.
   */
  private chipOfExpression(expr: Expression, scope: Scope): Chip {
    return this.chipOf(expr, serialize(expr, (id) => id), scope);
  }

  private chipOf(parsed: Expression, source: string, scope: Scope, slot?: Span): Chip {
    const refs = this.namesIn(parsed, scope);
    const role: Chip['role'] =
      containsExpressionType(parsed, 'llm') ? 'ai'
      : containsExpressionType(parsed, 'concat') ? 'interpolation'
      : refs.length > 0 ? 'reference'
      : 'literal';
    return { source, role, refs, parts: this.parts(parsed, source, scope, slot) };
  }

  // ── Splitting an expression into what a reader can read ──

  /**
   * The chip's parts. A whole expression that IS one reference becomes one
   * referent; a template becomes its literal runs and its referents; a test
   * becomes its two sides and the operator between them. Every one of those
   * splits is a read of the shape the PARSER built — nothing here scans text
   * for `${` or for an operator.
   *
   * An expression of any other shape stays exactly as the author wrote it: one
   * text part carrying the verbatim source, which is what the chip has always
   * shown. Simplifying it would be the page saying something the script does
   * not.
   */
  private parts(
    parsed: Expression,
    source: string,
    scope: Scope,
    slot: Span | undefined,
  ): ChipPart[] {
    return this.split(parsed, scope, slot) ?? [{ kind: 'text', text: source }];
  }

  /** The parts of an expression whose shape has parts. `undefined` ⇒ it has
   *  none, and the caller decides what to show whole. */
  private split(expr: Expression, scope: Scope, slot: Span | undefined): ChipPart[] | undefined {
    const whole = this.reference(expr, scope, slot);
    if (whole !== undefined) return [{ kind: 'reference', reference: whole }];
    switch (expr.type) {
      case 'concat':
        return expr.parts.map((part) => this.templatePiece(part, scope, slot));
      // `AI("… ${x} …")` — the prompt is a template like any other, and the
      // chip already says it is an AI value, so the wrapper adds nothing.
      case 'llm':
        return expr.promptExpression !== undefined
          ? this.pieces(expr.promptExpression, scope, slot)
          : undefined;
      case 'compare':
        return [
          {
            kind: 'test',
            operator: expr.op,
            subject: this.pieces(expr.left, scope, slot),
            against: this.pieces(expr.right, scope, slot),
          },
        ];
      case 'logical':
        return [
          {
            kind: 'group',
            joiner: expr.op,
            of: expr.operands.map((operand) => this.pieces(operand, scope, slot)),
          },
        ];
      case 'not':
        return [{ kind: 'not', of: this.pieces(expr.expression, scope, slot) }];
      // `FIRST(chat-[:Channels WHERE …]->)` — a fold over a WALK. The walk is
      // the same structure a for-each header is written from, and it was
      // reaching the page as raw syntax purely because a function wrapped it.
      case 'aggregate': {
        const walk = this.walkPart(expr.fn, expr.expression, expr, scope, slot);
        return walk !== undefined ? [walk] : undefined;
      }
      case 'function': {
        const only = expr.args.length === 1 ? expr.args[0] : undefined;
        const walk =
          only === undefined ? undefined : this.walkPart(expr.fn, only, expr, scope, slot);
        return walk !== undefined ? [walk] : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * A stdlib call over a walk, as the CHECKER's own walk of it.
   *
   * Only where there is real structure to compose from: an argument that is a
   * path with hops, and a recording of where those hops landed. A call over
   * anything else — a plain value, a walk in a program the checker could not
   * get through — answers nothing, and the caller shows the author's own text,
   * which is the same honesty rule a bare path already follows.
   */
  private walkPart(
    fn: string,
    argument: Expression,
    whole: Expression,
    scope: Scope,
    slot: Span | undefined,
  ): ChipPart | undefined {
    if (slot === undefined) return undefined;
    if (argument.type !== 'traverse' || argument.steps.length === 0) return undefined;
    const traversal = this.valuePathTraversal(argument, scope, slot);
    if (traversal === undefined) return undefined;
    return { kind: 'walk', fn, source: serialize(whole, (name) => name), traversal };
  }

  /**
   * A path written as a VALUE, as a TRAVERSAL — the same row a block head
   * projects, from the recording the expression typer made as it walked.
   *
   * It carries no `from`: nothing records how a value path's root typed, and
   * saying "graph" because that is the common case would be the projection
   * claiming a fact it does not have. Nothing reads it here — a fold names its
   * own subject — so the silence costs nothing.
   */
  private valuePathTraversal(
    expr: Extract<Expression, { type: 'traverse' }>,
    scope: Scope,
    slot: Span,
  ): StoryTraversal | undefined {
    const key = `${spanKey(slot)}|${valuePathKey(expr.aliasRoot, expr.steps)}`;
    const recorded = this.valuePaths.get(key);
    const id = this.valuePathIds.get(key);
    if (recorded === undefined || id === undefined) return undefined;
    const hops = recorded.steps.flatMap((step, index) =>
      this.hop(step, recorded.landings[index], scope),
    );
    if (hops.length === 0) return undefined;
    return {
      id,
      source: serialize(expr, (name) => name),
      ...(recorded.root !== undefined ? { root: this.ref(recorded.root, scope) } : {}),
      hops,
    };
  }

  /** A nested expression: split where it splits, shown whole where it does not. */
  private pieces(expr: Expression, scope: Scope, slot: Span | undefined): ChipPart[] {
    return this.split(expr, scope, slot) ?? [this.piece(expr, scope, slot)];
  }

  private piece(expr: Expression, scope: Scope, slot: Span | undefined): ChipPart {
    const reference = this.reference(expr, scope, slot);
    if (reference !== undefined) return { kind: 'reference', reference };
    return {
      kind: 'expression',
      source: serialize(expr, (id) => id),
      refs: this.namesIn(expr, scope),
    };
  }

  /** The names an expression reads, resolved — its own hop aliases excluded,
   *  since those are bound inside it and never leak out. */
  private namesIn(expr: Expression, scope: Scope): StoryRef[] {
    const names = collectExpressionNames(expr);
    return [...new Set(names.refs)]
      .filter((name) => !names.aliases.has(name))
      .map((name) => this.ref(name, scope));
  }

  /** Inside a template a fixed run is the author's own PROSE, so it reads as
   *  words; anywhere else a fixed value is a value, and reads as one. */
  private templatePiece(expr: Expression, scope: Scope, slot: Span | undefined): ChipPart {
    if (expr.type === 'static') return { kind: 'text', text: `${expr.value ?? ''}` };
    const split = this.split(expr, scope, slot);
    return split?.length === 1 && split[0] !== undefined ? split[0] : this.piece(expr, scope, slot);
  }

  /**
   * One reference, if this expression is one: a bare name, or a name with a
   * field read off it. A read with any more structure in it than that (a walk,
   * an index, a call) is NOT reduced to a referent — it is shown whole, because
   * a phrase would leave out the very part that made it worth writing.
   */
  private reference(
    expr: Expression,
    scope: Scope,
    slot: Span | undefined,
  ): StoryReference | undefined {
    const read = nameRead(expr);
    if (read === undefined) return this.pathReference(expr, scope, slot);
    const origin = this.origin(read.name, scope);
    return {
      source: serialize(expr, (id) => id),
      root: this.ref(read.name, scope),
      ...(read.field !== undefined ? { field: read.field } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(origin !== undefined && this.ambiguous(read.name, scope, origin)
        ? { ambiguous: true }
        : {}),
    };
  }

  /**
   * A path written as a VALUE (`n-[:Attendees]->.\`Name\``), as the walk the
   * CHECKER did — hops and landings, never a re-reading of the syntax.
   *
   * Two cases stay raw on purpose. A hop with a WHERE carries a test that a
   * one-line phrase would have to leave out, and a walk nobody recorded (a
   * program the checker could not get through) has no structure to compose
   * from. Both show the author's own text, which is the honest answer.
   */
  private pathReference(
    expr: Expression,
    scope: Scope,
    slot: Span | undefined,
  ): StoryReference | undefined {
    if (slot === undefined) return undefined;
    if (expr.type !== 'traverse') return undefined;
    if (expr.aliasRoot === undefined || expr.steps.length === 0) return undefined;
    if (expr.expression.type !== 'property') return undefined;
    const recorded = this.valuePaths.get(
      `${spanKey(slot)}|${valuePathKey(expr.aliasRoot, expr.steps)}`,
    );
    if (recorded === undefined) return undefined;
    const hops = recorded.steps.flatMap((step, index) =>
      this.hop(step, recorded.landings[index], scope),
    );
    if (hops.length === 0 || hops.some((hop) => hop.filter !== undefined)) return undefined;
    const origin = this.origin(expr.aliasRoot, scope);
    return {
      source: serialize(expr, (id) => id),
      root: this.ref(expr.aliasRoot, scope),
      path: hops,
      field: expr.expression.propertyTypeId,
      // Where the walk STARTED, so a phrase can say it. A walk off something
      // the reader watched happen reads differently from one off a name they
      // have to take on trust, and that difference is the root's own origin.
      ...(origin !== undefined ? { origin } : {}),
    };
  }

  /**
   * What a name stands for. The flow-order maps answer first — a record we
   * wrote, an answer we waited for, a movement we called are facts about THIS
   * story, and the reader watched each of them happen. Everything else comes
   * off the checker's own type for the binding.
   */
  private origin(name: string, scope: Scope): StoryOrigin | undefined {
    const record = this.recordByBinding.get(name);
    if (record !== undefined) return { kind: 'record', record };
    if (this.answerBindings.has(name)) return { kind: 'answer' };
    if (this.callbackBindings.has(name)) return { kind: 'callback', name };
    const called = this.callBindings.get(name);
    if (called !== undefined) return { kind: 'call', movement: called };
    const resolution = scope.resolve(name);
    return resolution.kind === 'found' ? this.originOfSymbol(resolution.symbol) : undefined;
  }

  /**
   * One parameter: what the author wrote, plus where the checker landed it.
   * A parameter whose type resolved to nothing carries no target, and the
   * renderer then says the parameter's name and stops.
   */
  private param(param: MovementParam, inside: Scope): StoryParam {
    const resolution = inside.resolve(param.name);
    const posType = resolution.kind === 'found' ? resolution.symbol.posType : undefined;
    const address = posType !== undefined ? positionAddress(posType) : undefined;
    const authored = typeRefOf(typeNameOf(param.type));
    if (param.type !== undefined && isValueTypeRef(param.type)) {
      return { name: param.name, valueType: spellValueType(param.type) };
    }
    if (address === undefined) {
      return { name: param.name, ...(authored !== undefined ? { type: authored } : {}) };
    }
    const adapterType = this.adapterTypeOf(address.instance);
    return {
      name: param.name,
      ...(authored !== undefined ? { type: authored } : {}),
      target: {
        ...(adapterType !== undefined ? { adapterType } : {}),
        ...address,
      },
    };
  }

  private originOfSymbol(symbol: ScopeSymbol): StoryOrigin | undefined {
    const posType = symbol.posType;
    if (posType === undefined) return undefined;
    const extracted = extractNodeOf(posType);
    if (extracted !== undefined) {
      return {
        kind: 'extracted',
        ...(extracted.name !== EXTRACT_ROOT_NAME ? { entity: extracted.name } : {}),
      };
    }
    const address = positionAddress(posType);
    if (address === undefined) return undefined;
    const adapterType = this.adapterTypeOf(address.instance);
    const target: StoryTarget = {
      ...(adapterType !== undefined ? { adapterType } : {}),
      ...address,
    };
    // A parameter is what came IN; everything else with an address is somewhere
    // the flow walked to. The two read differently ("the email" vs "the
    // Channel"), and the symbol's own kind is the fact that tells them apart.
    return symbol.kind === 'param' ? { kind: 'event', target } : { kind: 'landing', target };
  }

  /**
   * Whether the phrase this origin composes to would fit MORE THAN ONE name in
   * scope. Two bindings of the same kind against the same declared type produce
   * the same sentence, and a sentence that fits two things names neither — so
   * the projection reports the collision and lets the renderer say which.
   */
  private ambiguous(name: string, scope: Scope, origin: StoryOrigin): boolean {
    const key = this.phraseKey(origin);
    const seen = new Set<string>();
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      for (const other of s.symbols.keys()) {
        if (seen.has(other)) continue; // an inner binding shadows an outer one
        seen.add(other);
        if (other === name) continue;
        const otherOrigin = this.origin(other, scope);
        if (otherOrigin !== undefined && this.phraseKey(otherOrigin) === key) return true;
      }
    }
    return false;
  }

  /** The facts a phrase is composed from, as one comparable token. Compared
   *  only — never parsed, and never shown. */
  private phraseKey(origin: StoryOrigin): string {
    switch (origin.kind) {
      case 'record': {
        const record = this.records.find((r) => r.id === origin.record);
        return JSON.stringify([
          origin.kind,
          record?.target.adapterType,
          record?.target.recordType,
          record?.action,
        ]);
      }
      case 'event':
      case 'landing':
        return JSON.stringify([origin.kind, origin.target.adapterType, origin.target.recordType]);
      case 'extracted':
        return JSON.stringify([origin.kind, origin.entity]);
      case 'call':
        return JSON.stringify([origin.kind, origin.movement]);
      // The phrase for a deferred action is composed out of the author's own
      // name for it, so two of them never compose the same sentence — and the
      // key says exactly that rather than collapsing every callback into one.
      case 'callback':
        return JSON.stringify([origin.kind, origin.name]);
      case 'answer':
        return JSON.stringify([origin.kind]);
    }
  }

  /**
   * A traversal head, projected. The hops and the landings are the CHECKER's —
   * recorded as it read the head — so nothing here parses a path. A head the
   * checker never recorded (or never managed to parse) yields a traversal with
   * no hops, which says exactly that.
   */
  private traversal(head: PathHead, scope: Scope): StoryTraversal {
    const recorded = this.nodes.get(`traversal:${spanKey(head.span)}`);
    const node: RecordedTraversal | undefined =
      recorded?.kind === 'traversal' ? recorded : undefined;
    return {
      id: traversalId(head.span),
      source: rawPath(head),
      ...(head.root?.kind === 'name' ? { root: this.ref(head.root.name, scope) } : {}),
      ...(head.root?.kind === 'expression'
        ? { rootExpression: this.chip(head.root.expr, scope) }
        : {}),
      ...(node?.from !== undefined ? { from: node.from } : {}),
      hops: (node?.steps ?? []).flatMap((step, index) =>
        this.hop(step, node?.landings[index], scope),
      ),
    };
  }

  /** One hop. A step that walks no named edge (a `_resources` bundle, a
   *  link-back) has no edge to name, so it contributes no hop rather than an
   *  anonymous one. */
  private hop(
    step: TraversalStep,
    landing: RecordedLanding | undefined,
    scope: Scope,
  ): StoryHop[] {
    if (step.type !== 'edge' && step.type !== 'meta_edge') return [];
    const filter = step.type === 'edge' ? step.expressionFilter : undefined;
    return [
      {
        ...(step.alias !== undefined ? { binding: step.alias } : {}),
        edge: step.type === 'edge' ? step.edgeTypeId : step.metaEdge,
        ...(landing !== undefined ? { landing: this.landing(landing) } : {}),
        ...(filter !== undefined ? { filter: this.filter(filter, scope) } : {}),
      },
    ];
  }

  private landing(landing: RecordedLanding): NonNullable<StoryHop['landing']> {
    const adapterType = this.adapterTypeOf(landing.instance);
    return {
      ...(adapterType !== undefined ? { adapterType } : {}),
      instance: landing.instance,
      ...(landing.position !== undefined ? { recordType: landing.position } : {}),
    };
  }

  private filter(expr: Expression, scope: Scope): StoryFilter {
    const simple = simpleComparisons(expr);
    if (simple === undefined) return { kind: 'expression', chip: this.chipOfExpression(expr, scope) };
    return {
      kind: 'comparisons',
      all: simple.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: this.chipOfExpression(c.value, scope),
      })),
    };
  }

  // ── Records ──

  private addRecord(
    write: WriteExpression | MatchExpression,
    recorded: RecordedWrite | undefined,
  ): string {
    const id = recordId(write.span);
    const scope = recorded?.scope;
    const fields: Record<string, Chip> = {};
    const fieldModes: StoryRecord['fieldModes'] = {};
    for (const field of recorded?.fields ?? write.fields) {
      if (scope !== undefined) fields[field.name] = this.chip(field.value, scope);
      if (field.semantics !== undefined) fieldModes[field.name] = field.semantics;
    }
    const instance = recorded?.target?.instance;
    this.records.push({
      id,
      ...(recorded?.binding !== undefined ? { binding: recorded.binding } : {}),
      target: {
        ...(this.adapterTypeOf(instance) !== undefined
          ? { adapterType: this.adapterTypeOf(instance) }
          : {}),
        ...(instance !== undefined ? { instance } : {}),
        ...(recorded?.target?.recordType !== undefined
          ? { recordType: recorded.target.recordType }
          : {}),
      },
      action: recorded?.action ?? 'create',
      fields,
      fieldModes,
      uniqueBy:
        scope === undefined ? [] : write.uniqueBy.map((c) => this.chip(c.predicate, scope)),
      at: write.span,
    });
    if (recorded?.binding !== undefined) this.recordByBinding.set(recorded.binding, id);
    // The write FORM is the parent edge: a linked or tuple write mints the
    // record and the edge that reaches it in one move. A match only looks
    // along the edge, so it draws none.
    if (scope !== undefined && recorded?.action !== 'find') {
      const paths: PathHead[] =
        write.target.kind === 'linked' ? [write.target.path]
        : write.target.kind === 'tuple' ? write.target.paths
        : [];
      paths.forEach((path, index) => {
        const edge = recorded?.parents[index]?.edge;
        const from = pathRootName(path);
        if (edge === undefined || from === undefined) return;
        this.edges.push({
          from: this.endpoint(from, scope),
          to: { kind: 'record', id },
          edge,
          kind: 'parent',
        });
      });
    }
    return id;
  }

  // ── The flow ──

  private steps(statements: Statement[]): Step[] {
    const steps: Step[] = [];
    for (const statement of statements) {
      const step = this.step(statement);
      if (Array.isArray(step)) steps.push(...step);
      else if (step !== undefined) steps.push(step);
    }
    return steps;
  }

  /** Mostly one step per statement; a `link` body is two — the find, then
   *  the link — exactly as its two-statement spelling projects. */
  private step(statement: Statement): Step | Step[] | undefined {
    switch (statement.kind) {
      case 'import':
      case 'shape':
      case 'type':
      case 'listen':
        return undefined; // declarations, not flow
      case 'movement': {
        // The checker records a frame for the movement whose span IS the
        // declaration's, so the parameters are looked up where they are BOUND —
        // their types are the checker's, never re-derived from the annotation.
        const inside = this.scopeOfNearest(statement.span);
        return {
          kind: 'movement',
          name: statement.name,
          params: statement.params.map((p: MovementParam) => this.param(p, inside)),
          steps: this.steps(statement.body),
          // A `return` written straight in the body is a step on the spine,
          // not a capped lane, so it leaves the run's own ending to be drawn;
          // only a terminator that caps its lanes stands in for that ending.
          terminates: terminates(statement.body.filter(s => s.kind !== 'return'), this.armExits()),
          // The row is the checker's, filed on the declaration it belongs to —
          // read back through the same symbol the parameters were typed from,
          // never re-derived here.
          effects: storyEffects(declaredMovementRow(inside, statement.name)),
          at: statement.span,
        };
      }
      case 'assign':
        return this.assignStep(statement.name, statement.value, statement.span);
      case 'return': {
        const effect = this.returnedEffectStep(statement.value, statement.span);
        if (effect !== undefined) return effect;
        const scope = this.scopeOfNearest(statement.span);
        return {
          kind: 'return',
          ...(statement.value.kind === 'expr'
            ? { value: this.chip(statement.value.expr, scope) }
            : {}),
          ...(statement.value.kind === 'lazy'
            ? { value: this.pathChip(statement.value.lazy.head, scope) }
            : {}),
          of: statement.value.kind,
          at: statement.span,
        };
      }
      case 'write':
        return {
          kind: 'write',
          record: this.addRecord(statement.write, this.writes.get(spanKey(statement.write.span))),
          at: statement.span,
        };
      case 'call': {
        // `MAP(xs, f)` run bare is the collection statement it resolved to.
        const reading = this.builtinReading(statement);
        if (reading?.kind === 'collection') {
          return this.step({ kind: 'collection', collection: reading.collection, span: statement.span });
        }
        return this.callStep(statement, undefined);
      }
      case 'block': {
        const scope = this.blockScope(statement.block.span);
        return {
          kind: 'group',
          over: this.traversal(statement.block.head, scope),
          steps: this.steps(statement.block.body),
          at: statement.span,
        };
      }
      case 'match':
        return this.matchStep(statement.match, statement.span);
      case 'link':
        return this.linkSteps(statement.link);
      case 'unlink': {
        const scope = this.scopeOfNearest(statement.span);
        return {
          kind: 'unlink',
          edge: statement.edge,
          from: this.endpoint(statement.from, scope),
          to: this.endpoint(statement.to, scope),
          at: statement.span,
        };
      }
      case 'delete':
      case 'refresh': {
        const recorded = this.nodes.get(`${statement.kind}:${spanKey(statement.span)}`);
        const scope = recorded !== undefined ? recorded.scope : this.scopeOfNearest(statement.span);
        return {
          kind: statement.kind,
          subject: this.ref(statement.name, scope),
          at: statement.span,
        };
      }
      case 'if':
        return this.branchStep(statement);
      case 'await': {
        // The combinator sources (`await race([…])` / `await parallel([…])`)
        // ARE the combinator — same recording, same step, awaited spelling.
        const src = statement.await.source;
        if (src.kind === 'combinator') {
          return this.combinatorStep(src.combinator, undefined, statement.span);
        }
        return this.awaitStep(statement.await.span, undefined, statement.span);
      }
      case 'combinator':
        return this.combinatorStep(statement.combinator, undefined, statement.span);
      case 'collection':
        return {
          kind: 'bind',
          of: 'collection',
          op: statement.collection.op,
          over: this.chip(statement.collection.source, this.scopeOfNearest(statement.span)),
          at: statement.span,
        };
      case 'error': {
        const scope = this.scopeOfNearest(statement.span);
        return { kind: 'error', message: this.chip(statement.message, scope), at: statement.span };
      }
    }
  }

  /** The step a RETURNED right-hand side projects in its own right — what the
   *  movement DOES, which a return must never hide. Undefined where the value
   *  is just a value; the `return` step then carries it. */
  private returnedEffectStep(value: RValue, at: Span): Step | Step[] | undefined {
    const resolved = this.resolvedValue(value);
    if (resolved !== value) return this.returnedEffectStep(resolved, at);
    switch (value.kind) {
      case 'write':
        return {
          kind: 'write',
          record: this.addRecord(value.write, this.writes.get(spanKey(value.write.span))),
          at,
        };
      case 'match':
        return this.matchStep(value.match, at);
      case 'link':
        return this.linkSteps(value.link);
      case 'call':
        return this.callStep(value.call, undefined);
      case 'block': {
        const scope = this.blockScope(value.block.span);
        return {
          kind: 'group',
          over: this.traversal(value.block.head, scope),
          steps: this.steps(value.block.body),
          at,
        };
      }
      default:
        return undefined;
    }
  }

  private assignStep(binding: string, value: RValue, at: Span): Step | Step[] | undefined {
    const resolved = this.resolvedValue(value);
    if (resolved !== value) return this.assignStep(binding, resolved, at);
    switch (value.kind) {
      case 'write':
        return {
          kind: 'write',
          record: this.addRecord(value.write, this.writes.get(spanKey(value.write.span))),
          at,
        };
      case 'match':
        return this.matchStep(value.match, at);
      case 'link':
        return this.linkSteps(value.link);
      case 'extract':
        return this.extractStep(value.extract.span, value.extract.from, binding, at);
      // The call is the same step to a reader: what it read, and the tree of
      // what it found (the shape, recorded by the checker at the call).
      case 'extractCall':
        return this.extractStep(value.extractCall.span, [value.extractCall.content], binding, at);
      case 'await': {
        const src = value.await.source;
        if (src.kind === 'combinator') {
          return this.combinatorStep(src.combinator, binding, at);
        }
        return this.awaitStep(value.await.span, binding, at);
      }
      case 'combinator':
        return this.combinatorStep(value.combinator, binding, at);
      case 'block': {
        const scope = this.blockScope(value.block.span);
        return {
          kind: 'group',
          over: this.traversal(value.block.head, scope),
          binding,
          steps: this.steps(value.block.body),
          at,
        };
      }
      case 'call':
        return this.callStep(value.call, binding);
      case 'construct': {
        // One surface form, two meanings — resolution decided. A recorded
        // `call` at this span means the checker read it as an invocation; an
        // `instance` means it constructed one (already a top-level row, not a
        // step).
        const call = this.nodes.get(`call:${spanKey(value.construct.span)}`);
        return call !== undefined
          ? this.callStep(constructionAsCall(value.construct), binding)
          : undefined;
      }
      case 'lazy': {
        const scope = this.scopeOfNearest(at);
        return { kind: 'value', binding, value: this.pathChip(value.lazy.head, scope), at };
      }
      case 'expr': {
        const scope = this.scopeOfNearest(at);
        return { kind: 'value', binding, value: this.chip(value.expr, scope), at };
      }
      case 'node':
        return {
          kind: 'node',
          binding,
          node: this.nodeLiteral(value.node, this.scopeOfNearest(at)),
          at,
        };
      // The body is projected by the ordinary flow walk. The checker already
      // opened a frame over it — a callback body is a closure over the
      // enclosing scope, checked like any other block — so every step inside
      // resolves its names in the scope the checker stood in, with nothing new
      // recorded for it.
      case 'callback': {
        const subject = value.callback.subject;
        this.callbackBindings.add(binding);
        return {
          kind: 'callback',
          binding,
          ...(subject.kind === 'named' ? { movement: subject.movement } : {}),
          steps: subject.kind === 'inline' ? this.steps(subject.closure.body) : [],
          at,
        };
      }
      // A collection op names ITSELF and the collection it ran over; its
      // function's steps stay where every function's do — at the call.
      case 'collection':
        return {
          kind: 'bind',
          binding,
          of: value.kind,
          op: value.collection.op,
          over: this.chip(value.collection.source, this.scopeOfNearest(at)),
          at,
        };
      // `MEMBERS` binds a value the flow shows no richer form for — the same
      // treatment a bound closure gets, and for the same reason: the work is
      // inside a function, and the picture shows a function's steps where it
      // is CALLED.
      case 'members':
      case 'inlineBlock':
      case 'closure':
        return { kind: 'bind', binding, of: value.kind, at };
    }
  }

  /** How the checker read a call whose callee is a built-in — undefined for
   *  a function's call (and wherever the checker recorded nothing). */
  private builtinReading(call: CallStatement): RecordedCallReading['reading'] | undefined {
    const recorded = this.nodes.get(`callReading:${spanKey(call.span)}`);
    return recorded?.kind === 'callReading' ? recorded.reading : undefined;
  }

  /** A bound or returned call to a built-in, as the value form it resolved
   *  to; any other right-hand side unchanged. */
  private resolvedValue(value: RValue): RValue {
    if (value.kind !== 'call') return value;
    const reading = this.builtinReading(value.call);
    switch (reading?.kind) {
      case 'value':
        return { kind: 'expr', expr: reading.expr };
      case 'collection':
        return { kind: 'collection', collection: reading.collection };
      case 'members':
        return { kind: 'members', members: reading.members };
      default:
        return value;
    }
  }

  private callStep(call: CallStatement, binding: string | undefined): Step {
    const recorded = this.nodes.get(`call:${spanKey(call.span)}`);
    const node = recorded?.kind === 'call' ? (recorded as RecordedCall) : undefined;
    const scope = node?.scope ?? this.scopeOfNearest(call.span);
    const args = call.args.map((arg, index) =>
      this.arg(arg, arg.name ?? node?.argParams?.[index] ?? `${index + 1}`, scope));
    if (binding !== undefined) this.callBindings.set(binding, call.callee);
    return {
      kind: 'call',
      movement: call.callee,
      isMovement: node?.isMovement ?? false,
      args,
      ...(binding !== undefined ? { binding } : {}),
      at: call.span,
    };
  }

  /** One argument. A POSITION argument is not a value, and it used to be
   *  dropped — which is how `notify(n: node { … })` rendered as a call with no
   *  arguments at all. Each form now carries what it actually is. */
  private arg(arg: CallArg, name: string, scope: Scope): StoryArg {
    switch (arg.kind) {
      case 'expr':
        return { name, kind: 'value', chip: this.chip(arg.expr, scope) };
      case 'call': {
        const reading = this.builtinReading(arg.call);
        if (reading?.kind === 'value') return { name, kind: 'value', chip: this.chip(reading.expr, scope) };
        return { name, kind: 'call', movement: arg.call.callee };
      }
      // Only a built-in takes either; handed to a function they are refused,
      // and shown as written.
      case 'closure':
      case 'type': {
        const source = arg.kind === 'type' ? `<${arg.type}>` : '(a function)';
        return { name, kind: 'value', chip: { source, role: 'unparsed', refs: [], parts: [{ kind: 'text', text: source }] } };
      }
      case 'node':
        return { name, kind: 'node', node: this.nodeLiteral(arg.node, scope) };
      case 'write':
        return {
          name,
          kind: 'record',
          record: this.addRecord(arg.write, this.writes.get(spanKey(arg.write.span))),
        };
    }
  }

  /** An assembled node, as its contents. */
  private nodeLiteral(literal: NodeLiteral, scope: Scope): StoryNode {
    const fields: Record<string, Chip> = {};
    const children: StoryNode['children'] = [];
    for (const entry of literal.entries) {
      switch (entry.kind) {
        case 'value':
          fields[entry.name] = this.chip(entry.value, scope);
          break;
        case 'nodes':
          children.push({
            name: entry.name,
            nodes: entry.nodes.map((child) => this.nodeLiteral(child, scope)),
          });
          break;
        case 'declared':
          // A declared edge has nothing in it where the literal is written.
          // What lands in it are the `link` steps, which the story already
          // tells one by one.
          children.push({ name: entry.name, nodes: [] });
          break;
        case 'traversal':
          // A pass-through entry takes its values from somewhere else entirely.
          // The honest thing to show is where from — the path, as written.
          fields[entry.name] = this.pathChip(entry.head, scope);
          break;
      }
    }
    // A graph literal's `...v`: its keys are only known when it runs, so the
    // honest thing to show is the map they come from.
    for (const spread of literal.spreads ?? []) {
      fields[`...${spread.source}`] = this.chip({ raw: spreadSourceText(spread), span: spread.span }, scope);
    }
    return { fields, children };
  }

  /** `link a -[:e]-> b` is one step. A body is the match it desugars to, then
   *  the link onto the record that match found. */
  private linkSteps(link: LinkExpression): Step[] {
    const found = link.to.kind === 'match' ? this.matchStep(link.to.match, link.to.match.span) : undefined;
    const recorded = this.nodes.get(`link:${spanKey(link.span)}`);
    if (recorded?.kind !== 'link') return found !== undefined ? [found] : [];
    const node: RecordedLink = recorded;
    const from = this.endpoint(node.from, node.scope);
    const to: StoryEndpoint =
      link.to.kind === 'handle'
        ? this.endpoint(link.to.name, node.scope)
        : { kind: 'record', id: recordId(link.to.match.span) };
    this.edges.push({ from, to, edge: node.edge, kind: 'link' });
    const step: Step = { kind: 'link', edge: node.edge, from, to, at: link.span };
    return found !== undefined ? [found, step] : [step];
  }

  /** A `match` finds a row of the graph — recorded by the checker exactly as a
   *  write body is, with action `find`. */
  private matchStep(match: MatchExpression, at: Span): Extract<Step, { kind: 'match' }> {
    const recorded = this.writes.get(spanKey(match.span));
    return {
      kind: 'match',
      record: this.addRecord(match, recorded),
      ...(recorded?.binding !== undefined ? { binding: recorded.binding } : {}),
      at,
    };
  }

  private extractStep(
    span: Span,
    from: ExprSlot[],
    binding: string | undefined,
    at: Span,
  ): Step {
    const recorded = this.nodes.get(`extract:${spanKey(span)}`);
    const node = recorded?.kind === 'extract' ? (recorded as RecordedExtract) : undefined;
    const scope = node?.scope ?? this.scopeOfNearest(at);
    return {
      kind: 'extract',
      ...(binding !== undefined ? { binding } : {}),
      from: from.map((slot) => this.chip(slot, scope)),
      ...(node !== undefined ? { tree: projectExtractNode(node.node) } : {}),
      at,
    };
  }

  /**
   * An `await` is an ASK's pause when the edge it waits on is the resolution of
   * a record WE raised — structurally: an awaitable edge off a binding that
   * holds one of our records. Nothing about which adapter, and nothing about
   * what the record is called.
   */
  private awaitStep(span: Span, binding: string | undefined, at: Span): Step {
    const recorded = this.nodes.get(`await:${spanKey(span)}`);
    const node = recorded?.kind === 'await' ? (recorded as RecordedAwait) : undefined;
    if (node === undefined) return { kind: 'wait', wait: { kind: 'edge' }, at };
    const source = node.source;
    if (source.kind === 'sleep') {
      return {
        kind: 'wait',
        wait: { kind: 'sleep', duration: source.duration },
        ...(binding !== undefined ? { binding } : {}),
        at,
      };
    }
    if (source.kind === 'until') {
      return {
        kind: 'wait',
        wait: { kind: 'until', ...(source.every !== undefined ? { every: source.every } : {}) },
        ...(binding !== undefined ? { binding } : {}),
        at,
      };
    }
    const record = source.root !== undefined ? this.recordByBinding.get(source.root) : undefined;
    if (source.awaitable === true && record !== undefined) {
      this.edges.push({
        from: { kind: 'record', id: record },
        to:
          binding !== undefined
            ? { kind: 'binding', ref: { name: binding, declaredAt: at } }
            : { kind: 'record', id: record },
        edge: source.edge ?? '',
        kind: 'response',
      });
      if (binding !== undefined) this.answerBindings.add(binding);
      return {
        kind: 'ask',
        record,
        ...(source.edge !== undefined ? { edge: source.edge } : {}),
        ...(binding !== undefined ? { binding } : {}),
        at,
      };
    }
    const waitedOn = source.root !== undefined ? this.origin(source.root, node.scope) : undefined;
    return {
      kind: 'wait',
      wait: {
        kind: 'edge',
        ...(source.root !== undefined ? { on: this.endpoint(source.root, node.scope) } : {}),
        ...(source.edge !== undefined ? { edge: source.edge } : {}),
        ...(waitedOn !== undefined ? { origin: waitedOn } : {}),
      },
      ...(binding !== undefined ? { binding } : {}),
      at,
    };
  }

  private combinatorStep(
    expr: CombinatorExpression,
    binding: string | undefined,
    at: Span,
  ): Step {
    const recorded = this.nodes.get(`combinator:${spanKey(expr.span)}`);
    const node = recorded?.kind === 'combinator' ? (recorded as RecordedCombinator) : undefined;
    // Arms built at run time have no lanes to draw — the picture says what it
    // knows (the combinator ran, and what it bound), not a lane count it made up.
    const arms = expr.arms.kind === 'literal' ? expr.arms.arms : [];
    return {
      kind: 'race',
      combinator: expr.kind,
      branches: arms.map((arm, index) => {
        const armAt = node?.arms[index]?.span ?? arm.span;
        if (arm.kind === 'ref') {
          return { steps: [], terminates: false, arm: arm.name, at: armAt };
        }
        return {
          steps: this.steps(arm.closure.body),
          // A `return` here is the arm's VALUE: the combinator takes it and the
          // run carries on, so only an `ERROR` caps a lane.
          terminates: terminates(arm.closure.body, { returns: false }),
          at: armAt,
        };
      }),
      ...(binding !== undefined ? { binding } : {}),
      at,
    };
  }

  private branchStep(statement: IfStatement): Step {
    const recorded = this.nodes.get(`branch:${spanKey(statement.span)}`);
    const node = recorded?.kind === 'branch' ? (recorded as RecordedBranch) : undefined;
    return {
      kind: 'branch',
      arms: statement.arms.map((arm, index) => ({
        // The condition resolves in the ARM's scope — that is where its own IS
        // tests have narrowed, and where the checker read it.
        condition: this.chip(
          arm.condition,
          node?.arms[index]?.scope ?? node?.scope ?? this.scopeOfNearest(arm.span),
        ),
        steps: this.steps(arm.body),
        terminates: terminates(arm.body, this.armExits()),
        at: arm.span,
      })),
      ...(statement.elseArm !== undefined
        ? {
            otherwise: {
              steps: this.steps(statement.elseArm.body),
              terminates: terminates(statement.elseArm.body, this.armExits()),
              at: statement.elseArm.span,
            },
          }
        : {}),
      at: statement.span,
    };
  }

  // ── Scopes ──

  /** The scope a traversal block's HEAD was written in — the block's own frame
   *  is the body's, and the head resolves outside it. */
  private blockScope(span: Span): Scope {
    return this.scopeOfNearest(span);
  }

  /**
   * The innermost recorded frame containing `span`. Used where no recorded node
   * carries the scope directly (a statement the checker resolves without
   * recording anything of its own); the frames were recorded by the same walk,
   * so this is the scope the checker stood in.
   */
  private scopeOfNearest(span: Span): Scope {
    let best: { span: Span; scope: Scope } | undefined;
    for (const frame of this.input.recording.frames) {
      if (!contains(frame.span, span)) continue;
      if (best === undefined || contains(best.span, frame.span)) {
        best = { span: frame.span, scope: frame.scope };
      }
    }
    if (best !== undefined) return best.scope;
    // The file frame is recorded first and covers everything; falling back to
    // it keeps the projection total on a recording that has one.
    const file = this.input.recording.frames[0];
    if (file !== undefined) return file.scope;
    throw new Error('projectStory: the recording has no scope frames');
  }
}

// By value: a span read back from the checker's scope need not be the very
// object the parse produced.
function sameSpan(a: Span, b: Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}

function contains(outer: Span, inner: Span): boolean {
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/**
 * A declared movement's inferred row, off the symbol the checker filed it on.
 * An unchecked program (or one whose declaration never resolved) has no row —
 * which is a lower bound, not "does nothing", so the fallback says so.
 */
function declaredMovementRow(scope: Scope, name: string): EffectRow {
  const resolution = scope.resolve(name);
  if (resolution.kind !== 'found') return { ...EMPTY_ROW, partial: true };
  return resolution.symbol.movement?.effects ?? { ...EMPTY_ROW, partial: true };
}

function storyEffects(row: EffectRow): StoryEffects {
  return {
    reads: instanceNames(row.read),
    writes: instanceNames(row.write),
    ai: row.ai,
    now: row.now,
    suspend: row.suspend,
    partial: row.partial,
  };
}

function before(a: { line: number; col: number }, b: { line: number; col: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}

function projectExtractNode(node: ExtractNodeType): StoryExtractNode {
  return {
    name: node.name,
    ...(node.description !== undefined ? { description: node.description } : {}),
    fields: [...node.properties.entries()].map(([name, info]) => ({
      name,
      ...(info.description !== undefined ? { description: info.description } : {}),
      ...(info.explicit !== undefined
        ? { type: info.nullable ? (maybeAbsent(info.explicit) ?? info.explicit) : info.explicit }
        : {}),
      at: info.span,
    })),
    children: [...node.children.values()].map(projectExtractNode),
  };
}

/** Every statement in the program, nested bodies included. */
function walkStatements(statements: Statement[], visit: (statement: Statement) => void): void {
  for (const statement of statements) {
    visit(statement);
    switch (statement.kind) {
      case 'movement':
        walkStatements(statement.body, visit);
        break;
      case 'block':
        walkStatements(statement.block.body, visit);
        break;
      case 'if':
        statement.arms.forEach((arm) => walkStatements(arm.body, visit));
        if (statement.elseArm) walkStatements(statement.elseArm.body, visit);
        break;
      case 'combinator':
        walkArmBodies(statement.combinator, visit);
        break;
      case 'await': {
        const src = statement.await.source;
        if (src.kind === 'combinator') walkArmBodies(src.combinator, visit);
        break;
      }
      // A binding and a `return` take the SAME right-hand side, so the nested
      // bodies inside one are found the same way in both.
      case 'assign':
      case 'return':
        walkRValueBodies(statement.value, visit);
        break;
      default:
        break;
    }
  }
}

/** A combinator's closure arms are ordinary bodies, walked like any other. */
function walkArmBodies(
  expr: CombinatorExpression,
  visit: (statement: Statement) => void,
): void {
  if (expr.arms.kind !== 'literal') return;
  for (const arm of expr.arms.arms) {
    if (arm.kind === 'closure') walkStatements(arm.closure.body, visit);
  }
}

/** The nested statement bodies a right-hand side carries. */
function walkRValueBodies(value: RValue, visit: (statement: Statement) => void): void {
  switch (value.kind) {
    case 'block':
      walkStatements(value.block.body, visit);
      return;
    case 'combinator':
      walkArmBodies(value.combinator, visit);
      return;
    case 'await': {
      const src = value.await.source;
      if (src.kind === 'combinator') walkArmBodies(src.combinator, visit);
      if (src.kind === 'until' && src.condition.kind === 'closure') {
        walkStatements(src.condition.closure.body, visit);
      }
      return;
    }
    case 'inlineBlock':
      walkStatements(value.inlineBlock.body, visit);
      return;
    case 'closure':
      walkStatements(value.closure.body, visit);
      return;
    // A deferred action's body is ordinary flow — a link or a race written
    // inside one is found the same way it is anywhere else.
    case 'callback':
      if (value.callback.subject.kind === 'inline') {
        walkStatements(value.callback.subject.closure.body, visit);
      }
      return;
    default:
      return;
  }
}
