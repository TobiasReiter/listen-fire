// The connected systems in compact text: what an authoring agent needs to write
// a program without reading the describe JSON — how to construct each system,
// its record types with their fields, its edges, and what a listen on it may
// say. Two readers share one notation:
//
//   - getStarted's digest: every system at its root, under a fixed budget.
//   - describeConnection's default answer: one place in one system, with its
//     edges and what each lands on, one level deep.
//
// The full JSON (describeConnection with `detail: "full"`) stays the way to
// see everything; this text says so wherever it cut something.
//
// Pure: describe_connection.ts and get_started.ts gather the catalog and the
// describes, this module turns them into text.

import { spellName, type AdapterSpec, type FieldType, type InstanceSchema } from 'movement-lang';

import type { WalkedDescribedNode, WalkedEdge, WalkedNode, WalkedProperty } from './walk';

import { neverAsAny } from 'movement-engine/lib/utils/types';

/** One system's block in getStarted, in characters (about a quarter as many
 *  tokens). Sized so a CRM's main record types keep their fields. */
export const SYSTEM_DIGEST_CHAR_CAP = 1_600;
/** Every block together. Past it, the remaining systems get a header line. */
export const CONNECTIONS_DIGEST_CHAR_CAP = 8_000;

/** Fields shown per type in getStarted, and on an edge's landing in a describe. */
const FIELDS_PER_TYPE = 10;
/** Fields shown for the node a describe stands on — the one being authored against. */
const FIELDS_AT_POSITION = 40;
const ENUM_OPTIONS_SHOWN = 4;

export interface SystemDigestInput {
  /** The adapter name, as imported from `adapters`. */
  system: string;
  spec: Pick<AdapterSpec, 'constructionArgs' | 'triggerConfig' | 'triggerConfigOptions' | 'triggerConfigRequired'>;
  /** The credential import names that serve this system; empty when it needs none. */
  connections: string[];
  /** The root of a describe, its stubs resolved where they could be: absent
   *  when the system could not be described. */
  node?: WalkedNode;
  /** The same describe's schema — read only for identity fields a landing does
   *  not carry itself. */
  schema?: InstanceSchema | null;
  /** Why there is no node, when there is none. */
  note?: string;
}

export const DIGEST_LEGEND =
  'Marks: `!` required to create · `*` identifies the record (a `unique by` candidate) · `~` read-only · [r] readable, [w] writable, [fires] a listen can fire on it · a `backticked` name is written with its backticks in code.';

const moreHint = (system: string) => `describeConnection("${system}") for more`;

/** A type in as few characters as stay unambiguous. */
export function compactType(type: FieldType): string {
  if (typeof type === 'string') return type === 'absent' ? 'null' : type;
  switch (type.kind) {
    case 'list':
      return `${compactType(type.of)}[]`;
    case 'maybeAbsent':
      return `${compactType(type.of)}?`;
    case 'enum': {
      const shown = type.options.slice(0, ENUM_OPTIONS_SHOWN);
      const hidden = type.options.length - shown.length;
      // `…+N` counts the options cut; a bare `…` says other values are legal too.
      const more = hidden > 0 ? [`…+${hidden}`] : type.open !== undefined ? ['…'] : [];
      return `enum(${[...shown, ...more].join('|')})`;
    }
    case 'union':
      return type.of.map(compactType).join('|');
    case 'tuple':
      return 'tuple';
    case 'dict':
      return 'dict';
    case 'record':
      return 'record';
    default:
      return neverAsAny(type);
  }
}

/** `attio(credentials: acme)`; a second connection is named after it. */
function constructionSpelling(input: Pick<SystemDigestInput, 'system' | 'spec' | 'connections'>): string {
  const args = input.spec.constructionArgs.flatMap((arg) => {
    if (arg.kind === 'credential') return [`${arg.name}: ${input.connections[0] ?? '…'}`];
    return arg.required ? [`${arg.name}: …`] : [];
  });
  const others = input.connections.slice(1);
  return `\`${input.system}(${args.join(', ')})\`${others.length > 0 ? ` (other connections: ${others.join(', ')})` : ''}`;
}

/** `listen { key! }`, `listen { events: record.created|record.updated, channels }`. */
function listenSpelling(spec: SystemDigestInput['spec']): string | null {
  const keys = spec.triggerConfig ?? [];
  if (keys.length === 0) return null;
  const required = new Set(spec.triggerConfigRequired ?? []);
  const parts = keys.map((key) => {
    const options = spec.triggerConfigOptions?.[key];
    const mark = required.has(key) ? '!' : '';
    return options && options.length > 0 ? `${key}${mark}: ${options.join('|')}` : `${key}${mark}`;
  });
  return `listen { ${parts.join(', ')} }`;
}

