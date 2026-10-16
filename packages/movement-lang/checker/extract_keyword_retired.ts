// The extraction keyword (`x = extract from […] { … }`) under language
// version 5: refused as MOV_EXTRACT_KEYWORD_RETIRED, with the rewrite to the
// extraction call where it is mechanical. The rewrite declares the tree as a
// node shape and extracts it with `extractOne`, the one record the keyword's
// result was: its fields read off it and its nodes walked from it as before.
// The fix is never `safe`: the record may be absent where the keyword's result
// never was, an untyped field becomes `<text>`, and the model is asked through
// the call's prompt. A `through […]` stage has no rewrite: no composition of
// plugin calls is provably the same.
//
// Pure over the AST, so crates/movement-checker (families/extract_keyword.rs)
// builds the same message and the same fix.

import type { DeclaredExtractNode, ExprSlot, ExtractExpression, ExtractNode, ExtractStage, Loc, ShapeNode } from '../parser/ast';
import type { DiagnosticFix } from './fixes';

/** What the generated declaration tells the model the one record is. */
const ROOT_WORDS = '"the relevant information in the content"';

const RETIRED =
  "the extraction keyword ('extract from […] { … }') is retired — an extraction is the call over a declared node shape: 'extract(content, Shape)' for each record the content holds, 'extractOne(content, Shape)' for the one it describes";

export interface ExtractKeywordContext {
  /** The name the result is bound to, when it is. */
  binding?: string;
  /** Where the statement holding the extraction starts. */
  statement: Loc;
  /** Where the file-level statement holding it starts. */
  topLevel: Loc;
  /** Every name the file declares or binds at its top, and the shapes earlier
   *  rewrites in this check generated: the new name is none of them. */
  taken: Set<string>;
  /** The node declaration a declared node names, as the checker resolved it
   *  (its base folded in). */
  resolveDeclared: (type: string) => ShapeNode | undefined;
}

export interface ExtractKeywordRetirement {
  message: string;
  fix?: DiagnosticFix;
}

export function extractKeywordRetirement(extract: ExtractExpression, context: ExtractKeywordContext): ExtractKeywordRetirement {
  const blocker = blockerOf(extract.stages, context);
  if (blocker !== undefined) return { message: `${RETIRED}. ${blocker}` };
  const name = shapeName(context.binding, context.taken);
  context.taken.add(name);
  // A description that interpolates reads the scope it is written in, so the
  // declaration stays in the body there; any other is hoisted to file level.
  const inBody = interpolates(extract.stages);
  const indent = inBody ? ' '.repeat(Math.max(context.statement.col - 1, 0)) : '';
  const lines = [`${indent}node ${name}: ${ROOT_WORDS} {`, ...stageLines(extract.stages[0], `${indent}  `, context), `${indent}}`];
  const at: Loc = { line: inBody ? context.statement.line : context.topLevel.line, col: 1 };
  const settings = extract.tier !== undefined ? `, { tier: ${JSON.stringify(extract.tier)} }` : '';
  const call = `extractOne([${extract.from.map((slot) => slot.raw.trim()).join(', ')}], ${name}${settings})`;
  const bound = context.binding !== undefined ? `'${context.binding} = ${shortCall(name, extract.tier)}'` : `'${shortCall(name, extract.tier)}'`;
  return {
    message:
      `${RETIRED}. The fix declares this tree as 'node ${name}' and writes ${bound}: the one record the keyword's result was, its fields read off it and its nodes walked from it as before.`
      + " Review it before applying: the record may be absent where the keyword's result never was (a field read off it then needs a fallback), an untyped field becomes <text>, and the model is asked through the call's prompt",
    fix: {
      edits: [
        { span: { start: at, end: at }, text: `${lines.join('\n')}\n${inBody ? '' : '\n'}` },
        { span: extract.span, text: call },
      ],
    },
  };
}

function shortCall(name: string, tier: string | undefined): string {
  return `extractOne(content, ${name}${tier !== undefined ? `, { tier: ${JSON.stringify(tier)} }` : ''})`;
}

/** Why no rewrite keeps this tree's meaning, if one is why. */
function blockerOf(stages: readonly ExtractStage[], context: ExtractKeywordContext): string | undefined {
  if (stages.length !== 1 || stages.some((stage) => stage.through !== undefined)) return THROUGH;
  for (const child of stages[0].children) {
    const blocker = isDeclared(child) ? declaredBlocker(child, context) : blockerOf(child.stages, context);
    if (blocker !== undefined) return blocker;
  }
  return undefined;
}

