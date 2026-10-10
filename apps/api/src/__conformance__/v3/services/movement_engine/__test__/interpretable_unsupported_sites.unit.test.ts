// Every MOVENG_UNSUPPORTED the engine can throw, and what stops a SAVED
// movement from reaching it.
//
// `unsupported(…)` fails a run at FIRE time. A movement that passed save and
// then fails in production for a construct the engine never ran is the worst
// place to find out — so each call site in the engine is registered here with
// its cover:
//
//   checker     — the movement-lang checker refuses every program that reaches it
//   dryRun      — the save-time construct scan (interpretable.ts) flags it; the
//                 snippet here PROVES the scan reaches it
//   harness     — only reachable when a durable seam is absent (a dry run or a
//                 test harness), never in a production firing
//   unreachable — nothing a program says can get there
//   partial     — the checker refuses the common case; `gap` says what slips by
//   uncovered   — a saved movement CAN reach it; `gap` says how
//
// A new `unsupported(…)` fails this test until it is registered, and the
// uncovered / partial count may only go DOWN: a new site must come with a
// checker diagnostic or a dry-run flag (or engine support instead of a throw).
// The sites are keyed by the construct text the engine throws, which is what
// a failed run shows.

import * as fs from 'fs';
import * as path from 'path';
import { listUnsupportedConstructs } from '../interpretable';

type Cover =
  | { by: 'checker'; codes: string[] }
  | { by: 'dryRun'; label: string; snippet: string }
  | { by: 'harness'; seam: 'parkSink' | 'callbackSink' | 'resolveFile' }
  | { by: 'unreachable'; why: string }
  | { by: 'partial'; codes: string[]; gap: string }
  | { by: 'uncovered'; gap: string };

interface Site {
  file: 'expression.ts' | 'run.ts';
  /** The construct argument's source text, quotes stripped, whitespace folded. */
  construct: string;
  cover: Cover;
}

/** Only ever goes DOWN. Closing a gap (a checker diagnostic, a dry-run flag,
 *  engine support) lowers it; nothing may raise it. */
const KNOWN_GAPS = 66;