/** The landing's own identity rules first; the schema's write shape for a
 *  source whose walk does not carry them. */
function identityFields(input: {
  landing: WalkedDescribedNode;
  edgeName?: string;
  schema?: InstanceSchema | null;
}): Set<string> {
  if (input.landing.unique !== undefined) return new Set(input.landing.unique.flat());
  const schema = input.schema;
  const rules =
    (input.edgeName !== undefined ? schema?.writableRoots[input.edgeName]?.nativeUniqueness : undefined) ??
    schema?.writableRoots[input.landing.name]?.nativeUniqueness ??
    schema?.createShapes?.[input.landing.name]?.nativeUniqueness ??
    [];
  return new Set(rules.flat());
}

function access(edge: WalkedEdge): string {
  const fires = edge.fires ? [edge.firesOn && edge.firesOn.length > 0 ? `fires(${edge.firesOn.join('|')})` : 'fires'] : [];
  const flags = [
    `${edge.readable ? 'r' : ''}${edge.writable ? 'w' : ''}`,
    ...fires,
    ...(edge.awaitable ? ['await'] : []),
    // Writing here performs an action and stores nothing.
    ...(edge.ephemeral ? ['action'] : []),
  ].filter(Boolean);
  return flags.length > 0 ? ` [${flags.join(' ')}]` : '';
}

function fieldSpelling(name: string, property: WalkedProperty, identity: Set<string>, writableType: boolean): string {
  const marks = `${property.required ? '!' : ''}${identity.has(name) ? '*' : ''}${writableType && !property.writable ? '~' : ''}`;
  const writeOnly = property.writable && !property.readable ? ' (write-only)' : '';
  return `${spellName(name)} ${compactType(property.type)}${marks}${writeOnly}`;
}

/** Required and identifying fields first: they are the ones a first write
 *  needs. `limit` bounds how many are spelled; the rest are counted. */
function fieldList(input: {
  landing: WalkedDescribedNode;
  identity: Set<string>;
  writableType: boolean;
  limit: number;
}): string {
  const entries = Object.entries(input.landing.properties);
  const rank = ([name, p]: [string, WalkedProperty]) => (p.required ? 0 : input.identity.has(name) ? 1 : 2);
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  const shown = ordered
    .slice(0, input.limit)
    .map(([name, property]) => fieldSpelling(name, property, input.identity, input.writableType));
  const hidden = ordered.length - shown.length;
  return shown.length === 0 ? 'no fields' : `${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

/** What following the edge lands on, after the edge's own name. */
function landingText(input: { edge: WalkedEdge; schema?: InstanceSchema | null; limit: number }): string {
  const { edge } = input;
  const target = edge.target;
  if (target === undefined) {
    if (edge.landsOn) return ` → ${edge.landsOn.map(spellName).join('|')}`;
    if (edge.members) {
      const shown = edge.members.slice(0, ENUM_OPTIONS_SHOWN).map((m) => m.name);
      return `: one of ${shown.join(', ')}${edge.members.length > shown.length ? ', …' : ''} (narrow with WHERE)`;
    }
    return '';
  }
  if (target.stub === true) return ': fields not loaded — describe it';
  const identity = identityFields({ landing: target, edgeName: edge.name, schema: input.schema });
  return `: ${fieldList({ landing: target, identity, writableType: edge.writable, limit: input.limit })}`;
}

// ── getStarted's digest ─────────────────────────────────────────────────────

interface DigestEdgeLine {
  edge: WalkedEdge;
  full: string;
  /** The same edge with its fields cut — what it shrinks to over budget. */
  short: string;
}

function digestEdgeLine(input: SystemDigestInput, edge: WalkedEdge): DigestEdgeLine {
  const head = `- ${spellName(edge.name)}${access(edge)}`;
  const full = `${head}${landingText({ edge, schema: input.schema, limit: FIELDS_PER_TYPE })}`;
  const fieldCount = edge.target && edge.target.stub !== true ? Object.keys(edge.target.properties).length : 0;
  return { edge, full, short: fieldCount > 0 ? `${head}: ${fieldCount} fields` : full };
}

/**
 * Which edges give up their fields first when a block is over budget: types
 * you can only read, then event payloads, and writable types last — a write is
 * where a wrong field name costs a failed run rather than an empty read. Within
 * a rank, the last listed goes first.
 */
function shrinkOrder(lines: DigestEdgeLine[]): number[] {
  const rank = ({ edge }: DigestEdgeLine) => (edge.writable ? 2 : edge.fires ? 1 : 0);
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => rank(a.line) - rank(b.line) || b.index - a.index)
    .map(({ index }) => index);
}

/** One system's block, never longer than {@link SYSTEM_DIGEST_CHAR_CAP}. */
export function renderSystemDigest(input: SystemDigestInput): string {
  const header = `### ${input.system} — ${constructionSpelling(input)}`;
  const lines = [header];
  const listen = listenSpelling(input.spec);
  if (listen) lines.push(`- ${listen}`);
  if (!input.node) {
    lines.push(`- ${input.note ?? 'not described'} — ${moreHint(input.system)}`);
    return fitLines(lines, input.system);
  }
  const edges = input.node.edges.filter((edge) => !edge.ephemeral || edge.writable);
  const edgeLines = edges.map((edge) => digestEdgeLine(input, edge));
  const chosen = edgeLines.map((line) => line.full);
  const size = () => [...lines, ...chosen].reduce((sum, line) => sum + line.length + 1, 0);
  const shrunk: WalkedEdge[] = [];
  for (const index of shrinkOrder(edgeLines)) {
    if (size() + CUT_LINE_ROOM <= SYSTEM_DIGEST_CHAR_CAP) break;
    if (edgeLines[index].short === edgeLines[index].full) continue;
    chosen[index] = edgeLines[index].short;
    shrunk.push(edgeLines[index].edge);
  }
  const example = shrunk.find((edge) => edge.position !== undefined);
  const shrunkHint =
    shrunk.length > 0
      ? [
          `- fields cut for space — describeConnection({ system: "${input.system}"${example?.position !== undefined ? `, position: ${JSON.stringify(example.position)}` : ''} }) shows a type's`,
        ]
      : [];
  return fitLines([...lines, ...chosen, ...shrunkHint], input.system);
}