const THROUGH =
  "No rewrite keeps a 'through […]' stage's meaning: it hands each record's plugin answers to a further extraction of that record, merged into it, where a plugin called as a function hands back a value of its own."
  + ' Rewrite it by hand: declare the shape, extract it, map over the records calling each plugin, extractOne over the content plus what the plugin returned, and merge the two with a spread';

function declaredBlocker(node: DeclaredExtractNode, context: ExtractKeywordContext): string | undefined {
  if (node.stages.length > 0) return THROUGH;
  const shape = context.resolveDeclared(node.declared.type);
  if (shape === undefined) return `The node '${node.name}' names <${node.declared.type}>, which is no node declaration in scope: declare the shape by hand`;
  if (shapeInterpolates(shape)) {
    return `The node '${node.name}' takes its fields from <${node.declared.type}>, whose words interpolate in the file that declared them, so copying them into a new declaration could change what they say: declare the shape by hand`;
  }
  return undefined;
}

function isDeclared(node: ExtractNode): node is DeclaredExtractNode {
  return node.declared !== undefined;
}

/** `x` → `XShape`, `found_cos` → `FoundCosShape`; a name already taken gets
 *  the next number (`XShape2`). */
export function shapeName(binding: string | undefined, taken: ReadonlySet<string>): string {
  const parts = (binding ?? 'extracted').split(/[^A-Za-z0-9]+/).filter((part) => part !== '');
  const base = `${parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Shape`;
  const first = /^[A-Za-z]/.test(base) ? base : `X${base}`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    if (!taken.has(`${first}${n}`)) return `${first}${n}`;
  }
}

function interpolates(stages: readonly ExtractStage[]): boolean {
  return stages.some(
    (stage) =>
      stage.fields.some((field) => holdsInterpolation(field.description))
      || stage.children.some((child) => holdsInterpolation(child.description) || interpolates(child.stages)),
  );
}

function shapeInterpolates(shape: ShapeNode): boolean {
  return (
    holdsInterpolation(shape.description)
    || shape.fields.some((field) => holdsInterpolation(field.description))
    || shape.children.some(shapeInterpolates)
  );
}

function holdsInterpolation(slot: ExprSlot | undefined): boolean {
  return slot !== undefined && slot.raw.includes('${');
}

function stageLines(stage: ExtractStage, indent: string, context: ExtractKeywordContext): string[] {
  const lines = stage.fields.map((field) => `${indent}${spelled(field.name)}: ${typeMarker(field.type ?? 'text', field.nullable)} ${field.description.raw.trim()}`);
  for (const child of stage.children) {
    if (isDeclared(child)) {
      const shape = context.resolveDeclared(child.declared.type);
      if (shape === undefined) continue;
      lines.push(...shapeLines({ ...shape, name: child.name, description: child.description ?? shape.description }, indent));
      continue;
    }
    lines.push(`${indent}node ${spelled(child.name)}: ${child.description.raw.trim()} {`, ...stageLines(child.stages[0], `${indent}  `, context), `${indent}}`);
  }
  return lines;
}

function shapeLines(node: ShapeNode, indent: string): string[] {
  const words = node.description !== undefined ? `: ${node.description.raw.trim()}` : '';
  const order = node.sequenced !== undefined ? ` order by ${node.sequenced}` : '';
  return [
    `${indent}node ${spelled(node.name)}${words} {`,
    ...node.fields.map((field) => {
      const described = field.description !== undefined ? ` ${field.description.raw.trim()}` : '';
      return `${indent}  ${spelled(field.name)}: ${typeMarker(field.type, field.nullable)}${described}`;
    }),
    ...node.children.flatMap((child) => shapeLines(child, `${indent}  `)),
    `${indent}}${order}`,
  ];
}

/** `<text>`, `<text | null>`; a borrowed `crm.companies.stage` in its
 *  surface spelling, `` <crm-[:companies]->.`stage`> ``. */
function typeMarker(type: string, nullable: true | undefined): string {
  const segments = /^[A-Za-z_][A-Za-z0-9_]*\.[^.]+\.[^.]+$/.test(type) && !type.includes('"') ? type.split('.') : undefined;
  const written = segments !== undefined ? `${segments[0]}-[:${segments[1]}]->.\`${segments[2]}\`` : type;
  return `<${written}${nullable ? ' | null' : ''}>`;
}

function spelled(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