// Sites in source order within each file; a construct thrown from two places
// is listed twice, in the order it appears.
const SITES: Site[] = [
  { file: "expression.ts", construct: "the '${expr.fn}' aggregation",
    cover: { by: 'partial', codes: ["MOV_BUILTIN_NOT_RUN"], gap: "LLM_AGG(\u2026) is refused under language version 3; a movement pinned to 1 or 2 still saves it (the scan treats aggregates as supported) and fails here" } },
  { file: "expression.ts", construct: "the function ${expr.fn.toUpperCase()}()",
    cover: { by: 'partial', codes: [], gap: "the dry run flags a non-built-in function outside adapter write fields ('non-built-in function calls'); inside a write field, or in a hop WHERE, nothing refuses an unadvertised name" } },
  { file: "expression.ts", construct: "rootless EXISTS()",
    cover: { by: 'uncovered', gap: "`EXISTS(-[:files]->)` in a body: the checker walks a rootless path with no start and says nothing" } },
  { file: "expression.ts", construct: "edge-property reads outside a traversal WHERE",
    cover: { by: 'uncovered', gap: "an edge-property read inside a hop WHERE over an extract result or meta-node (the scan never looks inside hop brackets)" } },
  { file: "expression.ts", construct: "the expression kind '${expr.type}'",
    cover: { by: 'partial', codes: ["MOV_PARENT_READ_RETIRED"], gap: "@parent.* nested inside a hop WHERE or ORDER BY is refused under language version 3 (a movement pinned to 1 or 2 still reaches it); a KG_EXISTS nested there is still open: the scan only checks top-level kinds" } },
  { file: "expression.ts", construct: "reading '${name}' (${describeBinding[binding.kind]}) as a bare value",
    cover: { by: 'uncovered', gap: "`COUNT(msg)` / `COALESCE(msg)`: the checker's RECORD_NOT_A_VALUE covers concat, arithmetic, compare and some folds only" } },
  { file: "expression.ts", construct: "relative traversal (no alias root)",
    cover: { by: 'uncovered', gap: "`COUNT(-[:files]->)` in a body: the checker walks from no position and says nothing" } },
  { file: "expression.ts", construct: "reading '${name}' (${describeBinding[binding.kind]}) in an expression",
    cover: { by: 'unreachable', why: "graph-rooted reads: the interpreter always wires graphRead, and graphReadFor always answers for an instance" } },
  { file: "expression.ts", construct: "reading fields of '${name}' (${describeBinding[binding.kind]})",
    cover: { by: 'uncovered', gap: "`crm.`name`` (a dot read on a graph's meta root): the checker's meta-position read answers undefined silently" } },
  { file: "expression.ts", construct: "traversing inside EXISTS() from '${name}', which holds ${describeHeldValue(binding.value)} rather than a record",
    cover: { by: 'uncovered', gap: "EXISTS walking from a name that holds a scalar: the checker's walk start is undefined for a non-record value, so it says nothing" } },
  { file: "expression.ts", construct: "reading '${name}' (${describeBinding[binding.kind]}) in an expression",
    cover: { by: 'uncovered', gap: "reading a tuple / shape / movement / plugin / import binding as a traversal root; closures are refused by MOV_UNKNOWN_PROPERTY, the rest are unconfirmed" } },
  { file: "expression.ts", construct: "this read shape on ${options.what} ('${options.name}')",
    cover: { by: 'uncovered', gap: "something other than a field after the final `.` (`rows-[:notes]->.TRIM(\u2026)`); the checker types it at the destination" } },
  { file: "expression.ts", construct: "this read shape on ${what} ('${name}')",
    cover: { by: 'uncovered', gap: "something other than a field after the final `.` off an adapter root (`msg.TRIM(\u2026)`)" } },
  { file: "expression.ts", construct: "EXISTS() after hops from '${name}'",
    cover: { by: 'uncovered', gap: "only via `v-[:a]->.EXISTS(-[:b]->)` on a scalar `v`; the checker's start is undefined" } },
  { file: "expression.ts", construct: "'${step.type}' hops inside EXISTS()",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` meta hop inside EXISTS: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "expression.ts", construct: "incoming EXISTS() hops ('${step.edgeTypeId}')",
    cover: { by: 'uncovered', gap: "an incoming hop on an adapter without incoming traversal; the checker never looks at hop direction" } },
  { file: "expression.ts", construct: "traversing '${step.edgeTypeId}' from ${describeBinding[cursor.kind]} inside EXISTS()",
    cover: { by: 'uncovered', gap: "an EXISTS hop off a landing that is neither a record, an extraction nor a meta-node (a synthesised node, a callback landing, a scalar)" } },
  { file: "expression.ts", construct: "sorting records with no key",
    cover: { by: 'partial', codes: ["MOV_SORT_NEEDS_KEY"], gap: "refused only when the checker knows the members are records; silent on an untyped member" } },
  { file: "expression.ts", construct: "reading SORT's key off this member",
    cover: { by: 'partial', codes: ["MOV_SORT_KEY_ON_SCALAR"], gap: "refused only when the checker knows the members are plain values; silent on an untyped member" } },
  { file: "expression.ts", construct: "'${step.type}' hops in a traversal from '${input.name}'",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` meta hop in an expression read: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "expression.ts", construct: "incoming hops ('${step.edgeTypeId}')",
    cover: { by: 'uncovered', gap: "an incoming hop in an expression read on an adapter without incoming traversal" } },
  { file: "expression.ts", construct: "'${step.type}' hops over the extract result ('${name}')",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` meta hop over an extract result: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "expression.ts", construct: "WHERE filters on extract-result hops ('${name}')",
    cover: { by: 'uncovered', gap: "`COUNT(deals-[:company WHERE \u2026]->)` over an extract result: no hop capability for extract positions, so the checker is silent" } },
  { file: "expression.ts", construct: "'${step.type}' hops over a block meta-node ('${name}')",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` meta hop over a meta-node: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "expression.ts", construct: "WHERE filters on block meta-node hops ('${name}')",
    cover: { by: 'uncovered', gap: "a hop WHERE over a meta-node's in-memory landings (race receipts, extraction children); record landings now walk through the adapter" } },
  { file: "expression.ts", construct: "traversing '${step.edgeTypeId}' from ${describeBinding[binding.kind]} inside a meta-node read",
    cover: { by: 'uncovered', gap: "a hop off an in-memory landing kind the meta walk has no plane for (a scalar, a callback, a shape position)" } },
  { file: "expression.ts", construct: "traversing from a write handle ('${name}')",
    cover: { by: 'uncovered', gap: "a write whose adapter returned no record id, then a hop off its handle; the checker cannot know the adapter's answer" } },
  { file: "expression.ts", construct: "WHERE filters on a synthesised node's edges ('${name}')",
    cover: { by: 'uncovered', gap: "a WHERE on a synthesised node's LAZY edge (`n-[:items WHERE \u2026]->` where `items: lazy \u2026`); a landed edge filters its landings in hand" } },
  { file: "expression.ts", construct: "reading the deferred traversal bound to '${name}'",
    cover: { by: 'unreachable', why: "walkDeferred is always wired: every evaluator context the interpreter builds carries it" } },
  { file: "expression.ts", construct: "this read shape on ${options.what} ('${options.name}')",
    cover: { by: 'uncovered', gap: "something other than a field after the final `.` over an extract result or meta-node (`deals.TRIM(\u2026)`)" } },
  { file: "expression.ts", construct: "writing out a record that contains itself through its edges",
    cover: { by: 'unreachable', why: "a record is built bottom-up from values already in hand, so no program can make one hold itself; the guard is for a structure the engine does not build" } },
  { file: "expression.ts", construct: "writing out the '${name}' edge of a record, which is a lazy walk that has not been run",
    cover: { by: 'checker', codes: ["MOV_STDLIB_ARG_LAZY_EDGE"] } },
  { file: "expression.ts", construct: "writing out a record whose field and edge are both called '${name}'",
    cover: { by: 'checker', codes: ["MOV_NODE_ENTRY_DUPLICATE", "MOV_EXTRACT_FIELD_DUPLICATE"] } },
  { file: "expression.ts", construct: "copying the keys of ${describeHeldValue(value)} into a map",
    cover: { by: 'checker', codes: ["MOV_MAP_SPREAD_NOT_KEYED"] } },
  { file: "expression.ts", construct: "reading every field of ${describeHeldValue(binding.value)}",
    cover: { by: 'checker', codes: ["MOV_STDLIB_ARG_NOT_RECORD", "MOV_MAP_SPREAD_NOT_KEYED"] } },
  { file: "expression.ts", construct: "reading every field of ${describeBinding[binding.kind]}",
    cover: { by: 'checker', codes: ["MOV_STDLIB_ARG_NOT_RECORD", "MOV_MAP_SPREAD_NOT_KEYED"] } },
  { file: "expression.ts", construct: "reading every field of ${describeBinding[binding.kind]}",
    cover: { by: 'checker', codes: ["MOV_STDLIB_ARG_NOT_RECORD", "MOV_MAP_SPREAD_NOT_KEYED"] } },
  { file: "expression.ts", construct: "reading '${field}' off ${describeBinding[binding.kind]} reached through '${name}'",
    cover: { by: 'uncovered', gap: "a field read through a meta-node landing kind readBindingField has no case for (e.g. a source record reached through a race receipt); unconfirmed" } },
  { file: "expression.ts", construct: "traversing from ${what} ('${name}')",
    cover: { by: 'uncovered', gap: "a hop off a scalar value binding (`v = \"x\"` then `COUNT(v-[:a]->)`), or off a callback in an expression" } },
  { file: "expression.ts", construct: "this read shape on ${what} ('${name}')",
    cover: { by: 'uncovered', gap: "something other than a field after the final `.`; also a bare `EXISTS(n-[:items]->)` off a synthesised node, shape position, callback or resource" } },
  { file: "expression.ts", construct: "aggregating ${what} ('${name}') as a position",
    cover: { by: 'uncovered', gap: "only by spelling the engine's internal position marker as a field name" } },
  { file: "run.ts", construct: "file-level calls",
    cover: { by: 'dryRun', label: "file-level calls", snippet: `import { fetch_url } from plugins\npage = fetch_url(url: "https://example.com")\n` } },
  { file: "run.ts", construct: "traversing the deferred edge '${edge}' of a synthesised node reached through a block meta-node",
    cover: { by: 'uncovered', gap: "a race receipt holding a synthesised node with a `lazy` edge, then hops past it; unconfirmed" } },
  { file: "run.ts", construct: "WHERE on the target of '${at}' — an edge of a node this run built",
    cover: { by: 'partial', codes: ["MOV_TARGET_WHERE_LOCAL"], gap: "silent when the checker cannot type the target's parent node (it returns before the local-node test)" } },
  { file: "run.ts", construct: "a movement parameter typed against '${paramType.graph}'",
    cover: { by: 'uncovered', gap: "a movement parameter typed against a shape (`movement m(msg: <Lead>)`) fired by a listen; the checker takes the shape-conformance path" } },
  { file: "run.ts", construct: "the file import \"${statement.source.path}\"",
    cover: { by: 'harness', seam: "resolveFile" } },
  { file: "run.ts", construct: "file-level extract expressions",
    cover: { by: 'dryRun', label: "file-level extract expressions", snippet: `r = extract from ["a fixed document"] {\n  name: "the name"\n}\n` } },
  { file: "run.ts", construct: "file-level traversal blocks",
    cover: { by: 'dryRun', label: "file-level traversal blocks", snippet: `rows = graph-[c:company]-> {\n  return c\n}\n` } },
  { file: "run.ts", construct: "file-level writes",
    cover: { by: 'dryRun', label: "file-level writes", snippet: `w = write crm-[:companies]-> { name: "Acme" }\n` } },
  { file: "run.ts", construct: "file-level matches",
    cover: { by: 'dryRun', label: "file-level matches", snippet: `co = match crm-[:companies]-> { unique by (\`name\`), name: "Acme" }\n` } },
  { file: "run.ts", construct: "file-level links",
    cover: { by: 'dryRun', label: "file-level links", snippet: `co = link crm -[:companies]-> { name: "Acme" }\n` } },
  { file: "run.ts", construct: "nested ${statement.kind} declarations inside a movement body",
    cover: { by: 'dryRun', label: "nested movement declarations inside a movement body", snippet: `movement outer(m: <inbox-[:message]->>) {\n  movement inner(n: <inbox-[:message]->>) {\n    write crm-[:companies]-> { name: n.\`subject\` }\n  }\n}\n` } },
  { file: "run.ts", construct: "calling the import '${statement.callee}'",
    cover: { by: 'checker', codes: ["MOV_CALL_NOT_MOVEMENT"] } },
  { file: "run.ts", construct: "recursive movement calls ('${[...this.callStack.map((d) => d.name), declaration.name].join(' \u2192 ')}')",
    cover: { by: 'uncovered', gap: "a movement that calls itself (calls.unit.test.ts proves the checker accepts it)" } },
  { file: "run.ts", construct: "a ${arg.kind} argument to the plugin '${statement.callee}'",
    cover: { by: 'uncovered', gap: "a node literal or write passed as a plugin argument; the checker checks plugin argument names only" } },
  { file: "run.ts", construct: "passing ${describeBinding[binding.kind]} ('${arg.expr.raw.trim()}') as a movement argument",
    cover: { by: 'uncovered', gap: "an argument whose binding is not a record (a value, a block's returned records) passed where a movement takes a position; the checker's fit check skips an unknown argument type" } },
  { file: "run.ts", construct: "callback(\u2026)",
    cover: { by: 'harness', seam: "callbackSink" } },
  { file: "run.ts", construct: "callback(${subject.movement}(\u2026)) leaving '${deferred.map((p) => p.name).join(\"', '\")}' unsupplied",
    cover: { by: 'checker', codes: ["MOV_CALLBACK_PARAM_NOT_VALUE", "MOV_PARAM_NEEDS_TYPE"] } },
  { file: "run.ts", construct: "await '${pathRootName(source.head) ?? ''}-[:${edge}]->'",
    cover: { by: 'uncovered', gap: "`await FIRST(m-[:Replies]->)` off a traversed record rather than a handle; the checker requires an awaitable edge, not a handle head" } },
  { file: "run.ts", construct: "await '-[:${edge}]->' on '${adapterType}'",
    cover: { by: 'partial', codes: ["MOV_AWAIT_NOT_AWAITABLE"], gap: "silent when the edge is undescribed" } },
  { file: "run.ts", construct: "await (a durable park)",
    cover: { by: 'harness', seam: "parkSink" } },
  { file: "run.ts", construct: "await '-[:${input.edge}]->' on a callback",
    cover: { by: 'checker', codes: ["MOV_TRAVERSE_UNKNOWN_EDGE"] } },
  { file: "run.ts", construct: "await cb-[:${CALLBACK_CALLED_EDGE}]->",
    cover: { by: 'harness', seam: "callbackSink" } },
  { file: "run.ts", construct: "await cb-[:${CALLBACK_CALLED_EDGE}]-> (a durable park)",
    cover: { by: 'harness', seam: "parkSink" } },
  { file: "run.ts", construct: "reading a block's inner binding by name ('{ \u2026 }.${binding}')",
    cover: { by: 'checker', codes: ["MOV_INLINE_BLOCK_RETIRED"] } },
  { file: "run.ts", construct: "continuing a walk past a head that is not a traversal",
    cover: { by: 'uncovered', gap: "a `lazy` head over `_resources` read past its end; the checker leaves that walk untyped (unconfirmed)" } },
  { file: "run.ts", construct: "rootless block heads (relative traversal)",
    cover: { by: 'uncovered', gap: "`-[c:companies]-> { \u2026 }` in a body; the checker walks rootless heads untyped" } },
  { file: "run.ts", construct: "this block head over a callback",
    cover: { by: 'partial', codes: ["MOV_TRAVERSE_UNKNOWN_EDGE"], gap: "a `_resources` head off a callback is untyped and not refused" } },
  { file: "run.ts", construct: "'${head.hopsRaw}' on a callback",
    cover: { by: 'partial', codes: ["MOV_TRAVERSE_UNKNOWN_EDGE", "MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` hop off a callback is refused under language version 3, still saved by a movement pinned to 1 or 2; any other edge is refused by MOV_TRAVERSE_UNKNOWN_EDGE" } },
  { file: "run.ts", construct: "cb-[:${CALLBACK_CALLED_EDGE}]->",
    cover: { by: 'harness', seam: "callbackSink" } },
  { file: "run.ts", construct: "this block head over ${describeBinding[rootBinding.kind]}",
    cover: { by: 'uncovered', gap: "a `_resources` head off a synthesised node or deferred walk; untyped in the checker" } },
  { file: "run.ts", construct: "this block head over an extract result",
    cover: { by: 'partial', codes: ["MOV_LINKED_HOP_RETIRED"], gap: "a `#linked` hop off an extract result is refused under language version 3 (a movement pinned to 1 or 2 still reaches it); any other non-traversal head here (a `_resources` head) is unconfirmed" } },
  { file: "run.ts", construct: "'${step.type}' hops in a block head over an extract result",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` hop over an extract result: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "run.ts", construct: "WHERE filters on extract-result block heads",
    cover: { by: 'uncovered', gap: "a hop WHERE on an extract-result block head; no hop capability for extract positions" } },
  { file: "run.ts", construct: "this block head over ${describeBinding[rootBinding.kind]}",
    cover: { by: 'uncovered', gap: "a `_resources` head off a graph or write handle; untyped in the checker" } },
  { file: "run.ts", construct: "block heads rooted at '${root}' (a ${rootBinding.kind} binding)",
    cover: { by: 'uncovered', gap: "a write whose adapter returned no record id, then a block head off its handle" } },
  { file: "run.ts", construct: "this block head over ${describeBinding[rootBinding.kind]}",
    cover: { by: 'partial', codes: ["MOV_LINKED_HOP_RETIRED"], gap: "a `#linked` hop off the event or a source record is refused under language version 3 (a movement pinned to 1 or 2 still reaches it); any other non-traversal head here (a `_resources` head) is unconfirmed" } },
  { file: "run.ts", construct: "this block head over a block meta-node",
    cover: { by: 'uncovered', gap: "a `_resources` head off a race receipt (unconfirmed)" } },
  { file: "run.ts", construct: "'${step.type}' hops in a block head over a block meta-node",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` hop over a meta-node: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "run.ts", construct: "WHERE filters on block meta-node block heads",
    cover: { by: 'uncovered', gap: "a hop WHERE on a race-receipt block head; no checker rule" } },
  { file: "run.ts", construct: "block heads rooted at '${root}' (a ${rootBinding.kind} binding)",
    cover: { by: 'uncovered', gap: "a hop off a `_resources` alias (`f-[x:foo]->`); the resource alias is untyped" } },
  { file: "run.ts", construct: "'${step.type}' hops over a synthesised node",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` hop over a synthesised node: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "run.ts", construct: "hopping past a '${step.edgeTypeId}' landing that is ${describeBinding[path.binding.kind]}",
    cover: { by: 'uncovered', gap: "hopping past a synthesised edge whose landing is a write handle; the declared edge types to the graph's positions" } },
  { file: "run.ts", construct: "WHERE filters on a lazy entry's hop",
    cover: { by: 'uncovered', gap: "`d-[c:companies WHERE \u2026]->` on a synthesised node whose `companies` entry is lazy; a landed edge filters its landings in hand" } },
  { file: "run.ts", construct: "naming a deferred edge's landing ('${step.alias}') while hopping past it",
    cover: { by: 'uncovered', gap: "naming a deferred edge's landing while hopping past it; no checker rule" } },
  { file: "run.ts", construct: "'${step.type}' hops in a block head over the source graph",
    cover: { by: 'partial', codes: ["MOV_TRANSFORM_HOP_RETIRED"], gap: "a `#transform` hop off the event: refused under language version 3, still saved by a movement pinned to 1 or 2" } },
  { file: "run.ts", construct: "incoming block-head hops ('${step.edgeTypeId}')",
    cover: { by: 'uncovered', gap: "an incoming block-head hop on an adapter without incoming traversal; the checker never looks at hop direction" } },
  { file: "run.ts", construct: "a WHERE on the target of a 'bind ${write.bind.name}' write",
    cover: { by: 'partial', codes: ["MOV_TARGET_WHERE_BIND", "MOV_TARGET_WHERE_LOCAL"], gap: "silent when the checker cannot type the target's parent or resolve its instance (it returns before the bind test)" } },
  { file: "run.ts", construct: "'bind' on a write into a node this run built (${at})",
    cover: { by: 'uncovered', gap: "`write d-[:companies]-> bind msg { \u2026 }` into a node this run built; the bind check skips local targets" } },
  { file: "run.ts", construct: "WHERE on a shape write",
    cover: { by: 'checker', codes: ["MOV_WRITE_SHAPE_RETIRED"] } },
  { file: "run.ts", construct: "unique by on a shape write",
    cover: { by: 'checker', codes: ["MOV_WRITE_SHAPE_RETIRED"] } },
  { file: "run.ts", construct: "link ${link.from} -[:${link.edge}]-> { \u2026 } on a node this run built",
    cover: { by: 'checker', codes: ["MOV_NODE_LINK_BODY"] } },
  { file: "run.ts", construct: "multi-hop linked writes",
    cover: { by: 'uncovered', gap: "`write crm-[:companies]->-[:notes]-> { \u2026 }`; the checker walks every hop but the last and accepts it" } },
  { file: "run.ts", construct: "linked writes off a shape position (multi-node shapes)",
    cover: { by: 'checker', codes: ["MOV_WRITE_SHAPE_RETIRED", "MOV_NODE_EDGE_UNDECLARED"] } },
  { file: "run.ts", construct: "multi-hop linked writes",
    cover: { by: 'uncovered', gap: "`write msg-[:channel]->-[:messages]-> { \u2026 }` off a handle or event root" } },
  { file: "run.ts", construct: "a 'unique by' clause with no key ('${clause.predicate.raw}')",
    cover: { by: 'checker', codes: ["MOV_UNIQUE_CONJUNCT_NEEDS_WHERE"] } },
  { file: "run.ts", construct: "a 'unique by' test that reads beyond the candidate",
    cover: { by: 'checker', codes: ["MOV_UNIQUE_CONJUNCT_NEEDS_WHERE"] } },
  { file: "run.ts", construct: "'${event.triggerType}' trigger events",
    cover: { by: 'unreachable', why: "the trigger type comes from dispatch, not the program; nothing in apps/api emits the two unhandled types" } },
];

const ENGINE_DIR = path.resolve(__dirname, '..');
const CHECKER_DIR = path.resolve(__dirname, '../../../../../../packages/movement-lang/checker');

const PRELUDE = `
import { email, attio, kg } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)
graph = kg()
`;

/** Every `unsupported(` call in a file, keyed by its first argument's text. */
function callSites(file: string): string[] {
  const source = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8');
  const found: string[] = [];
  const call = /\bunsupported\(/g;
  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    if (source.slice(Math.max(0, match.index - 9), match.index) === 'function ') continue;
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | undefined;
    let firstArgEnd: number | undefined;
    let i = start;
    for (; depth > 0; i++) {
      const c = source[i];
      if (quote !== undefined) {
        if (c === '\\') i++;
        else if (c === quote) quote = undefined;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 1 && firstArgEnd === undefined) firstArgEnd = i;
    }
    const arg = source.slice(start, firstArgEnd ?? i - 1).trim().replace(/\s+/g, ' ');
    found.push(arg.slice(1, -1));
  }
  return found;
}

function checkerSources(): string {
  return fs
    .readdirSync(CHECKER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(CHECKER_DIR, f), 'utf8'))
    .join('\n');
}

describe('every MOVENG_UNSUPPORTED site names what stops a saved movement reaching it', () => {
  it('only the registered files throw it', () => {
    const callers = fs
      .readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.ts') && callSites(f).length > 0)
      .sort();
    expect(callers).toEqual(['expression.ts', 'run.ts']);
  });

  for (const file of ['expression.ts', 'run.ts'] as const) {
    it(`${file}: the registry lists exactly the call sites in the file`, () => {
      const inSource = callSites(file);
      const registered = SITES.filter((s) => s.file === file).map((s) => s.construct);
      const unregistered = inSource.filter((c, i) => registered[i] !== c);
      // A mismatch names the first construct out of place — register it (with
      // its cover) where it sits in the file.
      expect({ firstOutOfPlace: unregistered[0], count: inSource.length }).toEqual({
        firstOutOfPlace: undefined,
        count: registered.length,
      });
    });
  }

  it('a checker cover names diagnostic codes the checker really has', () => {
    const checker = checkerSources();
    const missing = SITES.flatMap((s) =>
      s.cover.by === 'checker' || s.cover.by === 'partial'
        ? s.cover.codes.filter((code) => !checker.includes(`'${code}'`))
        : [],
    );
    expect(missing).toEqual([]);
  });

  it('a dry-run cover is proven: the scan flags its snippet with its label', () => {
    for (const site of SITES) {
      if (site.cover.by !== 'dryRun') continue;
      expect({ site: site.construct, flagged: listUnsupportedConstructs(`${PRELUDE}${site.cover.snippet}`) })
        .toEqual({ site: site.construct, flagged: expect.arrayContaining([site.cover.label]) });
    }
  });

  it('the known gaps only ever shrink', () => {
    const gaps = SITES.filter((s) => s.cover.by === 'uncovered' || s.cover.by === 'partial');
    expect(gaps.length).toBeLessThanOrEqual(KNOWN_GAPS);
  });
});