/** Room kept for the line that says what was cut. */
const CUT_LINE_ROOM = 120;

/** Keep whole lines while they fit, then say how many were cut and where they are. */
function fitLines(lines: string[], system: string): string {
  const longest = SYSTEM_DIGEST_CHAR_CAP - CUT_LINE_ROOM;
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const clipped = line.length > longest / 2 ? `${line.slice(0, longest / 2 - 1)}…` : line;
    const room = index === lines.length - 1 ? SYSTEM_DIGEST_CHAR_CAP : longest;
    if (used + clipped.length + 1 > room) {
      kept.push(`- … ${lines.length - index} more — ${moreHint(system)}`);
      break;
    }
    kept.push(clipped);
    used += clipped.length + 1;
  }
  return kept.join('\n');
}

/**
 * Every system's block, together never longer than
 * {@link CONNECTIONS_DIGEST_CHAR_CAP}. Systems come in the order given — the
 * caller puts the ones the team connected first — and those past the budget
 * keep only their construction line.
 */
export function renderConnectionsDigest(input: {
  systems: SystemDigestInput[];
  /** Systems that need a connection the team does not have yet. */
  notConnected: string[];
}): string {
  const footer =
    input.notConnected.length > 0
      ? `Not connected yet (connectSystem first): ${input.notConnected.join(', ')}.`
      : '';
  const budget = CONNECTIONS_DIGEST_CHAR_CAP - DIGEST_LEGEND.length - footer.length - 4;
  const blocks: string[] = [];
  let used = 0;
  for (const [index, system] of input.systems.entries()) {
    const full = renderSystemDigest(system);
    const block = used + full.length + 2 <= budget ? full : `### ${system.system} — ${constructionSpelling(system)}`;
    if (used + block.length + 2 > budget) {
      blocks.push(`… ${input.systems.length - index} more systems — listConnections names them.`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return [DIGEST_LEGEND, ...blocks, ...(footer ? [footer] : [])].join('\n\n');
}

// ── describeConnection's compact answer ─────────────────────────────────────

export interface ConnectionDescriptionInput {
  system: string;
  /** How to construct and listen — known at the root, where it is said once. */
  spec?: SystemDigestInput['spec'];
  connections?: string[];
  /** The walked node at the requested position, stubs resolved where they could be. */
  node?: WalkedNode;
  schema?: InstanceSchema | null;
  notes: string[];
  /** The manifest's prose: said at the root only. */
  about?: {
    description?: string;
    triggerExpectation?: string;
    authoringHints?: string;
    identity?: string;
    capability?: string;
  };
}

/** `-[:Team]-> People (many)`, a polymorphic edge's members as their own
 *  spellings, a multi-target edge's possible landings. */
function edgeSpelling(edge: WalkedEdge): string {
  const landing =
    edge.target !== undefined
      ? spellName(edge.target.name)
      : edge.landsOn !== undefined
        ? edge.landsOn.map(spellName).join('|')
        : '?';
  return `-[:${spellName(edge.name)}]-> ${landing} (${edge.cardinality})`;
}

function describedEdgeLines(input: { edge: WalkedEdge; at: string; schema?: InstanceSchema | null }): string[] {
  const { edge } = input;
  const head = `- ${edgeSpelling(edge)}${access(edge)}`;
  const target = edge.target;
  const tail =
    target === undefined
      ? ''
      : target.stub === true
        ? `: fields not loaded${edge.position !== undefined ? ` — describe position ${JSON.stringify(edge.position)}` : ''}`
        : `: ${fieldList({
            landing: target,
            identity: identityFields({ landing: target, edgeName: edge.name, schema: input.schema }),
            writableType: edge.writable,
            limit: FIELDS_PER_TYPE,
          })}`;
  // A member's address is this position plus the narrowed hop; the hop alone
  // is what an author writes after a record they already hold.
  const members = (edge.members ?? []).map((member) => {
    const hop = member.position.startsWith(input.at) ? member.position.slice(input.at.length) : member.position;
    return `  - ${JSON.stringify(member.name)}: ${hop}`;
  });
  return [`${head}${tail}`, ...members];
}

/**
 * One place in one system, in the digest's notation: the node's own fields,
 * then every edge leaving it with what it lands on, one level deep. At the
 * root it also says how to construct and listen, and what the system is.
 */
export function renderConnectionDescription(input: ConnectionDescriptionInput): string {
  const node = input.node;
  const atRoot = node === undefined || node.position === '';
  const lines: string[] = [];

  if (atRoot) {
    const construct =
      input.spec !== undefined
        ? ` — ${constructionSpelling({ system: input.system, spec: input.spec, connections: input.connections ?? [] })}`
        : '';
    lines.push(`### ${input.system}${construct}`);
    if (input.about?.description) lines.push(input.about.description);
    const listen = input.spec !== undefined ? listenSpelling(input.spec) : null;
    if (listen) lines.push(`- ${listen}`);
    if (input.about?.triggerExpectation) lines.push(`- What a listen fires on: ${input.about.triggerExpectation}`);
    if (input.about?.identity) lines.push(`- Runs as: ${input.about.identity}`);
    if (input.about?.capability) lines.push(`- Limits: ${input.about.capability}`);
    if (input.about?.authoringHints) lines.push(`- Hint: ${input.about.authoringHints}`);
    if (input.schema && input.schema.supportsInPlaceUpdate !== true) {
      lines.push('- Records here cannot be updated in place: a write creates.');
    }
  } else {
    lines.push(`### ${input.system} at ${node.position}`);
  }

  if (node !== undefined) {
    const own = Object.keys(node.properties).length;
    if (own > 0 || !atRoot) {
      const identity = identityFields({ landing: node, schema: input.schema });
      const writableType = Object.values(node.properties).some((p) => p.writable);
      lines.push(
        `${spellName(node.name)}: ${fieldList({ landing: node, identity, writableType, limit: FIELDS_AT_POSITION })}`,
      );
    }
    const edges = node.edges.filter((edge) => !edge.ephemeral || edge.writable);
    if (edges.length > 0) {
      lines.push(atRoot ? 'Record types:' : 'Edges:');
      for (const edge of edges) lines.push(...describedEdgeLines({ edge, at: node.position, schema: input.schema }));
    } else {
      lines.push('No edges leave this node.');
    }
  }

  for (const note of input.notes) lines.push(`Note: ${note}`);

  const deeper = node?.edges.find((edge) => edge.position !== undefined)?.position;
  lines.push(
    [
      deeper !== undefined
        ? `Go one hop further with an edge's position — this position followed by the edge, e.g. position: ${JSON.stringify(deeper)}.`
        : '',
      'detail: "full" returns the JSON (descriptions, capabilities, write shapes).',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return lines.join('\n');
}
